import { analyseCalibration, type CalibrationAnalysis } from './analysis';
import { CalibrationTrace } from './CalibrationTrace';
import { CalibrationAborted, FrameClock } from './FrameClock';
import { renderAgentTask, renderReport } from './reports';
import { buildScenario } from './scenarios';
import type { CalibrationHost, CalibrationScenario, CalibrationStep, StepRecord } from './types';
import { CALIBRATION_FILE_CHUNK, type CalibrationReply } from '../shared/messages';

/**
 * Phases of the calibration state machine:
 *
 *   idle → preflight → detect-environment → start-voice → (pick-voice) →
 *   assistant-<lang>… → user-<lang>… → interruption → analyse → complete → exporting → exported
 *
 * `paused` waits for the one thing only the user can do (open Voice, pick the voice); the run then continues from
 * the current step. Nothing but Start, those fallbacks, the optional "visually wrong" flag and Export needs the user.
 */
export type CalibrationPhase =
  | 'idle'
  | 'preflight'
  | 'detect-environment'
  | 'start-voice'
  | 'pick-voice'
  | 'assistant'
  | 'user'
  | 'interruption'
  | 'analyse'
  | 'complete'
  | 'exporting'
  | 'exported'
  | 'paused'
  | 'failed'
  | 'discarded';

export type CalibrationActionId = 'open-voice' | 'resume-voice' | 'mic';

export interface CalibrationView {
  phase: CalibrationPhase;
  /** State-machine label: "assistant-ru", "user-uk", "interruption", … */
  label: string;
  message: string;
  environment: {
    voice: string | null;
    voiceMode: string | null;
    voiceDetection: string;
    languages: string[];
    microphone: string;
    audioCapture: string;
  };
  progress: { done: number; total: number };
  /** The user's part of a user/interruption step. */
  prompt: { title: string; instruction: string; text: string; listening: boolean; countdown: number | null; speakNow: boolean } | null;
  /** A fallback only the user can do. */
  action: { id: CalibrationActionId; label: string; text: string } | null;
  voicePicker: { options: readonly string[] } | null;
  samples: { valid: number; total: number };
  /** "Mark this as visually wrong" applies to the current step. */
  flaggable: boolean;
  result: { lines: string[]; fileName: string } | null;
  error: string | null;
}

export interface CalibrationRunnerOptions {
  host: CalibrationHost;
  scenario?: CalibrationScenario;
  /** Waits and timeouts, seconds (tests shorten them). */
  timing?: Partial<typeof DEFAULT_TIMING>;
}

export const DEFAULT_TIMING = Object.freeze({
  /** Assistant audio must start this soon after a prompt was sent. */
  assistantStart: 30,
  /** Assistant silence that ends its turn. */
  assistantEndSilence: 2,
  assistantMaxTurn: 90,
  /** Quiet before a prompt is sent (the previous reply really ended). */
  quietBeforePrompt: 1,
  /** A running gesture may take this long to release after the speech ends. */
  gestureRelease: 3,
  /** The reply's text may appear this long after the speech ended. */
  textGrace: 3,
  /** The user must start speaking this soon after the instruction. */
  userStart: 20,
  /** VAD silence that ends the user's utterance. */
  userEndSilence: 0.8,
  userMaxUtterance: 30,
  /** Reaction window after the user's utterance (nod, thinking). */
  userReaction: 1.5,
  /** Interruption: speak cue this long after the assistant started. */
  interruptLead: 2,
  countdown: 3,
  interruptOnset: 8,
  voiceStart: 12,
  /** Voice controls must be mounted and tab audio quiet before the first scripted prompt is armed. */
  voiceReady: 10,
  voiceQuiet: 1.2,
  /** A click/chime is not a reply: assistant audio must remain present this long. */
  assistantMinSpeech: 0.7,
  micOn: 10,
});

const MIC_UNAVAILABLE = 'microphone reactions are not on';
/** Consecutive assistant samples without audio after which the typed-prompt path is considered broken. */
const MAX_SILENT_ASSISTANT = 3;

