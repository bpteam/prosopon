# Avatar sandbox (US-001)

Standalone browser sandbox for developing the VRM avatar renderer. It has no dependencies on ChatGPT or Chrome Extension APIs.

```bash
npm install
npm run dev          # http://localhost:5173/
npm test             # Vitest unit tests
npm run test:e2e     # Playwright smoke tests (starts the dev server itself)
npm run typecheck
```

Playwright needs Chromium: run `npx playwright install chromium` once, or point it at an existing binary
with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:e2e`.

## Architecture

```
src/
├── main.ts                     composition root + the single rAF loop + HMR boundary
├── config.ts                   camera framing (AVATAR_VIEW), rest pose, model URL
├── renderer/
│   ├── AvatarStage.ts          scene / camera / renderer / lights / resize / framing
│   └── RenderLoop.ts           the only requestAnimationFrame, clamped delta
├── avatar/
│   ├── Avatar.ts               engine-facing API over a VRM: expressions, bones, transform, gaze
│   ├── AvatarLoader.ts         GLTFLoader + VRMLoaderPlugin + VRMUtils optimisations
│   ├── AvatarIdleController.ts procedural idle: breathing, blink, head micro-motion, gaze
│   └── AvatarDebugPanel.ts     lil-gui, talks only to Avatar / AvatarIdleController
└── debug/
    ├── DebugOverlay.ts         FPS, frame time, VRM state, WebGL version, triangles, draw calls
    └── FpsMeter.ts
```

Frame order: `delta → idle.update(delta) → avatar.update(delta) [applies layers, vrm.update] → renderer.render()`.

### Pose layering

`Avatar` composes two layers once per frame:

| layer      | written by                                           | composition                              |
|------------|------------------------------------------------------|------------------------------------------|
| manual     | `setExpression`, `setBoneRotation`, `setHeadRotation`| base value                               |
| procedural | `setProcedural` (idle controller; later lip-sync)    | added to bones; `blink = max(manual, procedural)` |

Because of the layering, debug sliders and idle motion don't overwrite each other. Rotations of bones that `Avatar` drives
(head, neck, chest, spine, shoulders, and anything set via `setBoneRotation`) are rewritten every frame, so write
them through the API, not directly on `getBone()` nodes.

### Gaze

`vrm.lookAt.target` is a proxy object placed at the camera plus the idle gaze offset (in the camera's
right/up plane). three-vrm computes eye yaw/pitch relative to the current head orientation, so the eyes
stay on the camera while the head micro-moves.

### Framing

The camera position is derived from the head bone, not hardcoded world coordinates. The distance is fitted so that
`frameWidth × frameHeight` metres around the target stays visible at any aspect ratio. The VRM rest pose is a T-pose,
so `REST_POSE` in `config.ts` lowers the arms for the portrait view.

### Time independence

All idle animation integrates `delta`. Discrete events (blink phases, gaze switches) split the delta at the
event boundary, so 30/60/120 FPS produce the same state (see `tests/unit/AvatarIdleController.test.ts`).
The loop clamps `delta` to 0.1 s, so the animation slows down instead of jumping when frame rate drops below 10 FPS
or a hidden tab resumes.

### HMR

`main.ts` self-accepts and disposes the loop, renderer, GUI and overlay. The parsed VRM is kept in
`import.meta.hot.data`, so edits under `src/` apply without a page reload and without re-parsing the model.
Exception: a change to `AvatarLoader.ts` only affects the next full reload, because the cached VRM is reused.

## Dev API

In dev mode, `window.__AVATAR_DEBUG__ = { loaded, error, fps, avatar, idle, stage }`. `<body data-avatar-loaded>`
is `false` → `true`, or `error` (with `data-avatar-error`) if loading fails. Load errors also go to
`console.error` and show a banner on the page.

## Model

`public/models/avatar.vrm` is pixiv's VRM 1.0 sample (VRM Public License 1.0, redistribution allowed; see
`public/models/LICENSE.md`). It is 10.7 MB and committed directly. Move it to Git LFS if models start
changing often.
