import { CAMERA_ADJUST_LIMITS, CAMERA_PRESETS, type CameraPreset } from '@avatar/renderer/CameraFraming';
import { AVATAR_SCALE, isCameraModified, snapScale } from '../../shared/settings';
import { h, setText, svg } from '../shared/dom';
import { ICONS, PRESET_SILHOUETTES } from '../shared/icons';
import type { DevBridge, PoseOffsets } from './DevBridge';
import { presetLabel, type Panel } from './panels';
import { card, sliderRow, switchRow } from './widgets';

/** Camera presets, manual corrections, size and position: the persisted layout (AvatarViewSettingsV1). */
export function cameraPanel(doc: Document, bridge: DevBridge): Panel {
  const presetButtons = CAMERA_PRESETS.map((preset) => {
    const b = h(doc, 'button', { type: 'button', class: 'preset', 'aria-pressed': 'false', 'data-testid': `camera-${preset}` });
    b.append(svg(doc, PRESET_SILHOUETTES[preset], ''), doc.createTextNode(presetLabel(preset)));
    b.addEventListener('click', () => bridge.view.update({ camera: { preset } }, 'now'));
    return [preset, b] as const;
  });
  const status = h(doc, 'p', { class: 'note', 'data-testid': 'camera-status' });
  const L = CAMERA_ADJUST_LIMITS;
  const camera = (key: 'distanceOffset' | 'targetYOffset' | 'yaw' | 'pitch', label: string, step: number, format: (v: number) => string) =>
    sliderRow(
      doc,
      label,
      { min: L[key][0], max: L[key][1], step },
      bridge.view.value.camera[key],
      format,
      (v) => bridge.view.update({ camera: { [key]: v } }),
      (v) => bridge.view.update({ camera: { [key]: v } }, 'now'),
      `camera-${key}`,
    );
  const sliders = {
    distanceOffset: camera('distanceOffset', 'Distance', 0.01, (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)} %`),
    targetYOffset: camera('targetYOffset', 'Target height', 0.01, (v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)} %`),
    yaw: camera('yaw', 'Yaw', 1, (v) => `${v.toFixed(0)}°`),
    pitch: camera('pitch', 'Pitch', 1, (v) => `${v.toFixed(0)}°`),
  };
  const size = sliderRow(
    doc,
    'Avatar size',
    AVATAR_SCALE,
    bridge.view.value.placement.scale,
    (v) => `${Math.round(v * 100)} %`,
    (v) => bridge.view.update({ placement: { scale: snapScale(v) } }),
    (v) => bridge.view.update({ placement: { scale: snapScale(v) } }, 'now'),
    'avatar-size',
  );
  const reset = h(doc, 'button', { type: 'button', 'data-testid': 'camera-reset' }, svg(doc, ICONS.reset, 'icon s'), 'Reset camera');
  reset.addEventListener('click', () => bridge.view.resetCamera());
  const moveLabel = h(doc, 'span', {}, 'Move avatar');
  const move = h(doc, 'button', { type: 'button', 'data-testid': 'move-avatar' }, svg(doc, ICONS.move, 'icon s'), moveLabel);
  move.addEventListener('click', () => bridge.setPlacementMode(!bridge.placementMode));
  const update = () => {
    const v = bridge.view.value;
    for (const [preset, b] of presetButtons) b.setAttribute('aria-pressed', String(preset === v.camera.preset));
    setText(status, `${presetLabel(v.camera.preset)}${isCameraModified(v.camera) ? ' · modified' : ''}`);
    for (const key of Object.keys(sliders) as (keyof typeof sliders)[]) sliders[key].set(v.camera[key]);
    size.set(v.placement.scale);
    setText(moveLabel, bridge.placementMode ? 'Finish moving' : 'Move avatar');
  };
  update();
  return {
    el: h(
      doc,
      'div',
      { class: 'tab-panel-inner' },
      card(doc, 'Camera presets', h(doc, 'div', { class: 'presets' }, presetButtons.map(([, b]) => b)), status),
      card(doc, 'Adjust', ...Object.values(sliders).map((s) => s.el), h(doc, 'div', { class: 'actions' }, reset)),
      card(doc, 'Placement', size.el, h(doc, 'div', { class: 'actions' }, move)),
    ),
    update,
    draw() {},
  };
}

