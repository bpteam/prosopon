export type AudioInputKind = 'none' | 'file' | 'mic' | 'test' | 'node' | 'stream';

export interface AudioInputOptions {
  /** Analysis window in samples (power of two). 1024 ≈ 21 ms at 48 kHz. */
  fftSize?: number;
  /** Injected for tests / sharing a context with a TTS player. Created lazily otherwise. */
  context?: AudioContext;
}

/**
 * The audio side of lip sync: one active source at a time routed into an AnalyserNode,
 * and a pull-style readRms() that the render loop calls once per frame.
 *
 * Routing: file and test signal → analyser → speakers; mic → analyser only (no monitoring, no feedback);
 * external node → analyser only (the caller decides whether it is audible); media stream → analyser, and to the
 * speakers when `monitor` is set.
 *
 * The AudioContext is created on the first start*() call, which should come from a user gesture
 * (autoplay policy).
 */
export class AudioInput {
  private readonly fftSize: number;
  private ctx: AudioContext | null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;

  private currentKind: AudioInputKind = 'none';
  private teardown: (() => void) | null = null;
  /** Bumped by every start*() and stop(), so a start that resolves after a newer one gives up. */
  private generation = 0;
  private readonly listeners = new Set<(kind: AudioInputKind) => void>();
  /** Extra consumers of the analysed signal (viseme analysers). Survive source changes. */
  private readonly taps = new Set<AudioNode>();

  constructor(options: AudioInputOptions = {}) {
    this.fftSize = options.fftSize ?? 1024;
    this.ctx = options.context ?? null;
  }

