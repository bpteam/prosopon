# Prosody / emotion calibration (manual, real mic + real ChatGPT voice)

Context: [PRODUCT.md §5.8](../PRODUCT.md#58-prosody-and-emotion-both-channels), code and tunables:
[avatar/README.md](../avatar/README.md#emotion-contracts). Rules: [AGENTS.md](../AGENTS.md).

The prosody/emotion analyser and the mapping were tuned on synthetic signals. These checks need your microphone, your room and ChatGPT's
real voice. Budget: ~30 minutes. Record findings as the JSON from *copy changed settings*.

The default heuristic is also regression-tested against a real Russian Voice capture supplied as **Sol**: compared
with its energetic answer, its calm answer was quieter and darker but *more* melodically variable. Therefore
`DEFAULT_PROSODY_EMOTION_CONFIG` gives the channel's relative loudness and brightness more influence than pitch
variation once its baseline is warm. The export's browser metadata called that voice `unknown`, so this is an acoustic
calibration, not a reliable browser-level Sol identity or a per-voice runtime profile.

## 0. Setup

- Extension: `cd extension && npm run build:dev`, load `dist/`, open chatgpt.com, enable Prosopon, turn on
  *Microphone reactions*. The debug overlay shows **— Emotion / Prosody** with `user` and `assistant` blocks and a
  `mix` line; the two checkboxes top-right switch each channel's influence off.
- Sandbox (faster loop for the assistant channel): `cd avatar && npm run dev`. Record 5–6 ChatGPT Voice answers
  (any screen/tab recorder, WAV/MP3), then Lip Sync → *play audio file…*, Emotion / Prosody → *audio source is:
  assistant*. Sliders apply live.
- Analyser settings can also be pushed into the running extension (dev build), in the chatgpt.com page console:
  `document.dispatchEvent(new CustomEvent('prosopon:debug', { detail: { emotionConfig: { baselineWeight: 0.3 } } }))`
- VAD / extractor settings (`VadConfig`, `energyRangeDb`, pitch `minConfidence`) are not live-tunable: they live in
  the worklet. Change `DEFAULT_VAD_CONFIG` / `DEFAULT_USER_VOICE_CONFIG` and rebuild (`npm run dev` rebuilds on save).

## 1. User voice (headphones first, then speakers)

| # | Do | Expect (overlay `user` block) | If not, tune |
|---|----|------|------|
| 1 | Long silence, 20 s | `silent`, conf 0.00, mix user 0.00 | VAD `activationMargin` if it flickers `active` |
| 2 | Fan / background noise on, silent | stays `silent`; no reaction | VAD margins; `activeOnRatio` |
| 3 | Quiet voice, 10 s | `active`, aro low (≲0.35), en low, conf rising to ~0.4–0.6 | `arousalWeights.energy`, extractor `energyRangeDb` |
| 4 | Normal voice | aro mid (~0.4–0.6) | `baselineWeight`, `baselineWarmup` |
| 5 | Loud / excited voice | aro high (≳0.65), lift > 0, var up; avatar head steadier, slight lean | `pitchVariationRange`, `centroidLowHz/HighHz` |
| 6 | Laugh-like speech | aro high; valence sign is **not** reliable without a model, conf(val) ≤ 0.25 | nothing: expected limitation |
| 7 | Stop talking | values decay over ~1–2 s, no jumps, then 0 | `silenceRelease`, `arousalRelease` |
| 8 | Speakers: let ChatGPT talk, stay silent | `mix user 0.00` while `assistant speaking`; crosstalk counter low | headphones if it climbs |

Also check: the reaction is not mirroring (a loud user must not make the avatar livelier, only more attentive).

## 2. Assistant voice (ChatGPT Voice, or recorded answers in the sandbox)

Ask for answers that differ: calm, energetic, slow, fast, expressive, neutral (e.g. "read this slowly and calmly",
"say it like you're thrilled").

| # | Expect (overlay `assistant` block / avatar) | If not, tune |
|---|------|------|
| 1 | calm/slow: aro ≲ 0.4, slower/smaller head motion, `relaxed` > 0 | `arousalWeights`, `speechRateMax` |
| 2 | energetic/fast: aro ≳ 0.6, livelier head and breathing, `surprised` small | same; mapping `assistantHeadMotion` |
| 3 | expressive: var high; neutral: var low | `pitchVariationRange` |
| 4 | Across a whole conversation the values still differ between answers (baseline didn't flatten them) | lower `baselineWeight` or raise `baselineAdaptation` |
| 5 | Mouth articulation looks the same with emotion on and off (toggle *Assistant emotion expression*) | if the mouth weakens: the model's `overrideMouth` (see extension README) |
| 6 | After the answer: face/body return to neutral within ~2 s, no snap | `silenceRelease`, `staleRelease` |
| 7 | Interrupt ChatGPT mid-answer: state → listening, `mix assistant` drops to ≲0.15×, `mix user` rises | `STATE_PROFILES.listening` weights |

Nothing should look dramatic. If a change is visible only with the switch off/on side by side, it is about right.

## 3. Optional: the local model

Extension: popup → *Install & Enable emotions* (see
[extension/README.md](../extension/README.md#emotion-model)). The overlay shows `model ready · N runs` and mode
`ml-webgpu` or `ml-wasm`. Compare valence on laughs / warm vs irritated speech with the model enabled and disabled
(*Disable emotions* keeps it installed). If it doesn't beat chance on Russian speech and ChatGPT's voice, lower
`trust` in `extension/src/emotion/InstalledModel.ts` or leave the model disabled.

Sandbox: put an `.onnx` + `model.json` in `avatar/public/emotion-model/` (git-ignored; format on `parseModelSpec` in
`avatar/src/audio/emotion/EmotionModel.ts`) and use *load ./emotion-model/model.json* in the Emotion / Prosody
folder. Check a model's licence before any distribution.

## 4. Record

Paste the *copy changed settings* JSON (sandbox) and the `emotionConfig` values you pushed (extension) into the
thread; they become the new defaults in `DEFAULT_PROSODY_EMOTION_CONFIG` / `DEFAULT_EMOTION_MIX`.
