import { CAMERA_PRESETS } from '@avatar/renderer/CameraFraming';
import { EMOTION_MODEL } from '../emotion/EmotionModelManifest';
import {
  isEmotionModelInstallState,
  message,
  parseMessage,
  type EmotionModelInstallState,
  type ExtensionPayload,
  type MicPreference,
} from '../shared/messages';
import {
  AVATAR_SCALE,
  DEFAULT_VIEW_SETTINGS,
  PersistedValue,
  STORAGE_KEYS,
  chromeSettingsArea,
  cloneView,
  isCameraModified,
  sanitizeDeveloperMode,
  sanitizeViewSettings,
  snapScale,
} from '../shared/settings';
import { h, setText, svg, toggleSwitch } from '../ui/shared/dom';
import { ICONS, PRESET_SILHOUETTES } from '../ui/shared/icons';
import { CONTROLS_CSS, TOKENS_CSS } from '../ui/shared/tokens';

/**
 * Toolbar popup: the user-facing controls. Avatar on/off for the active ChatGPT tab, avatar layout (Settings),
 * the optional emotion model, microphone reactions and Developer mode. No diagnostics here: those live in the
 * in-page Developer Tools while Developer mode is on.
 */

const POPUP_CSS = `
:root { ${TOKENS_CSS} color-scheme: dark; }
${CONTROLS_CSS}
html, body { margin: 0; background: var(--bg-panel); }
body { width: 320px; min-height: 460px; max-height: 600px; overflow-y: auto; }
main { display: flex; flex-direction: column; gap: var(--gap); padding: 0 var(--pad-panel) var(--pad-panel); }
header { display: flex; align-items: center; gap: var(--gap); height: 56px; margin: 0 calc(-1 * var(--pad-panel)); padding: 0 10px 0 var(--pad-panel); border-bottom: 1px solid var(--border); }
.logo { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; color: #fff; flex: none;
  background: radial-gradient(circle at 30% 25%, #ff9a5c, var(--accent) 55%, #b53c0c); }
.logo .icon { width: 20px; height: 20px; }
.name { font: 600 16px/1.2 var(--font); }
.version { font: 400 11px/1.2 var(--font); color: var(--text-secondary); }
.status { display: flex; gap: var(--gap); align-items: flex-start; }
.status .dot { margin-top: 5px; }
.status-title { font-weight: 600; }
.row-card { display: flex; align-items: center; gap: var(--gap); }
.row-card .text { flex: 1 1 auto; min-width: 0; }
.row-card .title { font-weight: 600; }
.row-card > .icon { color: var(--text-secondary); }
button.nav { width: 100%; justify-content: flex-start; gap: var(--gap); background: var(--bg-card); padding: 12px; min-height: 44px; font-weight: 600; border-radius: var(--radius-card); }
button.nav .grow { text-align: left; }
button.nav .icon { color: var(--text-secondary); }
.emotion-head { display: flex; align-items: baseline; justify-content: space-between; }
.emotion { display: flex; flex-direction: column; gap: var(--gap-s); }
.model { background: var(--bg-page); border: 1px solid var(--border); border-radius: var(--radius-control); padding: 10px; }
.model .label { font-size: 11px; color: var(--text-muted); }
.model strong { display: block; font-weight: 600; margin: 2px 0; }
.actions { display: flex; gap: var(--gap-s); }
.actions button { flex: 1 1 0; }
.actions button.danger { flex: 0 1 auto; }
progress { width: 100%; height: 6px; accent-color: var(--accent); }
.error { color: var(--red); font-size: 12px; margin: 0; }
.view-head { display: flex; align-items: center; gap: var(--gap-s); height: 56px; margin: 0 calc(-1 * var(--pad-panel)); padding: 0 var(--pad-panel) 0 6px; border-bottom: 1px solid var(--border); }
.view-head h1 { font: 600 16px/1 var(--font); margin: 0; }
.presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--gap-s); }
.preset { flex-direction: column; gap: 4px; min-height: 76px; padding: 8px 4px; font-weight: 600; font-size: 12px; }
.preset svg { width: 44px; height: 36px; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.preset[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.slider { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; }
.slider input { grid-column: 1 / -1; }
.stack { display: flex; flex-direction: column; gap: var(--gap); }
`;

