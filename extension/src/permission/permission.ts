import { message } from '../shared/messages';

/**
 * One-time microphone grant for the extension origin. The offscreen document that runs the analysis can't show a
 * permission prompt, so the service worker opens this visible page when the grant is missing. The track is stopped
 * the moment it opens: nothing is analysed here.
 */
const status = document.getElementById('status')!;

async function ask(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    for (const track of stream.getTracks()) track.stop();
    status.textContent = 'Microphone allowed. Microphone reactions are on; this tab closes itself.';
    await chrome.runtime.sendMessage(message({ type: 'mic:granted' }));
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    status.textContent =
      name === 'NotAllowedError'
        ? 'Microphone blocked. Allow it for Prosopon in the address bar (or chrome://settings/content/microphone), ' +
          'then reload this page. The avatar and lip sync keep working without it.'
        : `No microphone available (${name ?? 'unknown error'}). The avatar and lip sync keep working without it.`;
  }
}

void ask();