  get kind(): AudioInputKind {
    return this.currentKind;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** @returns unsubscribe */
  onKindChange(listener: (kind: AudioInputKind) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Play a file or URL through the speakers and analyse it. Resolves once playback has started. */
  async playFile(source: Blob | string): Promise<void> {
    const ctx = await this.begin();
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const element = new Audio();
    element.src = url;
    // A MediaElementSourceNode can be created once per element, so every file gets a fresh element.
    const node = ctx.createMediaElementSource(element);
    node.connect(this.analyser!);
    this.analyser!.connect(ctx.destination);

    const generation = this.generation;
    const onEnded = () => this.stop();
    element.addEventListener('ended', onEnded);
    this.activate('file', () => {
      element.removeEventListener('ended', onEnded);
      element.pause();
      node.disconnect();
      this.analyser?.disconnect();
      element.removeAttribute('src');
      element.load();
      if (typeof source !== 'string') URL.revokeObjectURL(url);
    });
    try {
      await element.play();
    } catch (error) {
      // play() also rejects when a newer source paused this element; that one must keep running.
      if (generation !== this.generation) throw new AudioInputSupersededError();
      this.stop();
      throw error;
    }
  }

  /** Analyse the microphone. Not routed to the speakers. */
  async startMic(): Promise<void> {
    const ctx = await this.begin();
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // AGC flattens the dynamics that amplitude lip sync relies on.
        autoGainControl: false,
        noiseSuppression: true,
        echoCancellation: true,
      },
    });
    if (generation !== this.generation) {
      // Another source was started (or stop() called) while the permission prompt was open.
      for (const track of stream.getTracks()) track.stop();
      throw new AudioInputSupersededError();
    }
    const node = ctx.createMediaStreamSource(stream);
    node.connect(this.analyser!);
    this.activate('mic', () => {
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
    });
  }

  /**
   * Built-in speech-like signal (buzz at ~130 Hz, amplitude-modulated at syllable rate with pauses),
   * for checking the mouth without a file or a mic. Loops until stop().
   */
  async startTestSignal(): Promise<void> {
    const ctx = await this.begin();
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 130;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1200;
    const envelope = ctx.createGain();
    envelope.gain.value = 0;
    osc.connect(lowpass).connect(envelope).connect(this.analyser!);
    this.analyser!.connect(ctx.destination);

    // Schedule envelopes ahead in chunks: 4-6 syllables of ~180 ms, then a ~400 ms pause.
    let scheduledUntil = ctx.currentTime + 0.05;
    let syllable = 0;
    const schedule = () => {
      const horizon = ctx.currentTime + 2;
      const g = envelope.gain;
      while (scheduledUntil < horizon) {
        const t = scheduledUntil;
        const inPhrase = syllable % 6 < 5;
        const dur = inPhrase ? 0.14 + 0.08 * ((syllable * 7) % 3) / 2 : 0.4;
        const peak = inPhrase ? 0.25 + 0.2 * (((syllable * 5) % 4) / 3) : 0;
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(peak, t + dur * 0.3);
        g.linearRampToValueAtTime(0, t + dur);
        scheduledUntil = t + dur + 0.02;
        syllable++;
      }
    };
    schedule();
    const timer = setInterval(schedule, 500);
    osc.start();
    this.activate('test', () => {
      clearInterval(timer);
      osc.stop();
      osc.disconnect();
      lowpass.disconnect();
      envelope.disconnect();
      this.analyser?.disconnect();
    });
  }

  /**
   * Analyse a MediaStream that is already open (tab capture, WebRTC). The stream is owned by the caller: stop()
   * disconnects it but doesn't stop its tracks.
   *
   * `monitor` also plays the stream through the speakers, for captures that take the audio away from where it
   * was playing (chrome.tabCapture mutes the tab). `monitorDelay` (seconds) delays only what is heard, which can
   * compensate the analysis latency of lip sync at the cost of the same delay in playback.
   */
  async attachMediaStream(stream: MediaStream, options: MediaStreamOptions = {}): Promise<void> {
    const ctx = await this.begin();
    if (stream.getAudioTracks().length === 0) {
      this.stop();
      throw new Error('[AudioInput] media stream has no audio track');
    }
    const node = ctx.createMediaStreamSource(stream);
    node.connect(this.analyser!);
    let monitor: AudioNode | null = null;
    if (options.monitor) {
      const delay = Math.max(0, options.monitorDelay ?? 0);
      if (delay > 0) {
        const delayNode = ctx.createDelay(Math.max(1, delay));
        delayNode.delayTime.value = delay;
        node.connect(delayNode).connect(ctx.destination);
        monitor = delayNode;
      } else {
        node.connect(ctx.destination);
      }
    }
    const onEnded = () => this.stop();
    const tracks = stream.getAudioTracks();
    // The capture ends on its own when the tab closes or the user stops it from the browser UI.
    for (const track of tracks) track.addEventListener('ended', onEnded);
    this.activate('stream', () => {
      for (const track of tracks) track.removeEventListener('ended', onEnded);
      node.disconnect();
      monitor?.disconnect();
    });
  }

  /**
   * Analyse an arbitrary node from the same AudioContext (a TTS player, a WebRTC stream).
   * Only taps the node: its own routing is untouched.
   */
  async connectNode(node: AudioNode): Promise<void> {
    await this.begin(node.context as AudioContext);
    node.connect(this.analyser!);
    this.activate('node', () => node.disconnect(this.analyser!));
  }

  /**
   * Feed the analysed signal (whatever source is active) into `node` as well, e.g. a viseme analyser.
   * The node must belong to `context`. @returns remove
   */
  addTap(node: AudioNode): () => void {
    this.taps.add(node);
    this.analyser?.connect(node);
    return () => {
      if (!this.taps.delete(node)) return;
      try {
        this.analyser?.disconnect(node);
      } catch {
        // Already disconnected by a source teardown.
      }
    };
  }

  stop(): void {
    this.generation++;
    const teardown = this.teardown;
    this.teardown = null;
    teardown?.();
    this.setKind('none');
  }

  /** RMS of the current analysis window, linear [0, 1]. 0 when no source is active. */
  readRms(): number {
    const analyser = this.analyser;
    const buffer = this.buffer;
    if (this.currentKind === 'none' || !analyser || !buffer) return 0;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const s = buffer[i]!;
      sum += s * s;
    }
    return Math.sqrt(sum / buffer.length);
  }

  async dispose(): Promise<void> {
    this.stop();
    this.listeners.clear();
    this.taps.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.analyser = null;
    if (ctx && ctx.state !== 'closed') await ctx.close();
  }

  private async begin(context?: AudioContext): Promise<AudioContext> {
    this.stop();
    const generation = this.generation;
    if (context && this.ctx && context !== this.ctx) {
      throw new Error('[AudioInput] node belongs to a different AudioContext');
    }
    const ctx = (this.ctx ??= context ?? new AudioContext());
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.buffer = new Float32Array(this.analyser.fftSize);
    }
    if (ctx.state === 'suspended') await ctx.resume();
    if (generation !== this.generation) throw new AudioInputSupersededError();
    return ctx;
  }

  private activate(kind: AudioInputKind, teardown: () => void): void {
    this.teardown?.();
    this.teardown = teardown;
    // File/test teardowns disconnect all analyser outputs; re-attach taps (duplicate connections are no-ops).
    for (const tap of this.taps) this.analyser?.connect(tap);
    this.setKind(kind);
  }

  private setKind(kind: AudioInputKind): void {
    if (kind === this.currentKind) return;
    this.currentKind = kind;
    for (const listener of [...this.listeners]) listener(kind);
  }
}

export interface MediaStreamOptions {
  /** Also play the stream through the speakers. Default false. */
  monitor?: boolean;
  /** Delay of the monitored signal, seconds. Default 0. */
  monitorDelay?: number;
}

/** A start*() call was overtaken by a newer start*() or stop() before it produced audio. */
export class AudioInputSupersededError extends Error {
  constructor() {
    super('superseded by a newer audio source');
    this.name = 'AudioInputSupersededError';
  }
}