/** Expression tests: manual layer only, inside an explicit preview that mutes the procedural emotion. */
const EXPRESSIONS: [label: string, names: string[]][] = [
  ['Neutral', []],
  ['Happy', ['happy']],
  ['Sad', ['sad']],
  ['Angry', ['angry']],
  ['Relaxed', ['relaxed']],
  ['Surprised', ['surprised']],
  ['Blink', ['blink']],
  ['Wink Left', ['blinkLeft']],
  ['Wink Right', ['blinkRight']],
];

export function expressionPanel(doc: Document, bridge: DevBridge): Panel {
  const preview = switchRow(doc, 'Expression preview', bridge.avatar.expressionPreview, (on) => bridge.avatar.setExpressionPreview(on), 'prosopon-expression-preview');
  let active: string | null = null;
  const buttons = EXPRESSIONS.map(([label, names]) => {
    const b = h(doc, 'button', { type: 'button', 'aria-pressed': 'false', 'data-testid': `expression-${label.toLowerCase().replace(' ', '-')}` }, label);
    b.addEventListener('click', () => {
      bridge.avatar.setExpressionPreview(true);
      bridge.avatar.clearExpressions();
      for (const n of names) bridge.avatar.previewExpression(n, 1);
      active = label;
      update();
    });
    return [label, names, b] as const;
  });
  const update = () => {
    const on = bridge.avatar.expressionPreview;
    if (preview.input.checked !== on) preview.input.checked = on;
    if (!on) active = null;
    for (const [label, names, b] of buttons) {
      const missing = names.filter((n) => !bridge.avatar.hasExpression(n));
      const loaded = bridge.avatar.listExpressions().length > 0;
      b.disabled = loaded && missing.length > 0;
      setText(b, b.disabled ? `${label} (n/a)` : label);
      b.setAttribute('aria-pressed', String(on && active === label));
    }
  };
  update();
  return {
    el: h(
      doc,
      'div',
      {},
      card(
        doc,
        'Expressions',
        preview.el,
        h(doc, 'p', { class: 'note' }, 'While the preview is on, emotion from both voices is faded out so the test expression is what you see. Turning it off gives the face back to the procedural layer.'),
        h(doc, 'div', { class: 'btn-grid' }, buttons.map(([, , b]) => b)),
      ),
    ),
    update,
    draw() {},
  };
}

export function posePanel(doc: Document, bridge: DevBridge): Panel {
  const specs: [keyof PoseOffsets, string, number, number][] = [
    ['headYaw', 'Head yaw', -45, 45],
    ['headPitch', 'Head pitch', -30, 30],
    ['headRoll', 'Head roll', -30, 30],
    ['lean', 'Upper body lean', -15, 15],
    ['shoulders', 'Shoulders', -10, 15],
    ['arms', 'Arms', -10, 60],
  ];
  const sliders = specs.map(([key, label, min, max]) => {
    const s = sliderRow(doc, label, { min, max, step: 0.5 }, bridge.avatar.poseOffsets[key], (v) => `${v.toFixed(1)}°`, (v) =>
      bridge.avatar.setPoseOffsets({ [key]: v }),
    );
    return [key, s] as const;
  });
  const reset = h(doc, 'button', { type: 'button', 'data-testid': 'pose-reset' }, svg(doc, ICONS.reset, 'icon s'), 'Reset pose');
  reset.addEventListener('click', () => {
    bridge.avatar.resetPoseOffsets();
    update();
  });
  const update = () => {
    for (const [key, s] of sliders) s.set(bridge.avatar.poseOffsets[key]);
  };
  return {
    el: card(
      doc,
      'Body pose (manual layer)',
      h(doc, 'p', { class: 'note' }, 'Offsets on top of the rest pose. Procedural motion (idle, gestures, emotion) keeps adding to them.'),
      ...sliders.map(([, s]) => s.el),
      h(doc, 'div', { class: 'actions' }, reset),
    ),
    update,
    draw() {},
  };
}

