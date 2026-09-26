# PRODUCT.md — Prosopon

> **Primary product and architecture context for AI agents.**
>
> Before proposing or implementing changes:
>
> 1. Read this file.
> 2. Inspect the current code.
> 3. Inspect architecture tests relevant to the subsystem being changed.
> 4. Reuse existing contracts and extension points instead of creating parallel implementations.
>
> **If documentation and implementation disagree, current code is the final source of truth.**

---

## 1. Product

**Prosopon** is a browser-based realtime VRM avatar for voice AI.

The current product integrates with **ChatGPT Voice / Live** through a Chrome Manifest V3 extension and replaces the standard voice orb with an animated VRM character.

The avatar reacts to:

- assistant speech audio;
- user speech activity;
- user prosody;
- assistant prosody;
- conversation state;
- procedural idle behavior;
- procedural gestures;
- optional local emotion ML inference.

The system is designed so that animation does **not** require speech-to-text.

---

## 2. Product Goal

The intended experience is:

```text
ChatGPT Voice
    ↓
Prosopon avatar appears instead of the orb
    ↓
assistant speaks → mouth + face + body react
user speaks      → avatar listens/reacts
interruptions    → avatar immediately changes behavior
silence          → natural idle behavior
```

The avatar should feel alive without becoming visually noisy or over-animated.

Core design direction:

- subtle behavior over exaggerated motion;
- continuous motion over discrete canned states;
- local realtime processing where possible;
- graceful fallback when optional components fail;
- provider-independent avatar core.

---

## 3. Repository

Repository:

```text
https://github.com/bpteam/prosopon
```

Reference checked while creating this document:

```text
branch: master
commit: 359cde84b8fa5d126b7a481fa39f734bfbffacd7
```

Main layout:

```text
prosopon/
├── avatar/       # reusable renderer / audio / behavior core + sandbox
├── extension/    # Chrome MV3 integration
├── docs/         # calibration / implementation notes
└── compose.yaml
```

The extension imports reusable functionality from `avatar/src`.

**Do not create a second avatar/audio/behavior implementation inside `extension/`.**

---

# 4. Technology Stack

```text
TypeScript
Vite
Three.js
@pixiv/three-vrm
Chrome Extension Manifest V3
Web Audio API
AudioWorklet
ONNX Runtime Web
Vitest
Playwright
Docker / Docker Compose
```

Lip-sync analyzers:

```text
AmplitudeLipSync
HeadAudio
wLipSync
```

Emotion ML:

```text
omote-ai/distilhubert-ser
DistilHuBERT SER INT8 ONNX
```

---

# 5. Core Mental Model

Prosopon is not a Three.js talking-head demo.

The architecture is:

```text
                  ┌─ idle
                  ├─ conversation state
User audio ───────┼─ user reaction
                  ├─ user emotion
                  │
Assistant audio ──┼─ lip sync
                  ├─ assistant emotion
                  │
                  └─ gestures
                         ↓
                   BehaviorMixer
                         ↓
                  AvatarController
                         ↓
                       Avatar
                         ↓
                      three-vrm
```

ChatGPT is currently one provider/integration around that core.

The avatar core should remain reusable with other realtime voice providers.

---

# 6. Architectural Invariants

These are deliberate architectural constraints and should be preserved unless a task explicitly changes them.

## 6.1 One render loop

There is one main `requestAnimationFrame` render loop.

Subsystems must not create their own visual animation loops.

---

## 6.2 One procedural writer

`AvatarController` + `BehaviorMixer` own procedural composition.

Correct:

```text
Source
  ↓
typed frame
  ↓
BehaviorMixer
  ↓
AvatarController
  ↓
Avatar
```

Wrong:

```text
GestureEngine      → bone.rotation
EmotionAnalyzer    → Avatar.setExpression()
LipSyncEngine      → vrm.expressionManager
```

---

## 6.3 Audio and rendering are isolated

Audio code must not import:

```text
Avatar
AvatarController
Three.js
three-vrm
```

Rendering code must not receive:

```text
raw PCM
AudioNode
AudioContext
MediaStream
```

Only compact typed numeric frames cross subsystem boundaries.

---

## 6.4 ChatGPT DOM is isolated

All ChatGPT-specific selectors and DOM knowledge belong in:

```text
ChatGPTAdapter
```

Selectors must not leak into avatar/audio/behavior code.

