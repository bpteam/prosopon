import {
  isCaptureReply,
  message,
  parseMessage,
  type CaptureListReply,
  type ExtensionPayload,
  type ExtensionTabState,
  type MicStatus,
  isMicStatus,
  type EmotionModelInstallState,
  type MicPreference,
} from '../shared/messages';
import { isChatGptUrl } from '../shared/urls';
import { TabSessions, type CaptureBackend } from './TabSessions';
import { EmotionModelInstaller, type EmotionInstallState } from '../emotion/EmotionModelInstaller';
import { IndexedDbModelStorage } from '../emotion/ModelStorage';

/**
 * Orchestration only: action clicks, tab identity, capture startup, the offscreen document's lifecycle, message
 * routing and per-tab enable state. No DOM, no audio processing, no rendering.
 *
 * State lives in memory and the worker is killed after ~30 s idle; the offscreen document (which owns the
 * captures) is the source of truth it recovers from on the next start.
 */

const OFFSCREEN_URL = 'offscreen/index.html';

const emotionInstaller = new EmotionModelInstaller(new IndexedDbModelStorage(), (state) => {
  void chrome.runtime.sendMessage(message({ type: 'emotion:model-state', state: publicEmotionState(state) })).catch(() => {});
});
function publicEmotionState(state: EmotionInstallState): EmotionModelInstallState {
  return { status: state.status, downloaded: state.downloaded, error: state.error, installed: !!state.metadata, enabled: state.metadata?.enabled };
}
async function initializeEmotionModel(): Promise<EmotionInstallState> {
  try {
    await ensureOffscreen();
    const selfTest = await toOffscreen({ type: 'emotion:model-self-test' }) as { ok?: boolean; error?: string };
    return selfTest.ok ? emotionInstaller.markReady() : await emotionInstaller.markRuntimeError(selfTest.error ?? 'Model self-test failed.');
  } catch (error) {
    return emotionInstaller.markRuntimeError(`Model self-test failed: ${String(error)}`);
  }
}
async function deactivateEmotionModel(): Promise<void> {
  if (await hasOffscreen()) await toOffscreen({ type: 'emotion:model-deactivate' }).catch(() => {});
}

let offscreenOp: Promise<unknown> = Promise.resolve();
/** Offscreen create/close must not interleave (createDocument rejects if one exists). */
function serial<T>(op: () => Promise<T>): Promise<T> {
  const next = offscreenOp.then(op, op);
  offscreenOp = next.catch(() => {});
  return next;
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

function ensureOffscreen(): Promise<void> {
  return serial(async () => {
    if (await hasOffscreen()) return;
    // USER_MEDIA only: an AUDIO_PLAYBACK document is closed by Chrome after 30 s of silence.
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification:
        'Analyse the ChatGPT tab audio for avatar lip sync and keep it audible while captured; when the user opts ' +
        'in, analyse their microphone locally for voice activity and pitch.',
    });
  });
}

/** runtime.sendMessage reaches every extension page; only the offscreen document answers capture:* messages. */
async function toOffscreen(payload: ExtensionPayload): Promise<unknown> {
  return chrome.runtime.sendMessage(message(payload));
}

const backend: CaptureBackend = {
  getStreamId: (tabId) => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
  async startCapture(tabId, streamId) {
    await ensureOffscreen();
    const reply = await toOffscreen({ type: 'capture:start', tabId, streamId });
    if (!isCaptureReply(reply)) throw new Error('offscreen audio runtime did not answer');
    if (!reply.ok) throw new Error(reply.error);
    // A freshly created offscreen document starts with the mic off: tell it what the user chose.
    void syncMic(false);
  },
  async stopCapture(tabId) {
    if (!(await hasOffscreen())) return;
    await toOffscreen({ type: 'capture:stop', tabId });
  },
  release: () =>
    serial(async () => {
      if (await hasOffscreen()) await chrome.offscreen.closeDocument();
    }),
};

const sessions = new TabSessions(backend);

sessions.onChange((tabId, state, error) => {
  void chrome.tabs.sendMessage(tabId, message({ type: 'tab:state', state, error })).catch(() => {
    // No content script in the tab (not chatgpt.com, or still loading): it asks with tab:hello when it starts.
  });
  void chrome.action.setBadgeText({ tabId, text: BADGE[state] }).catch(() => {});
  void chrome.action.setTitle({ tabId, title: title(state, error) }).catch(() => {});
});

