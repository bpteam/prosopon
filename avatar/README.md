# Avatar sandbox (US-001, US-002)

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
│   ├── AvatarController.ts     public API of the subsystem: conversation state, manual proxies, update()
│   ├── ConversationStateMachine.ts  idle/listening/thinking/speaking + delta-time profile blending
│   ├── AvatarStateProfiles.ts  per-state profiles (multipliers/offsets), transition duration
│   ├── BehaviorMixer.ts        merges idle pose + state profile into the one ProceduralPose
│   ├── Avatar.ts               engine-facing API over a VRM: expressions, bones, transform, gaze
│   ├── AvatarLoader.ts         GLTFLoader + VRMLoaderPlugin + VRMUtils optimisations
│   ├── AvatarIdleController.ts procedural idle: breathing, blink, head micro-motion, gaze
│   └── AvatarDebugPanel.ts     lil-gui, talks only to AvatarController
└── debug/
    ├── DebugOverlay.ts         FPS, frame time, VRM state, WebGL version, triangles, draw calls
    └── FpsMeter.ts
```

Frame order: `delta → controller.update(delta) → renderer.render()`, where `controller.update` is
`state transition → idle.update → BehaviorMixer.compose → avatar.setProcedural → avatar.update [layers, vrm.update]`.

### Conversation state

`AvatarController` is what application code and future providers use. It has no dependency on ChatGPT,
Chrome Extension APIs or audio.

```ts
const controller = new AvatarController({ avatar, idle });
controller.onStateChange((state, previous) => { /* ... */ }); // returns unsubscribe
controller.setState('listening'); // idle | listening | thinking | speaking
controller.update(delta);
```

- Each state is an `AvatarStateProfile` in `AvatarStateProfiles.ts`: multipliers for the idle head/gaze/breath
  signal plus head/gaze/lean offsets. Profiles never touch expressions; conversation state is not emotion.
- `setState` blends from the *current* (possibly mid-transition) profile to the target with a smoothstep over
  `STATE_TRANSITION_DURATION` seconds of accumulated delta, so it is continuous and frame-rate independent.
  Re-setting the current target state does nothing.
- Blink is passed through from idle untouched, so a state change can't interrupt a blink or reset its timer.
- `AvatarController` is the only caller of `Avatar.setProcedural()` (it detaches the idle sink). New sources
  (audio, emotion, gestures) become inputs of `BehaviorMixer.compose()`, not additional writers.
- `setIdleEnabled(false)` fades idle motion out; state posture/gaze offsets still apply.

### Pose layering

`Avatar` composes two layers once per frame:

| layer      | written by                                           | composition                              |
|------------|------------------------------------------------------|------------------------------------------|
| manual     | `setExpression`, `setBoneRotation`, `setHeadRotation`| base value                               |
| procedural | `setProcedural` (AvatarController: idle × state)     | added to bones; `blink = max(manual, procedural)` |

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

In dev mode, `window.__AVATAR_DEBUG__ = { loaded, error, fps, avatar, idle, stage, controller, state }`
(`state` is a live getter; `controller`/`state` are `null` until the model is loaded). `<body data-avatar-loaded>`
is `false` → `true`, or `error` (with `data-avatar-error`) if loading fails. `<body data-avatar-state>` mirrors
the conversation state once the avatar is loaded. Load errors also go to
`console.error` and show a banner on the page.

## Model

`public/models/avatar.vrm` is pixiv's VRM 1.0 sample (VRM Public License 1.0, redistribution allowed; see
`public/models/LICENSE.md`). It is 10.7 MB and committed directly. Move it to Git LFS if models start
changing often.
