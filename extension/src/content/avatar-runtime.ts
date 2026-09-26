import { FrameMouthSource } from '@avatar/audio/FrameMouthSource';
import { CLOSED_MOUTH, VISEMES, type MouthShape } from '@avatar/avatar/MouthShape';
import type { LipSyncFrame } from '@avatar/audio/LipSyncFrame';
import { Avatar } from '@avatar/avatar/Avatar';
import { AvatarController } from '@avatar/avatar/AvatarController';
import { AvatarIdleController } from '@avatar/avatar/AvatarIdleController';
import { AvatarLoader, disposeVRM } from '@avatar/avatar/AvatarLoader';
import { UserReactionMapper } from '@avatar/avatar/UserReactionMapper';
import { SILENT_USER_VOICE_FRAME, type UserVoiceFrame } from '@avatar/audio/user/UserVoiceFrame';
import { MAX_FRAME_DELTA, REST_POSE } from '@avatar/config';
import { AvatarStage } from '@avatar/renderer/AvatarStage';
import { RenderLoop } from '@avatar/renderer/RenderLoop';
import { describeError, type AudioStatus, type ExtensionTabState, type MicStatus } from '../shared/messages';
import { AvatarOverlay } from './AvatarOverlay';
import { ChatGPTAdapter, type ConversationUiAdapter, type VoiceUiSnapshot } from './ChatGPTAdapter';
import { ConversationSignalResolver, type ConversationSignals } from './ConversationSignalResolver';

/**
 * Avatar side of the content script, loaded on activation only (three.js + three-vrm stay off chatgpt.com until
 * the user enables Prosopon). Composes existing Avatar Core parts; the only new pieces are the overlay, the
 * ChatGPT adapter and the resolver that turns voice UI / assistant audio / user voice signals into conversation
 * states.
 *
 * Signals in, one decision out:
 *   ChatGPTAdapter (voice UI) ─┐
 *   LipSyncFrame.active ───────┼─► ConversationSignalResolver ─► AvatarController.setState
 *   UserVoiceFrame.speaking ───┘
 *   UserVoiceFrame ─► UserReactionMapper ─► (ReactionSource) BehaviorMixer
 *   LipSyncFrame ─► FrameMouthSource ─► (MouthSource) BehaviorMixer      the mouth follows the assistant only
 */

export interface AvatarRuntimeOptions {
  /** Resolves a packaged asset path (chrome.runtime.getURL). */
  assetUrl: (path: string) => string;
  debug: boolean;
  /** Reports failures that leave ChatGPT untouched but the avatar degraded (VRM didn't load). */
  onError?: (error: string) => void;
  adapter?: ConversationUiAdapter;
  doc?: Document;
}

export interface Diagnostics {
  extensionState: ExtensionTabState;
  extensionError: string | null;
  offscreenConnected: boolean;
  audioActive: boolean;
  lipSyncMode: string;
  analyzer: string;
  avatarLoaded: boolean | 'error';
  avatarError: string | null;
  voiceUi: boolean;
  orbHidden: boolean;
  frames: number;
  /** Frames received per second, measured over the last diagnostics interval (transport health). */
  frameHz: number;
  /** Last frame's per-viseme weights, for spotting a stuck or out-of-range analyser output. */
  visemes: Readonly<MouthShape>;
  volume: number;
  mic: MicStatus;
  userVoice: Readonly<UserVoiceFrame>;
  userFrames: number;
  conversation: Readonly<ConversationSignals>;
  resolvedState: string;
  crosstalkEvents: number;
  suppressedInterruptions: number;
  nods: number;
}

/** Development builds: the same data for DevTools (select the extension's content-script context in the console). */
export interface ProsoponDebug {
  diagnostics: Readonly<Diagnostics>;
  userVoiceFrame: Readonly<UserVoiceFrame>;
  conversationSignals: Readonly<ConversationSignals>;
  resolvedState: string;
}

declare global {
  interface Window {
    __PROSOPON_DEBUG__?: ProsoponDebug;
  }
}

