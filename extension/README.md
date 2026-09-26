# Prosopon Chrome extension (US-004)

Replaces the ChatGPT voice orb with the VRM avatar and drives its mouth from the audio the ChatGPT tab plays.
Manifest V3, Chrome 116+. Everything stays local: captured audio never leaves the browser.

## Use

```bash
cd avatar && npm ci      # Avatar Core and its dependencies (three, three-vrm, wlipsync) live here
cd ../extension && npm ci
npm run build            # → extension/dist
```

`chrome://extensions` → Developer mode → Load unpacked → `extension/dist`. On chatgpt.com, start voice mode and
click the Prosopon toolbar button. Click again to disable. The badge shows `ON`, `…` (starting) or `!` (error, the
tooltip says why; click to retry).

### Docker

Without a local Node: `compose.yaml` in the repo root has an `extension` service (profile `extension`) and an
`extension-e2e` service (profile `test`). Both bind-mount `avatar/` and `extension/`, so `extension/dist` appears
on the host and is loaded unpacked from there. `node_modules` of both packages live in named volumes and are
reinstalled by the entrypoint when a `package-lock.json` changes.

```bash
docker compose run --rm extension                      # production build → extension/dist
docker compose run --rm extension npm run dev          # development build, rebuilt on change
WATCH_POLLING=true docker compose run --rm extension npm run dev   # when edits aren't picked up (Docker Desktop on Windows)
docker compose run --rm extension npm test             # unit tests
docker compose --profile test run --rm extension-e2e   # E2E in mcr.microsoft.com/playwright (Chromium + tab capture)
```

- Build context is the repo root (the extension compiles `avatar/src`); `extension/Dockerfile.dockerignore` limits
  it to the lockfiles.
- `extension-e2e` rebuilds `extension/dist` in development mode: run the production build again before loading it
  in Chrome for real use.
- Containers run as uid 1000 (like the avatar services); with another host uid, `extension/dist` gets the wrong owner.
- The Playwright image tag in `extension/Dockerfile` must match `@playwright/test` in `extension/package-lock.json`.

Development: `npm run dev` rebuilds on change (`--mode development`: diagnostics panel over the avatar, E2E hook in
the service worker). Content scripts have no HMR: after a rebuild, reload the extension and the ChatGPT tab. The
old content script notices its dead runtime and removes itself, so no duplicate overlays.

## Architecture

```
chatgpt.com tab ──audio──► chrome.tabCapture ──stream id──► offscreen document
                                                            AudioInput.attachMediaStream (monitor → speakers)
                                                            AmplitudeLipSync + VisemeLipSync + HeadAudio/wLipSync
                                                            → LipSyncFrame @ 30 Hz
content script ◄──────────── runtime Port (LIPSYNC_PORT) ───┘
  ContentLifecycle → (on enable) import avatar-runtime.js
  AvatarOverlay (shadow root) · AvatarController + FrameMouthSource · ChatGPTAdapter · VoiceStatePresenter
```

| Context | Owns | Never |
|---|---|---|
| `background/` service worker | action click, `getMediaStreamId`, offscreen lifecycle, per-tab state (`TabSessions`), routing | DOM, audio, three.js |
| `offscreen/` | `MediaStream`, `AudioContext`, analysers, `LipSyncFrame` generation | three.js, VRM, Avatar, ChatGPT DOM |
| `content/` | overlay, renderer, `AvatarController`, ChatGPT DOM (in `ChatGPTAdapter` only) | audio nodes, PCM, streams |

Enforced by `tests/unit/architecture.test.ts` on the import graph.

- **Reuse, not copies.** All avatar/audio code is imported from `avatar/src` (`@avatar/*` alias). New core pieces
  added for this story live there too: `LipSyncFrame` (the cross-context contract), `FrameMouthSource` (a
  `MouthSource` fed by frames), `AudioInput.attachMediaStream`, `AvatarController.attachAvatar`, `MouthShape.ts`
  (three-free mouth contract, so the offscreen bundle has no three.js).
- **Transport.** The content script connects a Port straight to the offscreen document, so 30 frames/s don't go
  through the service worker. Frames are ~100 bytes; the content side interpolates them at display rate and closes
  the mouth if they stop for 250 ms.
- **State.** `TabSessions` is the only writer of `disabled | starting | enabled | error`; enable/disable are
  idempotent. The SW is killed after ~30 s idle; on restart it rebuilds state from the captures the offscreen
  document still holds (`capture:list`), so no `storage` permission. The capture survives page reloads; leaving
  chatgpt.com, closing the tab or the stream ending disables the tab.
- **Messages** are a typed union with `PROTOCOL_VERSION` (`shared/messages.ts`); receivers validate with
  `parseMessage` and ignore anything else.
- **Early state.** The controller exists before the VRM loads, so presenter states set during loading are kept.
- **Weight on chatgpt.com.** The manifest content script is ~4 kB and does nothing until enabled; the avatar
  runtime (~770 kB, three.js) is imported from `web_accessible_resources` on activation only. Side effect: the page
  can detect the extension through those resources.
- **Speaking state** is a presentation hint in `VoiceStatePresenter` (ChatGPT integration layer): voice UI open →
  `listening`, captured audio active → `speaking` (held 450 ms), voice UI closed → `idle`. Lip sync never sets states.

## Known limitations

- **ChatGPT selectors are unverified.** `CHATGPT_SELECTORS` in `ChatGPTAdapter.ts` are guesses; the live voice
  mode DOM wasn't reachable from CI. If nothing matches, the avatar sits bottom-right and the orb stays visible.
  Update them from DevTools; the E2E fixture (`tests/e2e/fixtures/chatgpt.html`) mirrors them.
- **Echo cancellation.** While captured, the tab's audio is played by the offscreen document. Whether ChatGPT's
  microphone echo cancellation still gets its reference signal is untested: on speakers (not headphones), check
  that ChatGPT doesn't hear and interrupt itself.
- **Latency.** Mouth lags audio by roughly analysis window + HeadAudio (~50 ms) + frame interval.
  `AUDIO_RUNTIME_CONFIG.monitorDelay` (offscreen) can delay what you hear to match, at the cost of the same delay
  in ChatGPT's answers. Off by default.
- **Viseme quality.** HeadAudio's model is English; on Russian speech shapes are closer to amplitude (see US-003).

## Tests

```bash
npm test          # unit: protocol, TabSessions/ContentLifecycle idempotency, ChatGPTAdapter (DOM fixtures),
                  # presenter, architecture rules
npm run test:e2e  # builds dist/ in development mode, then Playwright with the unpacked extension
```

E2E runs Chromium headless with the extension on a routed `https://chatgpt.com/` fixture (strict CSP). Two flags
make it work without a human: `--allowlisted-extension-id=<id>` lets the SW's dev hook start `tabCapture`
without a toolbar click, and Playwright's default `--mute-audio` is removed so the captured audio isn't silence.
The audio test plays a speech-like signal in the page and checks it arrives as mouth weights through the real
capture → offscreen → Port → content path. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a preinstalled Chromium.
What E2E can't cover: the real click (user gesture) path and the live chatgpt.com DOM.
