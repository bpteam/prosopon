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
import { GESTURE_TYPES } from '@avatar/avatar/gesture/Gesture';
import {
  describeError,
  type AudioStatus,
  type DevTelemetry,
  type EmotionStatus,
  type ExtensionPayload,
  type ExtensionTabState,
  type MicStatus,
} from '../shared/messages';
import {
  BASE_BOX_HEIGHT,
  DEFAULT_DEV_WINDOWS,
  DEFAULT_VIEW_SETTINGS,
  PersistedValue,
  STORAGE_KEYS,
  chromeSettingsArea,
  cloneView,
  isCameraModified,
  sanitizeDevWindows,
  sanitizeDeveloperMode,
  sanitizeViewSettings,
  type AvatarViewSettingsV1,
  type SettingsArea,
} from '../shared/settings';
import { UiLayer } from '../ui/shared/UiLayer';
import { PLACEMENT_CSS, PlacementHandle } from '../ui/placement/PlacementHandle';
import type { DevBridge, DevSample } from '../ui/dev/DevBridge';
import { DevModeSwitch } from './DevModeSwitch';
import { ManualControls } from '../ui/dev/ManualControls';
import { AvatarOverlay } from './AvatarOverlay';
import { ChatGPTAdapter, type ChatGPTAdapterDebugSnapshot, type ConversationUiAdapter, type VoiceUiSnapshot } from './ChatGPTAdapter';
import { ConversationSignalResolver, type ConversationSignals } from './ConversationSignalResolver';
import { SemanticFeed } from './SemanticFeed';

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
 *   ChatGPTAdapter (reply text) ─► SemanticFeed (analyser + text clock) ─► GestureEngine.pushSemantic
 */

