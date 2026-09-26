/**
 * Mouth contract shared by the avatar and lip sync. Kept free of three.js/VRM imports so an audio runtime can use
 * it without pulling in the renderer (the extension's offscreen document must not bundle three).
 */

/** VRM 1.0 mouth presets driven by lip sync. */
export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;
export type Viseme = (typeof VISEMES)[number];

/** Weight per viseme preset, [0, 1] each. */
export type MouthShape = Record<Viseme, number>;

export const CLOSED_MOUTH: Readonly<MouthShape> = Object.freeze({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });

/**
 * Anything that drives the mouth once per frame (amplitude lip sync, viseme analysers, frames from another context).
 * Pulled by AvatarController.update(), so it runs on the render loop's delta.
 */
export interface MouthSource {
  /** @returns mouth openness on "aa", [0, 1], or a weight per viseme preset */
  update(deltaTime: number): number | Readonly<MouthShape>;
}