---

## 6.5 Conversation state has one resolver

Audio processors emit signals.

They do not call:

```ts
controller.setState(...)
```

directly.

`ConversationSignalResolver` is the integration-layer owner of:

```text
idle
listening
thinking
speaking
```

---

## 6.6 Lip-sync owns articulation only

Lip-sync owns:

```text
aa
ih
ou
ee
oh
```

It does not own:

```text
blink
semantic emotion
conversation state
gestures
```

---

## 6.7 Gestures go through BehaviorMixer

`GestureEngine` produces a `GestureFrame`.

It never manipulates VRM bones directly.

---

## 6.8 User reactions are reactions, not mirroring

The avatar should not simply copy the user's:

```text
energy
pitch
emotion
```

User signals are mapped into bounded attentive/reaction behavior.

---

## 6.9 Animation does not require STT

Current lip-sync, state, prosody, emotion and gesture behavior do not depend on transcription.

No new feature should introduce STT as a hidden requirement unless explicitly intended.

---

## 6.10 Fail soft

Failure of optional systems must not break ChatGPT or basic avatar rendering.

Examples:

```text
emotion model fails      → heuristic mode
viseme analyzer fails    → amplitude lip-sync
microphone denied        → assistant avatar still works
ChatGPT selector drift   → ChatGPT stays usable
```

---

# 7. Avatar Rendering

The avatar sandbox and extension use:

```text
Three.js
+
@pixiv/three-vrm
+
VRM 1.0
```

Implemented:

- WebGL renderer;
- transparent canvas;
- responsive resize;
- VRM loading;
- VRMUtils optimizations;
- humanoid normalized bones;
- VRM expressions;
- lookAt;
- spring-bone runtime update;
- neutral lighting;
- debug overlay;
- development GUI.

Default framing is portrait-oriented:

```text
head
shoulders
upper torso
```

Camera framing is derived from the head bone where possible.

A fallback exists for models without a usable head bone.

---

# 8. Rest Pose

VRM models usually load in T-pose.

Prosopon has a configured `REST_POSE` that lowers the arms for portrait use.

This is part of the manual/base layer.

Procedural motion must return to `REST_POSE`, not raw T-pose.

---

# 9. Avatar Layering

Conceptually:

```text
manual/base layer
+
procedural layer
=
final avatar pose
```

Manual/base layer includes:

```text
REST_POSE
manual expressions
manual bone rotations
debug controls
```

Procedural layer includes:

```text
idle
conversation state
mouth
emotion
user reaction
gestures
```

Composition happens once per frame.

---

# 10. AvatarController

`AvatarController` is the public high-level API of the avatar subsystem.

It can exist before the VRM is loaded.

Example:

```ts
const controller = new AvatarController({ idle });

controller.setState('speaking');

controller.attachAvatar(avatar);

controller.update(delta);
```

This intentionally preserves state events that arrive before model loading completes.

---

# 11. Conversation States

Implemented states:

```text
idle
listening
thinking
speaking
```

State profiles control:

- head movement multiplier;
- gaze movement multiplier;
- breathing multiplier;
- head offsets;
- gaze offsets;
- body lean;
- user/assistant emotion weights.

Transitions are:

- delta-time based;
- smooth;
- continuous across mid-transition target changes.

Re-setting the current target state is a no-op.

Conversation state is separate from emotion.

```text
thinking != sad
speaking != happy
```

---

# 12. ConversationSignalResolver

Inputs:

```text
voice UI active
user speaking
assistant speaking
```

Typical state flow:

```text
voice UI opens
→ listening

user speaks
→ listening

user stops
→ thinking

assistant starts
→ speaking

assistant stops
→ listening
```

User speech has priority during interruptions.

Current behavior includes:

```text
minimum interruption speech ≈ 300 ms
thinking timeout ≈ 6 s
```

Short echo/noise spikes should not flip state.

---

# 13. Procedural Idle

Implemented:

- breathing;
- automatic blinking;
- occasional double blink;
- micro head motion;
- subtle gaze drift.

Timing is delta-based.

Blink/gaze state transitions split delta at event boundaries.

Behavior is tested across approximately:

```text
30 FPS
60 FPS
120 FPS
```

Main frame delta is clamped to:

```text
0.1 s
```

to avoid large jumps after tab suspension / very slow frames.

---

# 14. Blink

