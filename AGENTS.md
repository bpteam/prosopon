# AGENTS.md

Rules for AI coding agents and human contributors working in this repository.
What the product is and how it is built lives in [PRODUCT.md](PRODUCT.md); this file says **how to work** on it.

Before making changes:

1. Read [PRODUCT.md](PRODUCT.md).
2. Read the relevant subsystem README: [avatar/README.md](avatar/README.md) (renderer, audio, behaviour core,
   sandbox) and/or [extension/README.md](extension/README.md) (Chrome extension runtime).
3. Inspect the current implementation.
4. Inspect the relevant architecture, unit and E2E tests.
5. Treat current code and architecture tests as the final source of truth. If a document disagrees, fix the
   document in the same change.

[README.md](README.md) is the onboarding entry point (what it is, how to run it). [docs/](docs/) holds manual
calibration procedures.

## Working rules

- **Extend, don't duplicate.** Add behaviour as a typed source into `BehaviorMixer`; add lip-sync analysers behind
  `VisemeAnalyzer`; add providers around `AvatarController`. Never a second render loop, audio pipeline or avatar
  implementation, and never core code copied into `extension/` (import it via `@avatar/*`).
- **Keep the invariants** in [PRODUCT.md §4](PRODUCT.md#4-architectural-invariants). If a change must break one,
  say why before implementing it, then update PRODUCT.md and the architecture tests in the same change.
- **Never delete, skip or weaken a test** (architecture tests included) to make a new implementation fit.
- **ChatGPT DOM knowledge** goes only in `ChatGPTAdapter`; keep `extension/tests/e2e/fixtures/chatgpt.html` in sync.
- **Permissions:** do not add a manifest permission or host without a concrete use; when one stops being used,
  remove it. `extension/tests/unit/manifest.test.ts` pins the permission list.
- **Emotion model pin:** `extension/src/emotion/EmotionModelManifest.ts` is the only place the model id, revision,
  URL, size and SHA-256 are defined in code. Never point it at a mutable ref such as `resolve/main`.
- **No remote executable code** in the extension; no raw audio across extension contexts; no microphone path to
  the speakers.
- **User stories** (US-00x) are history. Don't use their numbers as architecture names in new code or docs.

## Commands

Use only commands that exist in `package.json` / `compose.yaml`; the full list is in [README.md](README.md#quick-start)
and the subsystem READMEs. Minimum checks for a change:

| Changed | Run |
|---|---|
| `avatar/src/**` | `cd avatar && npm run typecheck && npm test`; `npm run test:e2e` if rendering, lip sync, emotion or gestures changed; then the extension checks (it compiles `avatar/src`) |
| `extension/**` | `cd extension && npm run typecheck && npm test`; `npm run test:e2e` if runtime behaviour changed |
| any `*.md` | `node scripts/check-md-links.mjs` |

E2E needs Chromium: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome` or `npx playwright install chromium`.
If a test was already failing before your change, say so explicitly instead of hiding it.

## Documentation is part of the task

Any task that changes functionality, architecture, configuration, runtime behaviour, permissions, the build
process, a public API, fallback behaviour or known limitations is **not complete** until the affected documentation
is updated.

Documentation must be updated in the same change as code.

Never leave documentation knowingly describing the previous implementation.

Do not postpone documentation to a separate future task.

"Documentation not requested by the user" is not a reason to skip it: documentation is part of the implementation.

| When changing | Update |
|---|---|
| product behaviour | `PRODUCT.md` |
| installation, development workflow, user-facing usage | `README.md` and/or the subsystem README |
| avatar core (`avatar/src`) | `avatar/README.md` |
| extension runtime (`extension/`) | `extension/README.md` |
| calibration / debug procedures | `docs/` |
| architecture rules | `PRODUCT.md`, plus this file if agent behaviour is affected |

If a new feature introduces:

- a new subsystem,
- a new public option,
- a new build flag,
- a new permission,
- a new fallback,
- a new architectural invariant,
- a new known limitation,

update `PRODUCT.md` in the same task.

### One fact, one place

| Document | Role |
|---|---|
| `README.md` | onboarding, quick start, links |
| `PRODUCT.md` | product, architecture, invariants, capabilities, limitations, what is not implemented |
| `AGENTS.md` | rules for agents and contributors |
| `avatar/README.md` | avatar core in detail: APIs, contracts, tunables, sandbox, tests |
| `extension/README.md` | extension in detail: contexts, messaging, permissions, emotion model, tests |
| `docs/*` | calibration and deep procedures |

Write a fact in its canonical document and link to it from the others. Constants that live in code (model hash,
thresholds, limits) are referenced by file/symbol rather than copied around; where a value is listed for readers,
list it once.

## Definition of Done

Before finishing a task:

- tests relevant to the change pass;
- documentation affected by the change is updated;
- PRODUCT.md still describes the real architecture;
- README examples and commands still work;
- obsolete documentation has been removed or corrected;
- no two documents contradict each other;
- relative Markdown links and anchors resolve: `node scripts/check-md-links.mjs` (no dependencies).

In the final report, state which documents changed, and name any documentation or test debt you found but did not
fix.
