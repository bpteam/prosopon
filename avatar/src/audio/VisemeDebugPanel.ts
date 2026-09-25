import type GUI from 'lil-gui';
import { VISEMES } from '../avatar/Avatar';
import type { AnalyzerChoice, VisemeAnalyzerHost } from './VisemeAnalyzerHost';
import type { VisemeLipSync } from './VisemeLipSync';

/** "Visemes" folder: analyser choice and status, viseme blending parameters, live mode and weights. */
export class VisemeDebugPanel {
  readonly folder: GUI;

  constructor(parent: GUI, host: VisemeAnalyzerHost, lipSync: VisemeLipSync) {
    this.folder = parent.addFolder('Visemes');
    this.folder.domElement.dataset.testid = 'viseme-panel';

    const choice = { analyzer: host.selected };
    const options: Record<string, AnalyzerChoice> = { 'none (amplitude)': 'none', HeadAudio: 'headaudio', wLipSync: 'wlipsync' };
    this.folder
      .add(choice, 'analyzer', options)
      .name('analyser')
      .onChange((v: AnalyzerChoice) => host.select(v));
    const view = {
      get status() {
        return host.status;
      },
      get mode() {
        return `${lipSync.mode} (${Math.round(lipSync.visemeWeight * 100)}%)`;
      },
    };
    this.folder.add(view, 'status').disable().listen();
    this.folder.add(view, 'mode').disable().listen();

    const c = lipSync.config;
    this.folder.add(c, 'enabled').name('use analyser');
    this.folder.add(c, 'levelInfluence', 0, 1, 0.05).name('loudness → opening');
    this.folder.add(c, 'attack', 0.005, 0.2, 0.005).name('attack (s)');
    this.folder.add(c, 'release', 0.01, 0.5, 0.005).name('release (s)');
    this.folder.add(c, 'modeBlend', 0.01, 1, 0.01).name('mode crossfade (s)');

    const meters = {} as Record<string, number>;
    for (const v of VISEMES) {
      Object.defineProperty(meters, v, { get: () => Math.round(lipSync.value[v] * 100) / 100, enumerable: true });
      this.folder.add(meters, v, 0, 1).disable().listen();
    }
  }

  dispose(): void {
    this.folder.destroy();
  }
}
