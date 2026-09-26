import { AVATAR_SCALE, BASE_BOX_HEIGHT, snapScale, type AvatarPlacement, type Viewport } from '../../shared/settings';
import { h, svg } from '../shared/dom';
import { ICONS } from '../shared/icons';

export const PLACEMENT_CSS = `
.placement {
  position: absolute; border: 1.5px dashed rgba(255,100,34,.9); border-radius: var(--radius-panel);
  background: rgba(255,100,34,.06); cursor: move; touch-action: none; box-shadow: 0 0 0 9999px rgba(8,11,15,.18);
}
.placement:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
.placement .grip {
  position: absolute; right: -9px; bottom: -9px; width: 18px; height: 18px; border-radius: 50%;
  background: var(--accent); border: 2px solid #fff; cursor: nwse-resize; touch-action: none;
}
.placement .hint {
  position: absolute; left: 50%; top: -46px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  white-space: nowrap; background: rgba(16,21,28,.96); border: 1px solid var(--border-strong); border-radius: 10px;
  padding: 6px 6px 6px 12px; font: 500 12px/1 var(--font); color: var(--text-secondary); cursor: default;
}
`;

export interface PlacementBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlacementHandleOptions {
  viewport(): Viewport;
  /** Placement changed by a drag (final on pointerup / key release). */
  onChange(change: Partial<AvatarPlacement>, final: boolean): void;
  /** Done button or Escape. */
  onDone(): void;
}

/**
 * "Move avatar": a draggable box over the avatar's presentation box. Dragging moves its centre (x, y as viewport
 * fractions), the corner grip resizes it (the avatar size), arrow keys nudge. Exists only while placement mode is
 * on: the render canvas itself never takes pointer events.
 */
export class PlacementHandle {
  readonly el: HTMLDivElement;
  private box: PlacementBox = { left: 0, top: 0, width: 0, height: 0 };

  constructor(doc: Document, private readonly options: PlacementHandleOptions) {
    const done = h(doc, 'button', { type: 'button', class: 'primary', 'data-testid': 'placement-done' }, 'Done');
    done.addEventListener('click', () => options.onDone());
    const hint = h(doc, 'div', { class: 'hint' }, svg(doc, ICONS.move, 'icon s'), 'Drag to move · corner to resize', done);
    hint.addEventListener('pointerdown', (e) => e.stopPropagation());
    const grip = h(doc, 'div', { class: 'grip', 'aria-hidden': 'true' });
    this.el = h(doc, 'div', {
      class: 'placement',
      role: 'application',
      tabindex: 0,
      'aria-label': 'Avatar placement. Drag or use arrow keys to move, plus and minus to resize, Escape to finish.',
      'data-testid': 'placement-handle',
    });
    this.el.append(hint, grip);
    this.el.addEventListener('pointerdown', (e) => this.drag(e as PointerEvent, 'move'));
    grip.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.drag(e as PointerEvent, 'resize');
    });
    this.el.addEventListener('keydown', (e) => this.onKey(e as KeyboardEvent));
  }

  /** Follows the stage's presentation box (after every reframe). */
  setBox(box: PlacementBox): void {
    this.box = box;
    const s = this.el.style;
    s.left = `${Math.round(box.left)}px`;
    s.top = `${Math.round(box.top)}px`;
    s.width = `${Math.round(box.width)}px`;
    s.height = `${Math.round(box.height)}px`;
  }

  dispose(): void {
    this.el.remove();
  }

  private placementFor(box: PlacementBox): Partial<AvatarPlacement> {
    const v = this.options.viewport();
    return {
      x: clamp01((box.left + box.width / 2) / Math.max(1, v.width)),
      y: clamp01((box.top + box.height / 2) / Math.max(1, v.height)),
    };
  }

  private drag(e: PointerEvent, kind: 'move' | 'resize'): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const start = { ...this.box, px: e.clientX, py: e.clientY };
    const viewport = this.options.viewport();
    const onMove = (ev: Event) => {
      const m = ev as PointerEvent;
      const dx = m.clientX - start.px;
      const dy = m.clientY - start.py;
      if (kind === 'move') {
        this.options.onChange(this.placementFor({ ...start, left: start.left + dx, top: start.top + dy }), false);
      } else {
        // Resizing from the corner keeps the box centre; the diagonal drag grows it by twice the distance.
        const height = start.height + dy + (dx * start.height) / Math.max(1, start.width);
        this.options.onChange({ scale: snapScale(height / (Math.max(1, viewport.height) * BASE_BOX_HEIGHT)) }, false);
      }
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      this.options.onChange({}, true);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  private onKey(e: KeyboardEvent): void {
    const step = e.shiftKey ? 40 : 8;
    const b = this.box;
    let change: Partial<AvatarPlacement> | null = null;
    if (e.key === 'Escape' || e.key === 'Enter') {
      this.options.onDone();
    } else if (e.key === 'ArrowLeft') change = this.placementFor({ ...b, left: b.left - step });
    else if (e.key === 'ArrowRight') change = this.placementFor({ ...b, left: b.left + step });
    else if (e.key === 'ArrowUp') change = this.placementFor({ ...b, top: b.top - step });
    else if (e.key === 'ArrowDown') change = this.placementFor({ ...b, top: b.top + step });
    else if (e.key === '+' || e.key === '=' || e.key === '-') {
      const v = this.options.viewport();
      const scale = b.height / (Math.max(1, v.height) * BASE_BOX_HEIGHT);
      change = { scale: snapScale(scale + (e.key === '-' ? -AVATAR_SCALE.step : AVATAR_SCALE.step)) };
    } else return;
    e.preventDefault();
    e.stopPropagation();
    if (change) this.options.onChange(change, true);
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