Automatic blink belongs to the idle/procedural layer.

Manual and procedural blink combine via:

```text
max(manual, procedural)
```

State changes must not:

- reset blink timers;
- reopen eyes mid-blink;
- restart blink phases.

---

# 15. Gaze

`vrm.lookAt.target` uses a proxy object.

The proxy is derived from:

```text
camera target
+
procedural gaze offset
```

This allows:

- independent head movement;
- stable eye contact;
- subtle gaze shifts;
- no direct eye-bone manipulation.

---

# 16. AudioInput

Core audio abstraction supports:

```text
file
microphone
test signal
external AudioNode
MediaStream
```

One active source goes through an `AnalyserNode`.

Current amplitude analysis uses:

```text
fftSize = 1024
```

roughly ~21 ms at common sample rates.

---

# 17. Amplitude Lip Sync

Pipeline:

```text
RMS
↓
dBFS
↓
noise gate
↓
level mapping
↓
attack/release smoothing
↓
mouth openness
```

Current approximate defaults:

```text
noiseFloorDb ≈ -50
fullOpenDb   ≈ -18
maxOpen      ≈ 0.8
attack       ≈ 30 ms
release      ≈ 100 ms
```

Smoothing:

```text
target + (value - target) * exp(-dt / tau)
```

This is frame-rate independent.

Known limitation:

```text
volume != articulation
```

Amplitude mode is intentionally a fallback.

---

# 18. Viseme Lip Sync

Implemented VRM visemes:

```text
aa
ih
ou
ee
oh
```

Current model:

```text
viseme analyzer determines shape
amplitude determines opening
```

Conceptually:

```text
shape × loudness = final mouth weights
```

Visemes are smoothed and crossfaded.

Silence closes the mouth.

---

# 19. Lip-Sync Analyzers

## 19.1 HeadAudio

Uses:

```text
MFCC
Gaussian prototypes
AudioWorklet
```

Outputs Oculus-like visemes mapped to VRM.

Strengths:

- local;
- lightweight;
- no STT.

Limitation:

- currently English-oriented.

---

## 19.2 wLipSync

Uses uLipSync-style MFCC matching in WASM.

Outputs roughly:

```text
A
I
U
E
O
S
```

mapped to VRM.

Limitation:

- current profile is speaker-dependent.

---

## 19.3 Fallback

If the viseme analyzer:

- fails to initialize;
- worklet asset fails;
- processor crashes;

Prosopon falls back to amplitude lip-sync.

---

# 20. Mouth Ownership

Lip-sync owns articulation.

Emotion can influence non-articulation mouth bias such as smile, but must not overwrite visemes.

VRM presets with:

```text
overrideMouth: blend
overrideBlink: blend
```

are compensated so emotion does not weaken lip-sync/blinking.

Hard `block` overrides are not used procedurally when they would break articulation.

---

# 21. User Voice Analysis

User microphone reactions are optional.

The microphone analysis pipeline is independent from assistant tab audio.

```text
assistant tab audio → assistant pipeline
microphone          → user pipeline
```

They are never mixed before analysis.

---

# 22. Microphone Capture

Requested approximately as:

```ts
{
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false
}
```

Microphone audio is not connected to speakers.

There is deliberately no feedback path:

```text
mic → AudioContext.destination
```

---

# 23. Voice Activity Detection

Implemented VAD includes:

```text
tracked noise floor
activation margin
deactivation margin
attack
hangover
```

Current approximate values:

```text
activation margin: 12 dB
deactivation margin: 6 dB
attack: 100 ms
hangover: 300 ms
```

Noise floor adapts slowly even during sustained loud input.

Reason:

constant noise such as a fan must not cause permanent `speaking = true`.

---

# 24. Pitch Detection

Implemented McLeod Pitch Method.

Approximate range:

```text
60–800 Hz
```

Low-confidence/unvoiced frames produce:

```text
pitchHz = null
```

instead of invented pitch.

---

# 25. Pitch Baseline

Raw Hz is not used as emotion directly.

A personal/session baseline is created from confident voiced speech.

Approximate behavior:

```text
initial baseline:
median of first ~1.5 s voiced speech

slow adaptation:
~40 s log-domain average
```

Relative pitch is represented in semitones.

---

# 26. UserVoiceFrame

The user analysis pipeline emits numeric frames, conceptually:

```ts
{
  speaking,
  rmsDb,
  energy,
  pitchHz,
  pitchConfidence,
  relativePitch,
  pitchVariation
}
```

Raw PCM is not transported into the content renderer.

---

# 27. User Reactions

Path:

```text
UserVoiceFrame
↓
UserReactionMapper
↓
UserReactionFrame
↓
BehaviorMixer
```

The avatar reacts rather than mirrors.

Examples:

```text
higher user energy
→ slightly more attentiveness

higher relative pitch
→ subtle attention change
```

The user's voice never drives avatar lip-sync.

---

# 28. Interruption Handling

When assistant speech and meaningful user speech overlap:

```text
assistant speaking
+
user speaking
↓
listening
```

Current minimum interruption speech is ~300 ms.

User reaction weight increases.

Assistant self-expression weight drops strongly.

---

# 29. Prosody / Emotion Analysis

Both channels use the same implementation:

```text
ProsodyEmotionAnalyzer
```

with independent state:

```text
user analyzer
assistant analyzer
```

No STT.

No transcript.

No backend is required for realtime analysis.

---

# 30. EmotionFrame

Conceptually contains:

```text
valence
arousal
energy
tension
pitch lift
pitch variation
confidence
valence confidence
mode
```

The analyzer does not know about Avatar/VRM/Three.js.

---

# 31. Heuristic Prosody Mode

Without ML, Prosopon uses features including:

```text
energy
pitch
pitch variation
speech rate proxy
spectral centroid
spectral rolloff
zero crossing rate
voiced ratio
pause structure
```

Useful outputs:

```text
arousal
energy
tension
```

Valence from acoustic-only heuristics is intentionally low-confidence.

---

# 32. Emotion Behavior

When the assistant speaks:

```text
assistant EmotionFrame
↓
self-expression
```

may affect:

- face;
- brows;
- eye openness;
- head motion;
- gaze;
- posture;
- gesture energy.

When the user speaks:

```text
user EmotionFrame
↓
reaction behavior
```

The avatar becomes more attentive rather than copying emotion directly.

---

# 33. Emotion Channel Priority

Typical current weighting:

```text
speaking:
assistant ≈ 1
user ≈ 0

listening:
assistant ≈ 0.15
user ≈ 1
```

The final mapping is inside `BehaviorMixer`.

---

# 34. Emotion ML Model

Configured model:

```text
omote-ai/distilhubert-ser
```

Artifact:

```text
distilhubert_ser_int8.onnx
```

Pinned immutable revision:

```text
6c4a6846578f718581e01883d01af7d174839123
```

Expected size:

```text
50,630,102 bytes
```

Expected SHA-256:

```text
b3bd62c1d1e74983ce712458e25368dfe32d37b7fc20618f109fd0bfa49cfa97
```

Expected input:

```text
mono
16 kHz
Float32
```

Outputs:

```text
arousal
valence
```

Source of truth:

```text
extension/src/emotion/EmotionModelManifest.ts
```

---

# 35. Emotion Model Installation

The user can install the model directly from the extension popup.

Flow:

```text
Install & Enable emotions
↓
download pinned ONNX
↓
verify exact size
↓
verify SHA-256
↓
store in IndexedDB
↓
initialize ONNX Runtime
↓
self-test
↓
ready
```

Available actions:

```text
Install & Enable
Enable
Disable
Remove
Retry
Cancel download
```

No manual file copying is required.

---

# 36. Emotion Model Storage

Binary model:

```text
IndexedDB
database: prosopon-emotion-models
```

Metadata:

```text
chrome.storage.local
```

Metadata includes:

```text
model id
revision
sha256
installation timestamp
enabled
```

Model bytes are not stored as base64 in Chrome storage.

---

# 37. Integrity

Every downloaded model is verified against:

```text
exact size
SHA-256
```

Production does not use:

```text
resolve/main
```

A corrupt/incomplete model is deleted and is not considered installed.

---

# 38. ONNX Runtime

Inference fallback:

```text
WebGPU
↓
WASM
↓
heuristic
```

ORT executable JS/WASM is packaged locally.

Remote executable code is not loaded.

Current CSP requires:

```text
wasm-unsafe-eval
```

for ORT WASM.

---

# 39. Model Download Permission

Current extension manifest allows:

```text
https://huggingface.co/*
```

for the pinned model download.

After installation, inference is local and works offline.

