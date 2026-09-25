import GUI, { type Controller } from 'lil-gui';
import * as THREE from 'three';
import type { AvatarController } from './AvatarController';
import { AVATAR_STATES, type AvatarState } from './AvatarStateProfiles';

const FACE = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;
const BLINK = ['blink', 'blinkLeft', 'blinkRight'] as const;
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

export interface DebugPanelHooks {
  /** Show/hide the stats overlay. */
  setOverlayVisible?: (visible: boolean) => void;
  overlayVisible?: boolean;
}

/**
 * lil-gui panel. Talks to AvatarController only (plus its low-level Avatar for the scene transform).
 */
export class AvatarDebugPanel {
  readonly gui: GUI;

  private readonly controller: AvatarController;
  private readonly expressionControllers: Controller[] = [];
  private readonly expressionValues: Record<string, number> = {};
  private readonly disposers: (() => void)[] = [];

  constructor(controller: AvatarController, hooks: DebugPanelHooks = {}) {
    this.controller = controller;
    this.gui = new GUI({ title: 'Avatar Sandbox' });
    this.gui.domElement.dataset.testid = 'debug-panel';

    this.buildState();
    this.buildHead();
    this.buildExpressions('Face', FACE);
    this.buildExpressions('Blink', BLINK);
    this.buildExpressions('Mouth', MOUTH);
    this.buildTransform();
    this.buildIdle();

    const view = { overlay: hooks.overlayVisible ?? true };
    if (hooks.setOverlayVisible) {
      const setOverlay = hooks.setOverlayVisible;
      this.gui.add(view, 'overlay').name('stats overlay').onChange((v: boolean) => setOverlay(v));
    }
    this.gui.add({ reset: () => this.resetExpressions() }, 'reset').name('reset expressions');
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.gui.destroy();
  }

  private buildState(): void {
    const folder = this.gui.addFolder('Conversation State');
    const view = { state: this.controller.getState() };
    const select = folder
      .add(view, 'state', [...AVATAR_STATES])
      .name('state')
      .onChange((v: AvatarState) => this.controller.setState(v));
    // Reflect changes made through the API (providers, devtools), not only through this panel.
    this.disposers.push(
      this.controller.onStateChange((state) => {
        view.state = state;
        select.updateDisplay();
      }),
    );
  }

  private buildHead(): void {
    const folder = this.gui.addFolder('Head');
    const head = { headYaw: 0, headPitch: 0, headRoll: 0 };
    const apply = () =>
      this.controller.setHeadRotation(
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
      const supported = this.controller.hasExpression(name);
      const controller = folder
        .add(this.expressionValues, name, 0, 1, 0.01)
        .name(supported ? name : `${name} (n/a)`)
        .onChange((v: number) => this.controller.setExpression(name, v));
      if (!supported) controller.disable();
      this.expressionControllers.push(controller);
    }
  }

  private buildTransform(): void {
    const folder = this.gui.addFolder('Avatar');
    const avatar = this.controller.avatar;
    const t = { positionX: 0, positionY: 0, positionZ: 0, rotationY: 0, scale: 1 };
    const applyPosition = () => avatar.setPosition(t.positionX, t.positionY, t.positionZ);
    folder.add(t, 'positionX', -1, 1, 0.01).onChange(applyPosition);
    folder.add(t, 'positionY', -1, 1, 0.01).onChange(applyPosition);
    folder.add(t, 'positionZ', -1, 1, 0.01).onChange(applyPosition);
    folder
      .add(t, 'rotationY', -180, 180, 1)
      .name('rotationY°')
      .onChange((v: number) => avatar.setRotationY(THREE.MathUtils.degToRad(v)));
    folder.add(t, 'scale', 0.25, 2, 0.01).onChange((v: number) => avatar.setScale(v));
    folder.close();
  }

  private buildIdle(): void {
    const folder = this.gui.addFolder('Idle');
    const c = this.controller.idle.config;
    const toggle = { idleEnabled: this.controller.idleEnabled };
    folder.add(toggle, 'idleEnabled').onChange((v: boolean) => this.controller.setIdleEnabled(v));
    folder.add(c, 'breathingIntensity', 0, 1, 0.01);
    folder.add(c, 'breathingRate', 0.15, 0.35, 0.01).name('breathingRate (Hz)');
    folder.add(c, 'headMotionIntensity', 0, 1, 0.01);
    folder.add(c, 'eyeMotionIntensity', 0, 1, 0.01);
    folder.add(c, 'blinkEnabled');
    folder.add({ blinkNow: () => this.controller.triggerBlink() }, 'blinkNow').name('blink now');
  }

  private resetExpressions(): void {
    this.controller.resetExpressions();
    for (const key of Object.keys(this.expressionValues)) this.expressionValues[key] = 0;
    for (const c of this.expressionControllers) c.updateDisplay();
  }
}
