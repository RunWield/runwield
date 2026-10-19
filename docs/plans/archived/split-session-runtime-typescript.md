---
planId: "a219d9a7-0cac-4e7e-9a52-bff07b64a35e"
classification: "PLANNED_CHANGE"
workKind: "REFACTOR"
complexity: "HIGH"
affectedPaths:
    - "src/shared/session/session-runtime.js"
    - "src/shared/session/session-runtime.ts"
    - "src/shared/session/runtime/"
    - "src/shared/session/architecture-boundary.test.ts"
    - "src/shared/session/session-runtime.test.js"
    - "src/shared/session/session-runtime-method-policy.test.ts"
    - "src/shared/session/managed-operation.ts"
    - "src/shared/session/hosted-session.js"
    - "scripts/language-policy-baseline.json"
    - "docs/adr/010-session-runtime-sibling-adapters-and-acp.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "7dba8e443795bd9e357ddd6b1062c5610fd68ffe"
workRecord:
    status: "generated"
    recordId: "af4ce5f1-40c6-43a5-a01e-deea4115e893"
    path: "docs/work-records/2026-09-22-split-sessionruntime-into-typed-private-owners.md"
    lastAttemptAt: "2026-09-22T15:30:56.607Z"
archivedAt: "2026-09-22T21:12:12.422Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/split-session-runtime-typescript.md"
---

# Split SessionRuntime into TypeScript Files

## Context

The user requests a split of `src/shared/session/session-runtime.js`, currently 5,564 lines, and conversion to
TypeScript. Every new source file must be TypeScript and less than 1,000 lines. This is a behavior-preserving refactor,
not a new Session design.

The file combines creation, reading, prompts, queues, events, managed operations, settings, images, shell commands, and
workflow handoffs. Its private maps and ordering rules make an arbitrary split unsafe.

Requirements to preserve, with no product additions or removals:

