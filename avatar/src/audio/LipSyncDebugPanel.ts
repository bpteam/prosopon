import type GUI from 'lil-gui';
import type { AmplitudeLipSync } from './AmplitudeLipSync';
import { AudioInputSupersededError, type AudioInput } from './AudioInput';

/**
 * "Lip Sync" folder of the sandbox GUI: source selection (file / mic / test signal), mapping and
 * smoothing parameters, live level and mouth readouts.
 */
export class LipSyncDebugPanel {
  readonly folder: GUI;

  private readonly fileInput: HTMLInputElement;
  private readonly view = { status: 'no source' };
  private readonly unsubscribe: () => void;

  constructor(parent: GUI, input: AudioInput, lipSync: AmplitudeLipSync) {
    this.folder = parent.addFolder('Lip Sync');
    this.folder.domElement.dataset.testid = 'lipsync-panel';

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'audio/*';
    this.fileInput.hidden = true;
    this.fileInput.dataset.testid = 'lipsync-file';
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) this.run(`file: ${file.name}`, () => input.playFile(file));
    });
    document.body.appendChild(this.fileInput);

    const actions = {
      file: () => this.fileInput.click(),
      mic: () => this.run('microphone', () => input.startMic()),
      test: () => this.run('test signal', () => input.startTestSignal()),
      stop: () => input.stop(),
    };
    this.folder.add(actions, 'file').name('play audio file…');
    this.folder.add(actions, 'mic').name('microphone');
    this.folder.add(actions, 'test').name('test signal');
    this.folder.add(actions, 'stop').name('stop');
    this.folder.add(this.view, 'status').name('source').disable().listen();

    const c = lipSync.config;
    this.folder.add(c, 'enabled');
    this.folder.add(c, 'gainDb', -20, 30, 0.5).name('gain (dB)');
    this.folder.add(c, 'noiseFloorDb', -90, -20, 1).name('noise floor (dBFS)');
    this.folder.add(c, 'fullOpenDb', -60, 0, 1).name('full open (dBFS)');
    this.folder.add(c, 'maxOpen', 0, 1, 0.01).name('max open');
    this.folder.add(c, 'attack', 0.005, 0.2, 0.005).name('attack (s)');
    this.folder.add(c, 'release', 0.01, 0.5, 0.005).name('release (s)');

    const meters = {
      get level() {
        return Math.round(lipSync.levelDb);
      },
      get mouth() {
        return Math.round(lipSync.value * 100) / 100;
      },
    };
    this.folder.add(meters, 'level', -100, 0).name('level (dBFS)').disable().listen();
    this.folder.add(meters, 'mouth', 0, 1).name('mouth "aa"').disable().listen();

    this.unsubscribe = input.onKindChange((kind) => {
      if (kind === 'none') this.view.status = 'no source';
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.fileInput.remove();
    this.folder.destroy();
  }

  private run(label: string, start: () => Promise<void>): void {
    this.view.status = `starting ${label}…`;
    start().then(
      () => (this.view.status = label),
      (error: unknown) => {
        if (error instanceof AudioInputSupersededError) return;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[LipSync] ${label} failed:`, error);
        this.view.status = `error: ${message}`;
      },
    );
  }
}
