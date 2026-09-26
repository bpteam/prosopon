# Real voice calibration wizard

Developer Tools → **Calibration** runs a scripted session against the real ChatGPT Voice and exports a ZIP that a
coding agent can use to tune the avatar (`AGENT_TASK.md` inside the bundle is that task). The user presses
**Start**, speaks when asked, and presses **Export**. Nothing is tuned, committed or uploaded by the wizard itself.

Code: `extension/src/calibration/` (runner, scenarios, trace, analysis, reports, ZIP/WAV), the recorder
`extension/src/offscreen/CalibrationRecorder*.ts`, the panel `extension/src/ui/dev/calibrationPanel.ts`, the export
page `extension/src/calibration-export/`, ChatGPT automation in `ChatGPTAdapter` (`ConversationAutomation`).
Architecture and privacy rules: [../PRODUCT.md](../PRODUCT.md) (invariants 5, 14, 19; §5.13).

## Before you start

- Chrome with Prosopon, the avatar on in a ChatGPT tab, Developer mode on.
- **Headphones.** ChatGPT Voice hears your speakers; the wizard mutes ChatGPT's microphone during scripted steps,
  but interruption steps need it on.
- Microphone reactions allowed (the wizard turns them on; without them the user steps are marked invalid).
- Choose the languages in the Calibration panel before **Start**. Russian is selected by default; only selected
  languages create assistant, user and interruption steps. A four-language run takes about 12–14 minutes.
  ChatGPT Voice usage limits apply.

## What a run does

1. Preflight: tab capture running, microphone on (auto-fix), config snapshot, offscreen recorder session.
2. Environment: voice name and mode from the page (`detectVoiceEnvironment`); unknown → a voice picker.
3. A new chat, then a setup prompt typed through the composer (text mode).
4. Voice started (`startVoice`), its controls mounted, ChatGPT's microphone muted, then the wizard waits for 1.2 s
   of quiet. This drains Voice's startup chime before any sample is armed. If start fails: *I couldn't start ChatGPT
   Voice automatically. [Open Voice]*.
5. Per language RU → UK → EN → ES: each assistant sample is a prompt typed into the composer asking ChatGPT to say a
   composite sentence verbatim; Prosopon accepts it only after sustained assistant audio *and* a new rendered
   assistant turn. A chime, tab noise, a closed Voice session, crosstalk from the user mic, or audio without a new
   turn is invalid rather than a sample. The Voice session closing ends the wait immediately. Retry once, then the
   sample is invalid and the run continues. Three silent samples in a row stop the assistant part (the typed-prompt
   path doesn't work in this voice session).
6. User steps: the wizard shows a phrase, VAD detects start and end, then the avatar's reaction window.
7. Interruptions: ChatGPT is asked for a long answer, a 3-2-1 countdown, **SPEAK NOW**, then onset, state change and
   gesture cancellation are measured.
8. Analysis (local rules, no LLM): a verdict per sample, a summary per language, measured chars/s.
9. Export: the ZIP is built in the offscreen document; an extension page downloads it. **Discard** (in the
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
`GESTURE_CLAMPED`, `SEMANTIC_MISS`, `PACING_DROP`, `VAD_MISSED`, `INTERRUPTION_SLOW`, … ; audio without a rendered
turn is `INVALID_SAMPLE` with `assistant-audio-without-reply-text`.
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

1. **Typed prompt during Voice** (the main risk). With a voice session open, does a message sent from the composer
   get a *spoken* answer? If ChatGPT only answers in text, every assistant sample is invalid and the run says so
   after three silent samples. There is no read-aloud fallback.
2. **Reply text in voice mode.** Is the spoken reply rendered in the thread while it is spoken? The wizard now rejects
   audio without a new rendered assistant turn, because it cannot distinguish it safely from startup/tab audio.
3. **Selectors** (`CHATGPT_SELECTORS`, all guesses except the orb and the assistant message):
   - composer `#prompt-textarea` or `contenteditable[role=textbox]` — typing through `execCommand('insertText')`;
   - send `[data-testid="send-button"]` / `#composer-submit-button`, otherwise native composer form submission;
   - new chat `[data-testid="create-new-chat-button"]`, otherwise exact localized accessible text (including
     *Новий чат*);
   - start voice `[data-testid="composer-speech-button"]`, English fallback *Start voice mode*, and the observed
     Ukrainian fallback *Почати голосову розмову*;
   - mute English controls or observed Ukrainian *Вимкнути/Увімкнути мікрофон*; the resulting state is confirmed,
     not just clicked;
   - the selected voice: a checked `menuitemradio`/`radio`/`option` with a known name, an `aria-label`/`title` like
     *Voice: Sol*, or a page `localStorage` key containing `voice`. Otherwise the picker appears (expected).
4. **Mute** actually stops ChatGPT from hearing you during scripted and user steps, and is restored at the end.
5. **Headphones vs speakers**: on speakers ChatGPT may interrupt itself; note it in the flags.
6. **Voice limits**: a run of this length may hit ChatGPT Voice limits or a session timeout; the wizard shows
   *[Resume Voice]* when the session closes.

Report selector fixes in `ChatGPTAdapter` and the fixture (`tests/e2e/fixtures/chatgpt.html`) together.

## Limits

- One voice per run; the architecture (a voice × language key, `ScenarioOptions`) allows a batch "all voices" run
  later, not implemented.
- The run resumes only within the page's lifetime (in memory); a reload loses it.
- No per-voice configs and no runtime config changes: the bundle is input for a later tuning change.
