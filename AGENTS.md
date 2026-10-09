## Local Type Style

JSDoc: prefer `@typedef` for object shapes over inline annotations or `@type` casts. Define the type once and reference
it. Type function parameters in the `@param` block, not with `@type` declarations in the function body.

TypeScript: do not use `any`, `unknown`, or `object`. Define a type with named properties, or let TypeScript infer the
type. Do not define complex inline types.

## Running Tests

When you need to run the test suite use `deno task test` or `deno run -A scripts/run-tests.js <deno test args>`. Never
run `deno test` directly. It puts every test file in one process and uses the real `HOME`, which can rewrite your own
`~/.wld` and Mnemoteca database. `scripts/run-tests.js` gives each file its own process and a sandboxed `HOME` and
`MNEMOTECA_DB_PATH`.

Two rules keep tests safe:

- Resolve home and cwd through `getHomeDir()` and `getCwd()` in `src/constants.js`. Never read `Deno.env.get("HOME")` or
  `Deno.cwd()` directly in `src/`, and never cache either in a module-level `const`.
- Wrap any test that mutates `HOME` or the working directory in `withProcessGlobalTestLock`
  (`src/testing/process-global-lock.ts`).

## Test Seams and Dependency Injection

RunWield has a zero-seam baseline. `deno task seams:check` enforces it and runs in `deno task ci`.

An injection seam is a public claim that something is **not ours**. Treat it as an architectural decision, not a testing
convenience:

- Do not add a seam for RunWield-owned machinery such as Plan writes, lifecycle transitions, registry writes, or locks.
- Do not write a conditional seam such as `__deps ? fake : real`.
- Fake the environment instead. Use `defineGitFixture` (`src/shared/git-test-fixture.ts`) for a real Git repository and
  `makeValidationProjectRoot` for a real Plan project.
- Use seams only for genuine boundaries: subprocesses, network, agent turns, CI runs, clocks, or other slow and
  nondeterministic external capabilities.

If `seams:check` fails, fix the code. Do not adopt or re-baseline a new seam.

## Frontend UX Work

Use the current RunWield browser design system and Workspace surfaces as the blueprint so new UI does not drift from the
established look and feel.

- Start with `docs/design-system.md`, then verify details against current source.
- Treat `src/ui/design-system/` as the implementation baseline: `tokens.css`, `components.css`, `theme-bridge.ts`, and
  `components/react/RunWieldPrimitives.jsx`.
- Use `--rw-*` semantic tokens and the theme bridge. Do not use hard-coded colors.
- Before adding a visual pattern, check whether an existing one covers it. If a new one is necessary, document it in
  `docs/design-system.md` and add it to the shared design-system layer in the same change.

## Product and Architecture Documents

PRDs describe user needs, product outcomes, scope, and acceptance journeys. ADRs explain architectural choices, user
constraints, alternatives considered or excluded, rationale, and implications. Plans track implementation steps, bugs,
and remaining work. Existing restrictions and tests describe implementation; they do not override the owner's product
intent.

The five living central PRDs are `docs/prd/runwield.md`, `runwield-core-prd.md`, `runwield-connect-prd.md`,
`runwield-workspace-prd.md`, and `runwield-acp-protocol-prd.md` in that directory. They hold guiding principles and
lasting product requirements. Other PRDs are transient: after implementation, fold lasting requirements into the
appropriate central PRD, update references, and remove the completed PRD. Git history preserves earlier proposals; Work
Records preserve delivery evidence. See `src/agent-definitions/document-formats/PRD-FORMAT.md`.

Organize requirements inside these five PRDs by capability, with stable links, named observable requirements, and
acceptance scenarios. Each capability has one owning PRD; link shared requirements instead of duplicating them. In the
same change that alters behavior, update the owning capability, scenarios, and affected references. Planning labels
proposed additions, changes, and removals; it does not claim they shipped. Keep current, target, and deferred behavior
distinct. The root PRD owns product-family promises, Core shared local behavior, Workspace browser/team journeys,
Connect external-host use, and ACP external-client compatibility. This five-document ownership is specific to this repo;
bundled agent guidance must work with any user's PRD structure.

Delivery workflows conclude only after confirmed publication or deliberate user abandonment. Failures, retry limits, and
internal inconsistencies are recoverable intermediate conditions. RunWield repairs its own locks, settings, storage,
metadata, and synchronization automatically, without making the user operate its machinery. Keep the owning requirements
and scenarios in `docs/prd/runwield-core-prd.md#execution-validation-and-recovery` authoritative.

Follow the shared ADR authoring and maintenance policy in `src/agent-definitions/document-formats/ADR-FORMAT.md`.
