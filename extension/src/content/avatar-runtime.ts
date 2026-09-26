import { FrameMouthSource } from '@avatar/audio/FrameMouthSource';
import { CLOSED_MOUTH, VISEMES, type MouthShape } from '@avatar/avatar/MouthShape';
import type { LipSyncFrame } from '@avatar/audio/LipSyncFrame';
import { Avatar } from '@avatar/avatar/Avatar';
import { AvatarController } from '@avatar/avatar/AvatarController';
import { AvatarIdleController } from '@avatar/avatar/AvatarIdleController';
import { AvatarLoader, disposeVRM } from '@avatar/avatar/AvatarLoader';
import { UserReactionMapper } from '@avatar/avatar/UserReactionMapper';
import { EmotionChannels } from '@avatar/avatar/EmotionChannels';
import { GestureEngine } from '@avatar/avatar/gesture/GestureEngine';
import { isGestureType, seededRandom, mathRandom, type GestureFrame } from '@avatar/avatar/gesture/Gesture';
import type { GestureConfigOverrides } from '@avatar/avatar/gesture/GestureConfig';
import { EMOTION_EXPRESSIONS } from '@avatar/avatar/EmotionExpression';
import type { EmotionMixConfig } from '@avatar/avatar/BehaviorMixer';
import { NEUTRAL_EMOTION, type EmotionChannel, type EmotionFrame } from '@avatar/audio/emotion/EmotionFrame';
import { SILENT_USER_VOICE_FRAME, type UserVoiceFrame } from '@avatar/audio/user/UserVoiceFrame';
import { MAX_FRAME_DELTA, REST_POSE } from '@avatar/config';
import { AvatarStage } from '@avatar/renderer/AvatarStage';
import { RenderLoop } from '@avatar/renderer/RenderLoop';
import { describeError, type AudioStatus, type EmotionStatus, type ExtensionTabState, type MicStatus } from '../shared/messages';
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
 *                                        └─ utterance ends ─► GestureEngine ─► (GestureSource) BehaviorMixer
 *   LipSyncFrame ─► FrameMouthSource ─► (MouthSource) BehaviorMixer      the mouth follows the assistant only
 *   EmotionFrame (user, assistant) ─► EmotionChannels ─► (EmotionSource) BehaviorMixer   face/body, never the mouth
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
  /** Nods started by GestureEngine (at user utterance ends, or while listening). */
  nods: number;
  gesture: Readonly<GestureFrame>;
  gestureCount: number;
  emotionStatus: EmotionStatus;
  /** Last EmotionFrame received per channel (as sent; the avatar follows it smoothly). */
  emotion: Record<EmotionChannel, Readonly<EmotionFrame>>;
  emotionFrames: Record<EmotionChannel, number>;
  /** Debug switches: "User emotion reactions" / "Assistant emotion expression". */
  emotionEnabled: Record<EmotionChannel, boolean>;
}

/** Development builds: the same data for DevTools (select the extension's content-script context in the console). */
export interface ProsoponDebug {
  diagnostics: Readonly<Diagnostics>;
  userVoiceFrame: Readonly<UserVoiceFrame>;
  conversationSignals: Readonly<ConversationSignals>;
  resolvedState: string;
  /** Turn a voice channel's emotion influence on/off (fades). */
  setEmotionEnabled(channel: EmotionChannel, enabled: boolean): void;
  /** Mapping bounds of the emotion layer; mutable for calibration. */
  emotionConfig: EmotionMixConfig;
  gesture: GestureEngine;
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
  pushEmotion(channel: EmotionChannel, frame: EmotionFrame): void;
  setEmotionStatus(status: EmotionStatus): void;
  setOffscreenConnected(connected: boolean): void;
  setExtensionState(state: ExtensionTabState, error?: string): void;
  readonly diagnostics: Readonly<Diagnostics>;
  dispose(): void;
}

const MODEL_PATH = 'models/avatar.vrm';
/** Diagnostics text/attributes refresh rate, Hz: DOM writes at 60 Hz would be wasted work. */
const DEBUG_RATE = 8;
/**
 * DOM event for toggling the emotion channels from a test or the page console (development builds):
 *   document.dispatchEvent(new CustomEvent('prosopon:emotion', { detail: { channel: 'user', enabled: false } }))
 */
const EMOTION_DEBUG_EVENT = 'prosopon:emotion';
/**
 * Same for gestures (development builds): seed the scheduler, override config, trigger or cancel, e.g.
 *   document.dispatchEvent(new CustomEvent('prosopon:gesture', { detail: { seed: 1, trigger: 'nod' } }))
 * detail: { seed?: number | null, config?: GestureConfigOverrides (top-level numbers/booleans), auto?, enabled?,
 * trigger?: GestureType, cancel?: true }
 */
