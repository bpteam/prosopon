# Avatar sandbox (US-001, US-002, US-003, US-006, US-008)

Standalone browser sandbox for developing the VRM avatar renderer. It has no dependencies on ChatGPT or Chrome Extension APIs.

```bash
npm install
npm run dev          # http://localhost:5173/
npm test             # Vitest unit tests
npm run test:e2e     # Playwright smoke tests (starts the dev server itself)
npm run typecheck
```

Playwright needs Chromium: run `npx playwright install chromium` once, or point it at an existing binary
with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:e2e`. The lip sync e2e tests use Chromium's
fake capture device and disable the autoplay gesture requirement (see `playwright.config.ts`).

### Docker

`compose.yaml` in the repo root runs the same commands without a local Node or Chromium. Sources are bind-mounted,
`node_modules` lives in a named volume and is reinstalled by the entrypoint when `package-lock.json` changes.

```bash
docker compose up --build                          # dev server with HMR on http://localhost:5173/
docker compose run --rm avatar npm test            # unit tests / typecheck in the dev container
docker compose --profile test run --rm e2e         # Playwright e2e in mcr.microsoft.com/playwright
WATCH_POLLING=true docker compose up               # when edits don't trigger HMR (Docker Desktop on Windows)
```

- The port is published on `127.0.0.1` only and must stay 5173 on both sides: the HMR client reconnects to the page's port.
- Microphone input needs a secure context: `http://localhost` qualifies, a LAN IP over http does not.
- Containers run as uid 1000. With a different host uid, files the containers write into `avatar/` (e.g. `test-results/`)
  get the wrong owner.
- The Playwright image tag in `Dockerfile` must match `@playwright/test` in `package-lock.json`.

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
│   ├── BehaviorMixer.ts        merges idle pose + state profile + mouth + user reaction into the one ProceduralPose
│   ├── UserReaction.ts         three-free reaction contract (engagement, pitch lift, nod) + REACTION_LIMITS
│   ├── UserReactionMapper.ts   UserVoiceFrame → bounded UserReactionFrame, end-of-utterance nod (a ReactionSource)
│   ├── Avatar.ts               engine-facing API over a VRM: expressions, bones, transform, gaze
│   ├── AvatarLoader.ts         GLTFLoader + VRMLoaderPlugin + VRMUtils optimisations
│   ├── AvatarIdleController.ts procedural idle: breathing, blink, head micro-motion, gaze
│   └── AvatarDebugPanel.ts     lil-gui, talks only to AvatarController
├── audio/
│   ├── AudioInput.ts           file / mic / test signal / external node → AnalyserNode, readRms()
│   ├── AmplitudeLipSync.ts     RMS → dB → mouth openness, attack/release follower (a MouthSource)
│   ├── VisemeLipSync.ts        analyser shape × loudness → aa/ih/ou/ee/oh, amplitude fallback (the MouthSource used)
│   ├── VisemeAnalyzer.ts       analyser contract: an input node + read() of the current mouth shape
│   ├── VisemeAnalyzerHost.ts   lazy creation, tap into AudioInput, failure → amplitude
│   ├── analyzers/              HeadAudio and wLipSync adapters + their phoneme → VRM tables
│   ├── user/                   the user's voice (US-005), no Web Audio/avatar deps: VoiceActivityDetector,
│   │                           PitchDetector (MPM), PitchBaseline, UserVoiceAnalyzer, UserVoiceFrame, worklet
│   ├── LipSyncDebugPanel.ts    "Lip Sync" GUI folder: sources, mapping, live level
│   └── VisemeDebugPanel.ts     "Visemes" subfolder: analyser choice/status, blending, live weights
├── vendor/headaudio/           HeadAudio main-thread module (not on npm; see its README)
└── debug/
    ├── DebugOverlay.ts         FPS, frame time, VRM state, WebGL version, triangles, draw calls
    └── FpsMeter.ts
