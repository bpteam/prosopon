import GUI, { type Controller } from 'lil-gui';
import * as THREE from 'three';
import type { Avatar } from './Avatar';
import type { AvatarIdleController } from './AvatarIdleController';

const FACE = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
const BLINK = ['blink', 'blinkLeft', 'blinkRight'] as const;
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

export interface DebugPanelHooks {
  /** Show/hide the stats overlay. */
  setOverlayVisible?: (visible: boolean) => void;
  overlayVisible?: boolean;
}

/**
 * lil-gui panel. Talks to Avatar / AvatarIdleController public API only.
 */
export class AvatarDebugPanel {
  readonly gui: GUI;

  private readonly avatar: Avatar;
  private readonly expressionControllers: Controller[] = [];
  private readonly expressionValues: Record<string, number> = {};

  constructor(avatar: Avatar, idle: AvatarIdleController, hooks: DebugPanelHooks = {}) {
    this.avatar = avatar;
    this.gui = new GUI({ title: 'Avatar Sandbox' });
    this.gui.domElement.dataset.testid = 'debug-panel';

    this.buildHead();
    this.buildExpressions('Face', FACE);
    this.buildExpressions('Blink', BLINK);
    this.buildExpressions('Mouth', MOUTH);
    this.buildTransform();
    this.buildIdle(idle);

    const view = { overlay: hooks.overlayVisible ?? true };
    if (hooks.setOverlayVisible) {
      const setOverlay = hooks.setOverlayVisible;
      this.gui.add(view, 'overlay').name('stats overlay').onChange((v: boolean) => setOverlay(v));
    }
    this.gui.add({ reset: () => this.resetExpressions() }, 'reset').name('reset expressions');
  }

  dispose(): void {
    this.gui.destroy();
  }

  private buildHead(): void {
    const folder = this.gui.addFolder('Head');
    const head = { headYaw: 0, headPitch: 0, headRoll: 0 };
    const apply = () =>
      this.avatar.setHeadRotation(
        THREE.MathUtils.degToRad(head.headYaw),
        THREE.MathUtils.degToRad(head.headPitch),
        THREE.MathUtils.degToRad(head.headRoll),
      );
    folder.add(head, 'headYaw', -45, 45, 0.5).name('headYaw°').onChange(apply);
    folder.add(head, 'headPitch', -30, 30, 0.5).name('headPitch°').onChange(apply);
    folder.add(head, 'headRoll', -30, 30, 0.5).name('headRoll°').onChange(apply);
  }

  private buildExpressions(title: string, names: readonly string[]): void {
    const folder = this.gui.addFolder(title);
    for (const name of names) {
      this.expressionValues[name] = 0;
      const supported = this.avatar.hasExpression(name);
      const controller = folder
        .add(this.expressionValues, name, 0, 1, 0.01)
        .name(supported ? name : `${name} (n/a)`)
        .onChange((v: number) => this.avatar.setExpression(name, v));
      if (!supported) controller.disable();
      this.expressionControllers.push(controller);
    }
  }

  private buildTransform(): void {
    const folder = this.gui.addFolder('Avatar');
    const t = { positionX: 0, positionY: 0, positionZ: 0, rotationY: 0, scale: 1 };
    const applyPosition = () => this.avatar.setPosition(t.positionX, t.positionY, t.positionZ);
    folder.add(t, 'positionX', -1, 1, 0.01).onChange(applyPosition);
    folder.add(t, 'positionY', -1, 1, 0.01).onChange(applyPosition);
    folder.add(t, 'positionZ', -1, 1, 0.01).onChange(applyPosition);
    folder
      .add(t, 'rotationY', -180, 180, 1)
      .name('rotationY°')
      .onChange((v: number) => this.avatar.setRotationY(THREE.MathUtils.degToRad(v)));
    folder.add(t, 'scale', 0.25, 2, 0.01).onChange((v: number) => this.avatar.setScale(v));
    folder.close();
  }

  private buildIdle(idle: AvatarIdleController): void {
    const folder = this.gui.addFolder('Idle');
    const c = idle.config;
    folder.add(c, 'enabled').name('idleEnabled');
    folder.add(c, 'breathingIntensity', 0, 1, 0.01);
    folder.add(c, 'breathingRate', 0.15, 0.35, 0.01).name('breathingRate (Hz)');
    folder.add(c, 'headMotionIntensity', 0, 1, 0.01);
    folder.add(c, 'eyeMotionIntensity', 0, 1, 0.01);
    folder.add(c, 'blinkEnabled');
    folder.add({ blinkNow: () => idle.triggerBlink() }, 'blinkNow').name('blink now');
  }

  private resetExpressions(): void {
    this.avatar.resetExpressions();
    for (const key of Object.keys(this.expressionValues)) this.expressionValues[key] = 0;
    for (const c of this.expressionControllers) c.updateDisplay();
  }
}
