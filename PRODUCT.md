# PRODUCT.md — Prosopon

> PRODUCT.md is the primary product and architecture context for humans and AI agents.
>
> Before proposing or implementing changes, inspect PRODUCT.md and the current code.
>
> If documentation and implementation disagree, current code and architecture tests are the final source of truth.

Related documents: [README.md](README.md) (onboarding, quick start) · [AGENTS.md](AGENTS.md) (rules for agents and
contributors) · [avatar/README.md](avatar/README.md) (avatar core in detail) ·
[extension/README.md](extension/README.md) (Chrome extension in detail) · [docs/](docs/) (calibration procedures).

This file describes the **current** product. It is not a changelog: history lives in git.

---

## 1. Product

Prosopon is a browser-based real-time VRM avatar for voice AI. Today it ships as a Chrome Manifest V3 extension that
replaces the ChatGPT Voice orb on `chatgpt.com` with an animated VRM character.

The avatar reacts to assistant speech (lip sync, prosody), user speech (voice activity, prosody), conversation state,
procedural idle behaviour and procedural gestures, optionally refined by a local emotion ML model. Occasional
semantic accents (a head tilt on a question, a shake on "not quite", a hand beat on a list item) come from local
rules over the assistant's reply **text as ChatGPT displays it**.
**No speech-to-text is involved**: audio signals are acoustic only; the only text read is the reply on the page.

Intended experience:

- assistant speaks → mouth, face and body react;
- user speaks → the avatar listens and reacts (attentive, not mirroring);
- user interrupts → behaviour switches at once;
- silence → natural idle.

Design direction: subtle over exaggerated; continuous motion over canned states; local real-time processing;
graceful fallback when optional parts fail; an avatar core that does not depend on ChatGPT.

## 2. Repository layout

```text
prosopon/
├── avatar/       reusable renderer / audio / behaviour core + standalone sandbox (Vite app)
├── extension/    Chrome MV3 integration; imports the core from avatar/src (@avatar/* alias)
├── docs/         manual calibration procedures
└── compose.yaml  Docker dev/test services for both packages
```

`avatar/` and `extension/` are separate npm packages (no root workspace). The extension compiles core sources from
`../avatar/src` and resolves `three`, `@pixiv/three-vrm`, `wlipsync` and `onnxruntime-web` from
`avatar/node_modules`, so `avatar/` must be installed first.

**Do not create a second avatar/audio/behaviour implementation inside `extension/`.**

Stack: TypeScript, Vite, Three.js, @pixiv/three-vrm (VRM 1.0), Web Audio + AudioWorklet, ONNX Runtime Web 1.30,
Vitest, Playwright, Docker Compose.

## 3. Architecture

```text
                  ┌─ conversation state (ConversationStateMachine, profiles)
                  ├─ idle (AvatarIdleController)
User audio ───────┼─ user reaction (UserReactionMapper → ReactionSource)
                  ├─ user emotion      ┐
Assistant audio ──┼─ assistant emotion ┴─ EmotionChannels (EmotionSource)
                  ├─ lip sync (MouthSource)
                  └─ gestures (GestureEngine → GestureSource)
                              ↑ pushSemantic(SemanticIntent)
Reply text (DOM) ─ ChatGPTAdapter → SemanticFeed ─ SemanticAnalyzer → SemanticPacer
                              ↓
                        BehaviorMixer            (the only composition point)
                              ↓
                       AvatarController          (the only caller of Avatar.setProcedural)
                              ↓
                  Avatar (manual + procedural layers)
                              ↓
                          three-vrm
```

Per frame (one `requestAnimationFrame` loop, delta clamped to 0.1 s):
`state transition → idle → mouth → reaction → emotion → gesture → BehaviorMixer.compose → avatar.setProcedural →
avatar.update → render`.

ChatGPT is one integration around this core. New inputs (another voice provider, camera tracking) must enter as
another typed source into `BehaviorMixer`, never as another writer of bones or expressions. Semantic cues are not a
source of pose at all: they are *intents* that `GestureEngine` may turn into a gesture of its own vocabulary.

## 4. Architectural invariants

Preserve these unless a task explicitly changes them (and then update this section and the tests).
Rules marked *(tested)* are enforced by `avatar/tests/unit/architecture.test.ts` or
`extension/tests/unit/architecture.test.ts`.