const GESTURE_DEBUG_EVENT = 'prosopon:gesture';

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
  const emotion = new EmotionChannels();
  controller.setEmotionSource(emotion);
  const gestures = new GestureEngine();
  controller.setGestureSource(gestures);
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
    gesture: gestures.current,
    gestureCount: 0,
    emotionStatus: { model: 'off', mode: 'heuristic', inferences: 0 },
    emotion: { user: NEUTRAL_EMOTION, assistant: NEUTRAL_EMOTION },
    emotionFrames: { user: 0, assistant: 0 },
    emotionEnabled: { user: true, assistant: true },
  };
  const toggles: Partial<Record<EmotionChannel, HTMLInputElement | null>> = {};
  const setEmotionEnabled = (channel: EmotionChannel, enabled: boolean) => {
    emotion.setEnabled(channel, enabled);
    diag.emotionEnabled[channel] = enabled;
    const input = toggles[channel];
    if (input && input.checked !== enabled) input.checked = enabled;
  };
  const onEmotionDebug = (event: Event) => {
    const d = (event as CustomEvent<{ channel?: unknown; enabled?: unknown }>).detail;
    if ((d?.channel === 'user' || d?.channel === 'assistant') && typeof d.enabled === 'boolean') {
      setEmotionEnabled(d.channel, d.enabled);
    }
  };
  if (options.debug) {
    toggles.user = overlay.addDebugToggle('prosopon-user-emotion', 'User emotion reactions', true, (on) =>
      setEmotionEnabled('user', on),
    );
    toggles.assistant = overlay.addDebugToggle('prosopon-assistant-emotion', 'Assistant emotion expression', true, (on) =>
      setEmotionEnabled('assistant', on),
    );
    doc.addEventListener(EMOTION_DEBUG_EVENT, onEmotionDebug);
    doc.addEventListener(GESTURE_DEBUG_EVENT, onGestureDebug);
  }
  function onGestureDebug(event: Event): void {
    const d = (event as CustomEvent<Record<string, unknown> | null>).detail;
    if (!d || typeof d !== 'object') return;
    if (d.seed === null) gestures.setRandom(mathRandom);
    else if (typeof d.seed === 'number' && Number.isFinite(d.seed)) gestures.setRandom(seededRandom(d.seed));
    if (d.config && typeof d.config === 'object') {
      // Top-level scalars only: enough for E2E (chances, rates) without letting a page event reshape the tables.
      const cfg = gestures.config as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(d.config as GestureConfigOverrides)) {
        if (k in cfg && typeof cfg[k] === typeof v && (typeof v === 'number' || typeof v === 'boolean')) cfg[k] = v;
      }
    }
    if (typeof d.auto === 'boolean') gestures.auto = d.auto;
    if (typeof d.enabled === 'boolean') gestures.enabled = d.enabled;
    if (d.cancel === true) gestures.cancel();
    if (isGestureType(d.trigger)) gestures.trigger(d.trigger);
  }
  const resetUserVoice = () => {
    diag.userVoice = SILENT_USER_VOICE_FRAME;
    userFrameAge = Infinity;
    reaction.reset();
    resolver.setUserSpeaking(false);
    emotion.reset('user');
    diag.emotion.user = NEUTRAL_EMOTION;
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
      setEmotionEnabled,
      get emotionConfig() {
        return controller.emotionConfig;
      },
      gesture: gestures,
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
    diag.nods = gestures.nods;
    diag.gesture = gestures.current;
    diag.gestureCount = gestures.history.gestureCount;
    d.mic = diag.mic.state;
    d.userSpeaking = String(conv.signals.userSpeaking);
    d.assistantSpeaking = String(conv.signals.assistantSpeaking);
    d.resolvedState = conv.resolved;
    d.userFrames = String(diag.userFrames);
    d.userEnergy = u.energy.toFixed(3);
    d.userPitch = u.pitchHz === null ? 'null' : u.pitchHz.toFixed(1);
    d.crosstalk = String(conv.crosstalkEvents);
    d.nods = String(gestures.nods);
    const g = gestures.current;
    d.gesture = g.type ?? '';
    d.gesturePhase = g.phase;
    d.gestureCount = String(gestures.history.gestureCount);
    // Largest arm offset in the composed pose: "no large arm movement after an interruption".
    d.armOffset = maxArmOffset(controller.pose).toFixed(4);
    const r = reaction.value;
    const mix = controller.emotionMix;
    const pose = controller.pose;
    const followed = emotion.value;
    for (const ch of ['user', 'assistant'] as const) {
      const f = followed[ch];
      const prefix = ch === 'user' ? 'userEmotion' : 'assistantEmotion';
      d[`${prefix}Active`] = String(f.active);
      d[`${prefix}Arousal`] = f.arousal.toFixed(3);
      d[`${prefix}Valence`] = f.valence.toFixed(3);
      d[`${prefix}Energy`] = f.energy.toFixed(3);
      d[`${prefix}Confidence`] = f.confidence.toFixed(3);
      d[`${prefix}Mode`] = diag.emotion[ch].mode;
      d[`${prefix}Frames`] = String(diag.emotionFrames[ch]);
      d[`${prefix}Enabled`] = String(diag.emotionEnabled[ch]);
    }
    d.emotionModel = diag.emotionStatus.model;
    d.emotionInferences = String(diag.emotionStatus.inferences);
    d.emotionMixAssistant = mix.assistant.toFixed(3);
    d.emotionMixUser = mix.user.toFixed(3);
    d.emotionExpressions = EMOTION_EXPRESSIONS.map((e) => `${e}:${pose[e].toFixed(3)}`).join(' ');
    const emotionLines = (['user', 'assistant'] as const).map((ch) => {
      const f = followed[ch];
      const sign = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2);
      return [
        `${ch.padEnd(11)} ${diag.emotionEnabled[ch] ? 'ON ' : 'OFF'} · ${f.active ? 'active' : 'silent'} · ${diag.emotion[ch].mode} · ${diag.emotionFrames[ch]} frames`,
        `            val ${sign(f.valence)} (c ${f.valenceConfidence.toFixed(2)}) · aro ${f.arousal.toFixed(2)} · en ${f.energy.toFixed(2)} · ten ${f.tension.toFixed(2)}`,
        `            lift ${sign(f.pitchLift)} · var ${f.pitchVariation.toFixed(2)} · rate ${f.speechRate.toFixed(2)} · conf ${f.confidence.toFixed(2)}`,
      ].join('\n');
    });
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
        `reaction    engagement ${r.engagement.toFixed(2)} · lift ${r.pitchLift.toFixed(2)} · utterances ${r.utteranceEnds}`,
        `gesture     ${g.type ?? '—'}${g.active ? ` · ${g.phase} · ${g.intensity.toFixed(2)}` : ''} · ${gestures.history.gestureCount} total · nods ${gestures.nods} · cooldown ${gestures.cooldownRemaining.toFixed(1)} s`,
        '— Conversation',
        `signals     voice UI ${conv.signals.voiceUiActive ? 'on' : 'off'} · user ${conv.signals.userSpeaking ? 'speaking' : '—'} · assistant ${conv.signals.assistantSpeaking ? 'speaking' : '—'}`,
        `resolved    ${conv.resolved}${conv.crosstalk ? ' · CROSSTALK' : ''} · crosstalk ${conv.crosstalkEvents} · ignored ${conv.suppressedInterruptions}`,
        `— Emotion / Prosody · model ${diag.emotionStatus.model} · ${diag.emotionStatus.inferences} runs${diag.emotionStatus.error ? ` (${diag.emotionStatus.error})` : ''}`,
        ...emotionLines,
        `mix         assistant ${mix.assistant.toFixed(2)} · user ${mix.user.toFixed(2)} · ${EMOTION_EXPRESSIONS.map((e) => `${e.slice(0, 5)} ${pose[e].toFixed(2)}`).join(' ')}`,
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
    pushEmotion(channel, frame) {
      // Same rule as pushUserVoice: a user frame in flight after reactions were turned off drives nothing.
      if (channel === 'user' && diag.mic.state !== 'on') return;
      diag.emotion[channel] = frame;
      diag.emotionFrames[channel]++;
      emotion.push(channel, frame);
    },
    setEmotionStatus(status) {
      diag.emotionStatus = status;
    },
    setOffscreenConnected(connected) {
      diag.offscreenConnected = connected;
      if (!connected) {
        mouth.reset();
        diag.audioActive = false;
        resolver.setAssistantAudioActive(false);
        diag.mic = { state: 'off' };
        resetUserVoice();
        emotion.reset('assistant');
        diag.emotion.assistant = NEUTRAL_EMOTION;
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
      doc.removeEventListener(EMOTION_DEBUG_EVENT, onEmotionDebug);
      doc.removeEventListener(GESTURE_DEBUG_EVENT, onGestureDebug);
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

function maxArmOffset(pose: Readonly<Record<string, number>>): number {
  let max = 0;
  for (const k of ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm']) {
    for (const axis of ['X', 'Y', 'Z']) max = Math.max(max, Math.abs(pose[k + axis] ?? 0));
  }
  return max;
}