---

# 40. Embedded Model Build

An embedded model build path exists:

```bash
npm run build:extension:embedded
```

using:

```text
PROSOPON_EMBED_MODEL=1
```

This packages the ONNX artifact with the extension.

Use this if Chrome Web Store review/policy makes remote model download undesirable.

---

# 41. Gesture Engine

Implemented renderer-independent gesture system:

```text
avatar/src/avatar/gesture/
```

Core:

```text
Gesture.ts
GestureConfig.ts
GestureEngine.ts
```

The gesture engine does not import Avatar/Three.js/VRM.

---

# 42. Gesture Behavior

Gesture frames can affect:

```text
head
body
shoulders
upper arms
lower arms
```

Examples include:

- nod;
- head tilt;
- body shift;
- shoulder shift;
- speaking hand emphasis.

One primary gesture is active at a time.

---

# 43. Gesture Scheduling

Gesture lifecycle:

```text
prepare
→ attack
→ hold
→ release
```

Features:

- randomized cooldown;
- state-dependent rate;
- emotion/prosody modulation;
- repeat penalty;
- priorities;
- cancellation;
- fast release during interruption.

Hands are currently only used during assistant speech.

---

# 44. Gesture Priority

Conceptually:

```text
forced/debug
>
boundary
>
speaking emphasis
>
ambient
```

Interrupted assistant gestures release smoothly rather than snapping.

---

# 45. Nod Ownership

Nod generation belongs to `GestureEngine`.

`UserReactionMapper` reports utterance boundaries rather than directly owning head nod animation.

This avoids competing head-motion writers.

---

# 46. Missing Bones

Gesture behavior degrades gracefully when optional humanoid bones are missing.

Missing arms/shoulders must not crash the avatar.

Fallback body/chest motion may be used where appropriate.

---

# 47. Chrome Extension

Manifest V3 extension.

Minimum Chrome:

```text
116+
```

Main contexts:

```text
service worker
offscreen document
content script
permission page
popup
```

Target:

```text
https://chatgpt.com/*
```

---

# 48. Extension Runtime Architecture

```text
ChatGPT tab
   │
   ├── DOM
   │    ↓
   │ Content Script
   │    ↓
   │ AvatarOverlay
   │    ↓
   │ AvatarController
   │
   └── audio
        ↓
   chrome.tabCapture
        ↓
   Offscreen Document
        ↓
   analyzers
        ↓
   numeric frames
        ↓
   content runtime
```

---

# 49. Service Worker

Owns:

```text
enable/disable
tab session state
tabCapture stream IDs
offscreen lifecycle
popup coordination
emotion model installer coordination
message orchestration
```

Must not own:

```text
DOM
Three.js
VRM rendering
PCM analysis
```

---

# 50. Offscreen Runtime

Owns:

```text
assistant tab MediaStream
microphone MediaStream
AudioContexts
AudioWorklets
lip-sync
VAD
pitch
prosody
emotion inference
```

Must not import:

```text
Three.js
VRM
Avatar
ChatGPT DOM code
```

---

# 51. Content Runtime

Owns:

```text
ChatGPTAdapter
AvatarOverlay
AvatarController
ConversationSignalResolver
FrameMouthSource
BehaviorMixer inputs
```

Must not receive raw audio objects.

---

# 52. Runtime Transport

Typed protocol with:

```text
PROTOCOL_VERSION
```

Transported frames include:

```text
LipSyncFrame
UserVoiceFrame
EmotionFrame
status/state events
```

Do not continuously transport:

```text
PCM
FFT arrays
AudioBuffer
MediaStream
```

---

# 53. Lazy Loading

The manifest content script stays small before activation.

Heavy runtime:

```text
Three.js
three-vrm
avatar runtime
```

is dynamically loaded only after Prosopon is enabled.

---

# 54. ChatGPTAdapter

Only `ChatGPTAdapter` knows ChatGPT selectors.

Uses observation rather than high-frequency polling.

React-managed orb DOM is hidden/restored rather than destructively removed.

If selectors fail:

```text
ChatGPT remains usable
avatar may use fallback placement
orb may remain visible
```

---

# 55. ChatGPT Selector Drift

Current selectors were manually checked against production on:

```text
2026-09-26
```

They will eventually drift.

Maintenance point:

```text
ChatGPTAdapter
CHATGPT_SELECTORS
```