1. **One render loop.** Only `RenderLoop` calls `requestAnimationFrame`. Subsystems pull from it; they do not run
   their own visual loops or clocks.
2. **One procedural writer** *(tested)*. Sources produce typed frames; `BehaviorMixer` composes them; `AvatarController` alone
   writes the procedural layer. Wrong: `GestureEngine → bone.rotation`, `EmotionAnalyzer → Avatar.setExpression()`,
   `LipSync → vrm.expressionManager`.
3. **Audio and rendering are isolated** *(tested)*. Audio code (`avatar/src/audio/**`, the offscreen document) does
   not import `Avatar`, `AvatarController`, Three.js or three-vrm. Rendering code never receives raw PCM,
   `AudioNode`, `AudioContext` or `MediaStream`. Only compact numeric frames cross the boundary.
4. **Gesture code is renderer-free** *(tested)*. `avatar/src/avatar/gesture/` imports no Avatar, AvatarController,
   three or three-vrm, not even as types. `GestureEngine` emits `GestureFrame`s; it never touches bones.
5. **ChatGPT DOM is isolated** *(tested)*. All ChatGPT selectors and DOM knowledge (including the calibration
   wizard's automation: composer, send, new chat, voice start, mute, voice detection) live in `ChatGPTAdapter`
   (`CHATGPT_SELECTORS`). Selector breakage is fixed there and nowhere else.
6. **One conversation-state resolver** *(tested)*. Audio processors emit signals; only `ConversationSignalResolver` (extension
   content script) calls `controller.setState()`.
7. **Lip sync owns articulation only**: visemes `aa ih ou ee oh`. Not blink, not emotion, not state, not gestures.
   Emotion may bias the face but never overwrites visemes. The user's voice never drives the mouth.
8. **The nod belongs to `GestureEngine`** *(tested)*. `UserReactionMapper` reports utterance boundaries (`utteranceEnds`
   counter, `lastUtteranceDuration`); it does not animate the head.
9. **React, don't mirror.** User energy, pitch and emotion map to bounded attentiveness (`REACTION_LIMITS`, emotion
   mix bounds), never copied onto the avatar.
10. **No hidden STT.** Nothing in lip sync, state, prosody, emotion or gestures depends on transcription. The
    semantic layer reads the reply text ChatGPT renders; it never transcribes audio.
11. **Assistant and user audio are never mixed before analysis.** Tab capture and microphone are separate pipelines.
12. **No microphone feedback path.** The mic is never connected to `AudioContext.destination`; the user-voice worklet
    node has zero outputs (checked in `UserVoicePipeline.link()`).
