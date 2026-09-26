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
procedural idle behaviour and procedural gestures, optionally refined by a local emotion ML model.
**No speech-to-text is involved**: every signal is acoustic.

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

ChatGPT is one integration around this core. New inputs (another voice provider, camera tracking, semantic hints)
must enter as another typed source into `BehaviorMixer`, never as another writer of bones or expressions.

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
5. **ChatGPT DOM is isolated** *(tested)*. All ChatGPT selectors and DOM knowledge live in `ChatGPTAdapter`
   (`CHATGPT_SELECTORS`). Selector breakage is fixed there and nowhere else.
6. **One conversation-state resolver** *(tested)*. Audio processors emit signals; only `ConversationSignalResolver` (extension
   content script) calls `controller.setState()`.
7. **Lip sync owns articulation only**: visemes `aa ih ou ee oh`. Not blink, not emotion, not state, not gestures.
   Emotion may bias the face but never overwrites visemes. The user's voice never drives the mouth.
8. **The nod belongs to `GestureEngine`** *(tested)*. `UserReactionMapper` reports utterance boundaries (`utteranceEnds`
   counter, `lastUtteranceDuration`); it does not animate the head.
9. **React, don't mirror.** User energy, pitch and emotion map to bounded attentiveness (`REACTION_LIMITS`, emotion
   mix bounds), never copied onto the avatar.
10. **No hidden STT.** Nothing in lip sync, state, prosody, emotion or gestures depends on transcription.
11. **Assistant and user audio are never mixed before analysis.** Tab capture and microphone are separate pipelines.
12. **No microphone feedback path.** The mic is never connected to `AudioContext.destination`; the user-voice worklet
    node has zero outputs (checked in `UserVoicePipeline.link()`).
13. **Fail soft.** An optional part failing must not break ChatGPT or basic rendering:
    viseme analyser fails → amplitude lip sync; emotion model fails → prosody heuristics (`fallback` mode);
    mic denied or missing → assistant-only avatar; selector drift → ChatGPT stays usable, avatar uses fallback
    placement.
14. **No raw audio across extension contexts** *(tested)*. Frames (`LipSyncFrame`, `UserVoiceFrame`, `EmotionFrame`, status)
    travel over the typed protocol (`PROTOCOL_VERSION` in `extension/src/shared/messages.ts`). PCM chunks for the
    local model stay inside the offscreen document.
15. **Executable code is local.** No remote JS/WASM. The only network fetch is the pinned emotion model download.
16. **Delta-time everywhere.** Animation integrates `delta`; discrete events split delta at their boundary, so
    30/60/120 FPS give the same result.

Do not delete or weaken architecture tests because they make a new implementation inconvenient.

## 5. Implemented subsystems

Details, APIs and tunables: [avatar/README.md](avatar/README.md) and [extension/README.md](extension/README.md).

### 5.1 Rendering (avatar core)

Three.js WebGL renderer with a transparent canvas, VRM 1.0 loading with VRMUtils optimisations, normalized humanoid
bones, expressions, lookAt and spring bones. Portrait framing (head, shoulders, upper torso) is derived from the head
bone, with a fallback for models without one. `REST_POSE` (`avatar/src/config.ts`) lowers the T-pose arms; procedural
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

`mode` values: `heuristic` (no model), `ml-webgpu` / `ml-wasm` (model fused in), `fallback` (model failed; rules only).

### 5.9 Local emotion model (optional)

