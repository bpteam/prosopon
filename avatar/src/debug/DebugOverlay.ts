import type * as THREE from 'three';
import { FpsMeter } from './FpsMeter';
import type { GestureFrame } from '../avatar/gesture/Gesture';

export interface OverlayInfo {
  loaded: boolean;
  vrmVersion: string | null;
  webgl2: boolean;
}

/**
 * Small stats box. DOM is only touched when the FPS meter publishes a sample (2×/s),
 * not every frame.
 */
export class DebugOverlay {
  readonly meter = new FpsMeter(0.5);
  private readonly el: HTMLPreElement;
  private readonly renderer: THREE.WebGLRenderer;
  private info: OverlayInfo;
  private gesture: (() => Readonly<GestureFrame>) | null = null;
  private gestureKey = '';

  constructor(parent: HTMLElement, renderer: THREE.WebGLRenderer, info: OverlayInfo) {
    this.renderer = renderer;
    this.info = info;
    this.el = document.createElement('pre');
    this.el.className = 'debug-overlay';
    this.el.dataset.testid = 'debug-overlay';
    parent.appendChild(this.el);
    this.draw();
  }

  set visible(v: boolean) {
    this.el.style.display = v ? '' : 'none';
  }

  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  setInfo(info: Partial<OverlayInfo>): void {
    this.info = { ...this.info, ...info };
    this.draw();
  }

  /** Shows the active gesture (type, phase, intensity); redrawn when type or phase change. */
  setGestureProvider(provider: (() => Readonly<GestureFrame>) | null): void {
    this.gesture = provider;
  }

  /** Call after renderer.render(): renderer.info is reset on each render. */
  afterRender(delta: number): void {
    const ticked = this.meter.tick(delta);
    let changed = false;
    if (this.gesture) {
      const g = this.gesture();
      const key = `${g.type}:${g.phase}`;
      changed = key !== this.gestureKey;
      this.gestureKey = key;
    }
    if ((ticked || changed) && this.visible) this.draw();
  }

  dispose(): void {
    this.el.remove();
  }

  private draw(): void {
    const r = this.renderer.info.render;
    this.el.textContent =
      `FPS         ${this.meter.fps.toFixed(0)}\n` +
      `frame       ${this.meter.frameTime.toFixed(2)} ms\n` +
      `VRM loaded  ${this.info.loaded ? 'yes' : 'no'}\n` +
      `VRM version ${this.info.vrmVersion ?? '-'}\n` +
      `renderer    ${this.info.webgl2 ? 'WebGL2' : 'WebGL'}\n` +
      `triangles   ${r.triangles}\n` +
      `draw calls  ${r.calls}`;
    if (this.gesture) {
      const g = this.gesture();
      this.el.textContent +=
        `\ngesture     ${g.type ?? '—'}` + (g.active ? ` · ${g.phase} · ${g.intensity.toFixed(2)}` : '');
      this.el.dataset.gesture = g.type ?? '';
      this.el.dataset.gesturePhase = g.phase;
    }
  }
}