13. **Fail soft.** An optional part failing must not break ChatGPT or basic rendering:
    viseme analyser fails → amplitude lip sync; emotion model fails → prosody heuristics (`fallback` mode);
    mic denied or missing → assistant-only avatar; selector drift → ChatGPT stays usable, the avatar stays where
    the user placed it (placement never depends on ChatGPT's DOM) and only the orb is not hidden.
14. **No raw audio across extension contexts** *(tested)*. Frames (`LipSyncFrame`, `UserVoiceFrame`, `EmotionFrame`, status)
    travel over the typed protocol (`PROTOCOL_VERSION` in `extension/src/shared/messages.ts`). PCM chunks for the
    local model stay inside the offscreen runtime and its dedicated same-origin inference Worker; they never cross
    an extension context. The calibration wizard's recordings (Developer mode, only while it runs) also stay in the
    offscreen document; the finished ZIP leaves it only as a same-origin `blob:` URL handed to the extension's export
    page, which downloads it.
15. **Executable code is local.** No remote JS/WASM. The only network fetch is the pinned emotion model download.
16. **Delta-time everywhere.** Animation integrates `delta`; discrete events split delta at their boundary, so
    30/60/120 FPS give the same result.
17. **UI is presentation and control only** *(tested)*. The popup and the in-page UI (`extension/src/ui/**`) import
    no three.js, `Avatar`, `AvatarController`, `BehaviorMixer` or `AvatarStage` at runtime, never touch bones,
    `expressionManager` or `setState`, and reach the avatar only through `DevBridge` / public APIs
    (`AvatarStage.setCameraPreset`, `setPresentation`, `AvatarController.getBehaviorSnapshot`, …). `ManualControls`
    is the only extension file that writes the manual layer. Wrong: debug panel → VRM bone, popup → Three.js,
    emotion button → `expressionManager`, UI → private camera fields.
18. **Semantics are signals, not animation** *(tested)*. `avatar/src/semantic/**` (text → `SemanticCue`/`SemanticIntent`)
    imports nothing outside itself: no avatar, renderer, audio, three, VRM, DOM or packages. The gesture side reads
    only `SemanticCue.ts`; `SemanticGesturePolicy` inside `GestureEngine` decides (and may decline) every gesture.
    Reply text reaches the analyzer only through `ChatGPTAdapter.readLatestReply()`; `SemanticFeed` has no DOM
    access. Semantics never touch lip sync, expressions or the conversation state, and the user interrupting always
    wins over them.
19. **Developer Mode off costs nothing** *(tested)*. With `prosopon.developerMode` false no Dev UI chunk is loaded, no
    history, charts, observers, telemetry or windows exist; the UI never runs its own `requestAnimationFrame` or
    `setInterval` (sampling is driven by the render loop). The calibration wizard is part of that chunk and is ticked
    by the same frame callback; `BehaviorMixer` attribution is computed only while a calibration runs.

Do not delete or weaken architecture tests because they make a new implementation inconvenient.

## 5. Implemented subsystems

Details, APIs and tunables: [avatar/README.md](avatar/README.md) and [extension/README.md](extension/README.md).

### 5.1 Rendering (avatar core)

Three.js WebGL renderer with a transparent canvas, VRM 1.0 loading with VRMUtils optimisations, normalized humanoid
bones, expressions, lookAt and spring bones.

Camera (`AvatarStage` + pure `CameraFraming`): three presets of one camera in one scene, framed from the model's
bounds and bones (box top, neck, hips, feet): **Face** (head + neck fills ~85 % of the avatar box), **Waist** (head
to hips, ~88 %), **Full body** (head to feet, ~90 %, margins top ~5 %, bottom ~5 %). Manual corrections on top
(`CameraAdjust`: distance, target height, yaw, pitch; clamped) and a *presentation* (normalized x/y centre and
height of the avatar box in the viewport). Presentation is a lens shift (`camera.setViewOffset`), not a smaller
canvas: the canvas covers the viewport and the avatar is drawn where the user put it. Rendering resolution is
capped by a pixel budget (`AVATAR_VIEW.maxPixels`, 4.5 M) instead of a scissor. `REST_POSE` (`avatar/src/config.ts`) lowers the T-pose arms; procedural
motion returns to it, not to the T-pose. The bundled model is pixiv's VRM 1.0 sample
(`avatar/public/models/avatar.vrm`, VRM Public License 1.0).

### 5.2 Pose layering

`Avatar` composes two layers once per frame. **Manual**: `REST_POSE`, manual expressions and bone rotations, debug
controls. **Procedural**: idle × state profile + mouth + reaction + emotion + gestures, written only via
`setProcedural`. Rotations add; `blink`, visemes and emotion presets combine as `max(manual, procedural)`.
The gesture layer is clamped to `GESTURE_LIMITS`, the procedural sum to `POSE_LIMITS`; the manual layer is not
clamped. VRM presets with `overrideMouth`/`overrideBlink: blend` are pre-compensated so an active emotion doesn't
weaken visemes or blink; presets that `block` get no procedural emotion.

### 5.3 AvatarController and conversation state

`AvatarController` is the public API of the avatar subsystem. It exists before the VRM is loaded
(`attachAvatar()` later), so states set during loading are kept. States: `idle`, `listening`, `thinking`,
`speaking`. Each state is a profile (head/gaze/breath multipliers, head/gaze offsets, lean, assistant/user emotion
weights) in `AvatarStateProfiles.ts`; transitions are smoothstep blends over `STATE_TRANSITION_DURATION` (0.35 s),
continuous across mid-transition changes; re-setting the target is a no-op. State is not emotion
(`thinking ≠ sad`, `speaking ≠ happy`).

### 5.4 Conversation signal resolution (extension)

`ConversationSignalResolver` combines voice-UI presence, assistant audio activity and user speech:
voice UI closed → `idle`; user speaking → `listening` (an interruption counts only after 300 ms of user speech,
an echo guard); assistant audio → `speaking` (held 450 ms); user just stopped → `thinking` after 200 ms, back to
`listening` after 6 s without a reply; otherwise `listening`.

### 5.5 Procedural idle

Breathing, automatic blink with occasional double blink, head micro-motion, gaze drift. Blink combines as
`max(manual, procedural)`; state changes never reset or reopen a blink. Gaze uses a lookAt proxy (camera target +
procedural offset), so eyes hold contact while the head moves.

### 5.6 Assistant lip sync

`AudioInput` (file, mic, test signal, external node, `MediaStream`) feeds one `AnalyserNode` (fftSize 1024).

- **Amplitude** (`AmplitudeLipSync`): RMS → dBFS → noise gate → level mapping → exact attack/release follower →
  mouth openness. Always present; the fallback and the loudness source.
- **Visemes** (`VisemeLipSync`): an analyser gives the *shape* (`aa ih ou ee oh`), amplitude gives the *opening*;
  silence forces the mouth closed. Analysers are pluggable behind `VisemeAnalyzer`:
  **HeadAudio** (default; MFCC + Gaussian prototypes, English model) and **wLipSync** (uLipSync MFCC matching in
  WASM, one-speaker example profile). Creation failure, missing asset or worklet error → amplitude.

In the extension the offscreen document runs this on the captured tab audio and sends `LipSyncFrame`s at 30 Hz;
the content script interpolates them and closes the mouth if frames stop for 250 ms.

### 5.7 User voice (optional, microphone)

Opt-in per browser session. The mic (`echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: false`)
is analysed in an AudioWorklet: `VoiceActivityDetector` (tracked noise floor, 12/6 dB margins, 100 ms attack, 300 ms
hangover), `PitchDetector` (McLeod, 60–800 Hz, `null` when unvoiced/low confidence), `PitchBaseline` (median of the
first ~1.5 s voiced speech, then ~40 s log-domain average; relative pitch in semitones). Only `UserVoiceFrame`
numbers leave the worklet (25 Hz). `UserReactionMapper` turns them into a bounded `UserReactionFrame`; reactions are
muted while the assistant speaks.

### 5.8 Prosody and emotion (both channels)

One `ProsodyEmotionAnalyzer` instance per channel (user, assistant per tab), same code. Heuristic features: energy,
pitch lift and variation, speech-rate proxy, spectral centroid/roll-off, ZCR, voiced ratio, pauses. Output
`EmotionFrame` (valence, arousal, energy, tension, pitch lift/variation, confidence, `valenceConfidence`, `mode`)
at 8 Hz. Heuristic valence confidence is capped at 0.25 (valence from prosody alone is near chance).

`EmotionChannels` follows both channels; `BehaviorMixer` maps them (`DEFAULT_EMOTION_MIX`, all subtle), weighted by
the state profile (speaking: assistant 1 / user 0; listening: assistant 0.15 / user 1) and confidence. The assistant
channel drives self-expression (face, brows, head/gaze motion, posture, gesture energy); the user channel drives
attentive reaction.

`mode` values: `heuristic` (no model), `ml-wasm` (model fused in), `fallback` (model failed; rules only).

### 5.9 Local emotion model (optional)

- Model `omote-ai/distilhubert-ser`, artifact `distilhubert_ser_int8.onnx` (~50.6 MB), pinned to an immutable
  Hugging Face revision and verified by exact size + SHA-256. **Technical source of truth:
  [`extension/src/emotion/EmotionModelManifest.ts`](extension/src/emotion/EmotionModelManifest.ts)**; the values are
  listed once in [extension/README.md](extension/README.md#emotion-model).
- Installed from the extension popup in one click: download → size check → SHA-256 → IndexedDB → ONNX Runtime
  initialisation in a dedicated Worker owned by the offscreen runtime → self-test → ready. Bytes live in IndexedDB
  (`prosopon-emotion-models`), metadata (id, revision, sha256, installedAt, enabled) in `chrome.storage.local`.
  Model bytes never go to `chrome.storage`. If the bytes are later missing while metadata remains, stale metadata is
  removed and *Retry* downloads a fresh verified copy. The offscreen self-test retries its first read briefly after
  installation to accommodate IndexedDB commit visibility between extension contexts and verifies a fresh Blob
  directly rather than waiting for its asynchronously published installation state.
- **Disable** keeps the verified bytes (re-enable without download); **Remove** deletes bytes and metadata.
- Inference: single-threaded WASM (packaged `ort-wasm-simd-threaded.jsep.wasm`) → heuristic. WebGPU is deliberately
  not used in the offscreen audio process: a GPU driver reset would interrupt tab audio and lip sync. A load timeout
  (30 s) or 3 failed inferences in a row turn every channel to `fallback`.
- Embedded build (`npm run build:extension:embedded`) packages the artifact inside the extension instead of
  downloading it.
- After installation inference is local and works offline.

### 5.10 Gestures

`avatar/src/avatar/gesture/`: `Gesture.ts` (contracts), `GestureConfig.ts` (amplitudes, rates, limits),
`GestureEngine.ts`, `SemanticGestureConfig.ts` + `SemanticGesturePolicy.ts` (5.11). Types: nod, double nod, head
tilt, head shake, lean in, body shift, shoulder shift, hand emphasis (head shake and lean in have rate 0: semantic
or manual only). One primary gesture at a time; lifecycle `prepare → attack → hold → release`; Poisson rates per
state (frame-rate independent), modulated by the assistant's arousal while speaking; randomised cooldown; repeat
penalty. Priority: forced/debug > boundary (nod after a user utterance) > semantic > speaking emphasis > ambient. Interruption or cancel releases
in 150–200 ms, never snaps. Hand emphasis is scheduled only while the assistant speaks and never while the user
speaks. Missing bones are skipped (no shoulders → shoulder shift becomes a chest roll).

### 5.11 Semantic performance layer

Reply text → `SemanticCue[]` → gesture decision. Cues are signals; "no gesture" is a normal outcome.

- **Analyzer** (`avatar/src/semantic/`, renderer-free): `SemanticAnalyzer.update(messageId, text, complete)` on the
  growing reply text. Segmentation into paragraph / list item / sentence / clause (fenced code skipped); a token trie
  of ~3 000 rules from data files (`rules/en|ru|uk|es.ts`; compiled once, ~20 ms) with multi-word precedence,
  Unicode word boundaries, positions (segment start, clause start, standalone, anywhere), tiers strong/medium/weak,
  negation rejection, `none` rules that swallow false friends ("не только… но и", "right now", "sino también"),
  quoted mentions ignored, a script hint between RU and UK. Structural signals: `?`/`¿`, numbered and bulleted items,
  a list intro ending with `:`, headings, bold, caps. Per segment the matches aggregate (noisy-OR) into at most one
  cue per type: question, enumeration (intro/item/final), contrast, conclusion, agreement, disagreement, emphasis;
  plus modifiers (example, cause, clarification). Streaming: a segment is emitted once its end is seen, or early
  when a strong marker opens it; each segment/type is emitted once, so a re-rendered or re-read reply yields no
  duplicates.
- **Pacer** (`SemanticPacer`): in a voice session the reply text arrives faster than it is spoken, so intents are
  released when the estimated spoken position (assistant audio seconds × 14 chars/s) reaches them, and dropped when
  3 s late. In text chat intents go out as they arrive. Inputs are two booleans per frame; no audio data.
- **Policy** (`SemanticGesturePolicy`, in `GestureEngine`): one decision per segment; skipped (with a logged
  reason) when disabled, stale, low confidence, the user is speaking, state is listening, global (2.5 s) or per-type
  (6 s) cooldown, a gesture of equal or higher priority runs. Otherwise one primary cue (disagreement > agreement >
  question > enumeration > conclusion > contrast; emphasis only boosts) and a roll of
  `base × confidence × strength × state × emphasis × prosody × repetition`. Mapping: agreement → nod / double nod;
  disagreement → head shake / tilt; question → head tilt / lean in; contrast → body or shoulder shift, tilt, hand
  (alternating side); enumeration → hand beat (alternating side) / body shift; conclusion → lean in / nod / hand;
  emphasis → hand / lean in / nod. While semantic intents are recent the ambient speaking rate is halved, so
  semantics replace rather than add motion. A long reply yields roughly one gesture per four to five cues.
- **Integration** (extension): `ChatGPTAdapter.readLatestReply()` renders the latest assistant message to light
  Markdown (lists, headings, bold; code blocks emptied); `SemanticFeed` reads it after DOM mutations at most every
  125 ms, ignores the reply that was on the page at activation, completes a reply after 2.5 s without change and
  switches itself off on any error. Sandbox: *Semantic* GUI folder plays demo replies (RU/UK/EN/ES).

### 5.12 Chrome extension runtime

MV3, Chrome 116+, active only on `https://chatgpt.com/*`.

| Context | Owns | Never |
|---|---|---|
| service worker | per-tab enable state (`TabSessions`), `tabCapture` stream ids, offscreen lifecycle, mic opt-in, emotion model installer, message routing | DOM, audio analysis, Three.js |
| offscreen document | tab + mic `MediaStream`s, AudioContexts, worklets, lip sync, VAD, pitch, prosody; owns the dedicated same-origin Worker for model inference | Three.js, VRM, Avatar, ChatGPT DOM |
| content script | `ChatGPTAdapter`, `AvatarOverlay` (full-viewport, click-through shadow root), `UiLayer` (in-page UI shadow root), `AvatarController`, `ConversationSignalResolver`, `FrameMouthSource`, `SemanticFeed` (reply text → gesture intents), Developer Mode (lazy chunk) | audio nodes, PCM, streams |
| popup | avatar on/off, microphone reactions, avatar layout (preset, size, *Move avatar*), emotion model install/enable/disable/remove, Developer mode switch | analysis, rendering, Three.js |
| permission page | one-time microphone grant for the extension origin | analysis |
| calibration export page | downloads the calibration ZIP (a `blob:` URL from the offscreen document), *Discard* | analysis, network |

The manifest content script is ~4 kB and inert until enabled; Three.js and the avatar runtime are imported from
`web_accessible_resources` only on activation. Tab audio is captured with `chrome.tabCapture` and played back from
the offscreen document so the user still hears ChatGPT. The content script connects a Port directly to the offscreen
document, so frames bypass the service worker. The service worker is stateless across restarts: it rebuilds state
from the captures the offscreen document still holds.

User-facing controls, all independent states (do not conflate them):

- **Avatar** for the current tab: popup → *Avatar* switch.
- **Microphone reactions**: popup → *Microphone reactions*, or right-click the toolbar icon → *Microphone
  reactions* (stored in `chrome.storage.session`, off after a browser restart). The mic is open only while this is
  on **and** at least one tab is enabled.
- **Emotion model**: popup → *Install & Enable* / *Disable emotions* / *Remove model* / *Retry* / *Cancel*.
- **Avatar layout**: popup → *Settings*: camera preset (Face / Waist / Full body), avatar size (75–250 %, default
  150 %), *Move avatar* (drag or arrow keys on the page), *Reset layout*. Default: Waist, 150 %, x 0.50, y 0.54.
  Persisted in `chrome.storage.local` and shared by every ChatGPT tab.
- **Developer mode** (default off): popup → *Developer mode*. Shows, inside ChatGPT, the Debug HUD, the Developer
  Tools window, the Avatar Controls window and a quick camera toolbar (see
  [extension/README.md](extension/README.md#developer-mode)). Users never see diagnostics unless they turn it on.

Storage keys (`extension/src/shared/settings.ts`, each validated and clamped on read, unknown versions → defaults):

| Key | Area | Schema |
|---|---|---|
| `prosopon.view` | local | `AvatarViewSettingsV1` `{version: 1, camera: {preset, distanceOffset, targetYOffset, yaw, pitch}, placement: {x, y, scale}}` |
| `prosopon.developerMode` | local | `boolean` |
| `prosopon.devWindows` | local | `DevWindowsSettingsV1` `{version: 1, windows: {hud?, devtools?, avatarControls?: {x, y, width, height, open, pinned}}, tabs}` |
| mic opt-in | session | `boolean` (see `service-worker.ts`) |
| emotion model metadata | local | see [extension/README.md](extension/README.md#emotion-model) |

Writes are debounced (250 ms) and flushed on pointer-up, `change` and close; another tab's write is applied live.
Closing a developer window survives a page reload while Developer mode stays on. Turning Developer mode off and back
on begins a new diagnostics session and restores the default Debug HUD, so the Developer Tools entry point is never
lost.

Permissions: `tabCapture`, `offscreen`, `scripting` (re-inject into open tabs after install/update), `contextMenus`
(mic opt-in), `storage` (mic opt-in in `session`; model metadata, layout and Developer Mode in `local`),
`unlimitedStorage` (protects the 50.6 MB local emotion-model Blob in IndexedDB from quota eviction); hosts `https://chatgpt.com/*`,
`https://huggingface.co/*` (model download). CSP `script-src 'self' 'wasm-unsafe-eval'` for ONNX Runtime WASM.

### 5.13 Privacy

Tab audio, microphone audio, model inference and reply-text analysis are processed locally; raw audio and text are
not uploaded, recorded or stored. The only network request Prosopon makes is the one-time pinned model download
(none in the embedded build).

One exception, explicit and Developer-mode only: while the [calibration wizard](docs/calibration-wizard.md) runs
(after the user presses *Start*, which states it), assistant and microphone audio and the reply text are held in
memory in the offscreen document and packed into a ZIP the user downloads. Nothing is uploaded; *Discard*, turning
Developer mode off or ending the tab's capture deletes them; nothing is written to extension storage.

### 5.14 Development tooling

- Sandbox (`avatar/`, `npm run dev`): lil-gui panels (Avatar, Lip Sync / Visemes, Emotion / Prosody, Gestures, Semantic),
  debug overlay, `window.__AVATAR_DEBUG__`, URL params `?analyzer=` and `?gestureSeed=`.
- Extension Developer mode (every build, off by default): Debug HUD, Developer Tools (incl. a *Semantic* tab:
  segments, cues, decisions with skip reasons, and a *Calibration* tab: the real-voice calibration wizard, see
  [docs/calibration-wizard.md](docs/calibration-wizard.md)), Avatar Controls, quick toolbar; no lil-gui in the
  extension.
- Extension development builds: diagnostics `data-*` attributes on the overlay host, `window.__PROSOPON_DEBUG__`
  (content-script world), page events `prosopon:debug` / `prosopon:gesture` / `prosopon:emotion` /
  `prosopon:semantic` / `prosopon:calibration`, service-worker E2E
  hook. None exist in production builds.
- Tests: Vitest unit + architecture tests in both packages; Playwright E2E for the sandbox and for the unpacked
  extension (real tab capture, fake microphone, WebGPU via SwiftShader).

Debug APIs are development-only and must not become runtime dependencies.

## 6. Configuration and options

| Option | Where | Default |
|---|---|---|
| Viseme analyser | sandbox `?analyzer=none\|headaudio\|wlipsync`; extension `AUDIO_RUNTIME_CONFIG` | `headaudio` |
| Monitor delay (align audio to mouth) | `AUDIO_RUNTIME_CONFIG.monitorDelay` (offscreen) | 0 (off) |
| Resolver timings | `ConversationSignalResolver` config | see 5.4 |
| Emotion analyser / mix | `DEFAULT_PROSODY_EMOTION_CONFIG`, `DEFAULT_EMOTION_MIX` | subtle, synthetic-tuned |
| Gesture amplitudes / rates | `GESTURE_CONFIG` | reasoned, not visually tuned |
| Semantic vocabulary / thresholds | `avatar/src/semantic/rules/*.ts`, `SEMANTIC_CONFIG` | hand-written examples only |
| Semantic → gesture mapping, chances, cooldowns | `SEMANTIC_GESTURE_CONFIG` | reasoned, not visually tuned |
| Speech rate of the text clock | `SEMANTIC_PACER_CONFIG.charsPerSecond` | 14 chars/s (estimate) |
| Embedded model build | `PROSOPON_EMBED_MODEL=1` (`build:extension:embedded`) | off |
| Docker file watching | `WATCH_POLLING=true` | off |

## 7. Known limitations

- **ChatGPT selector drift.** `CHATGPT_SELECTORS` were checked against production on 2026-09-26 and will drift.
  Repair only in `ChatGPTAdapter` (+ its E2E fixture).
- **Echo and crosstalk.** No custom AEC by design. On speakers the assistant can leak into the mic; mitigations are
  browser echo cancellation, the 300 ms interruption minimum and muting user reactions while the assistant speaks.
  Whether ChatGPT's own echo cancellation still works while the tab is captured is unverified. Headphones are the
  safe setup.
- **Calibration.** VAD, pitch, prosody and gesture thresholds are tuned on synthetic signals. The calibration
  wizard collects real-voice data but tunes nothing; its ChatGPT automation (typing a prompt during Voice, the
  composer/send/new-chat/voice/mute selectors, voice-name detection, reply text in voice mode) is tested on the
  fixture only and is unverified on production: manual checks in
  [docs/calibration-wizard.md](docs/calibration-wizard.md#manual-checks-on-real-chatgptcom). Other procedures are
  manual ([docs/](docs/)).
- **Viseme quality.** HeadAudio's model is English; the wLipSync profile is one speaker. Neither is validated on
  Russian or ChatGPT voices.
- **Latency.** Mouth lags audio by the analysis window + frame interval; `monitorDelay` trades it for audible delay.
- **Emotion quality.** The model is an animation control signal, not psychological truth; arousal is more reliable
  than valence; it is trained on acted speech. The output mapping of the installed model (see
  [extension/README.md](extension/README.md#emotion-model)) has not been validated against real model outputs.
- **Size.** ~50.6 MB model in IndexedDB plus ONNX Runtime WASM (~28 MB) in every package.
- **Web Store review.** The default build downloads a model graph from Hugging Face (no executable code). If that
  is a review problem, ship the embedded build.
- **VRM variation.** `overrideMouth`/`overrideBlink`, expression strengths, bone proportions and spring-bone setups
  differ per model; per-model calibration is expected.
- **Device changes.** A disappearing microphone ends the user pipeline; it does not reopen when the device returns.
- **Test gaps.** The emotion model Worker and full remote installer flow need an E2E fixture; the installer state
  and storage-recovery paths have unit coverage, and the
  extension's local-model E2E tests do not exercise the installed-model path (see
  [extension/README.md](extension/README.md#tests)). The real toolbar/popup user-gesture path and the live
  chatgpt.com DOM are not covered by E2E.
- **Layout on real ChatGPT.** The full-viewport overlay, the default Waist placement and the dev windows are E2E-
  tested on a fixture page only; how they sit next to ChatGPT's real composer and sidebar is a manual check.
- **Semantic layer on real ChatGPT.** On 2026-09-26, the logged-out shell used
  `[role="region"][aria-label="Conversation"]`; authenticated Voice Mode used the separate transcript path
  `[data-chatgpt-conversation-selection-target="true"]` →
  `[data-content-search-unit-key$=":assistant"]` → `[data-markdown-text-style="assistant-message"]` (with a
  nested `data-chatgpt-selection-message-id`). The Voice transcript grows while the assistant speaks; the adapter
  observes text-node and child-node updates inside that root. Timing is a text-clock estimate (fixed chars/s, no
  alignment):
  an accent can land a second early or late. The vocabulary is validated on hand-written ChatGPT-style replies, not
  on real ones; rule-based cues miss irony, implicit contrast and anything not in the lists. No brow accent. Manual
  checks: [docs/semantic-calibration.md](docs/semantic-calibration.md).
- **Layout is global.** One layout for every ChatGPT tab and window size; positions are normalized, so a very
  different aspect ratio can put the avatar over page content until it is moved.

## 8. Not implemented

Do not assume these exist:

- camera / visual tracking (MediaPipe, face landmarks, user smile, head pose, gaze);
- deeper semantic understanding (transcripts, text sentiment, LLM or ML NLP intent, word-level audio alignment);
- iconic/deictic gestures (pointing, sizing, finger counting, direction);
- full-body generative motion (motion diffusion, motion matching, mocap generation);
- custom echo cancellation;
- speaker identification / diarization;
- long-term personalisation (pitch baseline is per session);
- other voice providers (only ChatGPT has an adapter);
- Chrome Web Store packaging (store assets, privacy copy, release CI).

## 9. Future directions (not commitments)

- Real-world hardening: several ChatGPT voices; Russian, Ukrainian, English, Spanish; headphones vs laptop/external
  speakers; different mics; long sessions; tab suspend/resume; device disconnect/reconnect.
- Camera reaction layer: `camera → MediaPipe → user visual state → ReactionSource → BehaviorMixer`, never wired to
  VRM directly.
- Better multilingual lip sync (another analyser behind `VisemeAnalyzer`, not a second pipeline).
- Semantic layer: word-level timing from audio onsets instead of a fixed speech rate; brow accents; iconic gestures
  (direction, size, counting); vocabulary tuned on real replies.
- Smaller/faster emotion model and ORT footprint.
- Web Store productionisation: privacy copy, permission audit, icons, versioning, store package, model distribution
  policy, release CI.

## 10. Source-of-truth priority

```text
current code > architecture tests > PRODUCT.md > subsystem READMEs / docs > old user stories
```

User stories (US-00x) are historical intent, not architecture. Fix documentation that disagrees with the code in
the same change that notices it (see [AGENTS.md](AGENTS.md)).
