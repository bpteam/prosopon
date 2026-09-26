import { isEmotionModelInstallState, message, parseMessage, type EmotionModelInstallState } from '../shared/messages';
const $ = (id: string) => document.getElementById(id)!;
const status = $('status'), progress = $('progress'), bar = $('bar') as HTMLProgressElement, bytes = $('bytes'), error = $('error');
const install = $('install') as HTMLButtonElement, cancel = $('cancel') as HTMLButtonElement, disable = $('disable') as HTMLButtonElement, remove = $('remove') as HTMLButtonElement;
function send(payload: Parameters<typeof message>[0]) { return chrome.runtime.sendMessage(message(payload)); }
function render(raw: EmotionModelInstallState) {
  const s = raw; status.textContent = s.status === 'not-installed' ? 'Not installed' : s.status[0]!.toUpperCase() + s.status.slice(1);
  const busy = ['downloading', 'verifying', 'initializing'].includes(s.status); progress.classList.toggle('hidden', !busy); cancel.classList.toggle('hidden', !busy);
  install.classList.toggle('hidden', busy || s.status === 'ready'); disable.classList.toggle('hidden', s.status !== 'ready'); remove.classList.toggle('hidden', !s.installed && s.status !== 'ready' && s.status !== 'disabled');
  install.textContent = s.status === 'disabled' ? 'Enable' : s.status === 'error' ? 'Retry' : 'Install & Enable';
  if (s.downloaded !== undefined) { bar.value = s.downloaded; bytes.textContent = `${(s.downloaded / 1048576).toFixed(1)} / 48.3 MB`; }
  error.classList.toggle('hidden', !s.error); error.textContent = s.error ?? '';
}
chrome.runtime.onMessage.addListener((raw) => { const msg = parseMessage(raw); if (msg?.type === 'emotion:model-state') render(msg.state); });
install.onclick = () => { if (confirm('Emotion ML runs locally. It downloads approximately 51 MB. Voice audio is processed on your device and is not sent to the model provider.')) void send({ type: 'emotion:model-install', enable: true }); };
cancel.onclick = () => void send({ type: 'emotion:model-cancel' }); disable.onclick = () => void send({ type: 'emotion:model-enable', enabled: false }); remove.onclick = () => void send({ type: 'emotion:model-remove' });
void send({ type: 'emotion:model-info' }).then((r) => { if (isEmotionModelInstallState(r)) render(r); });