const BADGE: Record<ExtensionTabState, string> = { disabled: '', starting: '…', enabled: 'ON', error: '!' };

function title(state: ExtensionTabState, error?: string): string {
  if (state === 'enabled') return 'Disable Prosopon';
  if (state === 'starting') return 'Prosopon is starting…';
  if (state === 'error') return `Prosopon failed: ${error ?? 'unknown error'}. Click to retry.`;
  return 'Enable Prosopon';
}

// --- Microphone reactions ------------------------------------------------------------------------------------
//
// Opt-in, off by default. The choice lives in storage.session: it survives service worker restarts but not a
// browser restart, so the mic never comes back on by itself in a new browser session. Only the flag is stored.

const MIC_MENU_ID = 'prosopon-mic-reactions';
const MIC_PREF_KEY = 'micReactions';
const PERMISSION_URL = 'permission/index.html';

async function micWanted(): Promise<boolean> {
  try {
    return (await chrome.storage.session.get(MIC_PREF_KEY))[MIC_PREF_KEY] === true;
  } catch {
    return false;
  }
}

async function ensureMicMenu(): Promise<void> {
  const checked = await micWanted();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MIC_MENU_ID,
    type: 'checkbox',
    title: 'Microphone reactions (audio stays local)',
    contexts: ['action'],
    checked,
  });
}

/** Grant state of the extension origin; 'prompt' when it can't be read from the worker. */
async function micPermission(): Promise<PermissionState> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
  } catch {
    return 'prompt';
  }
}

async function openPermissionPage(): Promise<void> {
  const url = chrome.runtime.getURL(PERMISSION_URL);
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url });
}

/**
 * Pushes the opt-in to the offscreen document (if there is one: it only exists while a tab is enabled).
 * `interactive`: the user just asked for it, so a missing grant opens the permission page. Enabling a tab never
 * does that on its own.
 */
async function syncMic(interactive: boolean): Promise<MicStatus | null> {
  const enabled = await micWanted();
  let status: MicStatus | null = null;
  if (await hasOffscreen()) {
    const reply = await toOffscreen({ type: 'mic:set', enabled }).catch(() => null);
    status = isMicStatus(reply) ? reply : null;
  }
  if (interactive && enabled) {
    const denied = status ? status.state === 'denied' : (await micPermission()) !== 'granted';
    if (denied) await openPermissionPage();
  }
  return status;
}

async function setMicWanted(enabled: boolean, interactive: boolean): Promise<MicStatus | null> {
  await chrome.storage.session.set({ [MIC_PREF_KEY]: enabled });
  await chrome.contextMenus.update(MIC_MENU_ID, { checked: enabled }).catch(() => {});
  return syncMic(interactive);
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MIC_MENU_ID) void ready.then(() => setMicWanted(info.checked === true, true));
});

chrome.runtime.onStartup.addListener(() => void ensureMicMenu());

/** Rebuild state after a worker restart from the captures the offscreen document still holds. */
const ready: Promise<void> = (async () => {
  try {
    await emotionInstaller.restore();
    if (!(await hasOffscreen())) return;
    const reply = (await toOffscreen({ type: 'capture:list' })) as CaptureListReply | undefined;
    sessions.restore(reply?.tabIds ?? []);
    await syncMic(false);
  } catch (error) {
    console.warn('[prosopon] could not restore capture state:', error);
  }
})();

async function toggle(tab: chrome.tabs.Tab): Promise<void> {
  await ready;
  if (tab.id === undefined) return;
  if (!isChatGptUrl(tab.url)) {
    // Only reachable when the action is clicked elsewhere; the extension is inert outside chatgpt.com.
    await chrome.action.setTitle({ tabId: tab.id, title: 'Prosopon works on chatgpt.com only' }).catch(() => {});
    return;
  }
  await sessions.toggle(tab.id);
}

async function activeTabState(): Promise<{ state: ExtensionTabState; error?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined || !isChatGptUrl(tab.url)) return { state: 'disabled', error: 'Open chatgpt.com to enable the avatar.' };
  const current = sessions.get(tab.id);
  return { state: current.state, error: current.error };
}

chrome.action.onClicked.addListener((tab) => void toggle(tab));

