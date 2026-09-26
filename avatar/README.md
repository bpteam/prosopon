# Avatar core and sandbox

Reusable VRM renderer, audio analysis and behaviour core of Prosopon, plus a standalone browser sandbox for
developing it. No dependency on ChatGPT or Chrome Extension APIs; the extension imports these sources as `@avatar/*`.

Product context and invariants: [../PRODUCT.md](../PRODUCT.md). Rules for changes (including which docs to update):
[../AGENTS.md](../AGENTS.md). Extension side: [../extension/README.md](../extension/README.md).

## Commands

```bash
npm ci                # or npm install
npm run dev           # sandbox with HMR on http://localhost:5173/
npm run build         # typecheck + production build of the sandbox → dist/
npm run preview       # serve that build
npm run typecheck
npm test              # Vitest unit + architecture tests
npm run test:watch
npm run test:e2e      # Playwright (starts the dev server itself)
```

Playwright needs Chromium: run `npx playwright install chromium` once, or point it at an existing binary with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:e2e`. The E2E tests use Chromium's fake capture
device and disable the autoplay gesture requirement (see `playwright.config.ts`).

### Docker

`compose.yaml` in the repo root runs the same commands without a local Node or Chromium. Sources are bind-mounted;
`node_modules` lives in a named volume and is reinstalled by the entrypoint when `package-lock.json` changes.

```bash
docker compose up --build                          # dev server with HMR on http://localhost:5173/
docker compose run --rm avatar npm test            # unit tests (or npm run typecheck) in the dev container
docker compose --profile test run --rm e2e         # Playwright E2E in mcr.microsoft.com/playwright
WATCH_POLLING=true docker compose up               # when edits don't trigger HMR (Docker Desktop on Windows)
```

- The port is published on `127.0.0.1` only and must stay 5173 on both sides: the HMR client reconnects to the page's port.
- Microphone input needs a secure context: `http://localhost` qualifies, a LAN IP over http does not.
- Containers run as uid 1000. With a different host uid, files the containers write into `avatar/` (e.g. `test-results/`)
  get the wrong owner.
- The Playwright image tag in `Dockerfile` must match `@playwright/test` in `package-lock.json`.

## Source layout

