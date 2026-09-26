# Prosopon

Chrome extension + reusable VRM avatar core that replaces the ChatGPT Voice orb and reacts to assistant/user speech.

On `chatgpt.com`, Prosopon puts an animated VRM character where the voice-mode orb was. The character lip-syncs to
the assistant's audio, switches between idle / listening / thinking / speaking, reacts to how both voices sound and
gestures on its own. Everything runs locally in the browser; no speech-to-text, no backend.

## Features

- VRM 1.0 rendering (Three.js + three-vrm) with procedural idle: breathing, blinking, gaze, micro-motion
- ChatGPT overlay: the avatar replaces the voice orb, the orb is restored when Prosopon is off
- Assistant lip sync from the tab's audio: visemes (HeadAudio or wLipSync) with an amplitude fallback
- User voice sensing (opt-in microphone): voice activity, pitch, interruption handling
- Conversation state resolved from both voices: idle, listening, thinking, speaking
- Dual-channel prosody/emotion: the assistant's voice shapes its expression, the user's voice its attention
- Optional local ONNX emotion model, installed from the popup in one click, WebGPU → WASM → heuristic fallback
- Procedural gestures: nods, head tilts, body/shoulder shifts, hand emphasis
- Local processing: audio never leaves the browser

## Quick start

Requirements: Node 22 and Chrome 116+ (or Docker, see below).

**Avatar sandbox** (the core, without the extension):

```bash
cd avatar
npm ci
npm run dev            # http://localhost:5173/
```

**Extension** (`avatar/` must be installed first: the extension compiles `avatar/src`):

```bash
cd avatar && npm ci
cd ../extension && npm ci
npm run build          # production build → extension/dist
```

Load it: `chrome://extensions` → Developer mode → *Load unpacked* → `extension/dist`. On chatgpt.com, open the
Prosopon popup from the toolbar and click *Enable avatar*; start voice mode. Right-click the toolbar icon for
*Microphone reactions*; the popup also installs the optional emotion model. Details:
[extension/README.md](extension/README.md#use).

**Tests** (in `avatar/` or `extension/`):

```bash
npm run typecheck
npm test               # unit + architecture tests (Vitest)
npm run test:e2e       # Playwright; needs Chromium (npx playwright install chromium,
                       # or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome)
```

**Docker** (no local Node/Chromium; run from the repo root):

```bash
docker compose up --build                                # sandbox dev server on http://localhost:5173/
docker compose run --rm avatar npm test                  # avatar unit tests
docker compose --profile test run --rm e2e               # avatar E2E
docker compose run --rm extension                        # extension production build → extension/dist
docker compose run --rm extension npm test               # extension unit tests
docker compose --profile test run --rm extension-e2e     # extension E2E (real tab capture)
```

More options (dev/watch builds, embedded-model build, polling for Docker Desktop on Windows) are in the subsystem
READMEs.

## Documentation

- [PRODUCT.md](PRODUCT.md) — product state, architecture, invariants and known limitations.
- [AGENTS.md](AGENTS.md) — rules for AI agents and contributors.
- [avatar/README.md](avatar/README.md) — avatar/audio/behavior core.
- [extension/README.md](extension/README.md) — Chrome extension runtime.
- [docs/](docs/) — calibration and subsystem notes.

New here (human or agent): read `README.md → PRODUCT.md → AGENTS.md`, then the README of the package you touch.

## Repository layout

```text
avatar/       reusable renderer / audio / behaviour core + standalone sandbox
extension/    Chrome MV3 extension for chatgpt.com (imports the core from avatar/src)
docs/         manual calibration procedures
scripts/      repository tooling (Markdown link check)
compose.yaml  Docker services for both packages
```

## Licences

Code in this repository has no licence file yet. Bundled third-party assets keep their own licences: the sample
VRM model ([avatar/public/models/LICENSE.md](avatar/public/models/LICENSE.md)), HeadAudio and wLipSync (MIT, see
`avatar/public/lipsync/` and `avatar/src/vendor/headaudio/`).
