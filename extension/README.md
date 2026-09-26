# Prosopon Chrome extension

Replaces the ChatGPT voice orb on `chatgpt.com` with the VRM avatar, drives its mouth from the audio the tab plays,
optionally listens to the user's microphone for conversation state and reactions, and optionally refines emotion with
a local ONNX model. Manifest V3, Chrome 116+. All audio analysis and inference stay in the browser; nothing is
recorded.

Product context and invariants: [../PRODUCT.md](../PRODUCT.md). Rules for changes (including which docs to update):
[../AGENTS.md](../AGENTS.md). The avatar/audio/behaviour core it imports: [../avatar/README.md](../avatar/README.md).

## Build

```bash
cd avatar && npm ci      # Avatar Core and its dependencies (three, three-vrm, wlipsync, onnxruntime-web) live here
cd ../extension && npm ci
npm run build            # typecheck + production build → extension/dist
```

| Script | What it does |
|---|---|
| `npm run build` (= `build:extension`) | typecheck, production build into `dist/` |
| `npm run build:extension:embedded` | same, with the emotion model packaged inside (see [Embedded build](#embedded-build)) |
| `npm run build:dev` | development build: diagnostics overlay, debug events, service-worker E2E hook |
| `npm run dev` | development build, rebuilt on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest unit + architecture tests |
| `npm run test:e2e` | development build, then Playwright with the unpacked extension |

Content scripts have no HMR: after a rebuild, reload the extension in `chrome://extensions` and the ChatGPT tab. The
old content script notices its dead runtime and removes itself, so overlays don't duplicate.

### Docker

`compose.yaml` in the repo root has an `extension` service (profile `extension`) and an `extension-e2e` service
(profile `test`). Both bind-mount `avatar/` and `extension/`, so `extension/dist` appears on the host and is loaded
unpacked from there. `node_modules` of both packages live in named volumes and are reinstalled by the entrypoint when
a `package-lock.json` changes.

```bash
docker compose run --rm extension                      # production build → extension/dist
docker compose run --rm extension npm run dev          # development build, rebuilt on change
WATCH_POLLING=true docker compose run --rm extension npm run dev   # when edits aren't picked up (Docker Desktop on Windows)
docker compose run --rm extension npm test             # unit tests
docker compose --profile test run --rm extension-e2e   # E2E in mcr.microsoft.com/playwright (Chromium + tab capture)
```

- Build context is the repo root (the extension compiles `avatar/src`); `extension/Dockerfile.dockerignore` limits
  it to the lockfiles.
- `extension-e2e` rebuilds `extension/dist` in development mode: run the production build again before real use.
- Containers run as uid 1000; with another host uid, `extension/dist` gets the wrong owner.
- The Playwright image tag in `extension/Dockerfile` must match `@playwright/test` in `extension/package-lock.json`.

## Use

`chrome://extensions` → Developer mode → *Load unpacked* → `extension/dist`.

- **Avatar.** On chatgpt.com click the Prosopon toolbar icon: the popup opens. *Enable avatar* / *Disable avatar*
  switches the current tab. The badge shows `ON`, `…` (starting) or `!` (error; the tooltip says why). Start voice
  mode as usual; the avatar takes the orb's place. The capture survives page reloads; leaving chatgpt.com, closing
  the tab or the stream ending disables the tab.
- **Microphone reactions** (off by default). Right-click the toolbar icon → *Microphone reactions (audio stays
  local)*. The first time, a Prosopon tab asks Chrome for the microphone (the offscreen document can't show a
  prompt) and closes itself once allowed. The choice is kept in `chrome.storage.session`, so a restarted browser
  starts with the mic off. The mic is open only while the choice is on **and** a tab is enabled. Without the
  permission or a mic, the avatar and lip sync work as before.
- **Emotion model** (optional). Popup → *Emotion Intelligence* → *Install & Enable emotions*; see
  [Emotion model](#emotion-model).

These three are independent states.

## Architecture

```text
chatgpt.com tab ──audio──► chrome.tabCapture ──stream id──► offscreen document
                                                            assistant: AudioInput.attachMediaStream (monitor → speakers)
                                                              AmplitudeLipSync + VisemeLipSync + HeadAudio/wLipSync
                                                              → LipSyncFrame @ 30 Hz, per tab
                                                              feature worklet → ProsodyEmotionAnalyzer → EmotionFrame @ 8 Hz
microphone (opt-in) ──getUserMedia──────────────────────►   user: UserVoicePipeline (own AudioContext)
                                                              AudioWorklet: UserVoiceAnalyzer (VAD, pitch, baseline),
                                                              0 outputs → UserVoiceFrame @ 25 Hz → EmotionFrame @ 8 Hz
                                                            local model (if installed): EmotionModelHost, both channels
content script ◄──────────── runtime Port (LIPSYNC_PORT) ───┘
  ContentLifecycle → (on enable) import avatar-runtime.js
  AvatarOverlay (shadow root) · ChatGPTAdapter
  ConversationSignalResolver ← voice UI + LipSyncFrame.active + UserVoiceFrame.speaking → AvatarController.setState
  AvatarController ← FrameMouthSource (assistant only) + UserReactionMapper + EmotionChannels + GestureEngine
```

| Context | Owns | Never |
|---|---|---|
| `background/` service worker | popup/menu commands, `getMediaStreamId`, offscreen lifecycle, per-tab state (`TabSessions`), mic opt-in, `EmotionModelInstaller`, routing | DOM, audio, three.js |
| `offscreen/` | `MediaStream`s (tab + mic), one `AudioContext` per pipeline, analysers, `ProsodyChannel`s, emotion model host, frame generation | three.js, VRM, Avatar, ChatGPT DOM; mixing the two signals |
| `content/` | overlay, renderer, `AvatarController`, `ConversationSignalResolver`, ChatGPT DOM (in `ChatGPTAdapter` only) | audio nodes, PCM, streams |
| `popup/` | avatar toggle for the active tab, emotion model controls | analysis, rendering |
| `permission/` | the one-time microphone grant for the extension origin | analysis (the track is stopped at once) |
| `emotion/` | model manifest, installer, IndexedDB storage, installed-model reader | audio processing, rendering |

The service worker, offscreen, content and worklet boundaries are enforced by `tests/unit/architecture.test.ts`
on the import graph; `popup/` and `emotion/` have no such test.

- **Reuse, not copies.** All avatar/audio code is imported from `avatar/src` (`@avatar/*`). Cross-context contracts
  live in the core too: `LipSyncFrame`, `FrameMouthSource`, `MouthShape`, `UserVoiceFrame`, `EmotionFrame`.
- **Build.** `scripts/build.mjs` runs three Vite builds: ES (service worker, offscreen, permission page, popup, avatar
  runtime), IIFE (the content script), and a single-file ES worklet (`worklets/user-voice.js`). It copies
  `avatar/public/` (VRM, lip-sync assets), the wLipSync worklet/WASM and ONNX Runtime's
  `ort-wasm-simd-threaded.jsep.wasm` into `dist/`. `import.meta.env.DEV` follows `NODE_ENV`, which the script sets
  from `--mode`.
- **Transport.** The content script connects a Port straight to the offscreen document, so frames don't go through
  the service worker. Frames are ~100 bytes; the content side interpolates them at display rate and closes the mouth
  if they stop for 250 ms. Messages are a typed union with `PROTOCOL_VERSION` (`shared/messages.ts`); receivers
  validate with `parseMessage` and ignore anything else.
- **State.** `TabSessions` is the only writer of `disabled | starting | enabled | error`; enable/disable are
  idempotent. The service worker is killed after ~30 s idle; on restart it rebuilds tab state from the captures the
  offscreen document still holds (`capture:list`) and the model state from `chrome.storage.local`.
- **Early state.** The controller exists before the VRM loads, so resolver states set during loading are kept.
- **Weight on chatgpt.com.** The manifest content script is ~4 kB and inert until enabled; the avatar runtime
  (three.js) is imported from `web_accessible_resources` on activation only. Side effect: the page can detect the
  extension through those resources.
- **Recovery after install/update.** The service worker re-injects `content.js` into open chatgpt.com tabs
  (`scripting`), so they work without a reload.
- **Conversation state** is decided in one place, `ConversationSignalResolver`: voice UI closed → `idle`; user
  speaking → `listening` (beats the assistant only after 300 ms, `interruptionMinDuration`); assistant audio →
  `speaking` (held 450 ms); user just stopped, no reply yet → `thinking` (after 200 ms, back to `listening` after
  6 s); otherwise `listening`. Lip sync and the user analyser only produce signals.
- **User voice.** The worklet runs the core `UserVoiceAnalyzer` (see
  [../avatar/README.md](../avatar/README.md#user-voice-contracts)); samples never leave the render thread, only
  frames do. The worklet node has zero outputs: every edge of the mic graph is checked in `UserVoicePipeline.link()`.
  Reactions are muted while the assistant speaks (the mic may be hearing it). The mouth never follows the user.
- **Prosody & emotion.** Both channels use one `ProsodyEmotionAnalyzer` each (`ProsodyChannel`: the assistant's is
  tapped off the tab capture, one per tab; the user's off the mic pipeline). The content script feeds the frames
  into `EmotionChannels` → `BehaviorMixer`, weighted by conversation state (speaking 1/0, listening 0.15/1, so an
  interruption hands priority to the user over the 0.35 s state blend) and by confidence.

## Emotion model

Optional. Without it every channel runs in `heuristic` mode (prosody rules). The model and its pin are defined in
**[`src/emotion/EmotionModelManifest.ts`](src/emotion/EmotionModelManifest.ts)**, the technical source of truth; the
values below are for reference only.

| | |
|---|---|
| model | [`omote-ai/distilhubert-ser`](https://huggingface.co/omote-ai/distilhubert-ser) |
| artifact | `distilhubert_ser_int8.onnx` |
| revision | `6c4a6846578f718581e01883d01af7d174839123` (immutable commit, never `resolve/main`) |
| size | 50,630,102 bytes |
| sha256 | `b3bd62c1d1e74983ce712458e25368dfe32d37b7fc20618f109fd0bfa49cfa97` |
| input | mono 16 kHz Float32 (`audio`), 2 s window, inference every 0.25 s |

Changing the model means changing the manifest (and this table). An installation whose metadata no longer matches
the manifest is treated as not installed.

**Install (remote pinned download, default build).** Popup → *Install & Enable emotions* → confirmation →
`EmotionModelInstaller` in the service worker:

1. downloads the pinned URL over HTTPS, streaming progress to the popup (*Cancel* aborts);
2. checks the exact byte size, then the SHA-256; on any mismatch or error the partial data and metadata are deleted
   and the state is `error`;
3. stores the bytes as a Blob in IndexedDB (database `prosopon-emotion-models`, store `models`, key
   `<id>@<revision>`); metadata (`modelId`, `revision`, `sha256`, `installedAt`, `enabled`) goes to
   `chrome.storage.local` (`emotionModelMetadata`). Model bytes never go into `chrome.storage`;
4. asks the offscreen document to load the model and run a self-test; success → `ready`, failure → `error` with the
   verified bytes kept, so *Retry installation* recovers without another download.

The offscreen document reads the bytes from IndexedDB only after the service worker confirms the model is installed
and enabled (`InstalledModel.ts`). Once installed, inference is local and works offline.

**Disable vs Remove.** *Disable emotions* unloads the model and keeps the verified bytes (*Enable emotions* brings it
back without a download). *Remove emotion model* unloads it and deletes bytes and metadata.

**Runtime fallback.** `OnnxEmotionModel` tries WebGPU (when `navigator.gpu` yields an adapter), then WASM
(single-threaded: extension pages are not cross-origin isolated). A load that fails or exceeds 30 s, or 3 failed
inferences in a row, switch every channel to `fallback` (prosody rules); the avatar keeps working. Frame `mode`:
`heuristic`, `ml-webgpu`, `ml-wasm` or `fallback`. The CSP allows `'wasm-unsafe-eval'` on extension pages for this
(without it: "Refused to compile or instantiate WebAssembly module"). PCM chunks at 16 kHz are posted from the
worklets to the offscreen document only while a model is loaded; they never leave it.

### Embedded build

For distribution where a remote model download is undesirable (e.g. Chrome Web Store review):

```bash
# place the verified artifact (same size and SHA-256 as the manifest) first:
#   extension/model-assets/distilhubert_ser_int8.onnx      (git-ignored)
npm run build:extension:embedded                           # PROSOPON_EMBED_MODEL=1 npm run build
```

The build copies it to `dist/emotion-model/` and fails if the file is missing. The popup flow is the same, but the
installer reads the packaged file instead of Hugging Face and still verifies size and SHA-256 before copying it into
IndexedDB. The `PROSOPON_EMBED_MODEL=1 …` script syntax needs a POSIX shell (use Docker or WSL on Windows).

## Permissions

| Permission | Used for |
|---|---|
| `tabCapture` | stream id of the ChatGPT tab's audio |
| `offscreen` | the audio document (`USER_MEDIA` reason: covers tab and mic) |
| `scripting` | re-injecting `content.js` into open chatgpt.com tabs after install/update |
| `contextMenus` | the *Microphone reactions* checkbox on the toolbar icon |
| `storage` | mic opt-in (`storage.session`), emotion model metadata (`storage.local`) |
| host `https://chatgpt.com/*` | content script, tab URLs, web-accessible avatar runtime |
| host `https://huggingface.co/*` | the pinned model download |

`tests/unit/manifest.test.ts` pins this list; don't add to it without a concrete use.

## Debugging (development builds)

- The diagnostics overlay over the avatar shows state, lip sync, user voice, conversation signals, emotion and
  gestures.
- `window.__PROSOPON_DEBUG__` lives in the content script's isolated world: pick the Prosopon context in the
  DevTools console's context selector.
- Page-console events: `prosopon:debug` (e.g. `{ emotionConfig: { baselineWeight: 0.3 } }`) and `prosopon:gesture`
  (`trigger`, `cancel`, `auto`, `seed`, `config`); the overlay host exposes `data-*` attributes used by E2E.
- Calibration procedures: [../docs/emotion-calibration.md](../docs/emotion-calibration.md) (prosody/emotion),
  [../docs/gesture-calibration.md](../docs/gesture-calibration.md) (gestures).

## Known limitations

- **ChatGPT selectors** in `CHATGPT_SELECTORS` (`ChatGPTAdapter.ts`) were checked against production on 2026-09-26
  and will drift. If nothing matches, the avatar sits bottom-right and the orb stays visible. Update them from
  DevTools; the E2E fixture (`tests/e2e/fixtures/chatgpt.html`) mirrors them.
- **Echo cancellation.** While captured, the tab's audio is played by the offscreen document. Whether ChatGPT's own
  echo cancellation still gets its reference signal is untested: on speakers, check that ChatGPT doesn't hear and
  interrupt itself.
- **Crosstalk.** Prosopon's mic requests `echoCancellation: true`, but on speakers the assistant may still reach it.
  No custom AEC by design; mitigations are the 300 ms interruption minimum and muted reactions while the assistant
  speaks. The overlay counts crosstalk and ignored short interruptions; if they climb, use headphones.
  `autoGainControl: false` is a preference Chrome/devices may ignore.
- **Device changes.** A mic that disappears ends the pipeline (`unavailable`); toggle *Microphone reactions* off and
  on after reconnecting.
- **Latency.** Mouth lags audio by roughly analysis window + HeadAudio (~50 ms) + frame interval.
  `AUDIO_RUNTIME_CONFIG.monitorDelay` (offscreen) can delay what you hear to match, at the cost of the same delay in
  ChatGPT's answers. Off by default.
- **Viseme quality.** HeadAudio's model is English; on Russian speech shapes are closer to amplitude.
- **Emotion from prosody.** Arousal/energy/tension are usable; valence from audio alone is near chance (confidence
  capped at 0.25 without a model). Thresholds are tuned on synthetic signals only. The user channel's weight is 0
  while the assistant is speaking.
- **Emotion model output mapping.** `InstalledModel.ts` reads arousal/valence as indices 0/1 of the model's first
  output tensor with range [−1, 1]; the manifest's `outputNames` (`arousal`, `valence`) are not passed to the
  runtime. This mapping has not been checked against the real model's outputs.
- **Popup details.** *Cancel* during a download ends in the `error` state (with the abort message), not
  `not-installed`. The popup shows the size as ~51 MB in one place and 48.3 MB (MiB) in another. A manifest change
  leaves the previous model's Blob in IndexedDB.
- **VRM expression overrides.** Presets with `overrideMouth: blend` are pre-compensated; a model whose emotion
  presets `block` the mouth gets no procedural emotion on them (warned once).

## Tests

```bash
npm test          # unit: protocol, manifest, TabSessions/ContentLifecycle idempotency, ChatGPTAdapter (DOM fixtures),
                  # ConversationSignalResolver, UserVoicePipeline (fake Web Audio graph), architecture rules
npm run test:e2e  # builds dist/ in development mode, then Playwright with the unpacked extension
```

E2E runs Chromium headless with the extension on a routed `https://chatgpt.com/` fixture (strict CSP). Set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a preinstalled Chromium. Two flags make it work without a human:
`--allowlisted-extension-id=<id>` lets the service worker's dev hook start `tabCapture` without a toolbar click, and
Playwright's default `--mute-audio` is removed so the captured audio isn't silence.

- `extension.spec.ts`: load, enable/disable, orb hide/restore, no duplicate runtimes on SPA navigation, real tab
  audio → offscreen → Port → mouth, viseme analyser fallback, reload.
- `user-voice.spec.ts`: Chromium's fake microphone (`--use-fake-device-for-media-stream` +
  `--use-file-for-fake-audio-capture=<wav>%noloop`, WAV from `tests/e2e/fakeMic.ts`). `--use-fake-ui-for-media-stream`
  is deliberately absent: with it, tabCapture's stream id fails with "Requested device not found". The test grants
  the mic context-wide; the denial test checks the permission page opens and everything else keeps working.
- `emotion.spec.ts`: assistant and user channels through to the mixer, interruption priority swap, debug switches;
  local-model tests on WASM, WebGPU (SwiftShader: `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader`) and a
  model that fails to load, using the `avatar/tests/fixtures/loudness-probe.onnx` plumbing fixture.

**Currently failing:** the three local-model tests in `emotion.spec.ts` package `emotion-model/model.json` into
`dist/`, a path the runtime no longer reads (the model now comes only from IndexedDB via the installer). They fail
waiting for `data-emotion-model` to become `ready`/`failed`. The installer itself (download, integrity, storage,
Disable/Remove) has no automated tests.

Not covered by E2E: the real toolbar/popup user-gesture path and the live chatgpt.com DOM.
