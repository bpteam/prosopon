# Prosopon Chrome extension (US-004, US-005)

Replaces the ChatGPT voice orb with the VRM avatar and drives its mouth from the audio the ChatGPT tab plays.
Optionally (US-005) it also listens to the user's microphone to tell when they speak and how their voice sounds,
so the avatar switches listening / thinking / speaking and reacts a little. Manifest V3, Chrome 116+. Everything
stays local: neither the captured tab audio nor the microphone leaves the browser, and neither is recorded.

## Use

```bash
cd avatar && npm ci      # Avatar Core and its dependencies (three, three-vrm, wlipsync) live here
cd ../extension && npm ci
npm run build            # → extension/dist
```

`chrome://extensions` → Developer mode → Load unpacked → `extension/dist`. On chatgpt.com, start voice mode and
click the Prosopon toolbar button. Click again to disable. The badge shows `ON`, `…` (starting) or `!` (error, the
tooltip says why; click to retry).

**Microphone reactions** are off by default. Right-click the toolbar button → *Microphone reactions*. The first time,
a Prosopon tab asks Chrome for the microphone (the offscreen document that analyses it can't show a prompt); it
closes itself once allowed. The choice lasts for the browser session (`chrome.storage.session`), so a restarted
browser starts with the mic off. The mic is open only while the choice is on **and** a tab is enabled. Without the
permission, or without a mic, the avatar and lip sync work as before.

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
                                                            assistant: AudioInput.attachMediaStream (monitor → speakers)
                                                              AmplitudeLipSync + VisemeLipSync + HeadAudio/wLipSync
                                                              → LipSyncFrame @ 30 Hz, per tab
microphone (opt-in) ──getUserMedia──────────────────────►   user: UserVoicePipeline (own AudioContext)
                                                              AudioWorklet: UserVoiceAnalyzer (VAD, MPM pitch,
                                                              baseline), 0 outputs → UserVoiceFrame @ 25 Hz
content script ◄──────────── runtime Port (LIPSYNC_PORT) ───┘
  ContentLifecycle → (on enable) import avatar-runtime.js
  AvatarOverlay (shadow root) · ChatGPTAdapter
  ConversationSignalResolver ← voice UI + LipSyncFrame.active + UserVoiceFrame.speaking → AvatarController.setState
  AvatarController ← FrameMouthSource (assistant only) + UserReactionMapper (ReactionSource) → BehaviorMixer
```

| Context | Owns | Never |
|---|---|---|
| `background/` service worker | action click, `getMediaStreamId`, offscreen lifecycle, per-tab state (`TabSessions`), routing | DOM, audio, three.js |
| `offscreen/` | `MediaStream`s (tab + mic), one `AudioContext` per pipeline, analysers, `LipSyncFrame`/`UserVoiceFrame` generation | three.js, VRM, Avatar, ChatGPT DOM; mixing the two signals |
| `permission/` | the one-time microphone grant for the extension origin | analysis (the track is stopped at once) |
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
- **Early state.** The controller exists before the VRM loads, so resolver states set during loading are kept.
- **Weight on chatgpt.com.** The manifest content script is ~4 kB and does nothing until enabled; the avatar
  runtime (~770 kB, three.js) is imported from `web_accessible_resources` on activation only. Side effect: the page
  can detect the extension through those resources.
- **Conversation state** is decided in one place, `ConversationSignalResolver` (content): voice UI closed → `idle`;
  user speaking → `listening` (beats the assistant: interruption); assistant audio → `speaking` (held 450 ms); user
  just stopped, no reply yet → `thinking` (after a 200 ms grace, back to `listening` after 6 s without a reply);
  otherwise `listening`. Lip sync and the user analyser only produce signals; neither calls `setState`.
- **User voice (US-005)** — core in `avatar/src/audio/user/`: `VoiceActivityDetector` (tracked noise floor,
  activation/deactivation margins 12/6 dB, attack 100 ms, hangover 300 ms), `PitchDetector` (McLeod on a 16 kHz
  decimation, 60–800 Hz, confidence ≥ 0.8 or `pitchHz = null`), `PitchBaseline` (median of the first 1.5 s of voiced
  speech, then a 40 s log-domain average: relative pitch in semitones), `UserVoiceAnalyzer` (fixed 10 ms hops, so
  chunk size doesn't matter). It runs inside an AudioWorklet (`UserVoiceWorklet`, its own single-file build); samples
  never leave the render thread, only `UserVoiceFrame` numbers do. The worklet node has zero outputs: the mic has no
  path to the speakers, and every edge of that graph is checked in `UserVoicePipeline.link()`.
- **Reactions** — `UserReactionMapper` turns frames into a bounded `UserReactionFrame` (engagement, pitch lift, nod)
  for `BehaviorMixer`, which clamps it to `REACTION_LIMITS` (±12 % head motion, 0.7° lean, 0.7° chin lift, a 3° nod).
  A nod follows an utterance of ≥ 500 ms, at most every 2 s. Reactions are muted while the assistant speaks (the mic
  may be hearing it). The mouth never follows the user.

## Known limitations

- **ChatGPT selectors** in `CHATGPT_SELECTORS` (`ChatGPTAdapter.ts`) were checked against production chatgpt.com on
  2026-09-26 and will drift. If nothing matches, the avatar sits bottom-right and the orb stays visible. Update them
  from DevTools; the E2E fixture (`tests/e2e/fixtures/chatgpt.html`) mirrors them.
- **Echo cancellation.** While captured, the tab's audio is played by the offscreen document. Whether ChatGPT's
  microphone echo cancellation still gets its reference signal is untested: on speakers (not headphones), check
  that ChatGPT doesn't hear and interrupt itself.
- **Crosstalk (US-005).** The same applies to Prosopon's own mic: `echoCancellation: true` is requested, but on
  speakers the assistant may still reach the mic. There is no custom AEC by design. Mitigation: a user segment only
  counts as an interruption after 300 ms (`interruptionMinDuration`), and reactions are muted while the assistant
  speaks. The debug panel counts crosstalk (`user` and `assistant` both active) and ignored short interruptions; if
  they climb on speakers, use headphones. `autoGainControl: false` is a preference Chrome/devices may ignore.
- **Device changes.** A mic that disappears ends the pipeline (`unavailable`); it doesn't reopen on its own when a
  device comes back: toggle *Microphone reactions* off and on.
- **Debug API.** `window.__PROSOPON_DEBUG__` (development builds) lives in the content script's isolated world:
  pick the Prosopon context in the DevTools console's context selector to read it.
- **Latency.** Mouth lags audio by roughly analysis window + HeadAudio (~50 ms) + frame interval.
  `AUDIO_RUNTIME_CONFIG.monitorDelay` (offscreen) can delay what you hear to match, at the cost of the same delay
  in ChatGPT's answers. Off by default.
- **Viseme quality.** HeadAudio's model is English; on Russian speech shapes are closer to amplitude (see US-003).

## Tests

```bash
npm test          # unit: protocol, TabSessions/ContentLifecycle idempotency, ChatGPTAdapter (DOM fixtures),
                  # ConversationSignalResolver, UserVoicePipeline (fake Web Audio graph), architecture rules
npm run test:e2e  # builds dist/ in development mode, then Playwright with the unpacked extension
```

E2E runs Chromium headless with the extension on a routed `https://chatgpt.com/` fixture (strict CSP). Two flags
make it work without a human: `--allowlisted-extension-id=<id>` lets the SW's dev hook start `tabCapture`
without a toolbar click, and Playwright's default `--mute-audio` is removed so the captured audio isn't silence.
The audio test plays a speech-like signal in the page and checks it arrives as mouth weights through the real
capture → offscreen → Port → content path. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a preinstalled Chromium.
What E2E can't cover: the real click (user gesture) path and the live chatgpt.com DOM.

`user-voice.spec.ts` runs with Chromium's fake microphone (`--use-fake-device-for-media-stream` +
`--use-file-for-fake-audio-capture=<wav>%noloop`), the WAV generated by `tests/e2e/fakeMic.ts` with a fixed
timeline (speech, silence, speech). `--use-fake-ui-for-media-stream` is deliberately absent: with it, tabCapture's
stream id fails with "Requested device not found". The offscreen document can't prompt, so the test grants the
microphone context-wide (Chromium refuses a grant for a `chrome-extension://` origin by name); the denial test skips
that and checks the permission page opens and everything else keeps working. The VAD/pitch/baseline algorithms are
unit-tested in `avatar/tests/unit/UserVoice.test.ts` (synthetic signals, 10/20/40 ms and 128-sample chunks).
