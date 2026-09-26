# Semantic layer checks (needs real ChatGPT and your eyes)

Context: [PRODUCT.md §5.11](../PRODUCT.md#511-semantic-performance-layer), code and tunables:
[avatar/README.md](../avatar/README.md#semantic-analyzer), [extension/README.md](../extension/README.md#architecture).
Rules: [AGENTS.md](../AGENTS.md).

The vocabulary, thresholds, gesture mapping and the 14 chars/s speech rate were set on hand-written ChatGPT-style
replies; nothing here has seen a real ChatGPT reply or real ChatGPT voice. Budget: ~30 minutes.

## 1. Reply text reaches the analyzer (blocking)

`cd extension && npm run build:dev`, enable Prosopon on chatgpt.com, turn **Developer mode** on, open Developer
Tools → **Semantic**.

| # | Do | Expect | If not |
|---|----|--------|--------|
| 1 | Text chat: ask "Compare Postgres and MySQL in 3 points, then give a conclusion" | *segments* and *cues* grow while the answer streams; entries show `enumeration item`, `contrast`, `conclusion` | `CHATGPT_SELECTORS.assistantMessage` / `messageBody` don't match: inspect the reply in DevTools, fix them in `ChatGPTAdapter.ts` and in `tests/e2e/fixtures/chatgpt.html` |
| 2 | Reload with an old reply on screen, enable the avatar | nothing is analysed until a new reply | the baseline id is unstable (no `data-message-id`) |
| 3 | Voice mode: ask a question and let it answer | *mode* `speech`; counters grow while it speaks | voice mode doesn't render the reply text (or renders it only at the end): semantics are silent in voice; write down what the DOM shows |
| 4 | Same in RU, UK, ES | cues in each language; RU and UK not confused | note the missed phrases (copy the segment text) |

Page-console (dev build, any context): `document.dispatchEvent(new CustomEvent('prosopon:semantic', { detail: {
probabilityScale: 3 } }))`, also `{ enabled: false }`, `{ pacing: false }`. Overlay attributes:
`data-semantic-cues`, `-intents`, `-accepted`, `-last`.

## 2. Timing in voice mode

Watch *spoken* (chars) against where the voice is in the text on screen. If accents land consistently early, lower
`SEMANTIC_PACER_CONFIG.charsPerSecond`; late → raise it (sandbox: *Speech, chars/s*). Expected ChatGPT voices:
12–16 chars/s. Per-voice and per-language differences are expected; one value is a compromise.

## 3. Density and look (sandbox first)

`cd avatar && npm run dev` → **Semantic** folder → *Play demo* in each language. Expect roughly one semantic gesture
per 4–5 cues (Developer Tools shows *cues / intents / gestures*), no two within 2.5 s, never the same cue type
within 6 s, and no nodding on a "No". Check the two new gestures in the **Gestures** folder: **Head Shake** (small,
symmetric, not a "no!" slap) and **Lean In** (slight forward lean, returns). Too busy → *Chance ×* below 1 or longer
*Cooldown*; too flat → the opposite. Paste settings into the thread.

## 4. False positives on real replies

Collect 5–10 real replies per language with the Semantic tab open and note any cue that is plainly wrong (e.g.
agreement on "Правильная настройка…", contrast on "не только…, но и…"). Each becomes a negative fixture in
`avatar/tests/unit/semanticFixtures.ts` and, if needed, a `none` rule in `avatar/src/semantic/rules/<locale>.ts`.