```text
src/
├── main.ts                     sandbox composition root, the single rAF loop, HMR boundary, __AVATAR_DEBUG__
├── config.ts                   camera defaults (AVATAR_VIEW), REST_POSE, model URL
├── renderer/
│   ├── AvatarStage.ts          scene / camera / renderer / lights / resize / camera API / helpers / render stats
│   ├── CameraFraming.ts        pure: presets, AvatarBounds, CameraAdjust, Presentation → Framing
│   └── RenderLoop.ts           the only requestAnimationFrame, clamped delta
├── avatar/
│   ├── AvatarController.ts     public API: conversation state, sources, manual proxies, snapshot, update()
│   ├── BehaviorSnapshot.ts     read-only BehaviorDebugSnapshot (what the mixer composed last frame)
│   ├── ConversationStateMachine.ts  idle/listening/thinking/speaking + delta-time profile blending
│   ├── AvatarStateProfiles.ts  per-state profiles (multipliers, offsets, emotion weights), transition duration
│   ├── BehaviorMixer.ts        idle × state + mouth + reaction + emotion + gesture → one ProceduralPose
│   ├── Avatar.ts               engine-facing API over a VRM: manual + procedural layers, expressions, bones, gaze
│   ├── AvatarLoader.ts         GLTFLoader + VRMLoaderPlugin + VRMUtils optimisations
│   ├── AvatarIdleController.ts procedural idle: breathing, blink, head micro-motion, gaze
│   ├── MouthShape.ts           three-free mouth contract (aa/ih/ou/ee/oh)
│   ├── BodyPose.ts             three-free upper-body offsets + POSE_LIMITS
│   ├── UserReaction.ts         three-free reaction contract + REACTION_LIMITS
│   ├── UserReactionMapper.ts   UserVoiceFrame → bounded UserReactionFrame (a ReactionSource)
│   ├── EmotionChannels.ts      two EmotionFrame followers (user, assistant) = the EmotionSource
│   ├── EmotionExpression.ts    emotion inputs/expression contracts
│   ├── gesture/                Gesture.ts (contracts), GestureConfig.ts, GestureEngine.ts,
│   │                           SemanticGestureConfig.ts, SemanticGesturePolicy.ts (intent → gesture decision)
│   └── AvatarDebugPanel.ts     lil-gui, talks only to AvatarController
├── audio/
│   ├── AudioInput.ts           file / mic / test signal / external node / MediaStream → AnalyserNode
│   ├── AmplitudeLipSync.ts     RMS → dB → mouth openness (a MouthSource)
│   ├── VisemeLipSync.ts        analyser shape × loudness → visemes, amplitude fallback (a MouthSource)
│   ├── VisemeAnalyzer.ts       analyser contract
│   ├── VisemeAnalyzerHost.ts   lazy creation, tap into AudioInput, failure → amplitude
│   ├── analyzers/              HeadAudio and wLipSync adapters + phoneme → VRM tables
│   ├── LipSyncFrame.ts         cross-context lip-sync frame contract (used by the extension)
│   ├── FrameMouthSource.ts     a MouthSource fed by LipSyncFrames (used by the extension)
│   ├── user/                   VoiceActivityDetector, PitchDetector, PitchBaseline, SpectralFeatures,
│   │                           UserVoiceAnalyzer, UserVoiceFrame, UserVoiceWorklet (+ protocol)
│   ├── emotion/                EmotionFrame, ProsodyEmotionAnalyzer, EmotionModel, EmotionModelHost, OnnxEmotionModel
│   ├── LipSyncDebugPanel.ts    "Lip Sync" GUI folder
│   └── VisemeDebugPanel.ts     "Visemes" GUI subfolder
├── semantic/                   reply text → SemanticCue/SemanticIntent (renderer-, audio- and DOM-free)
│   ├── SemanticCue.ts          contracts: cue types, SemanticCue, SemanticIntent, CUE_RANK
│   ├── SemanticText.ts         normalisation, segmentation (paragraph / item / sentence / clause), script hint
│   ├── SemanticRuleSet.ts      rules → token trie (compiled once), tokenizer, counts
│   ├── SemanticMatcher.ts      per segment: matches, scoring, negation, overlaps, structure, aggregation
│   ├── SemanticAnalyzer.ts     streaming: growing text → new intents, once per segment/type
│   ├── SemanticPacer.ts        text clock: releases intents at the estimated spoken position
│   ├── SemanticConfig.ts       thresholds, tier weights, structural signals
│   ├── rules/                  vocabulary as data: RuleData.ts + en.ts, ru.ts, uk.ts, es.ts
│   └── demoReplies.ts          long RU/UK/EN/ES replies for the sandbox and tests
├── vendor/headaudio/           HeadAudio main-thread module (not on npm; see its README)
└── debug/                      DebugOverlay, FpsMeter, EmotionDebugPanel, GestureDebugPanel, SemanticDebugPanel
```

Frame order: `delta → controller.update(delta) → renderer.render()`, where `controller.update` is
`state transition → idle → mouth source → reaction source → emotion source → gesture source → BehaviorMixer.compose →
avatar.setProcedural → avatar.update (layers, vrm.update)`.

## AvatarController and conversation state

`AvatarController` is what application code and providers use. It has no dependency on ChatGPT, Chrome APIs or audio.

```ts
const controller = new AvatarController({ idle });   // no avatar needed yet
controller.setState('speaking');                     // kept while the VRM loads
controller.attachAvatar(avatar);                     // picks up the current state on its first frame
controller.onStateChange((state, previous) => { /* ... */ }); // returns unsubscribe
controller.setMouthSource(visemes);                  // MouthSource
controller.setReactionSource(reactions);             // ReactionSource
controller.setEmotionSource(emotionChannels);        // EmotionSource
controller.setGestureSource(gestures);               // GestureSource
controller.update(delta);                            // once per frame, from the render loop
controller.getBehaviorSnapshot();                    // read-only BehaviorDebugSnapshot (copies; for diagnostics)
controller.resetPose();                              // manual bones back to REST_POSE
```