export interface AvatarRuntimeOptions {
  /** Resolves a packaged asset path (chrome.runtime.getURL). */
  assetUrl: (path: string) => string;
  debug: boolean;
  /** Reports failures that leave ChatGPT untouched but the avatar degraded (VRM didn't load). */
  onError?: (error: string) => void;
  adapter?: ConversationUiAdapter;
  doc?: Document;
  /** Persistent UI settings (chrome.storage.local by default). */
  settingsArea?: SettingsArea;
  /** Sends to the offscreen document over the frame port (dev:subscribe). No-op while disconnected. */
  sendToOffscreen?: (payload: ExtensionPayload) => void;
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
  /** Semantic layer (reply text → intents); null if it failed to start. */
  semantic: SemanticFeed | null;
  /** ChatGPT DOM capture state; null when a test/custom integration adapter is in use. */
  chatgpt: ChatGPTAdapterDebugSnapshot | null;
  /** Camera API (presets, corrections, presentation). */
  stage: AvatarStage;
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
  /** "Move avatar" (popup, quick toolbar): drag the avatar's box into place. */
  setPlacementMode(active: boolean): void;
  /** Offscreen developer telemetry (only arrives while Developer Mode subscribed to it). */
  pushTelemetry(telemetry: DevTelemetry): void;
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
/**
 * Semantic layer (development builds), e.g.
 *   document.dispatchEvent(new CustomEvent('prosopon:semantic', { detail: { pacing: false, probabilityScale: 3 } }))
 * detail: { enabled?: boolean, pacing?: boolean, probabilityScale?: number }
 */
const SEMANTIC_DEBUG_EVENT = 'prosopon:semantic';

export function mountAvatar(options: AvatarRuntimeOptions): AvatarRuntimeHandle {
  const doc = options.doc ?? document;
  const view = doc.defaultView ?? window;
  const adapter = options.adapter ?? new ChatGPTAdapter(doc);
  const overlay = new AvatarOverlay(doc);
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
  // Semantic performance: the reply's text shapes gestures. Optional: if it cannot start, nothing else changes.
  let semantic: SemanticFeed | null = null;
  try {
    semantic = new SemanticFeed({
      source: adapter,
      sink: (intent) => gestures.pushSemantic(intent),
      onError: (error) => console.warn('[prosopon] semantic layer stopped; the avatar continues without it:', error),
    });
  } catch (error) {
    console.warn('[prosopon] semantic layer unavailable:', error);
  }
  /** Seconds since the last user voice frame; the user is not speaking once frames stop. */
  let userFrameAge = Infinity;
  const USER_FRAME_STALE = 0.5;
  /** performance.now() of the last LipSyncFrame (frame age in the Dev UI). */
  let lastFrameAt = -Infinity;

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
  // Manual (debug) layer and the emotion switches; the only manual writer, used by Developer Mode.
  const manual = new ManualControls(controller, (channel, enabled) => emotion.setEnabled(channel, enabled));
  const setEmotionEnabled = (channel: EmotionChannel, enabled: boolean) => {
    manual.setEmotionEnabled(channel, enabled);
    diag.emotionEnabled[channel] = enabled;
  };
  const onEmotionDebug = (event: Event) => {
    const d = (event as CustomEvent<{ channel?: unknown; enabled?: unknown }>).detail;
    if ((d?.channel === 'user' || d?.channel === 'assistant') && typeof d.enabled === 'boolean') {
      setEmotionEnabled(d.channel, d.enabled);
    }
  };
  if (options.debug) {
    doc.addEventListener(EMOTION_DEBUG_EVENT, onEmotionDebug);
    doc.addEventListener(GESTURE_DEBUG_EVENT, onGestureDebug);
    doc.addEventListener(SEMANTIC_DEBUG_EVENT, onSemanticDebug);
  }
  function setSemanticEnabled(on: boolean): void {
    semantic?.setEnabled(on);
    gestures.semantic.config.enabled = on && semantic !== null;
  }
  function onSemanticDebug(event: Event): void {
    const d = (event as CustomEvent<Record<string, unknown> | null>).detail;
    if (!d || typeof d !== 'object') return;
    if (typeof d.enabled === 'boolean') setSemanticEnabled(d.enabled);
    if (typeof d.pacing === 'boolean') semantic?.setPacing(d.pacing);
    if (typeof d.probabilityScale === 'number' && Number.isFinite(d.probabilityScale)) {
      gestures.semantic.config.probabilityScale = Math.max(0, d.probabilityScale);
    }
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
      semantic,
      get chatgpt() {
        return adapter instanceof ChatGPTAdapter ? adapter.debugSnapshot() : null;
      },
      stage,
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
    resolver.setVoiceUiActive(ui.active);
    diag.voiceUi = ui.active;
    diag.orbHidden = restoreOrb !== null;
  };
  const stopObserving = adapter.observe(onVoiceUi);

  // --- Layout: camera preset + corrections, placement, size (persisted in chrome.storage.local) ----------------

  const area = options.settingsArea ?? chromeSettingsArea();
  const viewSetting = new PersistedValue(area, STORAGE_KEYS.view, sanitizeViewSettings, cloneView(DEFAULT_VIEW_SETTINGS));
  const devModeSetting = new PersistedValue(area, STORAGE_KEYS.developerMode, sanitizeDeveloperMode, false);
  const windowsSetting = new PersistedValue(area, STORAGE_KEYS.devWindows, sanitizeDevWindows, sanitizeDevWindows(DEFAULT_DEV_WINDOWS));
  const viewListeners = new Set<() => void>();

  function applyView(v: Readonly<AvatarViewSettingsV1>): void {
    const { preset, ...adjust } = v.camera;
    stage.setCameraPreset(preset);
    stage.setCameraAdjust(adjust);
    stage.setPresentation({ x: v.placement.x, y: v.placement.y, height: v.placement.scale * BASE_BOX_HEIGHT });
    const d = overlay.host.dataset;
    d.cameraPreset = preset;
    d.cameraModified = String(isCameraModified(v.camera));
    d.placementX = v.placement.x.toFixed(3);
    d.placementY = v.placement.y.toFixed(3);
    d.avatarScale = v.placement.scale.toFixed(2);
    for (const l of [...viewListeners]) l();
  }
  function updateView(
    change: { camera?: Partial<AvatarViewSettingsV1['camera']>; placement?: Partial<AvatarViewSettingsV1['placement']> },
    persist: 'debounced' | 'now' = 'debounced',
  ): void {
    const cur = viewSetting.value;
    const next = sanitizeViewSettings({
      version: 1,
      camera: { ...cur.camera, ...change.camera },
      placement: { ...cur.placement, ...change.placement },
    });
    viewSetting.set(next, persist);
    applyView(next);
  }
  applyView(viewSetting.value);
  const offView = viewSetting.onChange(applyView); // another tab or the popup

  // --- In-page UI root (placement handle, developer windows): created on first use -----------------------------

  let layer: UiLayer | null = null;
  const ensureLayer = (): UiLayer => (layer ??= new UiLayer(doc));
  const releaseLayer = () => {
    if (layer && !placement && !devMode.on) {
      layer.dispose();
      layer = null;
    }
  };

  let placement: { handle: PlacementHandle; stop: () => void } | null = null;
  function setPlacementMode(active: boolean): void {
    if (active === !!placement || disposed) return;
    if (!active) {
      placement!.stop();
      placement = null;
      void viewSetting.flush();
      releaseLayer();
      devMode.handle?.refresh();
      return;
    }
    const l = ensureLayer();
    l.addStyle('placement', PLACEMENT_CSS);
    const handle = new PlacementHandle(doc, {
      viewport: () => l.viewport,
      onChange: (change, final) => updateView({ placement: change }, final ? 'now' : 'debounced'),
      onDone: () => setPlacementMode(false),
    });
    l.root.append(handle.el);
    if (stage.framing) handle.setBox(stage.framing.box);
    const offFraming = stage.onFraming((f) => handle.setBox(f.box));
    placement = {
      handle,
      stop: () => {
        offFraming();
        handle.dispose();
      },
    };
    handle.el.focus({ preventScroll: true });
    devMode.handle?.refresh();
  }

  // --- Developer Mode: diagnostics and controls, loaded only while on -----------------------------------------

  let telemetry: DevTelemetry | null = null;
  let telemetryWanted = false;
  let transparent = true;

  const sendTelemetryRequest = () => options.sendToOffscreen?.({ type: 'dev:subscribe', enabled: telemetryWanted });

  const bridge: DevBridge = {
    doc,
    get layer() {
      return ensureLayer();
    },
    sample: () => sampleDiagnostics(),
    windows: {
      get value() {
        return windowsSetting.value;
      },
      set: (value, persist) => windowsSetting.set(value, persist),
    },
    view: {
      get value() {
        return viewSetting.value;
      },
      update: updateView,
      resetCamera: () => updateView({ camera: { distanceOffset: 0, targetYOffset: 0, yaw: 0, pitch: 0 } }, 'now'),
      onChange(listener) {
        viewListeners.add(listener);
        return () => void viewListeners.delete(listener);
      },
    },
    setPlacementMode,
    get placementMode() {
      return !!placement;
    },
    setDeveloperMode: (enabled) => {
      devModeSetting.set(enabled, 'now');
      setDevMode(enabled);
    },
    camera: {
      get preset() {
        return stage.cameraPreset;
      },
      get adjust() {
        return stage.cameraAdjust;
      },
    },
    scene: {
      helpers: () => stage.sceneHelpers,
      setHelpers: (h) => stage.setSceneHelpers(h),
      get transparent() {
        return transparent;
      },
      setTransparent(on) {
        transparent = on;
        stage.setBackground(on ? null : '#080b0f');
      },
    },
    avatar: {
      listExpressions: () => controller.listExpressions(),
      hasExpression: (name) => controller.hasExpression(name),
      setExpressionPreview: (active) => manual.setExpressionPreview(active),
      get expressionPreview() {
        return manual.expressionPreview;
      },
      previewExpression: (name, value) => manual.previewExpression(name, value),
      clearExpressions: () => manual.clearExpressions(),
      setPoseOffsets: (o) => manual.setPoseOffsets(o),
      get poseOffsets() {
        return manual.poseOffsets;
      },
      resetPoseOffsets: () => manual.resetPoseOffsets(),
    },
    emotion: { setEnabled: setEmotionEnabled },
    gestures: {
      types: GESTURE_TYPES,
      trigger: (type) => gestures.trigger(type),
      cancel: () => gestures.cancel(),
      setAuto: (on) => (gestures.auto = on),
      setEnabled: (on) => (gestures.enabled = on),
    },
    semantic: {
      setEnabled: setSemanticEnabled,
      setPacing: (on) => semantic?.setPacing(on),
      setProbabilityScale: (v) => (gestures.semantic.config.probabilityScale = Math.max(0, v)),
    },
    setTelemetry(enabled) {
      telemetryWanted = enabled;
      if (!enabled) telemetry = null;
      sendTelemetryRequest();
    },
  };

  overlay.host.dataset.devMode = 'false';
  const devMode = new DevModeSwitch(
    // A separate chunk: none of the developer UI is parsed unless Developer Mode is on.
    () => import('../ui/dev/DevTools').then((m) => () => m.mountDevTools(bridge)),
    {
      onEnable: () => (overlay.host.dataset.devMode = 'true'),
      onDisable: () => {
        // Leaving Developer Mode also ends a preview and the manual pose: the procedural layer owns the avatar again.
        manual.release();
        stage.setSceneHelpers({ grid: false, skeleton: false, axes: false });
        bridge.scene.setTransparent(true);
        if (telemetryWanted) bridge.setTelemetry(false);
        overlay.host.dataset.devMode = 'false';
        releaseLayer();
      },
      onError: (error) => console.warn('[prosopon] developer tools failed to load:', error),
    },
  );
  const setDevMode = (on: boolean) => {
    if (!disposed) devMode.set(on);
  };
  const offDevMode = devModeSetting.onChange(setDevMode);

  function sampleDiagnostics(): DevSample {
    const conv = resolver.diagnostics;
    const followed = emotion.value;
    const g = gestures.current;
    const r = stage.renderStats;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const channel = (ch: EmotionChannel) => ({
      ...diag.emotion[ch],
      ...followed[ch],
      mode: diag.emotion[ch].mode,
      active: followed[ch].active,
      enabled: diag.emotionEnabled[ch],
    });
    return {
      time: performance.now(),
      avatarLoaded: diag.avatarLoaded,
      voiceUi: diag.voiceUi,
      offscreenConnected: diag.offscreenConnected,
      state: conv.resolved,
      signals: {
        voiceUi: conv.signals.voiceUiActive,
        userSpeaking: conv.signals.userSpeaking,
        assistantSpeaking: conv.signals.assistantSpeaking,
        crosstalk: conv.crosstalk,
      },
      lipSync: {
        mode: diag.lipSyncMode,
        analyzer: diag.analyzer,
        active: diag.audioActive,
        volume: diag.volume,
        visemes: { ...diag.visemes },
        frameHz: diag.frameHz,
        frameAgeMs: performance.now() - lastFrameAt,
      },
      mic: diag.mic,
      userVoice: diag.userVoice,
      emotion: { user: channel('user'), assistant: channel('assistant') },
      emotionStatus: diag.emotionStatus,
      behavior: controller.getBehaviorSnapshot(),
      gesture: {
        type: g.type,
        phase: g.phase,
        progress: g.progress,
        intensity: g.intensity,
        cooldown: gestures.cooldownRemaining,
        count: gestures.history.gestureCount,
        nods: gestures.nods,
        auto: gestures.auto,
        enabled: gestures.enabled,
      },
      render: {
        fps: 0,
        frameMs: 0,
        drawCalls: r.drawCalls,
        triangles: r.triangles,
        pixelRatio: r.pixelRatio,
        memoryMb: memory ? memory.usedJSHeapSize / 1048576 : null,
      },
      semantic: semanticSample(),
      telemetry,
    };
  }

  function semanticSample(): DevSample['semantic'] {
    const st = gestures.semanticStatus;
    const feed = semantic?.status;
    const decisions = new Map(st.decisions.map((d) => [d.segmentId, d] as const));
    return {
      available: semantic !== null,
      enabled: (feed?.enabled ?? false) && st.enabled,
      error: feed?.error ?? st.error,
      pacing: feed?.pacing ?? false,
      mode: feed?.pacer.mode ?? 'immediate',
      spokenChars: feed?.pacer.spokenChars ?? 0,
      pending: (feed?.pacer.pending ?? 0) + st.queued,
      dropped: feed?.pacer.dropped ?? 0,
      messages: feed?.messages ?? 0,
      segments: feed?.segments ?? 0,
      cues: feed?.cues ?? 0,
      intents: st.intents,
      accepted: st.accepted,
      probabilityScale: gestures.semantic.config.probabilityScale,
      busyMs: feed?.busyMs ?? 0,
      entries: (feed?.recent ?? []).map((i) => {
        const d = decisions.get(i.segmentId);
        return {
          segmentId: i.segmentId,
          text: i.text,
          early: i.early,
          cues: i.cues.map((c) => ({ type: c.type, role: c.role, confidence: c.confidence, strength: c.strength })),
          matches: i.matches.map((m) => ({ kind: m.kind, marker: m.marker, locale: m.locale, tier: m.tier, confidence: m.confidence })),
          modifiers: [...i.modifiers],
          decision: d
            ? { accepted: d.accepted, gesture: d.gesture, reason: d.reason, probability: d.probability, cue: d.cue, intensity: d.intensity }
            : null,
        };
      }),
    };
  }

  const onViewportResize = () => devMode.handle?.refresh();
  view.addEventListener('resize', onViewportResize);

  let disposed = false;
  void Promise.all([viewSetting.load(), devModeSetting.load(), windowsSetting.load()]).then(() => {
    if (disposed) return;
    applyView(viewSetting.value);
    setDevMode(devModeSetting.value);
  });

  let sinceDebug = Infinity;
  const loop = new RenderLoop((delta) => {
    userFrameAge += delta;
    if (userFrameAge > USER_FRAME_STALE && resolver.signals.userSpeaking) resolver.setUserSpeaking(false);
    resolver.update(delta);
    // The mic hears the speakers when echo cancellation falls short: no reactions while the assistant talks.
    reaction.setSuppressed(resolver.signals.assistantSpeaking);
    semantic?.update(delta, resolver.signals.voiceUiActive, resolver.signals.assistantSpeaking);
    controller.update(delta);
    stage.render();
    devMode.handle?.frame(delta);
    const m = mouth.value;
    const open = Math.max(m.aa, m.ih, m.ou, m.ee, m.oh);
    if (open > mouthPeak) mouthPeak = open;
    // Wall clock, not the loop's clamped delta: at a low frame rate the clamped delta lags real time and the
    // transport rate would read 0 for seconds.
    if (performance.now() - rateMark.time >= 1000) measureFrameRate();
    sinceDebug += delta;
    if (sinceDebug >= 1 / DEBUG_RATE) {
      sinceDebug = 0;
      renderDiagnostics(open);
    }
  }, MAX_FRAME_DELTA);
  loop.start();

  let vrm: Awaited<ReturnType<AvatarLoader['loadVRM']>> | null = null;
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
      overlay.host.dataset.avatarLoaded = 'true';
    } catch (error) {
      if (disposed) return;
      diag.avatarLoaded = 'error';
      diag.avatarError = describeError(error);
      console.warn('[prosopon] avatar failed to load; ChatGPT is unaffected:', error);
      options.onError?.(`avatar failed to load: ${diag.avatarError}`);
    }
  })();

  /** Transport health for the diagnostics: LipSyncFrames received per second. */
  function measureFrameRate(): void {
    const now = performance.now();
    if (rateMark.time > 0) {
      const seconds = (now - rateMark.time) / 1000;
      if (seconds > 0) diag.frameHz = (diag.frames - rateMark.frames) / seconds;
    }
    rateMark = { frames: diag.frames, time: now };
  }

  function renderDiagnostics(open: number): void {
    if (!options.debug) return;
    // Development builds only: attributes for E2E. Nothing of this ships to end users.
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
    const sem = gestures.semanticStatus;
    const feed = semantic?.status;
    d.semanticEnabled = String((feed?.enabled ?? false) && sem.enabled);
    d.semanticMode = feed?.pacer.mode ?? 'off';
    d.semanticCues = String(feed?.cues ?? 0);
    d.semanticIntents = String(sem.intents);
    d.semanticAccepted = String(sem.accepted);
    d.semanticLast = feed?.recent.at(-1)?.cues.map((c) => c.type).join(' ') ?? '';
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
  }

  return {
    diagnostics: diag,
    pushFrame(frame) {
      diag.frames++;
      diag.visemes = frame.visemes;
      diag.volume = frame.volume;
      lastFrameAt = performance.now();
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
      if (connected) {
        // A new port: repeat the telemetry subscription (the offscreen document forgot the old port).
        if (telemetryWanted) sendTelemetryRequest();
        return;
      }
      telemetry = null;
      mouth.reset();
      diag.audioActive = false;
      resolver.setAssistantAudioActive(false);
      diag.mic = { state: 'off' };
      resetUserVoice();
      emotion.reset('assistant');
      diag.emotion.assistant = NEUTRAL_EMOTION;
    },
    setExtensionState(state, error) {
      diag.extensionState = state;
      diag.extensionError = error ?? null;
    },
    setPlacementMode,
    pushTelemetry(t) {
      if (!telemetryWanted) return;
      telemetry = t;
      devMode.handle?.pushTelemetry(t);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      loop.stop();
      stopObserving();
      view.removeEventListener('resize', onViewportResize);
      doc.removeEventListener(EMOTION_DEBUG_EVENT, onEmotionDebug);
      doc.removeEventListener(GESTURE_DEBUG_EVENT, onGestureDebug);
      doc.removeEventListener(SEMANTIC_DEBUG_EVENT, onSemanticDebug);
      semantic?.dispose();
      if (window.__PROSOPON_DEBUG__?.diagnostics === diag) delete window.__PROSOPON_DEBUG__;
      restoreOrb?.();
      restoreOrb = null;
      if (placement) {
        placement.stop();
        placement = null;
      }
      devMode.dispose();
      layer?.dispose();
      layer = null;
      offView();
      offDevMode();
      viewListeners.clear();
      viewSetting.dispose();
      devModeSetting.dispose();
      windowsSetting.dispose();
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