export interface AvatarRuntimeHandle {
  pushFrame(frame: LipSyncFrame): void;
  setAudioStatus(status: AudioStatus): void;
  pushUserVoice(frame: UserVoiceFrame): void;
  setMicStatus(status: MicStatus): void;
  setOffscreenConnected(connected: boolean): void;
  setExtensionState(state: ExtensionTabState, error?: string): void;
  readonly diagnostics: Readonly<Diagnostics>;
  dispose(): void;
}

const MODEL_PATH = 'models/avatar.vrm';
/** Diagnostics text/attributes refresh rate, Hz: DOM writes at 60 Hz would be wasted work. */
const DEBUG_RATE = 8;

export function mountAvatar(options: AvatarRuntimeOptions): AvatarRuntimeHandle {
  const doc = options.doc ?? document;
  const adapter = options.adapter ?? new ChatGPTAdapter(doc);
  const overlay = new AvatarOverlay(doc, { debug: options.debug });
  const stage = new AvatarStage(overlay.stageContainer);

  // The controller exists before the VRM: states from the resolver set while it loads are kept.
  const controller = new AvatarController({ idle: new AvatarIdleController() });
  const mouth = new FrameMouthSource();
  controller.setMouthSource(mouth);
  const reaction = new UserReactionMapper();
  controller.setReactionSource(reaction);
  const resolver = new ConversationSignalResolver(controller);
  /** Seconds since the last user voice frame; the user is not speaking once frames stop. */
  let userFrameAge = Infinity;
  const USER_FRAME_STALE = 0.5;

  const diag: Diagnostics = {
    extensionState: 'enabled',
    extensionError: null,
    offscreenConnected: false,
    audioActive: false,
    lipSyncMode: '—',
    analyzer: '—',
    avatarLoaded: false,
    avatarError: null,
    voiceUi: false,
    orbHidden: false,
    frames: 0,
    frameHz: 0,
    visemes: CLOSED_MOUTH,
    volume: 0,
    mic: { state: 'off' },
    userVoice: SILENT_USER_VOICE_FRAME,
    userFrames: 0,
    conversation: resolver.signals,
    resolvedState: resolver.resolved,
    crosstalkEvents: 0,
    suppressedInterruptions: 0,
    nods: 0,
  };
  const resetUserVoice = () => {
    diag.userVoice = SILENT_USER_VOICE_FRAME;
    userFrameAge = Infinity;
    reaction.reset();
    resolver.setUserSpeaking(false);
  };
  if (options.debug) {
    window.__PROSOPON_DEBUG__ = {
      get diagnostics() {
        return diag;
      },
      get userVoiceFrame() {
        return diag.userVoice;
      },
      get conversationSignals() {
        return resolver.signals;
      },
      get resolvedState() {
        return resolver.resolved;
      },
    };
  }
  let mouthPeak = 0;
  // Frame-rate window: frames counted at the previous diagnostics render, and when that was.
  let rateMark = { frames: 0, time: 0 };

  let restoreOrb: (() => void) | null = null;
  const onVoiceUi = (ui: VoiceUiSnapshot) => {
    restoreOrb?.();
    restoreOrb = null;
    // Worst case (selectors outdated): no orb found, ChatGPT's orb stays visible next to the avatar.
    if (ui.orb) restoreOrb = adapter.hideVisually(ui.orb);
    overlay.setAnchor(ui.orb ?? ui.container);
    resolver.setVoiceUiActive(ui.active);
    diag.voiceUi = ui.active;
    diag.orbHidden = restoreOrb !== null;
  };
  const stopObserving = adapter.observe(onVoiceUi);

  let sinceDebug = Infinity;
  const loop = new RenderLoop((delta) => {
    userFrameAge += delta;
    if (userFrameAge > USER_FRAME_STALE && resolver.signals.userSpeaking) resolver.setUserSpeaking(false);
    resolver.update(delta);
    // The mic hears the speakers when echo cancellation falls short: no reactions while the assistant talks.
    reaction.setSuppressed(resolver.signals.assistantSpeaking);
    controller.update(delta);
    stage.render();
    const m = mouth.value;
    const open = Math.max(m.aa, m.ih, m.ou, m.ee, m.oh);
    if (open > mouthPeak) mouthPeak = open;
    sinceDebug += delta;
    if (sinceDebug >= 1 / DEBUG_RATE) {
      sinceDebug = 0;
      renderDiagnostics(open);
    }
  }, MAX_FRAME_DELTA);
  loop.start();

  let vrm: Awaited<ReturnType<AvatarLoader['loadVRM']>> | null = null;
  let disposed = false;
  void (async () => {
    try {
      const loaded = await new AvatarLoader().loadVRM(options.assetUrl(MODEL_PATH));
      if (disposed) {
        disposeVRM(loaded);
        return;
      }
      vrm = loaded;
      const avatar = new Avatar(loaded, { restPose: REST_POSE });
      controller.attachAvatar(avatar);
      controller.update(0);
      stage.setAvatar(avatar);
      diag.avatarLoaded = true;
    } catch (error) {
      if (disposed) return;
      diag.avatarLoaded = 'error';
      diag.avatarError = describeError(error);
      console.warn('[prosopon] avatar failed to load; ChatGPT is unaffected:', error);
      options.onError?.(`avatar failed to load: ${diag.avatarError}`);
    }
  })();

  function renderDiagnostics(open: number): void {
    if (!options.debug) return;
    const now = performance.now();
    if (rateMark.time > 0) {
      const seconds = (now - rateMark.time) / 1000;
      if (seconds > 0) diag.frameHz = (diag.frames - rateMark.frames) / seconds;
    }
    rateMark = { frames: diag.frames, time: now };
    // Development builds only: attributes for E2E, text for humans. Nothing of this ships to end users.
    const d = overlay.host.dataset;
    d.extensionState = diag.extensionState;
    d.avatarLoaded = String(diag.avatarLoaded);
    d.voiceUi = String(diag.voiceUi);
    d.orbHidden = String(diag.orbHidden);
    d.offscreen = String(diag.offscreenConnected);
    d.audioActive = String(diag.audioActive);
    d.lipSyncMode = diag.lipSyncMode;
    d.frames = String(diag.frames);
    d.mouth = open.toFixed(3);
    d.frameHz = diag.frameHz.toFixed(1);
    d.volume = diag.volume.toFixed(3);
    d.visemes = VISEMES.map((v) => `${v}:${diag.visemes[v].toFixed(2)}`).join(' ');
    d.mouthPeak = mouthPeak.toFixed(3);
    d.avatarState = controller.getState();
    const u = diag.userVoice;
    const conv = resolver.diagnostics;
    diag.conversation = conv.signals;
    diag.resolvedState = conv.resolved;
    diag.crosstalkEvents = conv.crosstalkEvents;
    diag.suppressedInterruptions = conv.suppressedInterruptions;
    diag.nods = reaction.nods;
    d.mic = diag.mic.state;
    d.userSpeaking = String(conv.signals.userSpeaking);
    d.assistantSpeaking = String(conv.signals.assistantSpeaking);
    d.resolvedState = conv.resolved;
    d.userFrames = String(diag.userFrames);
    d.userEnergy = u.energy.toFixed(3);
    d.userPitch = u.pitchHz === null ? 'null' : u.pitchHz.toFixed(1);
    d.crosstalk = String(conv.crosstalkEvents);
    d.nods = String(reaction.nods);
    const r = reaction.value;
    overlay.setDebugText(
      [
        `extension   ${diag.extensionState}${diag.extensionError ? ` (${diag.extensionError})` : ''}`,
        `tabCapture  ${diag.extensionState === 'enabled' ? 'capturing' : 'off'}`,
        `offscreen   ${diag.offscreenConnected ? 'connected' : 'disconnected'} · ${diag.frames} frames · ${diag.frameHz.toFixed(0)} Hz`,
        `audio       ${diag.audioActive ? 'active' : 'silent'} · mouth ${open.toFixed(2)}`,
        `lip sync    ${diag.lipSyncMode} · ${diag.analyzer} · vol ${diag.volume.toFixed(2)}`,
      `visemes     ${VISEMES.map((v) => `${v} ${diag.visemes[v].toFixed(2)}`).join('  ')}`,
        `avatar      ${diag.avatarLoaded === true ? 'loaded' : diag.avatarLoaded === 'error' ? `error: ${diag.avatarError}` : 'loading'} · ${controller.getState()}`,
        `voice UI    ${diag.voiceUi ? 'detected' : 'not found'}${diag.orbHidden ? ' · orb hidden' : ''}`,
        '— User Voice',
        `mic         ${diag.mic.state === 'off' ? 'Microphone reactions: OFF' : `Microphone reactions: ON · ${diag.mic.state}`}${diag.mic.error ? ` (${diag.mic.error})` : ''}`,
        `speaking    ${u.speaking ? 'yes' : 'no'} · segment ${u.segmentDuration.toFixed(2)} s · ${diag.userFrames} frames`,
        `level       ${u.rmsDb.toFixed(1)} dBFS · floor ${u.noiseFloorDb.toFixed(1)} · energy ${u.energy.toFixed(2)}`,
        `pitch       ${u.pitchHz === null ? '—' : `${u.pitchHz.toFixed(0)} Hz`} · conf ${u.pitchConfidence.toFixed(2)} · rel ${u.relativePitch.toFixed(1)} st · var ${u.pitchVariation.toFixed(1)} st`,
        `reaction    engagement ${r.engagement.toFixed(2)} · lift ${r.pitchLift.toFixed(2)} · nods ${reaction.nods}`,
        '— Conversation',
        `signals     voice UI ${conv.signals.voiceUiActive ? 'on' : 'off'} · user ${conv.signals.userSpeaking ? 'speaking' : '—'} · assistant ${conv.signals.assistantSpeaking ? 'speaking' : '—'}`,
        `resolved    ${conv.resolved}${conv.crosstalk ? ' · CROSSTALK' : ''} · crosstalk ${conv.crosstalkEvents} · ignored ${conv.suppressedInterruptions}`,
      ].join('\n'),
    );
  }

  return {
    diagnostics: diag,
    pushFrame(frame) {
      diag.frames++;
      diag.visemes = frame.visemes;
      diag.volume = frame.volume;
      mouth.push(frame);
      if (frame.active !== diag.audioActive) {
        diag.audioActive = frame.active;
        resolver.setAssistantAudioActive(frame.active);
      }
    },
    setAudioStatus(status) {
      diag.lipSyncMode = status.mode;
      diag.analyzer = status.analyzer;
    },
    pushUserVoice(frame) {
      // Frames can arrive after the user turned reactions off (in flight): only an 'on' mic drives anything.
      if (diag.mic.state !== 'on') return;
      diag.userFrames++;
      diag.userVoice = frame;
      userFrameAge = 0;
      reaction.push(frame);
      resolver.setUserSpeaking(frame.speaking, frame.segmentDuration);
    },
    setMicStatus(status) {
      diag.mic = status;
      if (status.state !== 'on') resetUserVoice();
    },
    setOffscreenConnected(connected) {
      diag.offscreenConnected = connected;
      if (!connected) {
        mouth.reset();
        diag.audioActive = false;
        resolver.setAssistantAudioActive(false);
        diag.mic = { state: 'off' };
        resetUserVoice();
      }
    },
    setExtensionState(state, error) {
      diag.extensionState = state;
      diag.extensionError = error ?? null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      loop.stop();
      stopObserving();
      if (window.__PROSOPON_DEBUG__?.diagnostics === diag) delete window.__PROSOPON_DEBUG__;
      restoreOrb?.();
      restoreOrb = null;
      controller.dispose();
      stage.dispose();
      if (vrm) disposeVRM(vrm);
      vrm = null;
      overlay.dispose();
    },
  };
}
