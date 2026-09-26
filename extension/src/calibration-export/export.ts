import { message, type CalibrationBundleInfo } from '../shared/messages';

/**
 * Export page of the calibration wizard. The offscreen document holds the finished ZIP as a same-origin blob URL;
 * this page only receives that URL and lets the browser download it. Discard destroys the recordings.
 */

const status = document.getElementById('status')!;
const download = document.getElementById('download') as HTMLAnchorElement;
const discard = document.getElementById('discard') as HTMLButtonElement;

function isBundle(raw: unknown): raw is CalibrationBundleInfo {
  const b = raw as Record<string, unknown> | null;
  return !!b && typeof b.name === 'string' && typeof b.url === 'string' && b.url.startsWith('blob:') && typeof b.bytes === 'number';
}

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

async function main(): Promise<void> {
  const reply: unknown = await chrome.runtime.sendMessage(message({ type: 'calibration:bundle' })).catch(() => null);
  if (!isBundle(reply)) {
    status.textContent = 'No calibration bundle is waiting. Run the calibration again from Developer Tools → Calibration.';
    return;
  }
  status.textContent = `${reply.name} · ${megabytes(reply.bytes)}`;
  download.href = reply.url;
  download.download = reply.name;
  download.hidden = false;
  discard.hidden = false;
  download.click();
}

discard.addEventListener('click', () => {
  void chrome.runtime.sendMessage(message({ type: 'calibration:discard', requestId: 0 })).finally(() => {
    download.hidden = true;
    discard.hidden = true;
    status.textContent = 'Recordings discarded.';
  });
});

void main();