export class CalibrationRunner {
  readonly clock = new FrameClock();
  readonly scenario: CalibrationScenario;
  readonly records: StepRecord[] = [];
  private readonly host: CalibrationHost;
  private readonly timing: typeof DEFAULT_TIMING;
  private trace: CalibrationTrace | null = null;
  private listeners = new Set<(view: CalibrationView) => void>();
  private current: StepRecord | null = null;
  private pressed: CalibrationActionId | null = null;
  private pickedVoice: string | null = null;
  private muted = false;
  private analysis: CalibrationAnalysis | null = null;
  private files: Map<string, string> | null = null;
  private startedAt = 0;
  private offscreenInfo: Record<string, unknown> = {};
  private configBefore: Record<string, unknown> = {};
  private env = { voiceName: null as string | null, voiceMode: null as string | null, uiLanguage: null as string | null, detectedFrom: 'unknown' };
  private silentAssistant = 0;
  /** Set by discard(): the aborted run's cleanup sends nothing more to the recorder. */
  private discarded = false;
  private assistantBroken = false;
  private stateView: CalibrationView;

  constructor(options: CalibrationRunnerOptions) {
    this.host = options.host;
    this.scenario = options.scenario ?? buildScenario();
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.stateView = this.initialView();
  }

  get view(): Readonly<CalibrationView> {
    return this.stateView;
  }

  get result(): CalibrationAnalysis | null {
    return this.analysis;
  }

  /** The bundle's text files (after analysis). */
  get bundleFiles(): ReadonlyMap<string, string> | null {
    return this.files;
  }

