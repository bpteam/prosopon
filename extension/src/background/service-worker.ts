import {
  isCaptureReply,
  message,
  parseMessage,
  type CaptureListReply,
  type ExtensionPayload,
  type ExtensionTabState,
} from '../shared/messages';
import { isChatGptUrl } from '../shared/urls';
import { TabSessions, type CaptureBackend } from './TabSessions';

/**
 * Orchestration only: action clicks, tab identity, capture startup, the offscreen document's lifecycle, message
 * routing and per-tab enable state. No DOM, no audio processing, no rendering.
 *
 * State lives in memory and the worker is killed after ~30 s idle; the offscreen document (which owns the
 * captures) is the source of truth it recovers from on the next start.
 */

const OFFSCREEN_URL = 'offscreen/index.html';

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
      justification: 'Analyse the ChatGPT tab audio for avatar lip sync and keep it audible while captured.',
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

/** Rebuild state after a worker restart from the captures the offscreen document still holds. */
const ready: Promise<void> = (async () => {
  try {
    if (!(await hasOffscreen())) return;
    const reply = (await toOffscreen({ type: 'capture:list' })) as CaptureListReply | undefined;
    sessions.restore(reply?.tabIds ?? []);
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

chrome.action.onClicked.addListener((tab) => void toggle(tab));

/**
 * After an install or an update, chatgpt.com tabs that are already open hold no content script (the old one, if
 * any, was orphaned by the reload): Chrome only injects into tabs loaded afterwards. Inject into them once, so
 * the extension works without the user reloading every tab.
 */
chrome.runtime.onInstalled.addListener(() => {
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
    case 'capture:ended':
      void ready.then(() => sessions.captureEnded(msg.tabId, msg.reason));
      return;
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
    },
  });
}