- Model `omote-ai/distilhubert-ser`, artifact `distilhubert_ser_int8.onnx` (~50.6 MB), pinned to an immutable
  Hugging Face revision and verified by exact size + SHA-256. **Technical source of truth:
  [`extension/src/emotion/EmotionModelManifest.ts`](extension/src/emotion/EmotionModelManifest.ts)**; the values are
  listed once in [extension/README.md](extension/README.md#emotion-model).
- Installed from the extension popup in one click: download → size check → SHA-256 → IndexedDB → ONNX Runtime
  initialisation in the offscreen document → self-test → ready. Bytes live in IndexedDB
  (`prosopon-emotion-models`), metadata (id, revision, sha256, installedAt, enabled) in `chrome.storage.local`.
  Model bytes never go to `chrome.storage`.
- **Disable** keeps the verified bytes (re-enable without download); **Remove** deletes bytes and metadata.
- Inference: WebGPU → WASM (single-threaded, packaged `ort-wasm-simd-threaded.jsep.wasm`) → heuristic. A load
  timeout (30 s) or 3 failed inferences in a row turn every channel to `fallback`.
- Embedded build (`npm run build:extension:embedded`) packages the artifact inside the extension instead of
  downloading it.
- After installation inference is local and works offline.

### 5.10 Gestures

`avatar/src/avatar/gesture/`: `Gesture.ts` (contracts), `GestureConfig.ts` (amplitudes, rates, limits),
`GestureEngine.ts`. Types: nod, double nod, head tilt, body shift, shoulder shift, hand emphasis. One primary gesture
at a time; lifecycle `prepare → attack → hold → release`; Poisson rates per state (frame-rate independent),
modulated by the assistant's arousal while speaking; randomised cooldown; repeat penalty. Priority:
forced/debug > boundary (nod after a user utterance) > speaking emphasis > ambient. Interruption or cancel releases
in 150–200 ms, never snaps. Hand emphasis is scheduled only while the assistant speaks and never while the user
speaks. Missing bones are skipped (no shoulders → shoulder shift becomes a chest roll).

### 5.11 Chrome extension runtime

MV3, Chrome 116+, active only on `https://chatgpt.com/*`.

| Context | Owns | Never |
|---|---|---|
| service worker | per-tab enable state (`TabSessions`), `tabCapture` stream ids, offscreen lifecycle, mic opt-in, emotion model installer, message routing | DOM, audio analysis, Three.js |
| offscreen document | tab + mic `MediaStream`s, AudioContexts, worklets, lip sync, VAD, pitch, prosody, model inference | Three.js, VRM, Avatar, ChatGPT DOM |
| content script | `ChatGPTAdapter`, `AvatarOverlay` (shadow root), `AvatarController`, `ConversationSignalResolver`, `FrameMouthSource` | audio nodes, PCM, streams |
| popup | avatar on/off for the active tab, emotion model install/enable/disable/remove | analysis, rendering |
| permission page | one-time microphone grant for the extension origin | analysis |

The manifest content script is ~4 kB and inert until enabled; Three.js and the avatar runtime are imported from
`web_accessible_resources` only on activation. Tab audio is captured with `chrome.tabCapture` and played back from
the offscreen document so the user still hears ChatGPT. The content script connects a Port directly to the offscreen
document, so frames bypass the service worker. The service worker is stateless across restarts: it rebuilds state
from the captures the offscreen document still holds.

User-facing controls, all independent states (do not conflate them):

- **Avatar** for the current tab: popup → *Enable avatar* / *Disable avatar*.
- **Microphone reactions**: right-click the toolbar icon → *Microphone reactions* (stored in
  `chrome.storage.session`, off after a browser restart). The mic is open only while this is on **and** at least one
  tab is enabled.
- **Emotion model**: popup → *Install & Enable emotions* / *Enable* / *Disable* / *Remove* / *Retry* / *Cancel*.

Permissions: `tabCapture`, `offscreen`, `scripting` (re-inject into open tabs after install/update), `contextMenus`
(mic opt-in), `storage` (mic opt-in in `session`, model metadata in `local`); hosts `https://chatgpt.com/*`,
`https://huggingface.co/*` (model download). CSP `script-src 'self' 'wasm-unsafe-eval'` for ONNX Runtime WASM.

### 5.12 Privacy

Tab audio, microphone audio and model inference are processed locally; raw audio is not uploaded or recorded. The
only network request Prosopon makes is the one-time pinned model download (none in the embedded build).

### 5.13 Development tooling

- Sandbox (`avatar/`, `npm run dev`): lil-gui panels (Avatar, Lip Sync / Visemes, Emotion / Prosody, Gestures),
  debug overlay, `window.__AVATAR_DEBUG__`, URL params `?analyzer=` and `?gestureSeed=`.
- Extension development builds: diagnostics overlay, `window.__PROSOPON_DEBUG__` (content-script world),
  page events `prosopon:debug` / `prosopon:gesture`, service-worker E2E hook. None exist in production builds.
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
| Embedded model build | `PROSOPON_EMBED_MODEL=1` (`build:extension:embedded`) | off |
| Docker file watching | `WATCH_POLLING=true` | off |

## 7. Known limitations

- **ChatGPT selector drift.** `CHATGPT_SELECTORS` were checked against production on 2026-09-26 and will drift.
  Repair only in `ChatGPTAdapter` (+ its E2E fixture).
- **Echo and crosstalk.** No custom AEC by design. On speakers the assistant can leak into the mic; mitigations are
  browser echo cancellation, the 300 ms interruption minimum and muting user reactions while the assistant speaks.
  Whether ChatGPT's own echo cancellation still works while the tab is captured is unverified. Headphones are the
  safe setup.
- **Calibration.** VAD, pitch, prosody and gesture thresholds are tuned on synthetic signals; real mic / real
  ChatGPT voice calibration is manual ([docs/](docs/)).
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
- **Test gaps.** The emotion model installer (download, integrity, storage) has no automated tests, and the
  extension's local-model E2E tests do not exercise the installed-model path (see
  [extension/README.md](extension/README.md#tests)). The real toolbar/popup user-gesture path and the live
  chatgpt.com DOM are not covered by E2E.

## 8. Not implemented

Do not assume these exist:

- camera / visual tracking (MediaPipe, face landmarks, user smile, head pose, gaze);
- semantic understanding (transcripts, text sentiment, LLM intent, semantic emphasis);
- semantic gestures (pointing, sizing, counting);
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
- Semantic gesture hints (agreement, question, emphasis, enumeration, direction, size) as another input to
  `GestureEngine`.
- Smaller/faster emotion model and ORT footprint.
- Web Store productionisation: privacy copy, permission audit, icons, versioning, store package, model distribution
  policy, release CI.

## 10. Source-of-truth priority

```text
current code > architecture tests > PRODUCT.md > subsystem READMEs / docs > old user stories
```

User stories (US-00x) are historical intent, not architecture. Fix documentation that disagrees with the code in
the same change that notices it (see [AGENTS.md](AGENTS.md)).
