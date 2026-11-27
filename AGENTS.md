## Write in plain language

Apply to responses, documentation, plans, PRDs, ADRs, and code comments. The
general rules live in the `plain-language-dialogue` and `show-the-work` shared
practices under `packages/agents/definitions/shared-practice/`. This repo adds:

- Lead with the answer, outcome, or decision. Omit how you got there unless it
  explains a choice.
- Replace jargon and vague abstractions with concrete meaning: who does what,
  what changes, and why it matters.
- Avoid rhetorical contrasts such as “X, not Y.” Keep a contrast when it explains
  a real trade-off, constraint, or likely mistake.
- Cut words, not detail. Preserve facts, conditions, warnings, and exact names,
  numbers, commands, paths, URLs, identifiers, and error messages. When editing
  prose, leave code unchanged.
- Keep the original language when editing unless asked to translate.

## Local Type Style

In TypeScript do not use `any`, `unknown`, or `object`. Define named types with specific properties, or let
TypeScript infer the type. Export reusable types from the module that owns them
and import them through its public surface. Avoid complex inline types and
standalone shared-type modules. Use real source extensions in imports.

## Running Tests

Use `bun run test` or `bun scripts/run-tests.ts <test paths or runner options>`.
Never run `bun test` directly. The isolated runner and preload guard give every
test file its own process, disposable HOME, temporary directory, and
`MNEMOTECA_DB_PATH`. `bun run ci` includes the full source and Golden portfolio;
`bun run test:bun` runs the explicit inventory in `scripts/bun-test-files.json`.

Read `.bun-version` at the Git root of **the worktree you are running in**. It is the single
source for selecting Bun. Run `./scripts/with-bun.sh run install:locked` before checks and use
the same launcher for tests, builds, and scripts. It selects the checkout's version even if
another Bun is on PATH. To upgrade Bun, edit the root `.bun-version`. Refer to that file in
agent instructions and plans so a saved version number cannot override the checkout.
Installation uses separate frozen locks for the root and docs dependency graphs and disables lifecycle scripts.

Two rules keep tests safe:

- Resolve home and cwd through `getHomeDir()` and `getCwd()` in
  `src/constants.ts`. Never read `Deno.env.get("HOME")` or `Deno.cwd()` directly
  in `src/`, and never cache either in a module-level `const`.
- Wrap any test that mutates `HOME` or the working directory in
  `withProcessGlobalTestLock` (`test-support/process-global-lock.ts`).

## Product and Architecture Documents

The five living PRDs in `docs/prd/`:

- `runwield.md` — product-family promises and guiding principles.
- `runwield-core-prd.md` — shared local behavior: planning, execution,
  validation, and recovery.
- `runwield-workspace-prd.md` — the personal browser and shared Plan review.
- `runwield-connect-prd.md` — use from external hosts.
- `runwield-acp-protocol-prd.md` — compatibility with external ACP clients.

Other PRDs are transient. After implementation, fold their lasting requirements
into the owning living PRD and delete them. This ownership is specific to this
repo; bundled agent guidance must work with any user's PRD structure.
