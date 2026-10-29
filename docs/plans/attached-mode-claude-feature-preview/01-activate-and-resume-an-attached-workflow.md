---
planId: "1da830b9-9256-4d4b-a6c2-0cfd0b88c1de"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached/"
    - "src/cmd/attached/"
    - "src/attached/claude/"
    - "src/cmd/registry.js"
    - "src/shared/workflow/triage-outcome.ts"
    - "src/tools/triage-report.ts"
    - "src/shared/workflow/orchestrator.ts"
    - "docs/domain-language.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/adr/014-attached-workflow-coordination-boundary.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-07T03:22:45.484Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 1
dependencies:
    []
targetBranch: "epic/attached-mode-claude-feature-preview"
userVerifiedAt: null
status: "validated"
validatedCommit: "243afd4d031a74c2790ca8116c3ab0155f316153"
---

# Activate and resume an Attached Workflow

## Context

This is the first child of
[RunWield Connect for Claude Code: FEATURE Preview](../attached-mode-claude-feature-preview.md). Claude owns
conversations and model turns. RunWield needs a durable coordinator that does not create a HostedSession and does not
import a host transcript.

Owning PRD capabilities in `docs/prd/runwield-connect-prd.md`:

- [Explicit per-request activation](../../prd/runwield-connect-prd.md#explicit-per-request-activation) — this child
  delivers steps 1, 3, and 4 of activation: identify the Project root, bind one request to one Attached Workflow, and
  supply the Triage role contract. Host preflight and plugin install stay with child 02.
- [Lazy project setup and recovery](../../prd/runwield-connect-prd.md#lazy-project-setup-and-recovery) — this child
  delivers "continuation after process loss" for activation and Triage. It writes nothing to the repository, so the
  "preview material repo-local changes" scenario first applies in child 02.

[ADR-014](../../adr/014-attached-workflow-coordination-boundary.md) defines the coordinator as a sibling runtime to
`SessionRuntime`. Planning, review, execution, validation, and publication are later children.

Decisions from planning:

- **The Attached Workflow Record lives in the user's home, not in the repository.** Like a Session, it describes one
  host request. It is not Plan controller state, which ADR-017 places under `.wld/internal/`.
- **Any PLANNED_CHANGE continues.** All Work Kinds go on to planning. Every other Routing Intent closes the workflow
  with an "unsupported in this Preview" result, and Claude returns to ordinary behavior.
- **No Plan exists yet, so Plan ownership waits for child 02.** The controller registry is keyed by Plan identity. This
  child does not touch it.

### Epic Scope Changes

- `02-plan-one-feature-request-inside-claude-code` — now owns binding the Attached Workflow Record to Plan ownership
  through the controller registry, and the first repository write (`.wld/internal/` and the managed `.gitignore` block)
  with its setup preview. Both moved out of this child.

## Objective

A user explicitly starts one Attached Workflow. Core saves it, gives Claude a Triage action, and exits. A later, fresh
Core process accepts Claude's Triage result exactly once and reports the next step. Status and recovery work from saved
state only.

## Approach

Every operation is one short process: load the record, check it, make one change, save, exit.

```text
process A: wld attached activate  → new record, revision 1, pending action = triage → exit
process B: wld attached submit    → check action id + revision → accept outcome → revision 2 → exit
process C: wld attached submit    → same operation id → return the saved result, change nothing
process D: wld attached status    → read-only view of the record and the next action
```

One coordinator module owns the rules. The CLI and the MCP server are two thin carriers over it:

```text
src/cmd/attached/index.ts ──┐
                            ├──► src/shared/attached/coordinator.ts ──► record-store.ts
src/attached/claude/mcp.ts ─┘                    │
                                                 └──► src/shared/workflow/triage-outcome.ts
```

### Where the record lives

```text
~/.wld/attached/<encodeCwdForSessionDir(primary checkout root)>/workflows/<workflowId>.json
```

- The key uses the primary checkout root, so a linked Git worktree finds the same records.
- The record stores the canonical project root. If the folder moves, the key no longer matches, and `status` reports a
  recovery case. It never matches a record to another project silently.
- With no home directory, records fall back to the project internal root, the same rule ADR-017 uses for worktrees.
- A later Plan Store change migrates these records together with Sessions.

> [!NOTE]
> **Triage writes nothing to the repository**
>
> Activation and Triage must not call `enterProjectRuntime`. That call adds RunWield's managed `.gitignore` block, and
> that is a repository change the PRD says to preview. Child 02 does it at Plan submission.

### What the record holds

```ts
type AttachedWorkflowRecord = {
    workflowId: string;
    revision: number;
    projectRoot: string; // canonical binding evidence
    request: { text: string; hostRequestId: string };
    evidence: { host: string; hostVersion: string; adapterVersion: string; coreVersion: string };
    state: "triaging" | "awaiting_planning" | "closed";
    pendingAction: { actionId: string; role: "router"; contractVersion: string } | null;
    acceptedOperations: Record<string, AcceptedOperationResult>; // operationId → saved result
    triageOutcome: TriageOutcome | null;
    closure: { reason: "unsupported_in_preview"; routingIntent: string } | null;
};
```

It holds no transcript and no copy of Plan or worktree status. Child 02 adds a Plan reference.

### One Triage contract

Today the Triage rules exist twice, in `normalizeTriageParams` (`src/tools/triage-report.ts`) and
`normalizeTriageOutcome` (`src/shared/workflow/orchestrator.ts`). Both modules import Pi. This child moves the rules
into one Pi-free module that the Pi tool, the orchestrator, and the coordinator all use.

> [!TIP]
> **Why not a SessionRuntime adapter**
>
> A fake HostedSession would make the coordinator depend on the Pi runtime and let Session state become a second source
> of truth. ADR-014 rejects this.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/triage-outcome.ts` (new) — the one Pi-free Triage normalization rule.
- `src/tools/triage-report.ts`, `src/shared/workflow/orchestrator.ts` — use the shared rule instead of local copies.
- `src/shared/attached/` (new) — coordinator, record store with lock and atomic write, operation types.
- `src/cmd/attached/` (new) and `src/cmd/registry.js` — `wld attached activate|submit|status|mcp`, JSON output, lazy
  import.
- `src/attached/claude/` (new) — MCP stdio server that maps tools to coordinator operations. No workflow rules.
- `docs/domain-language.md` — Attached Workflow Coordinator and Attached Workflow Record.
- `docs/prd/runwield-connect-prd.md` — implemented-status notes for the delivered activation and continuation subset.
- `docs/adr/014-attached-workflow-coordination-boundary.md` — record location in home and why it is not ADR-017 runtime
  state.

Deliberately unchanged: `src/shared/workflow/controller-registry.ts` (no Plan exists yet), and
`src/shared/session/bridged-tools/` (it belongs to SessionRuntime).

## Reuse Opportunities

- `encodeCwdForSessionDir` (`src/shared/session/root-session.js`) — key encoding. Move it to a Pi-free shared module if
  importing `root-session.js` pulls Session modules into the Attached graph.
- `getHomeDir` (`src/constants.js`) — home resolution; never cache it.
- `atomicWrite` and the stale-write checks in `src/shared/workflow/controller-registry.ts` — the pattern for revision
  checks and atomic replace.
- `resolveProjectRoot` / primary-root resolution in `src/shared/project-runtime-layout.ts` — canonical and primary
  checkout roots, without entering the runtime.
- `normalizeRoutingIntent`, `normalizeWorkKind` (`src/constants.js`) and `sanitizeSessionName` — inputs to the shared
  Triage rule.
- `@modelcontextprotocol/sdk/server` and `/server/stdio` — already in `deno.json`.
- `src/cmd/wr/index.ts` — pattern for a subcommand family with JSON output.

## Implementation Steps

1. `src/shared/workflow/triage-outcome.ts` exports `normalizeTriageOutcome` and the `TriageOutcome` type. It imports
   nothing from `@earendil-works/*` or `src/shared/session/`. `src/tools/triage-report.ts` and
   `src/shared/workflow/orchestrator.ts` call it, and neither file still contains its own routing-intent,
   classification, or Work Kind normalization logic. Existing triage-report and orchestrator tests pass unchanged.
2. `src/shared/attached/record-store.ts` reads and writes Attached Workflow Records at the home path in Approach, with
   the no-home fallback. Writes take a per-workflow lock file, check the expected revision, write to a temporary file,
   and rename. A stale lock from a dead process is reclaimed automatically. A revision mismatch fails with a typed
   conflict result and leaves the file unchanged.
3. `src/shared/attached/coordinator.ts` exports `activate`, `submitOutcome`, and `readStatus`. Each takes a typed
   operation envelope: project root, workflow ID, host/adapter/Core evidence, operation ID, expected revision, and a
   bounded payload.
4. `activate` creates a record with a new `workflowId`, `state: "triaging"`, and a pending Triage action. The action
   names the Router role and a contract version. It returns the action ID and revision 1. It does not create
   `.wld/internal/` and does not change `.gitignore`.
5. `submitOutcome` accepts a Triage outcome only when the action ID matches the pending action, the expected revision
   matches, and the payload passes `normalizeTriageOutcome`. Otherwise it returns a typed rejection and leaves the
   record unchanged.
   - A PLANNED_CHANGE outcome of any Work Kind moves the record to `awaiting_planning` with next action `plan`.
   - Any other Routing Intent moves it to `closed` with `closure.reason: "unsupported_in_preview"`.
   - It never creates or submits a Plan.
6. Repeating an operation ID that was already accepted returns the saved result and makes no new change. A different
   operation against a superseded action or old revision is rejected.
7. Payloads over the size limit, payloads with unknown fields, and payloads with path-like or transcript-shaped fields
   are rejected. No record field stores host conversation text except the original request text.
8. `readStatus` returns the state, revision, next action or waiting reason, and recovery information. It writes nothing.
   When the stored `projectRoot` does not match the current canonical root, it reports a project-moved recovery case.
9. `wld attached activate|submit|status` print JSON from the coordinator. `wld attached mcp` starts an MCP stdio server
   in `src/attached/claude/` with one tool per operation. For the same input, CLI and MCP return the same result object.
   Neither carrier contains state checks of its own.
10. `src/cmd/registry.js` imports `src/cmd/attached/` lazily inside `execute`, the same way as `remote`.
11. An architecture test runs `deno info --json` on `src/cmd/attached/index.ts`, `src/shared/attached/coordinator.ts`,
    and the MCP server module. It fails if the transitive graph contains `@earendil-works/*`, `src/shared/session/`,
    `src/acp/`, or `src/ui/`. A second check fails if `src/attached/claude/` imports any domain module other than
    `src/shared/attached/`.
12. `docs/domain-language.md` defines **Attached Workflow Coordinator** and **Attached Workflow Record**, with avoided
    aliases and stable relationships: one record per Attached Workflow; the record references, and never copies, Plan
    and worktree truth; the record is not a Session.
13. ADR-014 states that Attached Workflow Records live under `~/.wld/attached/`, keyed like Sessions, and explains why
    they are not ADR-017 runtime state. The Connect PRD marks only activation binding, Triage handoff, and continuation
    after process loss as implemented for this subset. Plugin install, preflight, and setup preview stay target scope.

## Verification Plan

- Automated:
  `deno run -A scripts/run-tests.js src/shared/workflow/triage-outcome.test.ts src/shared/attached/
  src/cmd/attached/ src/attached/claude/`.
- Automated, multi-process: the test runs `wld attached activate` in subprocess A, `submit` in B, and the same `submit`
  in C, all against a sandboxed `HOME` and a real Git fixture (`defineGitFixture`). Expected: B advances to revision 2;
  C returns B's result and the file bytes are unchanged. This test fails against a stub that keeps state in memory.
- Automated, concurrency: two subprocesses submit different outcomes with the same expected revision. Expected: one
  succeeds, one gets a conflict, and the record holds exactly one outcome.
- Automated, rejection: wrong action ID, old revision, malformed outcome, oversized payload, transcript-shaped field,
  and a path-escape field each return a typed rejection with the record unchanged.
- Automated, routing: PLANNED_CHANGE with each Work Kind reaches `awaiting_planning`. INQUIRY, QUICK_FIX, and PROJECT
  each reach `closed` with `unsupported_in_preview`.
- Automated, no repository writes: after activate and submit in an uninitialized fixture, `git status --porcelain` is
  empty, and neither `.wld/` nor a `.gitignore` change exists.
- Automated, parity: the same activate/submit/status inputs through the CLI and through an MCP client connected to
  `wld attached mcp` give equal result objects.
- Automated, crash recovery: a leftover lock from a dead PID and a leftover temporary file do not block the next
  operation, and the record is still the last committed revision.
- Automated, project moved: renaming the fixture folder makes `status` report the project-moved recovery case.
- Automated, isolation: the architecture test in step 11 passes, and fails when a test-only import of
  `src/shared/session/hosted-session.js` is added to the coordinator.
- Protect existing behavior: `src/tools/triage-report` tests and orchestrator routing tests must still pass without
  edits. They prove the Pi tool and Native routing still normalize Triage the same way. No existing behavior stops.
- `deno task seams:check` passes with no new seams. Subprocess runs are real; no fake for the record store or lock.
- Docs: the glossary terms, ADR-014 note, and PRD status land in the same change, and the PRD does not claim plugin
  install, preflight, or setup preview as delivered.

## Edge Cases & Considerations

- The host request ID is binding evidence, not lifecycle authority. Rebinding never uses transcript matching.
- Host cancellation leaves the pending action in place. Shutdown never counts as acceptance, completion, or abandonment.
- A moved project folder orphans its records until Plan Store adds a stable project identity. The same limit applies to
  Sessions today. `status` reports it instead of guessing.
- `src/cmd/registry.js` imports TUI and Session modules at load time, so a `wld attached` process loads Pi code even
  though it never constructs a Session or calls a model. The isolation test checks the Attached module graph, not the
  whole `wld` binary. Assumption: this is acceptable for the Preview; a lighter entry point can come later.
- Capability evidence fields are recorded here. The tested Claude Compatibility Matrix belongs to child 02.
- Records accumulate under `~/.wld/attached/`. Assumption: closed-record cleanup is out of scope for this child.
