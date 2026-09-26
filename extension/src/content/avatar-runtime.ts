import { FrameMouthSource } from '@avatar/audio/FrameMouthSource';
import type { LipSyncFrame } from '@avatar/audio/LipSyncFrame';
import { Avatar } from '@avatar/avatar/Avatar';
import { AvatarController } from '@avatar/avatar/AvatarController';
import { AvatarIdleController } from '@avatar/avatar/AvatarIdleController';
import { AvatarLoader, disposeVRM } from '@avatar/avatar/AvatarLoader';
import { MAX_FRAME_DELTA, REST_POSE } from '@avatar/config';
import { AvatarStage } from '@avatar/renderer/AvatarStage';
import { RenderLoop } from '@avatar/renderer/RenderLoop';
import { describeError, type AudioStatus, type ExtensionTabState } from '../shared/messages';
import { AvatarOverlay } from './AvatarOverlay';
import { ChatGPTAdapter, type ConversationUiAdapter, type VoiceUiSnapshot } from './ChatGPTAdapter';
import { VoiceStatePresenter } from './VoiceStatePresenter';

/**
 * Avatar side of the content script, loaded on activation only (three.js + three-vrm stay off chatgpt.com until
 * the user enables Prosopon). Composes existing Avatar Core parts; the only new pieces are the overlay, the
 * ChatGPT adapter and the presenter that turns voice UI/audio activity into conversation states.
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
}

export interface AvatarRuntimeHandle {
  pushFrame(frame: LipSyncFrame): void;
  setAudioStatus(status: AudioStatus): void;
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

  // The controller exists before the VRM: states from the presenter set while it loads are kept.
  const controller = new AvatarController({ idle: new AvatarIdleController() });
  const mouth = new FrameMouthSource();
  controller.setMouthSource(mouth);
  const presenter = new VoiceStatePresenter(controller);

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
  };
  let mouthPeak = 0;

  let restoreOrb: (() => void) | null = null;
  const onVoiceUi = (ui: VoiceUiSnapshot) => {
    restoreOrb?.();
    restoreOrb = null;
    // Worst case (selectors outdated): no orb found, ChatGPT's orb stays visible next to the avatar.
    if (ui.orb) restoreOrb = adapter.hideVisually(ui.orb);
    overlay.setAnchor(ui.orb ?? ui.container);
    presenter.setVoiceUiActive(ui.active);
    diag.voiceUi = ui.active;
    diag.orbHidden = restoreOrb !== null;
  };
  const stopObserving = adapter.observe(onVoiceUi);

  let sinceDebug = Infinity;
  const loop = new RenderLoop((delta) => {
    presenter.update(delta);
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
    d.mouthPeak = mouthPeak.toFixed(3);
    d.avatarState = controller.getState();
    overlay.setDebugText(
      [
        `extension   ${diag.extensionState}${diag.extensionError ? ` (${diag.extensionError})` : ''}`,
        `tabCapture  ${diag.extensionState === 'enabled' ? 'capturing' : 'off'}`,
        `offscreen   ${diag.offscreenConnected ? 'connected' : 'disconnected'} · ${diag.frames} frames`,
        `audio       ${diag.audioActive ? 'active' : 'silent'} · mouth ${open.toFixed(2)}`,
        `lip sync    ${diag.lipSyncMode} · ${diag.analyzer}`,
        `avatar      ${diag.avatarLoaded === true ? 'loaded' : diag.avatarLoaded === 'error' ? `error: ${diag.avatarError}` : 'loading'} · ${controller.getState()}`,
        `voice UI    ${diag.voiceUi ? 'detected' : 'not found'}${diag.orbHidden ? ' · orb hidden' : ''}`,
      ].join('\n'),
    );
  }

  return {
    diagnostics: diag,
    pushFrame(frame) {
      diag.frames++;
      mouth.push(frame);
      if (frame.active !== diag.audioActive) {
        diag.audioActive = frame.active;
        presenter.setAudioActive(frame.active);
      }
    },
    setAudioStatus(status) {
      diag.lipSyncMode = status.mode;
      diag.analyzer = status.analyzer;
    },
    setOffscreenConnected(connected) {
      diag.offscreenConnected = connected;
      if (!connected) {
        mouth.reset();
        diag.audioActive = false;
        presenter.setAudioActive(false);
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
