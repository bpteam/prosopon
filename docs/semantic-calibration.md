# Semantic layer checks (needs real ChatGPT and your eyes)

Context: [PRODUCT.md §5.11](../PRODUCT.md#511-semantic-performance-layer), code and tunables:
[avatar/README.md](../avatar/README.md#semantic-analyzer), [extension/README.md](../extension/README.md#architecture).
Rules: [AGENTS.md](../AGENTS.md).

The vocabulary, thresholds, gesture mapping and the 14 chars/s speech rate were set on hand-written ChatGPT-style
replies; nothing here has seen a real ChatGPT reply or real ChatGPT voice. Budget: ~30 minutes.

## Production DOM investigation (2026-09-26)

The production `https://chatgpt.com/` shell was inspected read-only while logged out. Its conversation subtree is a
`div[role="region"][aria-label="Conversation"]`, containing a conversation `section` and an `ol` transcript.

An authenticated Voice Mode session was then inspected after several spoken turns. It uses a different transcript
path: the canonical root is `div[data-chatgpt-conversation-selection-target="true"]`; assistant turns are
`[data-content-search-unit-key$=":assistant"]`, identified by a child
`h4[data-conversation-role="assistant"]`. The assistant body is
`[data-markdown-text-style="assistant-message"]`, and its immutable id is the descendant's
`data-chatgpt-selection-message-id`. The ordinary `[data-message-author-role="assistant"]` and `.markdown`
selectors matched **zero** Voice Mode nodes. The root now scopes `ChatGPTAdapter`'s observer, preventing a
voice-overlay/accessibility mirror from winning and allowing rebind after SPA replacement.

User and assistant turns are distinct in the same transcript: user speech is
`fallback-turn-N:0:user`, while assistant speech is `fallback-turn-N:1:assistant`. The adapter selects only the
`:assistant` suffix; user streaming text is intentionally observed only as a DOM mutation and never read or sent to
the semantic subsystem.

The Voice transcript is incremental: during assistant speech the message grows in place rather than appearing only
after speech finishes (observed in the live session). `ChatGPTAdapter` observes both text-node changes and child-node
changes inside the transcript root, so either React update shape becomes a bounded semantic revision. The exact
low-level React mutation form (one text node vs appended/replaced spans) was not recorded, so the adapter deliberately
does not depend on either. The fixture streams text in that body so the integration path has a regression test.
`window.__PROSOPON_DEBUG__.chatgpt` reports the root/turn/body selectors, current text revision and observer state
during a development build.

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