export function scenePanel(doc: Document, bridge: DevBridge): Panel {
  const transparent = switchRow(doc, 'Transparent background', bridge.scene.transparent, (on) => bridge.scene.setTransparent(on));
  const helper = (key: 'grid' | 'skeleton' | 'axes', label: string) =>
    switchRow(doc, label, bridge.scene.helpers()[key], (on) => bridge.scene.setHelpers({ [key]: on }), `prosopon-helper-${key}`);
  const rows = { grid: helper('grid', 'Grid helper'), skeleton: helper('skeleton', 'Skeleton helper'), axes: helper('axes', 'Axes helper') };
  return {
    el: card(
      doc,
      'Scene',
      transparent.el,
      ...Object.values(rows).map((r) => r.el),
      h(doc, 'p', { class: 'note' }, 'Helpers exist only while switched on in Developer mode; turning Developer mode off removes them.'),
    ),
    update() {
      const hs = bridge.scene.helpers();
      for (const key of ['grid', 'skeleton', 'axes'] as const) if (rows[key].input.checked !== hs[key]) rows[key].input.checked = hs[key];
      if (transparent.input.checked !== bridge.scene.transparent) transparent.input.checked = bridge.scene.transparent;
    },
    draw() {},
  };
}

/** Bottom quick toolbar: [Face] [Waist] [Full body] | [−] 150 % [+] | Move | Reset. */
export function quickToolbar(doc: Document, bridge: DevBridge): Panel {
  const presets = CAMERA_PRESETS.map((preset: CameraPreset) => {
    const b = h(doc, 'button', { type: 'button', 'aria-pressed': 'false', 'data-testid': `toolbar-${preset}` }, presetLabel(preset));
    b.addEventListener('click', () => bridge.view.update({ camera: { preset } }, 'now'));
    return [preset, b] as const;
  });
  const scaleBy = (d: number) => bridge.view.update({ placement: { scale: snapScale(bridge.view.value.placement.scale + d) } }, 'now');
  const minus = h(doc, 'button', { type: 'button', class: 'icon-only', 'aria-label': 'Smaller avatar', 'data-testid': 'toolbar-smaller' }, svg(doc, ICONS.minus, 'icon s'));
  minus.addEventListener('click', () => scaleBy(-AVATAR_SCALE.step));
  const plus = h(doc, 'button', { type: 'button', class: 'icon-only', 'aria-label': 'Larger avatar', 'data-testid': 'toolbar-larger' }, svg(doc, ICONS.plus, 'icon s'));
  plus.addEventListener('click', () => scaleBy(AVATAR_SCALE.step));
  const scale = h(doc, 'span', { class: 'scale', 'data-testid': 'toolbar-scale', 'aria-live': 'polite' });
  const move = h(doc, 'button', { type: 'button', 'aria-pressed': 'false', 'data-testid': 'toolbar-move' }, 'Move');
  move.addEventListener('click', () => bridge.setPlacementMode(!bridge.placementMode));
  const reset = h(doc, 'button', { type: 'button', 'data-testid': 'toolbar-reset' }, 'Reset');
  reset.addEventListener('click', () => bridge.view.resetCamera());
  const el = h(
    doc,
    'div',
    { class: 'toolbar', role: 'toolbar', 'aria-label': 'Avatar camera', 'data-testid': 'quick-toolbar' },
    presets.map(([, b]) => b),
    h(doc, 'span', { class: 'sep' }),
    minus,
    scale,
    plus,
    h(doc, 'span', { class: 'sep' }),
    move,
    reset,
  );
  const update = () => {
    const v = bridge.view.value;
    for (const [preset, b] of presets) b.setAttribute('aria-pressed', String(preset === v.camera.preset));
    setText(scale, `${Math.round(v.placement.scale * 100)}%`);
    minus.disabled = v.placement.scale <= AVATAR_SCALE.min;
    plus.disabled = v.placement.scale >= AVATAR_SCALE.max;
    move.setAttribute('aria-pressed', String(bridge.placementMode));
  };
  update();
  return { el, update, draw() {} };
}