Do not fix selector breakage elsewhere.

---

# 56. tabCapture

Assistant audio uses:

```text
chrome.tabCapture
```

Captured audio goes to:

```text
analysis
+
AudioContext.destination
```

so the user continues hearing ChatGPT.

---

# 57. Microphone Opt-In

Microphone reactions are currently controlled separately through the toolbar action context menu.

Preference storage:

```text
chrome.storage.session
```

Therefore it resets after full browser restart.

The microphone is active only when:

```text
mic reactions enabled
AND
at least one Prosopon tab enabled
```

---

# 58. Popup

Current popup has conceptually separate controls.

## Avatar

```text
Enable avatar
Disable avatar
```

## Emotion Intelligence

```text
Install & Enable emotions
Enable emotions
Disable emotions
Remove emotion model
Retry
```

Important:

```text
avatar enabled
emotion model enabled
microphone reactions enabled
```

are separate states.

Do not conflate them.

---

# 59. Privacy

Current intended privacy model:

```text
ChatGPT tab audio → local analysis
microphone audio → local analysis
emotion ONNX      → local inference
```

Raw audio is not intentionally uploaded for Prosopon analysis.

Network use for the emotion model is currently only the initial pinned model download.

---

# 60. Sandbox

The standalone `avatar/` app is a first-class development environment.

Use it to debug:

```text
VRM rendering
state machine
idle
lip-sync
emotion
gestures
calibration
```

without extension reload overhead.

Typical commands:

```bash
cd avatar
npm install
npm run dev
npm test
npm run test:e2e
npm run typecheck
```

---

# 61. Extension Development

Typical:

```bash
cd avatar
npm ci

cd ../extension
npm ci
npm run build
```

Load:

```text
chrome://extensions
→ Developer mode
→ Load unpacked
→ extension/dist
```

Development content scripts do not have HMR like a normal page.

After rebuild, reload the extension and ChatGPT tab as needed.

---

# 62. Docker

The repo supports Docker-based development/testing.

Current compose setup covers:

```text
avatar dev
avatar tests
avatar E2E
extension build
extension tests
extension E2E
```

Use existing `compose.yaml` and package READMEs for exact commands.

---

# 63. Tests

Existing test categories:

```text
unit
architecture
Playwright E2E
```

Coverage includes:

- VRM loading;
- state transitions;
- frame-rate independence;
- idle;
- blink;
- gaze;
- amplitude lip-sync;
- visemes;
- analyzer fallback;
- VAD;
- pitch;
- pitch baseline;
- microphone lifecycle;
- interruption;
- ChatGPTAdapter DOM fixtures;
- tabCapture;
- offscreen transport;
- SPA duplication protection;
- emotion channels;
- ONNX WebGPU/WASM/fallback paths;
- gesture scheduling;
- import-boundary architecture rules;
- model installer/integrity behavior.

**Do not delete architectural tests merely because they make a new implementation inconvenient.**

---

# 64. Debug / Calibration

Existing calibration documentation:

```text
docs/US-006-calibration.md
docs/US-008-calibration.md
```

Development tooling exposes debug information for:

```text
FPS
renderer
state
lip-sync
visemes
user voice
conversation signals
emotion
gestures
```

Debug APIs are development-only and should not become runtime dependencies.

---

# 65. Known Limitations

## 65.1 ChatGPT selector drift

Selectors will break eventually.

Expected repair location:

```text
ChatGPTAdapter
```

---

## 65.2 Speaker echo / AEC

Real-world speaker echo behavior still needs broader device validation.

Headphones remain the safest environment.

There is deliberately no custom acoustic echo canceller.

---

## 65.3 Crosstalk

Assistant output can leak into microphone input.

Current mitigations:

- browser echo cancellation;
- interruption minimum duration;
- suppress user reactions while assistant speaks.

---

## 65.4 Microphone calibration

VAD and pitch logic are strongly tested synthetically but still require wider real-device tuning.

Thresholds are not universal.

---

## 65.5 Viseme quality

HeadAudio is English-oriented.

wLipSync profile quality depends on speaker calibration.

Multilingual speech and different ChatGPT voices require evaluation.

---

## 65.6 Lip-sync latency

There is unavoidable analysis-window latency.

An optional monitor delay can be used to align perceived audio/mouth timing, but adds the same audible delay.

---

## 65.7 Emotion quality