/**
 * After an install or an update, chatgpt.com tabs that are already open hold no content script (the old one, if
 * any, was orphaned by the reload): Chrome only injects into tabs loaded afterwards. Inject into them once, so
 * the extension works without the user reloading every tab.
 */
chrome.runtime.onInstalled.addListener(() => {
  void ensureMicMenu();
  void (async () => {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      // Re-injecting into a tab that already has a live script is harmless: content.ts takes the old one over.
      await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
        .catch(() => {}); // a discarded or restricted tab: it will inject itself when it loads
    }
  })();
});

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const msg = parseMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'tab:hello': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return;
      void ready.then(() => {
        const { state, error } = sessions.get(tabId);
        sendResponse(message({ type: 'tab:state', state, error }));
      });
      return true;
    }
    case 'prosopon:status':
      void ready.then(() => activeTabState().then(sendResponse));
      return true;
    case 'prosopon:toggle':
      void ready.then(async () => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) await toggle(tab);
        sendResponse(await activeTabState());
      });
      return true;
    case 'capture:ended':
      void ready.then(() => sessions.captureEnded(msg.tabId, msg.reason));
      return;
    case 'mic:granted': {
      // The permission page did its job: start the mic where it's wanted, and close the page.
      void ready.then(() => syncMic(false));
      const tabId = sender.tab?.id;
      if (tabId !== undefined) setTimeout(() => void chrome.tabs.remove(tabId).catch(() => {}), 1200);
      return;
    }
    case 'emotion:model-info':
      void ready.then(() => sendResponse(publicEmotionState(emotionInstaller.current)));
      return true;
    case 'emotion:model-install':
      void ready.then(async () => {
        const result = await emotionInstaller.install(msg.enable);
        if (result.status !== 'initializing') { sendResponse(publicEmotionState(result)); return; }
        sendResponse(publicEmotionState(await initializeEmotionModel()));
      });
      return true;
    case 'emotion:model-cancel':
      emotionInstaller.cancel();
      sendResponse(publicEmotionState(emotionInstaller.current));
      return;
    case 'emotion:model-remove':
      void ready.then(async () => { await deactivateEmotionModel(); sendResponse(publicEmotionState(await emotionInstaller.remove())); });
      return true;
    case 'emotion:model-enable':
      void ready.then(async () => {
        const state = await emotionInstaller.setEnabled(msg.enabled);
        if (!msg.enabled) await deactivateEmotionModel();
        sendResponse(publicEmotionState(state.status === 'initializing' ? await initializeEmotionModel() : state));
      });
      return true;
    case 'mic:preference':
      void ready.then(async () => {
        const enabled = await micWanted();
        const status = (await hasOffscreen()) ? await toOffscreen({ type: 'mic:info' }).catch(() => null) : null;
        sendResponse({ enabled, status: isMicStatus(status) ? { state: status.state, error: status.error } : null } satisfies MicPreference);
      });
      return true;
    case 'mic:set-preference':
      // Popup switch: the same path as the toolbar context menu (a user gesture, so a missing grant opens the page).
      void ready.then(async () => {
        const status = await setMicWanted(msg.enabled, true);
        sendResponse({ enabled: msg.enabled, status } satisfies MicPreference);
      });
      return true;
    case 'extension:error':
      console.warn(`[prosopon] tab ${sender.tab?.id}: ${msg.error}`);
      return;
    default:
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void ready.then(() => sessions.remove(tabId)));

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Without the "tabs" permission tab.url is only visible for host_permissions pages, so a missing URL after a
  // completed navigation means the tab left chatgpt.com: nothing to put the avatar on any more.
  if (change.status !== 'complete' || isChatGptUrl(tab.url)) return;
  void ready.then(() => sessions.disable(tabId));
});

if (import.meta.env.DEV) {
  // E2E hook: Playwright can't click the toolbar button. Needs Chromium's --allowlisted-extension-id to pass
  // tabCapture's user-gesture check. Not present in production builds.
  Object.assign(globalThis, {
    __prosopon: {
      toggle: async (tabId: number) => toggle(await chrome.tabs.get(tabId)),
      state: (tabId: number) => sessions.get(tabId),
      hasOffscreen,
      setMic: (enabled: boolean, interactive = false) => ready.then(() => setMicWanted(enabled, interactive)),
      micInfo: async () => ((await hasOffscreen()) ? toOffscreen({ type: 'mic:info' }) : null),
    },
  });
}