const doc = document;
const style = doc.createElement('style');
style.textContent = POPUP_CSS;
doc.head.append(style);
const app = doc.getElementById('app')!;

function send<T = unknown>(payload: ExtensionPayload): Promise<T> {
  return chrome.runtime.sendMessage(message(payload)) as Promise<T>;
}

const area = chromeSettingsArea();
const viewSetting = new PersistedValue(area, STORAGE_KEYS.view, sanitizeViewSettings, cloneView(DEFAULT_VIEW_SETTINGS));
const devSetting = new PersistedValue(area, STORAGE_KEYS.developerMode, sanitizeDeveloperMode, false);
// The popup closes without notice: write every change at once.
addEventListener('pagehide', () => {
  void viewSetting.flush();
  void devSetting.flush();
});

// --- Main view ----------------------------------------------------------------------------------------------------

const version = chrome.runtime.getManifest().version;
const settingsButton = h(doc, 'button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings' }, svg(doc, ICONS.settings, 'icon'));
const header = h(
  doc,
  'header',
  {},
  h(doc, 'div', { class: 'logo', 'aria-hidden': 'true' }, svg(doc, ICONS.avatar, 'icon')),
  h(doc, 'div', { class: 'grow' }, h(doc, 'div', { class: 'name' }, 'Prosopon'), h(doc, 'div', { class: 'version' }, `v${version}`)),
  settingsButton,
);

const statusDot = h(doc, 'span', { class: 'dot' });
const statusTitle = h(doc, 'div', { class: 'status-title', id: 'status-title' }, 'Checking…');
const statusText = h(doc, 'div', { class: 'secondary', id: 'status-text' });
const statusCard = h(doc, 'section', { class: 'card status', 'aria-labelledby': 'status-title' }, statusDot, h(doc, 'div', {}, statusTitle, statusText));

const avatarSwitch = toggleSwitch(doc, 'Avatar', false, () => void toggleAvatar(), 'avatar-toggle');
const avatarCard = h(
  doc,
  'section',
  { class: 'card row-card' },
  svg(doc, ICONS.avatar, 'icon'),
  h(doc, 'div', { class: 'text' }, h(doc, 'div', { class: 'title' }, 'Avatar')),
  avatarSwitch.el,
);

const settingsNav = h(
  doc,
  'button',
  { type: 'button', class: 'nav', id: 'open-settings' },
  svg(doc, ICONS.sliders, 'icon'),
  h(doc, 'span', { class: 'grow' }, 'Settings'),
  svg(doc, ICONS.chevronRight, 'icon s'),
);

// Emotion Intelligence
const emotionDot = h(doc, 'span', { class: 'dot' });
const emotionStatus = h(doc, 'strong', { id: 'status' }, 'Loading…');
const progressBar = h(doc, 'progress', { max: EMOTION_MODEL.size, value: 0, 'aria-label': 'Model download' });
const progressText = h(doc, 'span', { class: 'tiny' });
const progress = h(doc, 'div', { class: 'hidden', id: 'progress' }, progressBar, progressText);
const emotionError = h(doc, 'p', { class: 'error hidden', id: 'error', role: 'alert' });
const install = h(doc, 'button', { type: 'button', class: 'primary', id: 'install' }, 'Install & Enable');
const cancel = h(doc, 'button', { type: 'button', class: 'hidden', id: 'cancel' }, 'Cancel');
const disable = h(doc, 'button', { type: 'button', class: 'hidden', id: 'disable' }, 'Disable emotions');
const remove = h(doc, 'button', { type: 'button', class: 'danger hidden', id: 'remove' }, 'Remove model');
const sizeMb = (EMOTION_MODEL.size / 1_000_000).toFixed(0);
const emotionCard = h(
  doc,
  'section',
  { class: 'card emotion', 'aria-labelledby': 'emotion-title' },
  h(doc, 'div', { class: 'emotion-head' }, h(doc, 'h2', { class: 'section-title', id: 'emotion-title' }, 'Emotion Intelligence'), h(doc, 'span', { class: 'badge' }, 'Optional')),
  h(doc, 'div', { class: 'row' }, emotionDot, emotionStatus),
  h(doc, 'p', { class: 'secondary', style: 'margin:0' }, 'Local voice valence and arousal analysis. Runs on your device.'),
  h(doc, 'div', { class: 'model' }, h(doc, 'span', { class: 'label' }, 'Model'), h(doc, 'strong', {}, 'DistilHuBERT SER INT8'), h(doc, 'span', { class: 'tiny' }, `~${sizeMb} MB · local`)),
  progress,
  emotionError,
  h(doc, 'div', { class: 'actions' }, install, cancel, disable, remove),
);