The current ML model is suitable as an animation-control signal, not as psychological truth.

Arousal is generally more reliable than valence.

The underlying model is trained from acted speech.

---

## 65.8 Emotion model size

Approximate model size:

```text
~50.6 MB
```

plus ONNX Runtime.

This is a meaningful packaging/storage cost.

---

## 65.9 Chrome Web Store remote-model review

The default build can download a pinned ONNX model from Hugging Face.

Executable JS/WASM remains local.

If Web Store review considers the model graph problematic, use the embedded-model build.

---

## 65.10 VRM-specific overrides

Different models vary in:

```text
overrideMouth
overrideBlink
expression strengths
bone proportions
spring-bone collision setup
```

Model calibration is expected.

---

# 66. Not Implemented Yet

Do not assume the following exists.

## Camera / user visual tracking

Not implemented:

```text
MediaPipe Face
camera capture
face landmarks
user smile detection
user head pose
user gaze tracking
visual emotion reaction
```

---

## Semantic animation understanding

Not implemented:

```text
transcript meaning
text sentiment
LLM intent signals
semantic emphasis
question/answer semantics
```

---

## Semantic gestures

Current gestures are procedural/state/prosody driven.

The avatar does not yet understand semantic requests such as:

```text
point left
show something large
count three things
gesture toward an object
```

---

## Full-body generative motion

Not implemented:

```text
motion diffusion
motion matching DB
full-body neural animation
mocap generation
```

---

## Custom echo cancellation

No custom AEC.

---

## Speaker identification

No speaker diarization or persistent user identity model.

---

## Long-term personalization

Pitch baseline is session-level.

There is no long-term learned behavioral/emotional profile.

---

# 67. Recommended Future Directions

These are directions, not commitments.

## 67.1 Real-world hardening

Test:

```text
multiple ChatGPT voices
Russian
Ukrainian
English
Spanish
headphones
laptop speakers
external speakers
different microphones
long sessions
tab suspend/resume
device disconnect/reconnect
```

---

## 67.2 MediaPipe reaction layer

Future architecture should be:

```text
camera
↓
MediaPipe
↓
user visual state
↓
ReactionSource
↓
BehaviorMixer
```

Do not wire MediaPipe directly to VRM.

---

## 67.3 Better multilingual lip-sync

Evaluate/train/calibrate a more universal viseme solution.

---

## 67.4 Semantic gesture hints

Optional semantic signals could later feed GestureEngine:

```text
agreement
question
emphasis
enumeration
direction
size
```

They must remain another source into the behavior system.

---

## 67.5 Runtime/model optimization

Potential targets:

```text
smaller emotion model
smaller ORT footprint
lower startup time
lower inference latency
better quantization
```

---

## 67.6 Distribution

Chrome Web Store productionization:

```text
privacy copy
permission audit
icons/assets
release versioning
store package
model distribution policy
release CI
```

---

# 68. Rules for Future AI Agents

Before implementing a new feature:

1. Read `PRODUCT.md`.
2. Inspect current code.
3. Inspect relevant architecture tests.
4. Reuse existing source contracts.
5. Avoid duplicate subsystem implementations.
6. Add new behavior as a typed source into `BehaviorMixer`.
7. Do not send raw PCM across extension contexts unless strictly necessary.
8. Do not couple audio analyzers to rendering.
9. Do not couple avatar behavior to ChatGPT DOM.
10. Preserve graceful fallback behavior.
11. Keep previous tests green.
12. If a proposed change violates an invariant, explain the reason before implementing it.

---

# 69. Source-of-Truth Priority

When there is disagreement:

```text
current code
    >
architecture tests
    >
PRODUCT.md
    >
subsystem README/docs
    >
old user stories
```

Old user stories describe historical intent and must not be treated as the current architecture automatically.

---

# 70. Summary

Current Prosopon already has:

```text
VRM renderer
procedural idle
conversation state machine
ChatGPT overlay
tabCapture
assistant lip-sync
amplitude fallback
HeadAudio / wLipSync
user microphone analysis
VAD
pitch baseline
interruption handling
user reactions
dual-channel prosody analysis
optional local emotion ML
one-click emotion-model installation
gesture engine
debug/calibration tooling
unit + architecture + E2E tests
```

The project should now evolve by **adding new typed behavior sources to the existing pipeline**, not by replacing the core architecture.