- The controller runs (state machine, idle, sources) without an avatar; manual-layer calls return `false`/`0` until
  one is attached. `new AvatarController({ avatar, idle })` also works.
- Each state is an `AvatarStateProfile` in `AvatarStateProfiles.ts`: idle head/gaze/breath multipliers, head/gaze/lean
  offsets, and assistant/user emotion weights. Profiles never touch expressions; conversation state is not emotion.
- `setState` blends from the *current* (possibly mid-transition) profile to the target with a smoothstep over
  `STATE_TRANSITION_DURATION` (0.35 s) of accumulated delta: continuous and frame-rate independent. Re-setting the
  current target does nothing.
- Blink passes through from idle untouched, so a state change can't interrupt a blink or reset its timer.
- `AvatarController` is the only caller of `Avatar.setProcedural()`. New behaviour becomes another input of
  `BehaviorMixer.compose()`, not another writer.
- `setIdleEnabled(false)` fades idle motion out; state posture/gaze offsets still apply.

Who sets the state is the integration's job: in the extension it is `ConversationSignalResolver`
(see [../extension/README.md](../extension/README.md#architecture)); in the sandbox, the debug GUI.

## Idle, blink and gaze

- Idle integrates `delta`. Discrete events (blink phases, gaze switches) split the delta at the event boundary, so
  30/60/120 FPS produce the same state (`tests/unit/AvatarIdleController.test.ts`). The loop clamps `delta` to 0.1 s,
  so animation slows down instead of jumping below 10 FPS or after a hidden tab resumes.
- Blink combines with the manual value as `max(manual, procedural)`.
- `vrm.lookAt.target` is a proxy placed at the camera plus the idle gaze offset (camera right/up plane). three-vrm
  computes eye yaw/pitch relative to the current head, so the eyes stay on the camera while the head moves.
- `REST_POSE` in `config.ts` lowers the T-pose arms; framing is described under [Camera](#camera).

## Camera

One camera, one scene. `AvatarStage` owns the camera; nothing outside writes its fields.

```ts
stage.setCameraPreset('face' | 'waist' | 'full-body');
stage.setCameraAdjust({ distanceOffset, targetYOffset, yaw, pitch }); // partial, clamped to CAMERA_ADJUST_LIMITS
stage.resetCamera();                                                   // adjust → 0, preset kept
stage.setPresentation({ x, y, height });  // normalized box centre (0..1) and height (fraction of viewport height)
stage.framing;                            // last Framing {target, position, distance, offsetX, offsetY, box}
stage.onFraming((f) => …);                // after every re-frame; returns unsubscribe
stage.setBackground(null | color); stage.setSceneHelpers({ grid, skeleton, axes }); stage.renderStats;
```

- **Presets** come from `measureBounds(avatar)` (`AvatarBounds`: bounding-box top/bottom, neck, hips, feet in
  world space; `resolveBounds` fills missing bones from `NOMINAL_BOUNDS`). A preset is a vertical span and a fill:
  Face = top → just below the neck (0.85), Waist = top → hips (0.88), Full body = top → feet (0.9, ~5 % margins).
  `computeFraming` is pure and height-driven: `distance = span / (fill × boxHeight × 2 tan(fov/2)) × (1 +
  distanceOffset)`, orbiting the span's centre by yaw/pitch.
- **Presentation** places that box in the viewport by a lens shift, `camera.setViewOffset`, so the canvas can cover
  the whole viewport (the extension does) and the avatar is still drawn at `(x, y)` with `height`. Moving or
  scaling the avatar never changes the preset; changing the preset never moves the box.
- Resolution is capped by `AVATAR_VIEW.maxPixels` (4.5 M, `budgetPixelRatio`), so a full-viewport canvas on a 4K
  screen doesn't render 8 M pixels of mostly transparency.
- Sandbox: lil-gui *Camera* folder (preset, sliders, reset). Default preset: `AVATAR_VIEW.preset` (`waist`).

## Lip sync

### Amplitude (fallback and loudness source)

```ts
const audio = new AudioInput();
const lipSync = new AmplitudeLipSync(() => audio.readRms());
controller.setMouthSource(lipSync);         // anything with update(delta): number | MouthShape
await audio.playFile(file);                 // or startMic(), startTestSignal(), connectNode(node), attachMediaStream(stream)
```

- Pull model: `AvatarController.update` calls `mouthSource.update(delta)` once per frame; `AmplitudeLipSync` reads the
  RMS of the analyser's current window (`fftSize` 1024 ≈ 21 ms). No audio callbacks, no second clock.
- Level maps linearly in dBFS between `noiseFloorDb` (closed; doubles as a noise gate) and `fullOpenDb`, times
  `maxOpen`, then a one-pole follower with `attack`/`release` time constants:
  `target + (v − target)·e^(−Δt/τ)`, exact for piecewise-constant input, so frame-rate independent.
- Routing: file/test signal are audible; mic and external nodes are only analysed (no feedback). The mic is opened
  with `autoGainControl: false`, because AGC flattens the dynamics amplitude lip sync relies on.
- The AudioContext is created on the first start call: start sources from a user gesture (autoplay policy).

### Visemes

```ts
const visemes = new VisemeLipSync(lipSync);  // wraps the amplitude path
const analyzers = new VisemeAnalyzerHost(audio, visemes, { headaudio: headAudioFactory(), wlipsync: wLipSyncFactory() }, 'headaudio');
controller.setMouthSource(visemes);
```

- An analyser reports only the *shape* (weights summing to ≤ 1, all zero = closed). Opening is
  `shape × ((1 − levelInfluence)·maxOpen + levelInfluence·amplitudeTarget)`, forced to 0 below the amplitude noise
  floor, so a stale analyser can't hold the mouth open in silence. Each viseme is smoothed with the same follower.
- Mode switches crossfade over `modeBlend`. The host falls back to amplitude when the analyser can't be created (no
  AudioWorklet outside https/localhost, asset 404) or its worklet throws (`processorerror`); `status` says why.
- Analysers are created on the first audio source and tapped from the `AnalyserNode` via `AudioInput.addTap()`, so
  they follow source changes. `?analyzer=none|headaudio|wlipsync` picks one at load; default `headaudio`.

| analyser | how | output | assets |
|---|---|---|---|
| HeadAudio ([met4citizen/HeadAudio](https://github.com/met4citizen/HeadAudio), MIT) | MFCC + Gaussian prototypes, AudioWorklet, ~50 ms | one of 15 Oculus visemes, mapped in `OCULUS_TO_VRM` (PP/sil close the mouth) | `public/lipsync/headaudio/` (worklet + 14 kB English model) |
| wLipSync ([mrxz/wLipSync](https://github.com/mrxz/wLipSync), MIT, npm) | uLipSync MFCC matching, WASM worklet, 1024-sample window at 16 kHz | A/I/U/E/O/S weights, mapped in `ULIPSYNC_TO_VRM` | `public/lipsync/wlipsync/profile.bin`: example profile calibrated for one voice; other voices need uLipSync calibration in Unity |

Known limits: HeadAudio's model is English-only, the wLipSync profile is one speaker, and neither is validated on
real Russian or ChatGPT voices. Both lag the amplitude path by roughly their window (~50–70 ms); opening timing
follows amplitude, only the shape arrives late.

For the extension, `LipSyncFrame` carries the mouth across contexts and `FrameMouthSource` replays it as a
`MouthSource`.

## User voice contracts

`audio/user/` has no Web Audio or avatar dependencies; it runs inside an AudioWorklet in the extension.

- `VoiceActivityDetector`: tracked noise floor (adapts slowly even under sustained input, so a fan can't latch
  `speaking`), activation/deactivation margins 12/6 dB, attack 100 ms, hangover 300 ms.
- `PitchDetector`: McLeod pitch method on a 16 kHz decimation, 60–800 Hz; `pitchHz = null` below confidence 0.8.
- `PitchBaseline`: median of the first 1.5 s of voiced speech, then a 40 s log-domain average; relative pitch in
  semitones.
- `UserVoiceAnalyzer`: fixed 10 ms hops (chunk size doesn't matter) → `UserVoiceFrame` (`speaking`, `rmsDb`,
  `energy`, `pitchHz`, `pitchConfidence`, `relativePitch`, `pitchVariation`, spectral features).
- `UserReactionMapper` (a `ReactionSource`) → `UserReactionFrame`: `engagement`, `pitchLift`, `speaking`,
  `utteranceEnds` (monotonic counter) and `lastUtteranceDuration`. It animates nothing itself: `BehaviorMixer`
  clamps engagement/pitch lift to `REACTION_LIMITS` (±12 % head motion, 25 % steadier gaze, ~0.7° lean, ~0.7° chin
  lift), and nods belong to `GestureEngine`.

## Emotion contracts

`audio/emotion/` knows audio features and `EmotionFrame` only (no Avatar, mixer or three.js):

- `ProsodyEmotionAnalyzer`, one per voice channel: rolling 1.5 s window of voice-feature frames → cues (energy,
  pitch lift/variation, syllable rate, brightness, pauses, voiced ratio) → rules → attack/release followers behind a
  0.04 hysteresis band, 8 Hz out. Arousal mixes an absolute scale with the channel's slow baseline
  (`baselineWeight`). Silence turns `active` off and returns everything to neutral over ~1 s. Heuristic valence
  confidence is capped at 0.25. Defaults: `DEFAULT_PROSODY_EMOTION_CONFIG`.
- `EmotionModel` / `EmotionModelHost` / `OnnxEmotionModel`: optional local model (ONNX Runtime Web; WebGPU → WASM,
  single-threaded) fused into arousal/valence and `valenceConfidence`. The host serves any number of channels with
  one model; load timeout 30 s, inference timeout 5 s, 3 failures in a row → mode `fallback` (rules only). The spec
  takes either a `url` or preloaded `data` bytes, and either one output tensor with `arousalIndex`/`valenceIndex` or
  named `outputNames`.
- Avatar side: `EmotionChannels` (two followers + debug on/off switches) is the `EmotionSource`; `BehaviorMixer`
  alone maps it (`DEFAULT_EMOTION_MIX`, all bounds subtle), weighted by the state profile and confidence. Emotion
  writes `happy/relaxed/sad/angry/surprised`, head/gaze motion and posture, never a viseme.

The extension installs a specific model for this host; see
[../extension/README.md](../extension/README.md#emotion-model). In the sandbox, the **Emotion / Prosody** GUI folder
is the calibration bench: play a recorded answer (Lip Sync → *play audio file*) or the mic, route it as the
assistant's or the user's channel, watch both channels and the effective mix, move sliders and *copy changed
settings (JSON)*. *load ./emotion-model/model.json* loads a model you place in `public/emotion-model/` (git-ignored;
format documented on `parseModelSpec` in `audio/emotion/EmotionModel.ts`). Procedure:
[../docs/emotion-calibration.md](../docs/emotion-calibration.md).

## Gestures

`avatar/gesture/` (architecture-tested: no Avatar, AvatarController, three or three-vrm, not even as types):

- `Gesture.ts`: `GestureType`, `GestureFrame` (offsets for head, body, shoulders, upper/lower arms), `GestureContext`,
  `GestureSource`, injectable `RandomSource` (`seededRandom` for tests/E2E).
- `GestureConfig.ts`: `GESTURE_CONFIG` (per-type duration, cooldown, envelope, amplitudes in radians at intensity 1;
  per-state rates; emotion compression; nod rules) and `GESTURE_LIMITS`.
- `GestureEngine`: one primary gesture at a time, `prepare → attack → hold → release`, randomised cooldown, Poisson
  rates per state scaled by the assistant's arousal/intonation while speaking, repeat penalty, priorities
  (forced/debug > boundary > semantic > speaking emphasis > ambient). `head-shake` and `lean-in` have rate 0 in
  every state: only semantic intents or `trigger()` start them. Cancel and interruption release in 150–200 ms. Hand
  emphasis is scheduled only while the assistant speaks, never while the user speaks.
- Nods: after a finished user utterance (`utteranceEnds` from the reaction source); double nods key on user arousal
  (valence counts only at `valenceConfidence ≥ 0.5`). Without a reaction source (sandbox), utterance ends are derived
  from `emotion.user.active`.

### Semantic intents

`engine.pushSemantic(intent)` queues a `SemanticIntent` (from `avatar/src/semantic/`); the next `update()` asks
`engine.semantic` (`SemanticGesturePolicy`) for a decision. The policy never throws into the engine: an exception
switches the semantic path off (`semanticStatus.error`) and procedural gestures continue.

- One decision per segment (early and final emissions of a segment share it); intents older than `maxAge` (4 s)
  are stale.
- Skip reasons, in order: `disabled`, `segment-done`, `stale`, `low-confidence`, `user-speaking`, `state`
  (listening), `cooldown` (global 2.5 s), `type-cooldown` (6 s per cue type), `active-gesture`, `no-gesture`,
  `probability`.
- Primary cue by `CUE_RANK` (disagreement, agreement, question, enumeration, conclusion, contrast); emphasis only
  raises chance and intensity; modifiers (example, cause, clarification) favour the hand.
- `p = probabilityScale × base × confidence × (0.7 + 0.3·strength) × stateFactor × (1 + 0.35·emphasis) × prosody ×
  repetition`, capped at 0.95. `stateFactor`: speaking 1, idle 0.5, thinking 0.25, listening 0. Prosody:
  0.85–1.15 from the assistant's arousal. Repetition: ×0.5 when the same cue type decided last.
- Mapping and weights: `SEMANTIC_GESTURE_CONFIG.cues` (see [PRODUCT.md §5.11](../PRODUCT.md#511-semantic-performance-layer)).
  Enumeration and contrast alternate sides.
- While intents are recent (`ambientWindow`, 8 s) the speaking ambient rate is × `ambientRateScale` (0.5).
- History: `engine.semantic.history` (last 16 decisions), `engine.semanticStatus` (counts, queue, error).

GUI **Gestures**: Enabled / Auto, readouts (current, phase, progress, intensity, cooldown), a button per gesture,
Cancel, amplitude sliders, *copy settings*. `?gestureSeed=N` seeds the scheduler. Tuning:
[../docs/gesture-calibration.md](../docs/gesture-calibration.md).

## Semantic analyzer

`new SemanticAnalyzer().update(messageId, text, complete)` takes the whole reply text so far (light Markdown:
`1.`/`-` items, `#` headings, `**bold**`, code fences) and returns the intents that became known: a segment is
emitted when its end is seen (or the reply is `complete`), or early when a strong/medium marker at its start is
followed by punctuation (≥ 0.75 confidence, or a list item, or `¿`). Each segment emits at most once early and once
final, each cue type once; a new `messageId` resets. Ids are `messageId#ordinal[:type]`, stable under re-rendering.

Rules are data (`rules/*.ts`): groups of phrases with `kind` (a cue, a modifier or `none`), `tier`
(strong/medium/weak → 0.92/0.78/0.5 confidence), `position` (`segment-start`, `clause-start`, `standalone` — must be
followed by punctuation other than `?` — or `any`), `negatable`. Phrases are lower case, `ё` → `е`, `'` for
apostrophes, a trailing `*` makes a stem. Longest match wins (words, then span, then position specificity);
`none` rules swallow false friends. A negator in the two preceding words of the clause rejects a negatable rule;
markers inside short quotes are mentions and are ignored. Scoring adds position and punctuation bonuses; a cue is
emitted at ≥ 0.55 aggregated confidence (noisy-OR per type) with at least one marker ≥ 0.5, so weak markers alone
never fire. Agreement vs disagreement: the earlier one in the segment wins.

Rule counts: `defaultRuleSet().counts` (by kind and locale; enumeration split into intro/item/final).
`SemanticPacer` (text clock) is described in [PRODUCT.md §5.11](../PRODUCT.md#511-semantic-performance-layer).

GUI **Semantic**: demo reply (RU/UK/EN/ES), text arrival rate, speech rate, *Follow speech*, *Semantic gestures*,
*Chance ×*, *Cooldown*, *Play* / *Stop*, readouts (segment, cues, decision, cues / intents / gestures). It sets the
state to speaking without audio (the mouth stays closed).

## Pose layering

`Avatar` composes two layers once per frame:

| layer | written by | composition |
|---|---|---|
| manual | `setExpression`, `setBoneRotation`, `setHeadRotation`, `REST_POSE` | base value, not clamped |
| procedural | `setProcedural` (AvatarController → BehaviorMixer) | added to bones; `blink`, `aa/ih/ou/ee/oh`, `happy/relaxed/sad/angry/surprised` = `max(manual, procedural)` |

- `BehaviorMixer` clamps the gesture layer to `GESTURE_LIMITS`, adds it on top of idle/state/emotion, then clamps the
  procedural sum to `POSE_LIMITS`. Arms therefore return to the lowered rest, not the T-pose.
- Missing bones are skipped; no shoulder bones → shoulder shift becomes a chest roll.
- Expression owners: visemes → lip sync, emotion presets → emotion layer, `blink` → idle, anything → manual/debug.
- VRM `overrideMouth`/`overrideBlink: blend` on an emotion preset would scale visemes/blink by `1 − Σweights` in
  three-vrm; `Avatar` divides them by that factor first (floored at 0.5), so an active smile doesn't weaken
  articulation. Presets that `block` get no procedural emotion (warned once).
- Bones that `Avatar` drives (head, neck, chest, spine, shoulders, upper/lower arms, anything set via
  `setBoneRotation`) are rewritten every frame: write them through the API, not on `getBone()` nodes.

## Debug API (sandbox, dev mode only)

`window.__AVATAR_DEBUG__ = { loaded, error, fps, avatar, idle, stage, controller, audio, lipSync, visemes, analyzers,
emotion, emotionPanel, gesture, state }`.

- `state` is a live getter; `controller` and `state` exist before the model loads; `avatar` is `null` until then.
- `gesture`: `engine`, `current`, `trigger(type, intensity?)`, `cancel()`, `enabled`, `auto`, `seed(n | null)`.
- `semantic`: the Semantic panel (`play(locale)`, `stop()`, `pacer`), decisions in `gesture.engine.semantic.history`.
- `<body data-avatar-loaded>` goes `false` → `true`, or `error` (with `data-avatar-error`). `<body data-avatar-state>`
  mirrors the conversation state from the start. Load errors also go to `console.error` and a banner on the page.

HMR: `main.ts` self-accepts and disposes the loop, renderer, GUI and overlay. The parsed VRM is kept in
`import.meta.hot.data`, so edits under `src/` apply without re-parsing the model. Exception: a change to
`AvatarLoader.ts` only takes effect on the next full reload.

## Tests

- Unit (`tests/unit/`): camera presets (fill, centring, ordering, lens shift, clamping, degenerate bounds, pixel
  budget), loader/avatar layering (`fakeVrm.ts`), controller and state machine, idle timing at
  30/60/120 FPS, amplitude and viseme lip sync, `AudioInput`, `LipSyncFrame`, user voice (VAD, pitch, baseline on
  synthetic signals), reactions, emotion analyser and mixer, `OnnxEmotionModel` (with an injected runtime), gestures,
  semantic analyzer (`Semantic.test.ts`: vocabulary size and hygiene, table-driven positives per type × language,
  critical false positives, multi-cue and conflicts from `semanticFixtures.ts`, segmentation, streaming = whole-text,
  performance) and semantic gestures (`SemanticGesture.test.ts`: policy skips, cooldowns, repetition, fail-soft,
  new gesture limits, density of a long multilingual reply).
- Architecture (`tests/unit/architecture.test.ts`): gesture code imports no renderer types; only `Avatar`,
  `AvatarController` and the debug panel touch bones; behaviour sources don't import `Avatar`; one nod implementation;
  `semantic/` imports nothing outside itself and uses no DOM/audio/pose API; the gesture side imports only
  `SemanticCue` from it.
- E2E (`tests/e2e/`): smoke (load, state), lip sync (fake capture device, analysers, fallback), emotion, gestures.
  `tests/fixtures/loudness-probe.onnx` is a plumbing fixture, not an emotion model.

## Model

`public/models/avatar.vrm` is pixiv's VRM 1.0 sample (VRM Public License 1.0, redistribution allowed; see
`public/models/LICENSE.md`). It is 10.7 MB and committed directly; move it to Git LFS if models start changing often.
The extension packages `public/` as-is, so anything placed there ships in the extension build.