const micSwitch = toggleSwitch(doc, 'Microphone reactions', false, (on) => void setMic(on), 'mic-toggle');
const micText = h(doc, 'div', { class: 'secondary', id: 'mic-text' }, 'React to your voice locally');
const micCard = h(
  doc,
  'section',
  { class: 'card row-card' },
  svg(doc, ICONS.mic, 'icon'),
  h(doc, 'div', { class: 'text' }, h(doc, 'div', { class: 'title' }, 'Microphone reactions'), micText),
  micSwitch.el,
);

const devSwitch = toggleSwitch(doc, 'Developer mode', false, (on) => devSetting.set(on, 'now'), 'dev-toggle');
const devCard = h(
  doc,
  'section',
  { class: 'card stack' },
  h(doc, 'div', { class: 'row-card' }, svg(doc, ICONS.code, 'icon'), h(doc, 'div', { class: 'text' }, h(doc, 'div', { class: 'title' }, 'Developer mode')), devSwitch.el),
  h(doc, 'div', { class: 'secondary' }, 'Open diagnostics and advanced avatar controls.'),
);

const mainView = h(doc, 'div', { class: 'stack', id: 'main-view' }, header, statusCard, avatarCard, settingsNav, emotionCard, micCard, devCard);

// --- Settings view: the avatar's layout (the same settings the in-page controls use) -------------------------------

const back = h(doc, 'button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', id: 'settings-back' }, svg(doc, ICONS.chevronLeft, 'icon'));
const presetButtons = CAMERA_PRESETS.map((preset) => {
  const label = preset === 'face' ? 'Face' : preset === 'waist' ? 'Waist' : 'Full body';
  const b = h(doc, 'button', { type: 'button', class: 'preset', 'aria-pressed': 'false', 'data-preset': preset }, svg(doc, PRESET_SILHOUETTES[preset], ''), label);
  b.addEventListener('click', () => updateView({ camera: { preset } }));
  return [preset, b] as const;
});
const cameraNote = h(doc, 'div', { class: 'tiny' });
const sizeValue = h(doc, 'span', { class: 'value' });
const sizeInput = h(doc, 'input', { type: 'range', min: AVATAR_SCALE.min, max: AVATAR_SCALE.max, step: AVATAR_SCALE.step, 'aria-label': 'Avatar size', id: 'avatar-size' });
sizeInput.addEventListener('input', () => {
  setText(sizeValue, `${Math.round(Number(sizeInput.value) * 100)}%`);
  updateView({ placement: { scale: snapScale(Number(sizeInput.value)) } }, 'debounced');
});
sizeInput.addEventListener('change', () => void viewSetting.flush());
const moveButton = h(doc, 'button', { type: 'button', id: 'move-avatar' }, svg(doc, ICONS.move, 'icon s'), 'Move avatar');
moveButton.addEventListener('click', () => void startPlacement());
const resetLayout = h(doc, 'button', { type: 'button', id: 'reset-layout' }, svg(doc, ICONS.reset, 'icon s'), 'Reset layout');
resetLayout.addEventListener('click', () => {
  viewSetting.set(cloneView(DEFAULT_VIEW_SETTINGS), 'now');
  renderView();
});
const moveHint = h(doc, 'p', { class: 'secondary', style: 'margin:0' });
const settingsView = h(
  doc,
  'div',
  { class: 'stack hidden', id: 'settings-view' },
  h(doc, 'div', { class: 'view-head' }, back, h(doc, 'h1', {}, 'Settings')),
  h(doc, 'section', { class: 'card stack' }, h(doc, 'h2', { class: 'section-title' }, 'Camera'), h(doc, 'div', { class: 'presets' }, presetButtons.map(([, b]) => b)), cameraNote),
  h(
    doc,
    'section',
    { class: 'card stack' },
    h(doc, 'h2', { class: 'section-title' }, 'Avatar size and position'),
    h(doc, 'label', { class: 'slider' }, h(doc, 'span', { class: 'secondary' }, 'Avatar size'), sizeValue, sizeInput),
    h(doc, 'div', { class: 'actions' }, moveButton, resetLayout),
    moveHint,
  ),
  h(doc, 'p', { class: 'tiny', style: 'margin:0' }, 'Saved on this device and applied to every ChatGPT tab.'),
);

