import { LIPSYNC_PORT, describeError, message, parseMessage, type ExtensionMessage } from '../shared/messages';
import type { AvatarRuntimeHandle, AvatarRuntimeOptions } from './avatar-runtime';
import { OVERLAY_ROOT_ID, UI_ROOT_ID } from './AvatarOverlay';
import { ContentLifecycle, type ContentLifecycleDeps } from './ContentLifecycle';

/**
 * Content script on chatgpt.com. Deliberately thin: it only talks to the service worker and the offscreen
 * document. The avatar (three.js, three-vrm, the ChatGPT adapter) is imported on activation, so a disabled
 * extension costs ChatGPT one small script and no observers.
 */

/** DOM event, so it crosses isolated worlds: a new instance tells a previous one (orphaned by a reload) to go. */
const TAKEOVER_EVENT = 'prosopon:takeover';

const isExtensionAlive = (): boolean => {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
};

function start(): void {
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
  // An orphan whose world is gone can't answer the event: drop its root directly.
  document.getElementById(OVERLAY_ROOT_ID)?.remove();
  document.getElementById(UI_ROOT_ID)?.remove();

  const reportError = (error: unknown) => {
    const text = describeError(error);
    console.warn('[prosopon]', text);
    if (isExtensionAlive()) void chrome.runtime.sendMessage(message({ type: 'extension:error', error: text })).catch(() => {});
  };

  const deps: ContentLifecycleDeps = {
    async mount(): Promise<AvatarRuntimeHandle> {
      const runtime = (await import(/* @vite-ignore */ chrome.runtime.getURL('avatar-runtime.js'))) as {
        mountAvatar(options: AvatarRuntimeOptions): AvatarRuntimeHandle;
      };
      return runtime.mountAvatar({
        assetUrl: (path) => chrome.runtime.getURL(path),
        debug: import.meta.env.DEV,
        onError: reportError,
        sendToOffscreen: (payload) => lifecycle.send(payload),
        sendToWorker: (payload) => chrome.runtime.sendMessage(message(payload)),
      });
    },
    connect(onMessage, onDisconnect) {
      const port = chrome.runtime.connect({ name: LIPSYNC_PORT });
      port.onMessage.addListener((raw) => {
        const msg = parseMessage(raw);
        if (msg) onMessage(msg);
      });
      port.onDisconnect.addListener(onDisconnect);
      return { disconnect: () => port.disconnect(), send: (payload) => port.postMessage(message(payload)) };
    },
    async requestState() {
      if (!isExtensionAlive()) return null;
      try {
        const reply = parseMessage(await chrome.runtime.sendMessage(message({ type: 'tab:hello' })));
        return reply?.type === 'tab:state' ? { state: reply.state, error: reply.error } : null;
      } catch {
        return null;
      }
    },
    isExtensionAlive,
    schedule: (fn, ms) => void setTimeout(fn, ms),
    onError: reportError,
  };
  const lifecycle = new ContentLifecycle(deps);

  // Development only: a page-world hook for driving the audio runtime from an integration test on the real site.
  //   document.dispatchEvent(new CustomEvent('prosopon:debug', { detail: { analyzer: 'none' } }))
  //   document.dispatchEvent(new CustomEvent('prosopon:debug', { detail: { emotionConfig: { baselineWeight: 0.3 } } }))
  const onDebugEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ analyzer?: unknown; emotionConfig?: unknown }>).detail;
    const choice = detail?.analyzer;
    if (choice === 'headaudio' || choice === 'wlipsync' || choice === 'none') {
      lifecycle.send({ type: 'debug:analyzer', choice });
    }
    const config = detail?.emotionConfig;
    if (config && typeof config === 'object') {
      // Validated again by the offscreen document (parseMessage): numbers only.
      lifecycle.send({ type: 'debug:emotion-config', config: config as Record<string, number> });
    }
  };
  if (import.meta.env.DEV) document.addEventListener('prosopon:debug', onDebugEvent);

  const onTakeover = () => {
    document.removeEventListener(TAKEOVER_EVENT, onTakeover);
    document.removeEventListener('prosopon:debug', onDebugEvent);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    lifecycle.dispose();
  };
  // Registered after dispatching, so the instance doesn't take itself over.
  document.addEventListener(TAKEOVER_EVENT, onTakeover);

  function onRuntimeMessage(raw: unknown): void {
    const msg: ExtensionMessage | null = parseMessage(raw);
    if (msg?.type === 'tab:state') void lifecycle.apply(msg.state, msg.error);
    // Popup → "Move avatar": only meaningful while the avatar is mounted in this tab.
    else if (msg?.type === 'ui:placement') lifecycle.mounted?.setPlacementMode(msg.active);
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // E2E/dev marker that the content script runs; production builds leave the page untouched until enabled.
  if (import.meta.env.DEV) document.documentElement.dataset.prosoponContent = 'ready';

  // Page load or refresh: the tab may already be enabled (the capture survives reloads).
  void deps.requestState().then((s) => s && lifecycle.apply(s.state, s.error));
}

start();
