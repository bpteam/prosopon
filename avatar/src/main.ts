import './styles.css';
import type { VRM } from '@pixiv/three-vrm';
import { Avatar } from './avatar/Avatar';
import { AvatarController } from './avatar/AvatarController';
import { AvatarDebugPanel } from './avatar/AvatarDebugPanel';
import { AvatarIdleController } from './avatar/AvatarIdleController';
import { AvatarLoader } from './avatar/AvatarLoader';
import type { AvatarState } from './avatar/AvatarStateProfiles';
import { AmplitudeLipSync } from './audio/AmplitudeLipSync';
import { AudioInput } from './audio/AudioInput';
import { LipSyncDebugPanel } from './audio/LipSyncDebugPanel';
import { headAudioFactory } from './audio/analyzers/HeadAudioAnalyzer';
import { wLipSyncFactory } from './audio/analyzers/WLipSyncAnalyzer';
import { VisemeAnalyzerHost, type AnalyzerChoice } from './audio/VisemeAnalyzerHost';
import { VisemeDebugPanel } from './audio/VisemeDebugPanel';
import { VisemeLipSync } from './audio/VisemeLipSync';
import { MAX_FRAME_DELTA, MODEL_URL, REST_POSE } from './config';
import { DebugOverlay } from './debug/DebugOverlay';
import { AvatarStage } from './renderer/AvatarStage';
import { RenderLoop } from './renderer/RenderLoop';

export interface AvatarDebugApi {
  loaded: boolean;
  error: string | null;
  fps: number;
  avatar: Avatar | null;
  idle: AvatarIdleController;
  stage: AvatarStage;
  controller: AvatarController;
  audio: AudioInput;
  lipSync: AmplitudeLipSync;
  visemes: VisemeLipSync;
  analyzers: VisemeAnalyzerHost;
  /** Live getter: current conversation state (also before the avatar is loaded). */
  readonly state: AvatarState;
}

declare global {
  interface Window {
    __AVATAR_DEBUG__?: AvatarDebugApi;
  }
}

interface HotData {
  vrm?: VRM;
}

const container = document.getElementById('stage');
if (!container) throw new Error('#stage element is missing');

const stage = new AvatarStage(container);
const idle = new AvatarIdleController();
const audio = new AudioInput();
const lipSync = new AmplitudeLipSync(() => audio.readRms());
const visemes = new VisemeLipSync(lipSync);
const analyzers = new VisemeAnalyzerHost(
  audio,
  visemes,
  { headaudio: headAudioFactory(), wlipsync: wLipSyncFactory() },
  analyzerFromUrl() ?? 'headaudio',
);
const overlay = new DebugOverlay(document.body, stage.renderer, { loaded: false, vrmVersion: null, webgl2: stage.isWebGL2 });
overlay.visible = import.meta.env.DEV;

// Exists before the model: conversation state set while the VRM loads is kept and applied on attach.
const controller = new AvatarController({ idle });
controller.setMouthSource(visemes);
document.body.dataset.avatarState = controller.getState();
controller.onStateChange((state) => (document.body.dataset.avatarState = state));

let panel: AvatarDebugPanel | null = null;
let lipSyncPanel: LipSyncDebugPanel | null = null;
let visemePanel: VisemeDebugPanel | null = null;
let errorBanner: HTMLElement | null = null;

const debugApi: AvatarDebugApi = {
  loaded: false,
  error: null,
  fps: 0,
  avatar: null,
  idle,
  stage,
  controller,
  audio,
  lipSync,
  visemes,
  analyzers,
  get state() {
    return controller.getState();
  },
};
if (import.meta.env.DEV) window.__AVATAR_DEBUG__ = debugApi;

// Single rAF loop: controller (state → idle → lip sync → composition → avatar/VRM) → render.
const loop = new RenderLoop((delta) => {
  controller.update(delta);
  stage.render();
  overlay.afterRender(delta);
  debugApi.fps = overlay.meter.fps;
}, MAX_FRAME_DELTA);
loop.start();

void boot();

async function boot(): Promise<void> {
  document.body.dataset.avatarLoaded = 'false';
  try {
    const hot = import.meta.hot?.data as HotData | undefined;
    // On HMR, reuse the already parsed VRM instead of downloading and parsing it again.
    const vrm = hot?.vrm ?? (await new AvatarLoader().loadVRM(MODEL_URL));
    if (hot) hot.vrm = vrm;

    const avatar = new Avatar(vrm, { restPose: REST_POSE });
    controller.attachAvatar(avatar);
    controller.update(0);
    stage.setAvatar(avatar);

    panel = new AvatarDebugPanel(controller, {
      overlayVisible: overlay.visible,
      setOverlayVisible: (v) => (overlay.visible = v),
    });
    lipSyncPanel = new LipSyncDebugPanel(panel.gui, audio, lipSync);
    visemePanel = new VisemeDebugPanel(lipSyncPanel.folder, analyzers, visemes);

    overlay.setInfo({ loaded: true, vrmVersion: formatVrmVersion(avatar.vrmVersion) });
    debugApi.loaded = true;
    debugApi.avatar = avatar;
    document.body.dataset.avatarLoaded = 'true';
  } catch (error) {
    reportError(error);
  }
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[avatar] failed to initialise:', error);
  debugApi.error = message;
  document.body.dataset.avatarLoaded = 'error';
  document.body.dataset.avatarError = message;

  errorBanner ??= document.createElement('div');
  errorBanner.className = 'error-banner';
  errorBanner.setAttribute('role', 'alert');
  errorBanner.textContent = `Avatar failed to load\n${message}`;
  document.body.appendChild(errorBanner);
}

function formatVrmVersion(metaVersion: string): string {
  return metaVersion === '1' ? '1.0' : metaVersion === '0' ? '0.x' : metaVersion;
}

if (import.meta.hot) {
  // main.ts is the HMR boundary for everything under src/: tear down and rebuild without a page reload.
  import.meta.hot.accept();
  import.meta.hot.dispose(() => {
    loop.stop();
    controller.dispose();
    visemePanel?.dispose();
    lipSyncPanel?.dispose();
    analyzers.dispose();
    panel?.dispose();
    void audio.dispose();
    overlay.dispose();
    errorBanner?.remove();
    stage.dispose();
    delete window.__AVATAR_DEBUG__;
  });
}

/** `?analyzer=none|headaudio|wlipsync` overrides the default viseme analyser. */
function analyzerFromUrl(): AnalyzerChoice | null {
  const v = new URLSearchParams(location.search).get('analyzer');
  return v === 'none' || v === 'headaudio' || v === 'wlipsync' ? v : null;
}