app.append(mainView, settingsView);
const showSettings = (on: boolean) => {
  mainView.classList.toggle('hidden', on);
  settingsView.classList.toggle('hidden', !on);
  (on ? back : settingsNav).focus();
};
settingsButton.addEventListener('click', () => showSettings(true));
settingsNav.addEventListener('click', () => showSettings(true));
back.addEventListener('click', () => showSettings(false));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsView.classList.contains('hidden')) {
    e.preventDefault();
    showSettings(false);
  }
});

function updateView(change: { camera?: Record<string, unknown>; placement?: Record<string, unknown> }, persist: 'debounced' | 'now' = 'now'): void {
  const cur = viewSetting.value;
  viewSetting.set(sanitizeViewSettings({ ...cur, camera: { ...cur.camera, ...change.camera }, placement: { ...cur.placement, ...change.placement } }), persist);
  renderView();
}

function renderView(): void {
  const v = viewSetting.value;
  for (const [preset, b] of presetButtons) b.setAttribute('aria-pressed', String(preset === v.camera.preset));
  setText(cameraNote, isCameraModified(v.camera) ? 'Adjusted in Developer mode · Reset layout to clear' : 'What the camera frames.');
  if (doc.activeElement !== sizeInput) sizeInput.value = String(v.placement.scale);
  setText(sizeValue, `${Math.round(v.placement.scale * 100)}%`);
}

// --- Avatar ---------------------------------------------------------------------------------------------------------

type TabState = { state: string; error?: string };
let tab: TabState = { state: 'disabled' };

function renderAvatar(state: TabState): void {
  tab = state;
  const enabled = state.state === 'enabled';
  const offSite = state.state === 'disabled' && !!state.error;
  statusDot.className = `dot ${enabled ? 'green' : state.state === 'starting' ? 'orange' : state.state === 'error' ? 'red' : ''}`;
  setText(
    statusTitle,
    enabled ? 'Active on chatgpt.com' : state.state === 'starting' ? 'Starting…' : state.state === 'error' ? 'Something went wrong' : offSite ? 'Not on ChatGPT' : 'Off for this tab',
  );
  setText(
    statusText,
    enabled
      ? 'Avatar replaces voice orb'
      : state.state === 'error'
        ? (state.error ?? 'Unknown error')
        : offSite
          ? 'Open chatgpt.com to use Prosopon'
          : 'Turn the avatar on below',
  );
  avatarSwitch.input.checked = enabled || state.state === 'starting';
  avatarSwitch.input.disabled = state.state === 'starting' || offSite;
  moveButton.disabled = !enabled;
  setText(moveHint, enabled ? 'Move avatar lets you drag it on the page; press Done or Escape when finished.' : 'Turn the avatar on in a ChatGPT tab to move it.');
}

async function toggleAvatar(): Promise<void> {
  renderAvatar({ state: 'starting' });
  renderAvatar(await send<TabState>({ type: 'prosopon:toggle' }));
}