- [Session continuity](../../prd/runwield-core-prd.md#session-continuity): **Continue the same saved work across
  clients.** Preserve deferred first-message persistence, dormant reads, independent Sessions, saved Agent/model
  choices, and handoffs without duplicate user messages.
- [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): **Validate
  and deliver approved work without losing recoverable changes** and **Publish successfully or end only by deliberate
  user abandonment.** Preserve Runtime workflow dispatch, repair, cancellation and recovery; do not change workflow
  authority.
- [Models and providers](../../prd/runwield-core-prd.md#models-and-providers): **Change models without losing Session or
  workflow context.** Preserve selection, rollback and Execution Backend compatibility.
- [Compaction and image context](../../prd/runwield-core-prd.md#compaction-and-image-context): **Retain useful
  conversation and attachment context.** Preserve image preflight, persistence, and repair context through reload and
  compaction.

[ADR-010](../../adr/010-session-runtime-sibling-adapters-and-acp.md),
[ADR-015](../../adr/015-file-authoritative-session-bundles.md), and
[ADR-013](../../adr/013-deno-native-typescript-ratchet.md) remain authoritative. No storage migration, new public
methods, new domain terms, or new test injection points are intended. Existing unmet product requirements remain unmet;
this refactor must not claim to complete them.

## Objective

- Replace the JavaScript implementation with `session-runtime.ts` and cohesive private TypeScript implementations.
- Keep **every resulting Runtime source file, including the public entry point and types, at 999 lines or fewer** after
  normal repository formatting. All new code files, including tests, use TypeScript and meet the same limit.
- Keep existing public exports, methods, inputs, result shapes, error behavior, event order, and synchronous versus
  asynchronous return behavior. Only the import extension changes.
- Give each internal state collection one owner. Do not move the monolith into another file, JavaScript helper,
  superclass, shared state bag, or dynamically installed method table.

## Approach

Keep one public `SessionRuntime`. Compose concrete internal implementations behind it. The public class keeps explicit
methods so existing reflection and method-policy checks still work. Its delegates are allowed; an internal module must
own real behavior rather than forward everything to a hidden monolith.

```text
TUI / ACP / Workspace / commands
  session-runtime.ts — same public methods
    turns — prompt and cancellation
      managed operations — lock, hydrate, checkpoint, release
        existing file store, HostedSession, Agent and workflow implementations
```

Proposed files under `src/shared/session/runtime/` follow existing responsibilities. Names can change if the ownership
stays clear. Estimates leave room for native types; they are not permission to exceed 999 lines.

| File                    | Behavior and state owned                                                                                                                     | Estimated lines |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------: |
| `types.ts`              | Shared named Runtime inputs/results and narrow internal contracts; use existing domain types                                                 |         250–400 |
| `events.ts`             | Event publication/subscriptions, replay/live buffers, busy depth, listener cleanup                                                           |         200–300 |
| `queues.ts`             | Steering, next-turn queue, dequeue/clear, source reconciliation, drain tasks and subscriptions                                               |         450–550 |
| `managed-operations.ts` | Capability implementation, operation context, current operations/proofs, settlement, nested/standalone/workflow guards, creation transaction |         700–850 |
| `lifecycle.ts`          | Create/load/adopt/close, deferred shell materialization, pending creation project/name data                                                  |         800–950 |
| `agent-settings.ts`     | Agent activation and MCP setup, model/thinking/rename/reload/compaction, prompt-ready profile                                                |         550–750 |
| `managed-sync.ts`       | Committed generation synchronization, initial recovery, continuation decision                                                                |         280–380 |
| `reads.ts`              | Snapshots, replay/projection, context/info/export, resume inspection, catalogs and read cache                                                |         500–650 |
| `turns.ts`              | User/named/managed/handler prompts, cancellation, interaction dispatch, turn settlements                                                     |         550–750 |
| `workflows.ts`          | Plan actions, execution, validation, repair/Epic continuation, execution replacement, associations and rollover dispatch                     |         650–850 |
| `images.ts`             | Image preflight/model agreement, persistence, named-invocation references                                                                    |         220–300 |
| `local-shell.ts`        | Shell dispatch, output events, cancellation and transcript recording                                                                         |         220–300 |

`session-runtime.ts` should need roughly 450–650 lines for composition, public methods and existing exports. If a group
exceeds the limit, split a coherent sub-responsibility rather than compressing formatting. Keep capability construction
private to managed operations. It must not become a public export.

### Internal cooperation

- Runtime privately constructs concrete owners. Internal methods operate on the same HostedSession and store owner;
  callers cannot replace owned logic through new constructor options or dependency bags.
- Managed operations alone owns its maps, operation context and capability lifecycle. Preserve the context's checks for
  Runtime identity, Session identity and exact capability identity. Busy state is not mutation authority.
- Agent settings performs root activation; managed operations owns the surrounding creation/activation transaction.
  Lifecycle owns pending shell data, not a second copy of proofs. Keep these responsibilities separate during
  extraction.
- Events owns buffers and busy counts. Queues owns its maps and provides explicit reconciliation and cleanup methods.
  Turns owns turn settlement; lifecycle waits for both turn and managed-operation settlement before disposal.
- HostedSession retains root manager, Agent, workflow, interactions and pending intent. Do not copy them into new
  stores.
- Use named, narrow internal collaboration methods. Do not pass the full Runtime as a general-purpose access point to
  private state. The existing live-connection integration may still receive the public Runtime as it does today.
- Avoid runtime import cycles. Shared type-only contracts can break type dependencies without adding global state or
  configurable callbacks. No internal components are exposed to adapters.

Arbitrary method chunks or mixins would require less initial design, but would keep private-state coupling hidden and
weaken type checking. They are not the chosen approach.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/session-runtime.js` → `session-runtime.ts`, plus `runtime/*.ts` — replace the monolith and give
  extracted behavior/state clear owners.
- Runtime importers throughout `src/` and `scripts/` — update static/dynamic imports, JSDoc type imports and source URLs
  to the real `.ts` path. No `.js` compatibility wrapper.
- `hosted-session.js`, `managed-operation.ts`, and directly related type declarations — correct narrow contracts exposed
  by migration, such as backend capabilities and `preparedModelOverride`. Do not expand into unrelated conversions.
- Runtime, architecture, operation, mutation and segment tests — retain behavior coverage and redirect source guards to
  the actual implementations. New structural and integration tests are TypeScript, each under 1,000 lines.
- `scripts/language-policy-baseline.json` — remove the deleted JavaScript path; do not re-baseline injection rules.
- ADR-010 — clarify that SessionRuntime is a logical public boundary with private internal implementations. Preserve
  existing ownership and restrictions. Update affected current source references in docs.
- Core PRD Session continuity — synchronize implementation references with the split, retaining named requirements,
  scenarios and current/target distinctions. No unrelated PRD rewrite or new product claim.

File store algorithms, transcript schemas, lower-level workflow engines, UI presentation and domain language definitions
are deliberately unchanged.

## Reuse Opportunities

- `session-runtime-method-policy.ts` — keep the existing public method policy and actual prototype comparison.
- `file-session-store-owner.ts`, `file-session-store.ts`, `managed-operation.ts` — retain store ownership, real locks,
  existing operation contracts and lifecycle semantics.
- `session-runtime-events.js`, `session-runtime-interactions.js`, transcript projection/manifest helpers,
  `segment-rollover.ts`, and `named-invocation.ts` — reuse existing contracts/behavior; do not duplicate them.
- `withRuntimeCommandFixture`, `defineGitFixture`, and `makeValidationProjectRoot` — real Session, Git and Plan
  fixtures. Only fake genuine external model/subprocess boundaries. Use `withProcessGlobalTestLock` for HOME/cwd
  mutations.

## Implementation Steps

1. **The preservation baseline is explicit and runnable.** Inventory current exports, public methods, private state and
   source-only guards. Map each method/state collection to its intended owner. Retain the public method allowlist and
   classify existing tests by the behavior below. Add the missing public-Runtime integration cases before extraction;
   verify baseline behavior without weakening assertions to accommodate this refactor.
2. **Typed contracts describe actual calls and results.** Named options, result unions, event drafts, backend
   capabilities and operation results replace loose local JSDoc. Reuse Pi types only where Pi is actually required; CLI
   backends use their real structural capabilities. Preserve optionality, null handling and sync/async returns. No
   explicit `any`, `unknown`, `object`, broad `Function`, unchecked cast chains, or production type-check suppressions
   in migrated code. Adjacent contract corrections remain narrow and behavior-neutral.
3. **Private implementations own the behavior and state in the table.** Extract lower-dependency reads/events/images/
   shell/queue work, then lifecycle, settings, operations, turns and workflows in compiling increments. Each operation
   still runs the real original behavior through its new owner. No duplicate old/new implementation remains. The
   lock-before-hydration and checkpoint-before-publication sequence, failure cleanup and nested identity checks remain
   intact, including the creation path.
4. **The public TypeScript entry point is the only consumer interface.** Existing exports and explicit public methods
   remain available with the same semantics. All import/type/source references use the correct extension. The old file
   is deleted, its language baseline entry removed, and no new JavaScript or generated implementation is introduced.
5. **Tests enforce the new structure without losing restrictions.** Size coverage includes the entry point and every
   internal production source file, not just a hand-picked list. Boundary scans cover TypeScript as well as JavaScript.
   Hydration, store mutation and event-production allowlists name only their specific new owners, not the entire
   `runtime/` directory. Consumer imports of internal Runtime files and exposure of owned state remain forbidden. Moved
   source-order guards inspect real owner implementations rather than public delegates. Behavioral tests cover the
   critical orderings; source matching alone is not proof.
6. **Documentation and verification match the delivered split.** ADR-010 explains the unchanged logical boundary and its
   private composition. Core PRD references and other affected current links point to the new implementation, with
   requirements and unresolved targets preserved. Every resulting/new code file passes the size rule after formatting,
   and all checks below pass or have a clearly reported pre-existing failure.

## Approval Confirmation

No Work Records are proposed for replacement. No `supersedes` relations are requested.

## Verification Plan

### Behavioral evidence

Keep existing assertions and use the public Runtime for new integration coverage. Existing JavaScript test files need
not all be converted; any newly split test files must be TypeScript and under 1,000 lines. No product behavior is
expected to stop existing. Only the old file path and single-file source assumptions are retired.

| Behavior that must survive                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty shell stays unpersisted; first message is shown before busy/persistence; first-turn failure remains retryable | Existing `session-runtime.test.js` deferred creation, first-message order, generation-zero and retry cases                                                                                                                                                                                                                                                     |
| A real operation blocks a competing writer; rejected text is not saved; lock becomes available after settlement     | `managed-operation-boundary.test.ts`, `fenced-shell-and-image.test.ts`, existing Runtime activation/publication cases                                                                                                                                                                                                                                          |
| Close does not dispose during an outer workflow operation, even with no ordinary prompt active                      | Add a real-file Runtime test to `close-awaits-operation.test.ts`: hold an external model/preparation boundary, request close, assert it remains pending and no close event/disposal occurs; release, assert committed evidence and lock release before `session_closed`, then reopen successfully                                                              |
| Cancellation does not permit same-Session overlap before settlement; other Sessions still run                       | Existing Runtime overlap/independent-session/cancellation tests; retain shell descendant termination and interaction cancellation                                                                                                                                                                                                                              |
| Dormant reads and sync do not create a writer; saved choices and history survive reload                             | `managed-read-non-mutation.test.ts`, Runtime projection/recovery/model tests, `cross-surface-workflow-invariants.integration.test.ts`                                                                                                                                                                                                                          |
| Queue behavior survives extraction and real managed settlement                                                      | Retain all steering/source/dequeue/transition cases in `session-runtime.test.js`; add real managed-turn cases for consumed steering/deferred follow-up and for cancellation before consumption, then close/reload; assert ordered transitions, exactly one delivery for consumed messages, no delivery for cleared messages, and no stale subscriptions/events |
| Execution rejects stale approval before successor creation; restart does not duplicate continuation                 | Supplement source-only `execution-segment-runtime.test.ts` with real Git/Plan/Session tests through Runtime: change approved Plan evidence and assert no successor/Engineer call; reload a committed continuation and assert the same successor and one seed, including after consumption                                                                      |
| Repair context survives compaction/reload; handoffs do not create another original user message                     | Existing Runtime blocked-repair test, execution handoff tests and cross-surface workflow tests; assert saved replay as well as live events                                                                                                                                                                                                                     |
| Named invocations use active-segment history and preserve root/workflow/model; images use the preflight model       | `named-invocation-active-segment.integration.test.ts`, Runtime image tests, `src/ui/named-invocation-cross-surface.integration.test.ts`                                                                                                                                                                                                                        |
| Model/backend changes retain rollback, cancellation and failure cleanup                                             | Existing Runtime model tests plus Claude/Agy execution and model-selection tests; retain the Agy Runtime permission-failure settlement/replay case                                                                                                                                                                                                             |

New tests must fail if close skips waiting, queued delivery is omitted/duplicated, or handoff dispatch is replaced with
a success stub. Use actual stored evidence, model-call counts, events and reopened state—not only returned `ok` values.
If a new characterization exposes an existing defect, report it separately; do not silently change product behavior or
remove the assertion under this refactor.

### Structural and type evidence

- A TypeScript structural test recursively inventories the Runtime implementation directory and entry point. After
  formatting, each is at most 999 physical lines; no old `.js` implementation remains. Check all new code files too.
- Keep actual prototype-policy and exact public-method checks. Verify consumers cannot import internals or access host,
  event emitters, operation capabilities or mutable queues. Update JS-only scanners so TypeScript cannot escape them.
- Semantic Review compares the before/after method-and-state inventory: each implementation has one named owner, calls
  reach that owner, and extracted modules contain real behavior. Reject a hidden monolith, shared mutable context bag,
  prototype patching, type erasure, compressed formatting, or forwarding bulk behavior into pre-existing JS files.
- `deno task check` must check all new implementation and test files. No config exclusions, ignore pragmas or weakened
  type policy may make the migration pass. No new injection seam is permitted.
- Verify PRD scenarios retain their meaning and ADR/source references describe the delivered structure. No glossary
  change is needed because no domain term or relationship changes.

### Commands

Run focused checks between extraction increments, then the full suite:

```sh
deno run -A scripts/run-tests.js src/shared/session
deno run -A scripts/run-tests.js src/shared/workflow/execution-segment-handoff.test.ts src/ui/named-invocation-cross-surface.integration.test.ts
deno task check
deno task language-policy:check
deno task seams:check
deno task doc-links:check
deno task lint
deno task test
```

Use the sandboxed test runner only, never raw `deno test`. Record baseline failures separately. Review the final diff
and formatted line counts. No visual redesign or browser-specific acceptance is required for this internal change.

## Edge Cases & Considerations

- **Two settlements:** turn completion and outer managed-operation completion are different. Cancellation requests do
  not make either complete. Preserve cleanup after success, error and cancellation.
- **Nested operations:** operation identity must remain Runtime-specific. A queued task or another Runtime must not
  inherit permission merely because a Session is busy.
- **Creation versus resume:** initial creation has its own transaction and deferred shell state. Resume must stay a
  read-only projection until mutation begins; neither path may bypass the common authority rules.
- **Types versus behavior:** do not make a synchronous method asynchronous just to simplify delegates. Do not cast CLI
  backends to Pi AgentSession or discard hidden Slicer/Pair root configuration.
- **Test blind spots:** several existing mutation/segment/close tests only inspect text. Keep narrow structural guards,
  but prove the important orderings through the real Runtime and filesystem.
- **Scope control:** unrelated existing JavaScript and large tests are not a conversion backlog for this Plan. All newly
  created code files and all extracted Runtime implementations must meet the requested format and size limits.
