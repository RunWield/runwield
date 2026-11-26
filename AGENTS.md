## Write in plain language

Apply these rules to responses, documentation, plans, PRDs, ADRs, code comments,
and other prose.

Write for a knowledgeable reader with limited time and attention. Make the text
easy to understand in one pass. Use a direct, conversational tone.

### Language

- Use everyday words and short, direct sentences. Give each sentence one main idea.
- Keep technical terms when they are the most precise choice. Explain unfamiliar
  terms briefly when the intended reader needs that context.
- Replace business jargon, buzzwords, stock metaphors, and vague abstractions with
  their concrete meaning. Say who does what, what changes, and why it matters.
- Remove filler, repetition, slogans, and unnecessary introductions.
- State facts directly. Avoid rhetorical contrasts such as “X, not Y” or
  “not A, but B.” Keep contrasts and negations when they explain a real tradeoff,
  constraint, exclusion, or likely mistake.
- Use the requested language. When editing, preserve the original language unless
  asked to translate.

### Structure

- Lead with the main point: the answer, outcome, proposal, or decision the reader
  needs to understand.
- Follow with the explanation and evidence needed to assess it. Omit the story of
  how you arrived there unless that history explains a relevant choice.
- Use paragraphs for connected reasoning, bullets for parallel facts, numbered
  lists for ordered steps, and tables for comparisons.
- Add short, descriptive headings when they help navigation. Keep short texts short.
- State each fact once where practical. Use links or cross-references instead of
  repeating whole explanations.
- Follow the document's required format. Within it, make requirements observable,
  plan steps actionable, and architectural decisions explicit about their rationale,
  alternatives, tradeoffs, and consequences.

### Precision

- Simplify the wording without losing meaning. Preserve necessary facts, conditions,
  qualifications, warnings, questions, and instructions.
- Keep proposed, implemented, and deferred behavior distinct. Identify assumptions
  and uncertainty; do not turn them into facts.
- Preserve exact names, numbers, commands, paths, URLs, identifiers, and error
  messages. When editing prose, leave code unchanged unless asked to change it.
- Include enough detail for the reader to act, decide, implement, or verify.
  Concision must not remove necessary reasoning or evidence.

Before finishing, reread the text. Remove words that add no meaning, replace vague
claims with concrete statements, and check that the main point is easy to find.

## Local Type Style

Use TypeScript (`.ts` or `.tsx`) for source and tests. Do not use `any`,
`unknown`, or `object`. Define named types with specific properties, or let
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

PRDs describe user needs, product outcomes, scope, and acceptance journeys. ADRs
explain architectural choices, user constraints, alternatives considered or
excluded, rationale, and implications. Plans track implementation steps, bugs,
and remaining work. Existing restrictions and tests describe implementation;
they do not override the owner's product intent.

The five living central PRDs are `docs/prd/runwield.md`, `runwield-core-prd.md`,
`runwield-connect-prd.md`, `runwield-workspace-prd.md`, and
`runwield-acp-protocol-prd.md` in that directory. They hold guiding principles
and lasting product requirements. Other PRDs are transient: after
implementation, fold lasting requirements into the appropriate central PRD,
update references, and remove the completed PRD. Git history preserves earlier
proposals; Work Records preserve delivery evidence. See
`packages/agents/definitions/document-formats/PRD-FORMAT.md`.

Organize requirements inside these five PRDs by capability, with stable links,
named observable requirements, and acceptance scenarios. Each capability has one
owning PRD; link shared requirements instead of duplicating them. In the same
change that alters behavior, update the owning capability, scenarios, and
affected references. Planning labels proposed additions, changes, and removals;
it does not claim they shipped. Keep current, target, and deferred behavior
distinct. The root PRD owns product-family promises, Core shared local behavior,
Workspace personal browser and shared Plan review journeys, Connect
external-host use, and ACP external-client compatibility. This five-document
ownership is specific to this repo; bundled agent guidance must work with any
user's PRD structure.

Delivery workflows conclude only after confirmed publication or deliberate user
abandonment. Failures, retry limits, and internal inconsistencies are
recoverable intermediate conditions. RunWield repairs its own locks, settings,
storage, metadata, and synchronization automatically, without making the user
operate its machinery. Keep the owning requirements and scenarios in
`docs/prd/runwield-core-prd.md#execution-validation-and-recovery` authoritative.

Follow the shared ADR authoring and maintenance policy in
`packages/agents/definitions/document-formats/ADR-FORMAT.md`.
