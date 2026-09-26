# Real voice calibration wizard

Developer Tools → **Calibration** runs a scripted session against the real ChatGPT Voice and exports a ZIP that a
coding agent can use to tune the avatar (`AGENT_TASK.md` inside the bundle is that task). You prepare the chat and
open Voice yourself, then press **Start**, speak when asked, and press **Export**. Nothing is tuned, committed or
uploaded by the wizard itself.

Code: `extension/src/calibration/` (runner, scenarios, trace, analysis, reports, ZIP/WAV), the recorder
`extension/src/offscreen/CalibrationRecorder*.ts`, the panel `extension/src/ui/dev/calibrationPanel.ts`, the export
page `extension/src/calibration-export/`, ChatGPT automation in `ChatGPTAdapter` (`ConversationAutomation`).
Architecture and privacy rules: [../PRODUCT.md](../PRODUCT.md) (invariants 5, 14, 19; §5.13).

## Before you start

- Chrome with Prosopon, the avatar on in a ChatGPT tab, Developer mode on.
- Start a ChatGPT Voice conversation yourself and leave it open. The wizard does not touch Voice controls,
  microphone controls or your chat setup.
- Choose the languages in the Calibration panel before **Start**. Russian is selected by default; only selected
  languages create assistant, user and interruption steps. A four-language run takes about 12–14 minutes.
  ChatGPT Voice usage limits apply.

## What a run does

1. Preflight: tab capture running, config snapshot, offscreen recorder session.
2. Environment: voice name and mode from the page (`detectVoiceEnvironment`); an unknown voice name is recorded as
   unknown and does not pause the run.
3. The wizard leaves the current chat, route and page untouched: it never creates a chat, clears its messages,
   refreshes the page or sends a setup prompt. Prepare the conversation context yourself.
4. Per selected language, the wizard inserts one requested phrase into the composer and presses **Enter**. It waits
   for assistant tab audio to start and finish, then saves that step's audio clip, trace, rendered reply text and
   behaviour events before sending the next phrase. It does not click other page controls.
5. Analysis (local rules, no LLM): a verdict per sample, a summary per language, measured chars/s.
6. Export: the ZIP is built in the offscreen document; an extension page downloads it. **Discard** (in the
   wizard or on the export page), turning Developer mode off or turning the avatar off for the tab deletes the
   recordings and the bundle; until then they stay in memory only.

*Mark this as visually wrong* (+ *Too weak* / *Too much* / *Wrong timing*) flags the current sample; the run never
waits for it.

## The bundle

`prosopon-calibration-<voice>-<date>.zip`, everything under `calibration/`:

| File | Content |
|---|---|
| `manifest.json` | git commit + dirty flag, versions, voice/mode (`voiceRuntimeModel: null`), languages, avatar model hash, runtime modes, browser, sample rates |
| `config-before.json` | defaults and live values: `GESTURE_CONFIG`, `SEMANTIC_GESTURE_CONFIG`, `DEFAULT_EMOTION_MIX`, `DEFAULT_PROSODY_EMOTION_CONFIG`, `REACTION_LIMITS`, `SEMANTIC_PACER_CONFIG`, state timings, audio runtime |
| `scenarios.json` | the steps with machine-readable expectations |
| `results.json`, `summary.json` | verdicts per sample; per-language summary, pacing, bottleneck, manual flags |
| `trace.jsonl` | 15 Hz rows: audio activity, VAD, energy, pitch, emotion, reaction, state, gesture, per-source pose attribution |
| `events.jsonl` | state transitions, utterances, cues, intents, decisions, gesture start/peak/release, interrupts, recovery |
| `assistant-text.jsonl` | requested vs actually rendered text per sample and where the text came from |
| `steps.jsonl`, `semantic.jsonl`, `gestures.jsonl`, `features.jsonl` | per-step records, semantic intents, gesture lifecycles, analyser feature frames |
| `audio/index.json`, `audio/assistant/<lang>/*.wav`, `audio/user/<lang>/*.wav` | 16-bit mono clips (≤ 120 s each) |
| `REPORT.md` | human summary |
| `AGENT_TASK.md` | ready task for the next coding agent |

Verdicts (`VERDICTS` in `analysis.ts`) include `GESTURE_POLICY_SUPPRESSION`, `MIX_OR_AMPLITUDE_TOO_LOW`,
`GESTURE_CLAMPED`, `SEMANTIC_MISS`, `PACING_DROP`, `NO_REPLY_TEXT`, … ; reply text is diagnostic data and does not
block an otherwise recorded audio sample.
`REPORT.md` explains the ones found, `AGENT_TASK.md` lists all of them.

Development builds accept a smaller run for the next Start:

```js
document.dispatchEvent(new CustomEvent('prosopon:calibration', {
  detail: { languages: ['en'], categories: ['question.normal', 'disagreement'], user: false },
}));
```

## Manual checks on real chatgpt.com

The E2E test (`extension/tests/e2e/calibration.spec.ts`) runs the whole flow on the fixture page only. Everything
below is **unverified against production** and must be checked in a real browser session, in this order:

1. **Enter during Voice** (the main risk). With a voice session open, does a phrase inserted into the composer and
   sent with **Enter**
   get a *spoken* answer? If ChatGPT only answers in text, every assistant sample is invalid and the run says so
   after three silent samples. There is no read-aloud fallback.
2. **Reply text in voice mode.** Is the spoken reply rendered in the thread while it is spoken? It is saved when
   present; the audio sample remains valid without it.
3. **Composer selector** (`CHATGPT_SELECTORS`):
   - composer `#prompt-textarea` or `contenteditable[role=textbox]` — typing through `execCommand('insertText')`;
4. **Voice limits:** a session ending or a silence longer than the configured response timeout invalidates that
   sample; prepare Voice again before starting another run.

Report selector fixes in `ChatGPTAdapter` and the fixture (`tests/e2e/fixtures/chatgpt.html`) together.

## Limits

- One voice per run; the architecture (a voice × language key, `ScenarioOptions`) allows a batch "all voices" run
  later, not implemented.
- The run resumes only within the page's lifetime (in memory); a reload loses it.
- No per-voice configs and no runtime config changes: the bundle is input for a later tuning change.