  onChange(listener: (view: CalibrationView) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  get running(): boolean {
    return !['idle', 'complete', 'exporting', 'exported', 'failed', 'discarded'].includes(this.stateView.phase);
  }

  /** Called from the render loop every frame. */
  tick(delta: number): void {
    if (this.running) this.trace?.update(delta);
    this.clock.tick(delta);
  }

  /** Start: everything from here on is automatic. */
  start(): Promise<void> {
    if (this.stateView.phase !== 'idle') return Promise.resolve();
    return this.run().catch((error: unknown) => {
      if (error instanceof CalibrationAborted) return;
      this.set({ phase: 'failed', error: error instanceof Error ? error.message : String(error), message: 'Calibration stopped.', prompt: null, action: null });
      this.finishTrace();
    });
  }

  /** The user pressed the fallback button. */
  act(id: CalibrationActionId): void {
    this.pressed = id;
  }

  pickVoice(name: string): void {
    const v = name.trim().slice(0, 40);
    if (v) this.pickedVoice = v;
  }

  /** "Mark this as visually wrong" (optional; the run never waits for it). A reason refines the last flag. */
  flag(reason: StepRecord['manualFlags'][number]['reason'] = 'unspecified'): void {
    const rec = this.current;
    if (!rec) return;
    const t = this.now();
    const last = rec.manualFlags.at(-1);
    if (reason !== 'unspecified' && last && last.reason === 'unspecified' && t - last.t < 15000) last.reason = reason;
    else rec.manualFlags.push({ t, reason });
    this.trace?.event('manual-flag', { reason }, t);
  }

  /** Throws the recordings away (offscreen buffers included). */
  async discard(): Promise<void> {
    this.discarded = true;
    this.clock.abort();
    this.finishTrace();
    this.files = null;
    await this.host.offscreen({ type: 'calibration:discard' }).catch(() => undefined);
    this.set({ phase: 'discarded', message: 'Calibration discarded. Nothing was kept.', prompt: null, action: null, voicePicker: null, flaggable: false });
  }

  /** Packs the bundle in the offscreen document and opens the export page. */
  async export(): Promise<void> {
    if (!this.files || this.stateView.phase !== 'complete') return;
    this.set({ phase: 'exporting', message: 'Packing the calibration bundle…' });
    try {
      for (const [name, text] of this.files) {
        for (let i = 0; i === 0 || i < text.length; i += CALIBRATION_FILE_CHUNK) {
          await this.request({ type: 'calibration:file', name, text: text.slice(i, i + CALIBRATION_FILE_CHUNK), append: i > 0 });
        }
      }
      await this.request({ type: 'calibration:build', fileName: this.stateView.result!.fileName });
      this.files = null;
      this.host.openExport();
      this.set({ phase: 'exported', message: 'The bundle opened in a new tab. Temporary recordings were released.' });
    } catch (error) {
      this.set({ phase: 'complete', error: `Export failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // --- The run ---------------------------------------------------------------------------------------------------

  private async run(): Promise<void> {
    this.startedAt = this.now();
    await this.preflight();
    this.trace = new CalibrationTrace(this.host);
    this.trace.start();
    this.trace.event('session-start', { scenario: this.scenario.id, steps: this.scenario.steps.length });

    this.set({ phase: 'detect-environment', label: 'detect-environment', message: 'Detecting the ChatGPT voice…' });
    this.detectEnvironment();

    this.set({ phase: 'start-voice', label: 'start-voice', message: 'Starting ChatGPT Voice…' });
    await this.ensureVoice(true);
    this.detectEnvironment();
    if (!this.env.voiceName) await this.askVoice();
    // ChatGPT's own microphone stays muted while the wizard talks to it and while you speak test phrases, so neither
    // your room nor your phrases interrupt or prompt it. Interruption tests unmute it.
    this.muted = await this.host.chat.setVoiceMicMuted(true).catch(() => false);
    if (!this.muted) throw new Error("Couldn't mute ChatGPT's microphone. Calibration would be contaminated by room speech.");
    this.trace.event('recovery', { chatgptMicMuted: this.muted });
    await this.waitForVoiceToSettle();

    for (const step of this.scenario.steps) await this.runStep(step);

    if (this.muted) await this.host.chat.setVoiceMicMuted(false).catch(() => false);
    this.set({ phase: 'analyse', label: 'analyse', message: 'Analysing…', prompt: null, flaggable: false });
    this.finishTrace();
    this.analyse();
  }

  private async preflight(): Promise<void> {
    this.set({ phase: 'preflight', label: 'preflight', message: 'Preparing calibration…' });
    this.configBefore = this.host.configSnapshot();
    const env = this.host.environment();
    if (!env.offscreenConnected) throw new Error('Prosopon is not capturing this tab. Turn the avatar off and on again, then retry.');
    const begin = await this.request({ type: 'calibration:begin' });
    this.offscreenInfo = begin.data ?? {};
    if (!this.offscreenInfo.assistantSampleRate) throw new Error('Tab audio capture is not running. Turn the avatar off and on again, then retry.');
    this.updateEnvironmentView();
    if (this.host.environment().mic.state !== 'on') {
      // Automatic fix: the same switch as the popup's "Microphone reactions". Without it the user steps are skipped.
      await this.host.requestMicReactions().catch(() => undefined);
      await this.clock.until(() => this.host.environment().mic.state === 'on', this.timing.micOn);
      this.updateEnvironmentView();
    }
  }

  private detectEnvironment(): void {
    const e = this.host.chat.detectVoiceEnvironment();
    if (e.voiceName) this.env = { ...e };
    else this.env = { ...this.env, voiceMode: e.voiceMode ?? this.env.voiceMode, uiLanguage: e.uiLanguage };
    this.updateEnvironmentView();
  }

  private async askVoice(): Promise<void> {
    this.pickedVoice = null;
    this.set({
      phase: 'pick-voice',
      message: "I couldn't detect the selected ChatGPT voice. Select it:",
      voicePicker: { options: this.host.chat.knownVoices },
    });
    await this.clock.until(() => this.pickedVoice !== null, Number.POSITIVE_INFINITY);
    this.env = { ...this.env, voiceName: this.pickedVoice, detectedFrom: 'unknown' };
    this.trace?.event('recovery', { voicePickedManually: this.pickedVoice });
    this.set({ voicePicker: null });
    this.updateEnvironmentView();
  }

  /** Voice is deliberately a user action: the wizard never opens a Voice session or accepts its permission UI. */
  private async ensureVoice(first = false): Promise<void> {
    const chat = this.host.chat;
    if (chat.isVoiceModeActive()) {
      await this.waitForVoiceReady();
      return;
    }
    if (!first) this.trace?.event('recovery', { voiceClosed: true });
    const phase = this.stateView.phase;
    await this.waitForUser(
      first
        ? { id: 'open-voice', label: 'Open Voice', text: 'Start ChatGPT Voice yourself, then return here.' }
        : { id: 'resume-voice', label: 'Resume Voice', text: 'ChatGPT Voice closed. Open it yourself to continue.' },
      () => chat.isVoiceModeActive(),
      async () => chat.isVoiceModeActive(),
    );
    this.set({ phase });
    if (!first && this.muted) await chat.setVoiceMicMuted(true).catch(() => false);
    await this.waitForVoiceReady();
  }

  private async waitForVoiceReady(): Promise<void> {
    const ready = await this.clock.until(() => this.host.chat.isVoiceReady(), this.timing.voiceReady);
    if (!ready) throw new Error("ChatGPT Voice opened, but its controls did not become ready.");
  }

  /** Drains the Voice startup chime before an assistant sample can be armed. */
  private async waitForVoiceToSettle(): Promise<void> {
    const quiet = await this.clock.held(
      () => this.host.chat.isVoiceReady() && !this.frame().signals.assistantSpeaking,
      this.timing.voiceQuiet,
      this.timing.voiceReady,
    );
    if (!quiet) throw new Error('ChatGPT Voice did not become quiet after startup. Restart Voice and try again.');
  }

  /** Pause until `done()` holds, retrying `attempt` whenever the user presses the action. */
  private async waitForUser(action: NonNullable<CalibrationView['action']>, done: () => boolean, attempt: () => Promise<boolean>): Promise<void> {
    const phase = this.stateView.phase;
    this.set({ phase: 'paused', action, message: action.text });
    this.pressed = null;
    while (!done()) {
      await this.clock.until(() => done() || this.pressed === action.id, Number.POSITIVE_INFINITY);
      if (this.pressed === action.id) {
        this.pressed = null;
        if (await attempt().catch(() => false)) break;
      }
    }
    this.set({ phase, action: null });
  }

  private async runStep(step: CalibrationStep): Promise<void> {
    const rec: StepRecord = {
      stepId: step.id,
      kind: step.kind,
      language: step.language,
      category: step.category,
      requestedText: step.requestedText,
      prompt: step.prompt ?? null,
      actualRenderedText: null,
      textSource: 'none',
      startedAt: this.now(),
      endedAt: null,
      attempts: 0,
      valid: false,
      invalidReason: null,
      assistantSpeechSeconds: 0,
      userSpeechSeconds: 0,
      clips: [],
      manualFlags: [],
    };
    this.records.push(rec);
    this.current = rec;
    const phase = step.kind === 'assistant' ? 'assistant' : step.kind === 'user' ? 'user' : 'interruption';
    this.set({
      phase,
      label: step.kind === 'interruption' ? 'interruption' : `${step.kind}-${step.language}`,
      message: step.kind === 'assistant' ? `ChatGPT is speaking: ${step.language.toUpperCase()} · ${step.category}` : '',
      progress: { done: this.records.length - 1, total: this.scenario.steps.length },
      flaggable: true,
      prompt: null,
    });
    this.trace!.step = step.id;
    this.trace!.event('step-start', { kind: step.kind, language: step.language, category: step.category });
    try {
      if (step.kind === 'assistant') await this.assistantStep(step, rec);
      else if (step.kind === 'user') await this.userStep(step, rec);
      else await this.interruptionStep(step, rec);
    } finally {
      rec.endedAt = this.now();
      const speech = this.trace!.speech.get(step.id);
      rec.assistantSpeechSeconds = round(speech?.assistant ?? 0);
      rec.userSpeechSeconds = round(speech?.user ?? 0);
      if (!rec.valid) this.trace!.event('step-invalid', { reason: rec.invalidReason });
      this.trace!.event('step-end', { valid: rec.valid });
      this.trace!.step = null;
      this.current = null;
      this.set({ samples: this.samples(), prompt: null });
    }
  }

  private async assistantStep(step: CalibrationStep, rec: StepRecord): Promise<void> {
    if (this.assistantBroken) {
      rec.invalidReason = 'skipped: ChatGPT did not speak the previous typed prompts';
      return;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      rec.attempts = attempt;
      if (attempt > 1) this.trace!.event('step-retry', { reason: rec.invalidReason });
      const outcome = await this.speakPrompt(step, rec, `assistant/${step.language}/${step.id}${attempt > 1 ? `.retry${attempt - 1}` : ''}`);
      if (outcome === 'ok') {
        rec.valid = true;
        rec.invalidReason = null;
        this.silentAssistant = 0;
        return;
      }
    }
    if (rec.invalidReason === 'no-assistant-audio' && ++this.silentAssistant >= MAX_SILENT_ASSISTANT) this.assistantBroken = true;
  }

  /** Sends the step's prompt, records the spoken reply until it ends and the gesture settles. */
  private async speakPrompt(step: CalibrationStep, rec: StepRecord, clipId: string): Promise<'ok' | 'failed'> {
    const chat = this.host.chat;
    await this.ensureVoice();
    await this.clock.held(() => !this.frame().signals.assistantSpeaking, this.timing.quietBeforePrompt, 20);
    const before = chat.countAssistantMessages();
    const crosstalkBefore = this.frame().crosstalkEvents;
    await this.clip(rec, clipId, 'assistant', 'start');
    try {
      if (!(await chat.sendMessage(step.prompt!))) {
        rec.invalidReason = 'composer-unavailable';
        return 'failed';
      }
      this.trace!.event('prompt-sent', { chars: step.prompt!.length });
      const onset = await this.clock.until(() => this.frame().signals.assistantSpeaking || !chat.isVoiceModeActive(), this.timing.assistantStart);
      const started = onset && chat.isVoiceModeActive() && (await this.clock.held(() => this.frame().signals.assistantSpeaking, this.timing.assistantMinSpeech, this.timing.assistantStart));
      if (!started || !chat.isVoiceModeActive() || !this.frame().signals.assistantSpeaking) {
        rec.invalidReason = !chat.isVoiceModeActive() ? 'voice-session-ended' : chat.countAssistantMessages() > before ? 'no-assistant-audio' : 'assistant-did-not-answer';
        this.captureText(rec, before);
        return 'failed';
      }
      await this.clock.held(() => !this.frame().signals.assistantSpeaking, this.timing.assistantEndSilence, this.timing.assistantMaxTurn);
      if (this.frame().crosstalkEvents > crosstalkBefore) {
        rec.invalidReason = 'external-voice-during-assistant-sample';
        return 'failed';
      }
      await this.clock.until(() => this.frame().gesture.type === null, this.timing.gestureRelease);
      if (!(await this.clock.until(() => chat.countAssistantMessages() > before, this.timing.textGrace))) {
        rec.invalidReason = 'assistant-audio-without-reply-text';
        return 'failed';
      }
      this.captureText(rec, before);
      return 'ok';
    } finally {
      await this.clip(rec, clipId, 'assistant', 'stop');
    }
  }

  private captureText(rec: StepRecord, before: number): void {
    if (this.host.chat.countAssistantMessages() <= before) return;
    const reply = this.host.chat.readLatestReply();
    if (reply?.text) {
      rec.actualRenderedText = reply.text;
      rec.textSource = 'dom';
      this.trace!.event('reply-text', { messageId: reply.id, chars: reply.text.length });
    }
  }

  private async userStep(step: CalibrationStep, rec: StepRecord): Promise<void> {
    if (this.frame().mic !== 'on') {
      rec.invalidReason = MIC_UNAVAILABLE;
      return;
    }
    const prompt = { title: 'Speak now', instruction: step.instruction ?? '', text: step.requestedText, listening: false, countdown: null, speakNow: true };
    for (let attempt = 1; attempt <= 2; attempt++) {
      rec.attempts = attempt;
      this.set({ prompt: { ...prompt }, message: attempt > 1 ? "I didn't hear you. Please say it again." : '' });
      const clipId = `user/${step.language}/${step.id}${attempt > 1 ? `.retry${attempt - 1}` : ''}`;
      await this.clip(rec, clipId, 'user', 'start');
      try {
        if (!(await this.clock.until(() => this.frame().signals.userSpeaking, this.timing.userStart))) {
          rec.invalidReason = 'user-speech-not-detected';
          continue;
        }
        this.set({ prompt: { ...prompt, listening: true } });
        await this.clock.held(() => !this.frame().signals.userSpeaking, this.timing.userEndSilence, this.timing.userMaxUtterance);
        this.set({ prompt: null, message: '' });
        await this.clock.sleep(this.timing.userReaction);
        rec.valid = true;
        rec.invalidReason = null;
        return;
      } finally {
        await this.clip(rec, clipId, 'user', 'stop');
        // Without the mute, ChatGPT answers the phrase: let it finish before the next step.
        if (!this.muted) await this.clock.held(() => !this.frame().signals.assistantSpeaking, this.timing.assistantEndSilence, 30);
      }
    }
  }

  private async interruptionStep(step: CalibrationStep, rec: StepRecord): Promise<void> {
    if (this.frame().mic !== 'on') {
      rec.invalidReason = MIC_UNAVAILABLE;
      return;
    }
    if (this.assistantBroken) {
      rec.invalidReason = 'skipped: ChatGPT did not speak the typed prompts';
      return;
    }
    const chat = this.host.chat;
    // ChatGPT must hear the interruption too, as in a real conversation.
    if (this.muted) await chat.setVoiceMicMuted(false).catch(() => false);
    const base = { title: 'Interrupt ChatGPT', instruction: step.instruction ?? '', text: step.requestedText, listening: false, speakNow: false };
    try {
      for (let attempt = 1; attempt <= 2 && !rec.valid; attempt++) {
        rec.attempts = attempt;
        await this.ensureVoice();
        this.set({ prompt: { ...base, countdown: null } });
        await this.clock.held(() => !this.frame().signals.assistantSpeaking, this.timing.quietBeforePrompt, 20);
        const suffix = attempt > 1 ? `.retry${attempt - 1}` : '';
        await this.clip(rec, `assistant/${step.language}/${step.id}${suffix}`, 'assistant', 'start');
        await this.clip(rec, `user/${step.language}/${step.id}${suffix}`, 'user', 'start');
        try {
          if (!(await chat.sendMessage(step.prompt!))) {
            rec.invalidReason = 'composer-unavailable';
            continue;
          }
          this.trace!.event('prompt-sent', { chars: step.prompt!.length, interruption: true });
          const onset = await this.clock.until(() => this.frame().signals.assistantSpeaking || !chat.isVoiceModeActive(), this.timing.assistantStart);
          if (!onset || !chat.isVoiceModeActive() || !(await this.clock.held(() => this.frame().signals.assistantSpeaking, this.timing.assistantMinSpeech, this.timing.assistantStart))) {
            rec.invalidReason = !chat.isVoiceModeActive() ? 'voice-session-ended' : 'no-assistant-audio';
            continue;
          }
          await this.clock.sleep(this.timing.interruptLead);
          for (let n = Math.round(this.timing.countdown); n > 0; n--) {
            this.set({ prompt: { ...base, countdown: n } });
            this.trace!.event('countdown', { n });
            await this.clock.sleep(1);
          }
          rec.speakCueAt = this.now();
          this.set({ prompt: { ...base, countdown: null, speakNow: true } });
          this.trace!.event('countdown', { n: 0, speakNow: true });
          if (!(await this.clock.until(() => this.frame().signals.userSpeaking, this.timing.interruptOnset))) {
            rec.invalidReason = 'user-speech-not-detected';
            continue;
          }
          this.set({ prompt: { ...base, countdown: null, speakNow: true, listening: true } });
          await this.clock.held(() => !this.frame().signals.userSpeaking, this.timing.userEndSilence, this.timing.userMaxUtterance);
          this.set({ prompt: null });
          // ChatGPT answers the interruption; let that finish before the next test.
          await this.clock.held(() => !this.frame().signals.assistantSpeaking, this.timing.assistantEndSilence, this.timing.assistantMaxTurn);
          rec.valid = true;
          rec.invalidReason = null;
        } finally {
          await this.clip(rec, `assistant/${step.language}/${step.id}${suffix}`, 'assistant', 'stop');
          await this.clip(rec, `user/${step.language}/${step.id}${suffix}`, 'user', 'stop');
        }
      }
    } finally {
      if (this.muted) await chat.setVoiceMicMuted(true).catch(() => false);
    }
  }

  private async clip(rec: StepRecord, clipId: string, channel: 'assistant' | 'user', action: 'start' | 'stop'): Promise<void> {
    if (this.discarded) return;
    const reply = await this.host.offscreen({ type: 'calibration:record', clipId, channel, action }).catch(
      (error: unknown): CalibrationReply => ({ requestId: 0, ok: false, error: String(error) }),
    );
    if (action === 'stop' && reply.ok && reply.data) {
      const d = reply.data;
      rec.clips.push({
        clipId,
        channel,
        seconds: round(Number(d.seconds) || 0),
        sampleRate: Number(d.sampleRate) || 0,
        truncated: d.truncated === true,
      });
    }
    // A failing recorder costs the audio of this sample, not the sample: telemetry still counts.
    if (!reply.ok) this.trace?.event('recovery', { clipId, action, error: reply.error ?? 'recording failed' });
  }

  private analyse(): void {
    const trace = this.trace!;
    const manifest = this.manifest();
    this.analysis = analyseCalibration({
      scenario: this.scenario,
      records: this.records,
      events: trace.events,
      intents: trace.intents,
      released: trace.released,
      decisions: trace.decisions,
      gestures: trace.gestures,
      traceRows: trace.rows,
      voice: this.env.voiceName ?? 'unknown',
      configuredCharsPerSecond: pacerRate(this.configBefore),
    });
    const files = new Map<string, string>();
    const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
    const jsonl = (items: readonly unknown[]) => items.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + (items.length ? '\n' : '');
    files.set('manifest.json', json(manifest));
    files.set('config-before.json', json({ ...this.configBefore, offscreen: this.offscreenInfo }));
    files.set('scenarios.json', json(this.scenario));
    files.set('results.json', json(this.analysis.results));
    files.set('summary.json', json(this.analysis.summary));
    files.set('trace.jsonl', jsonl(trace.rows));
    files.set('events.jsonl', jsonl(trace.events));
    files.set(
      'assistant-text.jsonl',
      jsonl(
        this.records
          .filter((r) => r.kind !== 'user')
          .map((r) => ({ step: r.stepId, kind: r.kind, language: r.language, prompt: r.prompt, requestedText: r.requestedText, actualRenderedText: r.actualRenderedText, textSource: r.textSource })),
      ),
    );
    files.set('steps.jsonl', jsonl(this.records));
    files.set('semantic.jsonl', jsonl([...trace.intents.map((i) => ({ kind: 'analyzed', ...i })), ...trace.released.map((i) => ({ kind: 'released', ...i })), ...trace.decisions.map((d) => ({ kind: 'decision', ...d }))]));
    files.set('gestures.jsonl', jsonl(trace.gestures));
    files.set('REPORT.md', renderReport(manifest, this.analysis));
    files.set('AGENT_TASK.md', renderAgentTask(manifest, this.analysis));
    this.files = files;
    const s = this.analysis.summary;
    const voice = this.env.voiceName ?? 'unknown';
    this.set({
      phase: 'complete',
      label: 'complete',
      message: 'Calibration complete.',
      prompt: null,
      flaggable: false,
      result: {
        fileName: `prosopon-calibration-${slug(voice)}-${new Date(this.startedAt).toISOString().slice(0, 10)}.zip`,
        lines: [`Voice: ${voice}`, `Languages: ${this.scenario.languages.map((l) => l.toUpperCase()).join(' / ')}`, `Samples: ${s.samples.valid} / ${s.samples.total} valid`, `Strongest suspected bottleneck: ${s.bottleneck ?? 'none'}`],
      },
    });
  }

  private manifest(): Record<string, unknown> {
    const env = this.host.environment();
    const b = this.host.build;
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    return {
      schemaVersion: 1,
      prosopon: { commit: b.commit, dirty: b.dirty, version: b.version, build: b.mode, builtAt: b.builtAt },
      chatgpt: {
        voice: this.env.voiceName,
        voiceMode: this.env.voiceMode,
        voiceDetection: this.env.detectedFrom,
        voiceRuntimeModel: null,
        uiLanguage: this.env.uiLanguage,
        chatgptMicMutedByWizard: this.muted,
      },
      languages: this.scenario.languages,
      scenario: this.scenario.id,
      avatar: { model: env.modelName, modelHash: this.modelHash },
      runtime: {
        emotionMode: env.emotionStatus.mode,
        emotionModel: env.emotionStatus.model,
        visemeAnalyzer: env.analyzer,
        lipSyncMode: env.lipSyncMode,
      },
      environment: {
        browser: nav?.userAgent ?? null,
        platform: (nav as (Navigator & { userAgentData?: { platform?: string } }) | undefined)?.userAgentData?.platform ?? nav?.platform ?? null,
        sampleRate: this.offscreenInfo.assistantSampleRate ?? null,
        micSampleRate: this.offscreenInfo.micSampleRate ?? null,
      },
      session: {
        startedAt: new Date(this.startedAt).toISOString(),
        endedAt: new Date(this.now()).toISOString(),
        steps: this.records.length,
        valid: this.records.filter((r) => r.valid).length,
      },
    };
  }

  /** Filled in the background at start (hashing the VRM takes a moment). */
  private modelHash: string | null = null;

  private finishTrace(): void {
    this.trace?.stop();
  }

  private frame() {
    return this.host.read();
  }

  private now(): number {
    return this.host.read().t;
  }

  private async request(req: Parameters<CalibrationHost['offscreen']>[0]): Promise<CalibrationReply> {
    const reply = await this.host.offscreen(req);
    if (!reply.ok) throw new Error(reply.error ?? `${req.type} failed`);
    return reply;
  }

  private samples(): { valid: number; total: number } {
    return { valid: this.records.filter((r) => r.valid).length, total: this.scenario.steps.length };
  }

  private updateEnvironmentView(): void {
    const env = this.host.environment();
    this.set({
      environment: {
        voice: this.env.voiceName,
        voiceMode: this.env.voiceMode,
        voiceDetection: this.env.detectedFrom,
        languages: this.scenario.languages.map((l) => l.toUpperCase()),
        microphone: env.mic.state === 'on' ? 'Ready' : env.mic.state === 'off' ? 'Off (user tests will be skipped)' : `Unavailable (${env.mic.state})`,
        audioCapture: env.offscreenConnected ? 'Ready' : 'Not capturing',
      },
    });
  }

  private initialView(): CalibrationView {
    const env = this.host.environment();
    void this.host
      .modelHash()
      .then((h) => (this.modelHash = h))
      .catch(() => undefined);
    return {
      phase: 'idle',
      label: 'idle',
      message: 'Calibration will temporarily record audio locally for analysis. Nothing is uploaded.',
      environment: {
        voice: null,
        voiceMode: null,
        voiceDetection: 'Detecting…',
        languages: this.scenario.languages.map((l) => l.toUpperCase()),
        microphone: env.mic.state === 'on' ? 'Ready' : env.mic.state === 'off' ? 'Off (will be turned on)' : `Unavailable (${env.mic.state})`,
        audioCapture: env.offscreenConnected ? 'Ready' : 'Not capturing',
      },
      progress: { done: 0, total: this.scenario.steps.length },
      prompt: null,
      action: null,
      voicePicker: null,
      samples: { valid: 0, total: this.scenario.steps.length },
      flaggable: false,
      result: null,
      error: null,
    };
  }

  private set(change: Partial<CalibrationView>): void {
    this.stateView = { ...this.stateView, ...change };
    for (const l of [...this.listeners]) l(this.stateView);
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function slug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function pacerRate(config: Record<string, unknown>): number {
  const pacer = (config.SEMANTIC_PACER_CONFIG ?? {}) as { charsPerSecond?: unknown };
  return typeof pacer.charsPerSecond === 'number' ? pacer.charsPerSecond : 14;
}