```

Frame order: `delta → controller.update(delta) → renderer.render()`, where `controller.update` is
`state transition → idle.update → mouthSource.update → reactionSource.update → BehaviorMixer.compose → avatar.setProcedural → avatar.update [layers, vrm.update]`.

### Conversation state

`AvatarController` is what application code and future providers use. It has no dependency on ChatGPT,
Chrome Extension APIs or audio.

```ts
const controller = new AvatarController({ idle });   // no avatar needed yet
controller.setState('speaking');                     // kept while the VRM loads
controller.attachAvatar(avatar);                     // picks up the current state on its first frame
controller.onStateChange((state, previous) => { /* ... */ }); // returns unsubscribe
controller.setState('listening'); // idle | listening | thinking | speaking
controller.update(delta);
```

- The controller runs (state machine, idle, mouth source) without an avatar; manual-layer calls return `false`/`0`
  until one is attached. `new AvatarController({ avatar, idle })` still works.
- Each state is an `AvatarStateProfile` in `AvatarStateProfiles.ts`: multipliers for the idle head/gaze/breath
  signal plus head/gaze/lean offsets. Profiles never touch expressions; conversation state is not emotion.
- `setState` blends from the *current* (possibly mid-transition) profile to the target with a smoothstep over
  `STATE_TRANSITION_DURATION` seconds of accumulated delta, so it is continuous and frame-rate independent.
  Re-setting the current target state does nothing.
- Blink is passed through from idle untouched, so a state change can't interrupt a blink or reset its timer.
- `AvatarController` is the only caller of `Avatar.setProcedural()` (it detaches the idle sink). New sources
  (audio, emotion, gestures) become inputs of `BehaviorMixer.compose()`, not additional writers.
- `setIdleEnabled(false)` fades idle motion out; state posture/gaze offsets still apply.

### Lip sync (amplitude fallback)

```ts
const audio = new AudioInput();
const lipSync = new AmplitudeLipSync(() => audio.readRms());
controller.setMouthSource(lipSync);         // anything with update(delta): number works
await audio.playFile(file);                 // or startMic(), startTestSignal(), connectNode(ttsNode)
```

- Pull model: `AvatarController.update` calls `mouthSource.update(delta)` once per frame, `AmplitudeLipSync` reads the
  RMS of the analyser's current window (`fftSize` 1024 ≈ 21 ms). No audio callbacks, no second clock.
- Level is mapped linearly in dBFS between `noiseFloorDb` (closed, doubles as a noise gate) and `fullOpenDb`, times
  `maxOpen`, then smoothed by a one-pole follower with `attack`/`release` time constants. The step is
  `target + (v − target)·e^(−Δt/τ)`, exact for piecewise-constant input, so it is frame-rate independent.
- A scalar source drives the `aa` preset through `ProceduralPose.aa` as `max(manual, procedural)`.
- Routing: file/test signal are audible, mic and external nodes are only analysed (no feedback). The mic is opened
  with `autoGainControl: false`, because AGC flattens the dynamics amplitude lip sync relies on.
- The AudioContext is created on the first start call, so start sources from a user gesture (autoplay policy).

### Lip sync (visemes)

```ts
const visemes = new VisemeLipSync(lipSync);  // wraps the amplitude path
const analyzers = new VisemeAnalyzerHost(audio, visemes, { headaudio: headAudioFactory(), wlipsync: wLipSyncFactory() }, 'headaudio');
controller.setMouthSource(visemes);
```

- A `MouthSource` may return a `MouthShape` (`aa/ih/ou/ee/oh`) instead of a number; each viseme preset is combined
  with its manual value via `max()`.
- An analyser only reports the *shape* (weights summing to ≤ 1, all zero = closed). Opening is
  `shape × ((1 − levelInfluence)·maxOpen + levelInfluence·amplitudeTarget)`, forced to 0 when the amplitude path is
  below its noise floor, so a stale analyser can't hold the mouth open in silence. Each viseme is then smoothed
  with the same exact attack/release follower as amplitude.
- Mode switching crossfades over `modeBlend` between amplitude `aa` and the viseme shape. The host falls back to
  amplitude when the analyser can't be created (no AudioWorklet outside https/localhost, asset 404) or its worklet
  throws (`processorerror`); `status` says why.
- Analysers are created on the first audio source (the AudioContext needs a user gesture) and tapped from the
  `AnalyserNode` via `AudioInput.addTap()`, so they follow source changes.
- `?analyzer=none|headaudio|wlipsync` picks the analyser at load; default `headaudio`.

| analyser | how | output | assets |
|---|---|---|---|
| HeadAudio ([met4citizen/HeadAudio](https://github.com/met4citizen/HeadAudio), MIT) | MFCC + Gaussian prototypes, AudioWorklet, ~50 ms | one of 15 Oculus visemes, mapped in `OCULUS_TO_VRM` (PP/sil close the mouth) | `public/lipsync/headaudio/` (worklet + 14 kB English model) |
| wLipSync ([mrxz/wLipSync](https://github.com/mrxz/wLipSync), MIT, npm) | uLipSync MFCC matching, WASM worklet, 1024-sample window at 16 kHz | A/I/U/E/O/S weights, mapped in `ULIPSYNC_TO_VRM` | `public/lipsync/wlipsync/profile.bin`: wLipSync's example profile, calibrated for one voice; other voices need uLipSync calibration in Unity |

Known limits: HeadAudio's model is English-only, the example wLipSync profile is one speaker, and neither has
been validated on real Russian or ChatGPT voice output yet. Both analysers lag the amplitude path by roughly their
window (~50–70 ms); opening timing follows amplitude, only the shape arrives late.

### Prosody & emotion (US-006)

`audio/emotion/` knows audio features and `EmotionFrame` only (architecture-tested: no Avatar, mixer or three.js):

- `ProsodyEmotionAnalyzer` — one per voice channel. Rolling 1.5 s window of voice-feature frames → cues (energy,
  pitch lift/variation, syllable rate, brightness, pauses, voiced ratio) → explicit rules → targets, followed by
  attack/release EMAs behind a 0.04 hysteresis band, 8 Hz out. Arousal mixes an absolute scale with the channel's own
  slow baseline (`baselineWeight`). Silence: `active` off (hysteresis on speech coverage), everything returns to
  neutral over ~1 s.
- `EmotionModelHost` + `OnnxEmotionModel` — optional local model (ONNX Runtime Web, WebGPU → WASM), fused into
  arousal/valence and `valenceConfidence`; load/inference failures and timeouts → mode `fallback`, rules only.
- Avatar side: `EmotionChannels` (two independent followers + the debug on/off switches) is the `EmotionSource`;
  `BehaviorMixer` alone maps it (`EmotionMixConfig`, all bounds subtle), weighted by the state profile and confidence.

The **Emotion / Prosody** GUI folder is the calibration bench: play a recorded ChatGPT answer (Lip Sync → *play audio
file*) or the mic, route it as the assistant's or the user's channel, watch both channels' values and the effective
mix, move the analyser/mapping sliders, and *copy changed settings (JSON)*. *load ./emotion-model/model.json* tries a
local model from `public/emotion-model/`.

### Gestures (US-008)

`avatar/gesture/` (architecture-tested: no Avatar, AvatarController, three or three-vrm, not even as types):

- `Gesture.ts` — contracts: `GestureType`, `GestureFrame` (offsets for head, body, shoulders, upper/lower arms),
  `GestureContext`, `GestureSource`, injectable `RandomSource` (`seededRandom` for tests/E2E).
- `GestureConfig.ts` — `GESTURE_CONFIG`: per type duration/cooldown/envelope/amplitudes (radians at intensity 1),
  per-state rates, emotion compression, nod rules; `GESTURE_LIMITS` for the gesture layer.
- `GestureEngine` — one primary gesture at a time, `prepare → attack → hold → release`, randomised cooldown,
  Poisson rates per state (frame-rate independent) scaled by the assistant's arousal/intonation while speaking,
  repeat penalty, priorities (boundary > speaking emphasis > ambient; forced/debug > all). Cancel and interruption
  (speaking → user takes the floor) release in 150–200 ms, never snap. Hands only while the assistant speaks.
- The nod moved here from `UserReactionMapper`, which now only reports `speaking`, `utteranceEnds` (monotonic
  counter) and `lastUtteranceDuration`.

`AvatarController.setGestureSource()` builds the context each frame; `BehaviorMixer` clamps the gesture layer to
`GESTURE_LIMITS`, adds it on top of idle/state/emotion, then clamps the procedural sum to `POSE_LIMITS`; `Avatar`
adds those offsets to the manual rotations (REST_POSE included), so arms return to the lowered rest, not T-pose.
Missing bones are skipped; no shoulder bones → shoulder shift becomes a chest roll.

GUI **Gestures**: Enabled / Auto, readouts (current, phase, progress, intensity, cooldown), a button per gesture
and Cancel, amplitude sliders per type, *copy settings*. `?gestureSeed=N` seeds the scheduler.
`window.__AVATAR_DEBUG__.gesture`: `current`, `trigger(type, intensity?)`, `cancel()`, `enabled`, `auto`,
`seed(n | null)`, `engine`. Tuning checklist: `docs/US-008-calibration.md`.

### Pose layering

`Avatar` composes two layers once per frame:

| layer      | written by                                           | composition                              |
|------------|------------------------------------------------------|------------------------------------------|
| manual     | `setExpression`, `setBoneRotation`, `setHeadRotation`| base value                               |
| procedural | `setProcedural` (AvatarController → BehaviorMixer: idle × state + mouth + emotion + gestures) | added to bones; `blink`, `aa/ih/ou/ee/oh`, `happy/relaxed/sad/angry/surprised` = `max(manual, procedural)` |

Expression owners: visemes → lip sync, emotion presets → emotion layer, `blink` → idle, anything → manual/debug.
VRM `overrideMouth`/`overrideBlink: blend` on an emotion preset would scale visemes/blink by `1 − Σweights` in
three-vrm; `Avatar` divides them by that factor first, so an active smile doesn't weaken articulation. Presets
that `block` get no procedural emotion.

Because of the layering, debug sliders and idle motion don't overwrite each other. Rotations of bones that `Avatar` drives
(head, neck, chest, spine, shoulders, upper/lower arms, and anything set via `setBoneRotation`) are rewritten every frame, so write
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

In dev mode, `window.__AVATAR_DEBUG__ = { loaded, error, fps, avatar, idle, stage, controller, audio, lipSync, visemes, analyzers, emotion, emotionPanel, state }`
(`state` is a live getter; `controller` and `state` exist before the model is loaded, `avatar` is `null` until then).
`<body data-avatar-loaded>` is `false` → `true`, or `error` (with `data-avatar-error`) if loading fails.
`<body data-avatar-state>` mirrors the conversation state from the start. Load errors also go to
`console.error` and show a banner on the page.

## Model

`public/models/avatar.vrm` is pixiv's VRM 1.0 sample (VRM Public License 1.0, redistribution allowed; see
`public/models/LICENSE.md`). It is 10.7 MB and committed directly. Move it to Git LFS if models start
changing often.