async function startPlacement(): Promise<void> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id === undefined || tab.state !== 'enabled') return;
  await chrome.tabs.sendMessage(active.id, message({ type: 'ui:placement', active: true })).catch(() => {});
  close(); // the page needs the pointer now
}

// --- Emotion Intelligence -------------------------------------------------------------------------------------------

let emotionState: EmotionModelInstallState | null = null;

function renderEmotion(s: EmotionModelInstallState): void {
  emotionState = s;
  const busy = ['downloading', 'verifying', 'initializing'].includes(s.status);
  const label: Record<EmotionModelInstallState['status'], string> = {
    'not-installed': 'Not installed',
    downloading: 'Downloading…',
    verifying: 'Verifying…',
    initializing: 'Starting…',
    ready: 'Ready',
    disabled: 'Disabled',
    error: 'Error',
  };
  setText(emotionStatus, label[s.status]);
  emotionDot.className = `dot ${s.status === 'ready' ? 'green' : busy ? 'orange' : s.status === 'error' ? 'red' : ''}`;
  progress.classList.toggle('hidden', !busy);
  cancel.classList.toggle('hidden', !busy);
  install.classList.toggle('hidden', busy || s.status === 'ready');
  disable.classList.toggle('hidden', s.status !== 'ready');
  remove.classList.toggle('hidden', busy || (!s.installed && s.status !== 'ready' && s.status !== 'disabled'));
  setText(install, s.status === 'disabled' ? 'Enable emotions' : s.status === 'error' ? 'Retry' : 'Install & Enable');
  if (s.downloaded !== undefined) {
    progressBar.value = s.downloaded;
    setText(progressText, `${(s.downloaded / 1_000_000).toFixed(1)} / ${(EMOTION_MODEL.size / 1_000_000).toFixed(1)} MB`);
  }
  emotionError.classList.toggle('hidden', !s.error);
  setText(emotionError, s.error ?? '');
}

install.addEventListener('click', () => {
  // Disabled and recoverable-error states retain a verified binary in IndexedDB: re-enable it, never download again.
  if (emotionState?.installed) {
    void send({ type: 'emotion:model-enable', enabled: true });
    return;
  }
  if (confirm(`Emotion ML runs locally. It downloads approximately ${sizeMb} MB. Voice audio is processed on your device and is not sent to the model provider.`)) {
    void send({ type: 'emotion:model-install', enable: true });
  }
});
cancel.addEventListener('click', () => void send({ type: 'emotion:model-cancel' }));
disable.addEventListener('click', () => void send({ type: 'emotion:model-enable', enabled: false }));
remove.addEventListener('click', () => void send({ type: 'emotion:model-remove' }));

// --- Microphone reactions -------------------------------------------------------------------------------------------

function renderMic(p: MicPreference | null): void {
  if (!p) return;
  micSwitch.input.checked = p.enabled;
  const s = p.status?.state;
  setText(
    micText,
    !p.enabled
      ? 'React to your voice locally'
      : s === 'denied'
        ? 'Microphone access needed: see the opened tab'
        : s === 'unavailable'
          ? 'No microphone found'
          : s === 'error'
            ? (p.status?.error ?? 'Microphone error')
            : 'On · audio stays on this device',
  );
}

async function setMic(on: boolean): Promise<void> {
  renderMic(await send<MicPreference>({ type: 'mic:set-preference', enabled: on }).catch(() => null));
}

// --- Start ------------------------------------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((raw) => {
  const msg = parseMessage(raw);
  if (msg?.type === 'emotion:model-state') renderEmotion(msg.state);
});
viewSetting.onChange(renderView);
devSetting.onChange((on) => (devSwitch.input.checked = on));
renderView();
void viewSetting.load().then(renderView);
void devSetting.load().then((on) => (devSwitch.input.checked = on));
void send<TabState>({ type: 'prosopon:status' }).then(renderAvatar);
void send({ type: 'emotion:model-info' }).then((r) => {
  if (isEmotionModelInstallState(r)) renderEmotion(r);
});
void send<MicPreference>({ type: 'mic:preference' }).then(renderMic).catch(() => {});
