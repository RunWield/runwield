---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/plan-store.js"
    - "src/shared/workflow/planning-worktree.ts"
    - "src/ui/workspace/server/plan-adapter.js"
    - "src/ui/workspace/server/owner-dashboard.ts"
    - "src/ui/workspace/static/workspace-shell.ts"
    - "src/ui/workspace/static/workspace-styles/navigation.css"
    - "src/ui/design-system/"
    - "src/plan-store-passive-reads.test.ts"
    - "src/ui/workspace/workspace-passive-reads.test.ts"
    - "src/ui/workspace/workspace-shell-navigation.test.ts"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/design-system.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-10-31"
status: "draft"
---

# Keep the Workspace Sidebar Usable When a Plan Cannot Be Parsed

## Context

One malformed Plan currently removes every Plan in its Project from the Workspace sidebar. The user wants the list to
load and a warning icon beside the affected Plan. Hovering over the icon must explain the problem.

The exact reported error was reproduced through `readPlanResourceCatalog` in this checkout. The stack reaches
`readTargetBranchPlansByParent`, which parses every Markdown file before checking parent membership. The offending
source is `origin/epic/remote-ssh-development:docs/plans/archived/acp-chat-menus-for-commands.md`. Its flattened
`affectedPaths: - ...` field produces the reported `bad indentation of a mapping entry (5:16)` error.

The same archived Plan in the current checkout already has valid YAML. The immediate defect is that active target
scans parse archived files. Repair this scan; do not rewrite Git history or copy current lifecycle metadata into an old
branch snapshot.

There is also a general failure path. `collectPlans` records per-file errors, but `listPlansWithTargetChildren` throws
one error for the whole catalog. `loadOwnerSidebar` then returns an empty Plan list and a large Project diagnostic.
A malformed result during the second resource read is silently skipped.

### Product requirements

- **Change:** [Workspace Project access and navigation](../prd/runwield-workspace-prd.md#project-access-and-navigation),
  **Navigate without repeated startup work**: an individual Plan parse error leaves healthy navigation available and
  appears beside the affected Plan, with details on hover or focus.
- **Preserve:** [Local Plan management](../prd/runwield-workspace-prd.md#local-plan-management), **Browse without hidden
  Project changes**: keep healthy entries, respect document authority, and do not enable actions from incomplete reads.
- **Preserve:** [Core Plan authoring and external adoption](../prd/runwield-core-prd.md#plan-authoring-and-external-adoption),
  **Inspect Plans without preparing them**: passive reads do not repair files, assign IDs, fetch, or create runtime state.

No new Plan Status or domain term is introduced. This is display feedback, not a lifecycle transition.

## Objective

The reported archived-file error no longer breaks active Plan discovery. If an active document has malformed front
matter, Workspace keeps healthy Plans and Sessions visible and shows that document's name with a warning icon and a
useful tooltip. A later successful refresh removes the warning.

## Approach

Keep strict parsing. Isolate failures at the document boundary for display reads, not at the Project boundary.

```text
active Plan discovery
  exclude archive and existing non-Plan artifacts before parsing
  resolve local, target, and registered document authority
  return healthy documents + document diagnostics for display
    Workspace summary adapter
      sidebar: normal Plan rows + named warning rows
```

Use the existing catalog diagnostic channel. Add an explicit display-read policy through the existing reader pipeline;
strict behavior remains the default for other callers. `loadPlanSummaryCatalog` selects the display behavior. This
small policy split is needed because browsing must retain partial results while identity checks and workflow actions
must not treat an incomplete list as complete. Do not add a second filesystem scanner or a permissive YAML parser.

Keep malformed documents out of valid Plan resources. Diagnostics carry their canonical Plan name and safe parser
explanation. Use an existing trusted registry ID only when available; never extract an ID, status, or parent from
broken YAML. Target diagnostics retain enough internal source identity for authority handling and deduplication.

In the sidebar, render a compact warning row in the Plan area: document name, warning icon, and no invented lifecycle
status. Keep healthy Plan ordering and Session associations unchanged. Do not repeat a per-Plan parser dump as a
Project-level message. Project-wide access failures still use Project diagnostics.

Following the existing **Browse Plans** diagnostic link, warning rows link to the Project Plan Board, where the
diagnostic is also visible. They do not open a new malformed-document editor. The warning control exposes its tooltip on hover, keyboard focus,
and touch activation without navigating away. This adds no repair or execution action.

Reuse the current compact sidebar design and `--rw-warning` token. Add the minimal shared warning/tooltip presentation
in the design-system layer if no suitable current pattern exists. Keep long messages within the viewport and clear of
sidebar overflow clipping. Diagnostic text is text, never HTML.

The alternative—catching the Project error and returning an empty or stale list—would still hide the affected Plan or
misrepresent its current state. Automatically repairing YAML during a read would also violate passive-read behavior.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/workflow/planning-worktree.ts` — exclude archived/non-Plan paths before active target parsing and retain
  document-level failures for display discovery without weakening strict workflow enumeration.
- `src/plan-store.js` — carry typed parse diagnostics through display catalogs, including authoritative copies and the
  second resource read; retain strict listing, identity, and mutation behavior.
- `src/ui/workspace/server/plan-adapter.js` — select display-read behavior and serialize safe, named diagnostics.
- `src/ui/workspace/server/owner-dashboard.ts` — preserve warning identity in sidebar data without discarding healthy
  Plans or changing their Session associations.
- `src/ui/workspace/static/workspace-shell.ts` and `static/workspace-styles/navigation.css` — render warning rows,
  accessible tooltip interaction, and refresh cleanup without disrupting expansion, focus, or scrolling.
- `src/ui/design-system/` and `docs/design-system.md` — share and document the minimal warning/tooltip pattern using
  existing tokens and compact controls.
- Plan-store, target-reader, Workspace passive-read, and shell-navigation tests — prove isolation at real read and
  browser-render boundaries.
- `docs/prd/runwield-workspace-prd.md` — update the owning navigation requirement and acceptance scenarios; reference
  the existing passive-read contract rather than duplicate it.

Archive editing, generic automatic YAML repair, a new Plan editor, and unrelated sidebar redesign are out of scope.
Strict Plan detail/action lookup is unchanged: this work restores the list, not all operations in a Project that still
contains invalid metadata. No architecture decision or glossary definition changes.

## Reuse Opportunities

- `collectPlans`, `PlanParseIssue`, `PlanFrontMatterParseError`, and `parsePlanTextStrict` — use current strict parsing
  and file-level error information rather than reconstructing metadata from strings.
- Existing hidden-directory and Epic artifact rules — apply the same active-document eligibility to target scans.
- Catalog diagnostics and `RegisteredPlanDocumentUnavailableError` — preserve authoritative failure reporting and
  existing board diagnostic presentation.
- `loadOwnerSidebar`, `normalizeProject`, and sidebar reconciliation — extend the present payload and refresh path,
  not a second sidebar data source.
- `defineGitFixture`, the passive-read snapshot tests, and the shell test DOM — exercise real Git/filesystem readers
  and existing browser behavior without new injection seams.

## Implementation Steps

1. Active target scans in `readTargetBranchPlansByParent` and `readTargetChildren` exclude archived and existing
   non-Plan artifact paths before loading/parsing their contents. Both primary-target and Git-snapshot paths follow
   the same eligibility rule. A malformed archived file cannot prevent discovery of a healthy active child.
2. The display path through `listPlansWithTargetChildren` and `readPlanResourceCatalog` returns healthy documents plus
   typed, named parse diagnostics. It covers pending runtime access, local files, target snapshots, registered document
   worktrees, and malformed results during resource reload. Diagnostics are deduplicated after authority resolution;
   a broken authoritative document never exposes stale primary content. Uncertain parent membership is not invented.
3. Strict callers retain rejection behavior: `listPlans`, `listPlanResources` unless explicitly used for display,
   identity assignment/collision checks, selected loads, writes, and workflow child enumeration must not accept an
   incomplete catalog as valid. Duplicate-ID, identity mismatch, and runtime-access failures retain their existing
   handling. No read writes files, repairs metadata, assigns IDs, or fetches target data.
4. `loadPlanSummaryCatalog` uses the display path. Its diagnostics preserve a canonical name, diagnostic kind, and
   safe explanation with parser location when available. `loadOwnerSidebar` retains those fields for per-Plan warning
   rendering and keeps healthy Plans and Sessions. Absolute local paths and raw error objects do not reach the browser.
5. Sidebar rendering shows each malformed active document by name with a warning icon and explanatory tooltip. It
   does not require or manufacture a durable `planId`, reuse broken metadata as a status, or show the parser dump in
   the Project header. Warning rows remain visible when all documents are malformed; this is not an empty Project.
   Existing expansion and healthy ordering remain intact. Refresh updates or removes the warning, including after a
   correction or deletion, without duplicate rows or stranded tooltip nodes.
6. The warning control has an accessible name and description. Hover and keyboard focus reveal the same explanation;
   touch can expose it without following the row link. Escape dismisses it. Long names and multiline diagnostics do
   not widen the sidebar or clip the tooltip. Shared styles use semantic tokens and preserve existing focus treatment.
7. Regression tests prove the archived-file root cause and active-file isolation before and after the fix. The
   Workspace PRD navigation capability and design-system reference describe the delivered behavior in the same change.
   Existing pending-availability and unavailable-authority scenarios remain intact; no unimplemented repair is claimed.

## Approval Confirmation

No Work Records are proposed for supersession.

## Verification Plan

Use Bun 1.4.3. Run `bun run install:locked` before checks. Planning completed that install and reproduced the exact
catalog error; it did not run the implementation regression tests.

### Automated

Run the focused suites after adding the regressions:

```sh
bun scripts/run-tests.js src/plan-store.test.js src/plan-store-passive-reads.test.ts src/shared/workflow/planning-worktree.test.ts src/shared/workflow/planning-worktree-inspection.test.ts src/ui/workspace/workspace-passive-reads.test.ts src/ui/workspace/workspace-shell-navigation.test.ts src/ui/workspace/owner-dashboard-stream.test.ts
bun run workspace:check
```

- **Exact root cause:** a real Git fixture has an Epic, a healthy active child, and an unrelated archived Plan with the
  screenshot's flattened `affectedPaths` syntax. Include the locally cached remote-target path used by production and
  the primary-target path. The healthy child is returned, the archived Plan is absent, and no archive warning appears.
- **Partial display:** healthy plus malformed active files return healthy summaries and one named diagnostic through
  the real owner sidebar API. Cover local, target-only, and registered-worktree documents, and missing runtime
  preparation. Include an ID-less malformed file. Two distinct broken files produce two distinct warnings.
- **Authority and safety:** a malformed registered document suppresses its stale healthy primary copy. Existing
  strict malformed-listing, mutation rejection, duplicate-ID, and identity checks still pass. Snapshot Plan bytes,
  runtime files, ignore rules, refs, and worktrees before and after repeated reads; they remain unchanged.
- **Resource reload:** exercise a malformed result between collection and resource loading using existing external
  boundaries or a deterministic filesystem fixture, not a new owned-code injection seam. It produces a diagnostic
  rather than disappearing silently.
- **Rendered behavior:** feed the actual sidebar response into the shell test harness. Healthy Plan links retain
  their destinations and Session navigation works; only the named broken document has a warning. Hover/focus reveals its parser explanation. A payload
  containing HTML-like diagnostic text displays text and creates no executable markup. All-malformed input is not
  labeled “No active Plans.” A corrected refresh clears the warning; deleted files remove their rows.
- **Preserved navigation:** keep coverage for Show more, nested Sessions, active routes, expansion, focus restoration,
  pending/failed reads, and Project-wide failure notices. Only the all-or-nothing response to individual parse errors
  and parsing archived files in active scans are intended to stop.

The mixed healthy/malformed API test fails if errors are merely swallowed or the broken document is omitted. The
archived-target test fails if only sidebar rendering changes. The rendered warning test fails if the API changes
without the requested icon and tooltip.

### Headed browser

Start the worktree-owned server with `bun run workspace:dev` at `http://127.0.0.1:5173`. Use an isolated test Project
with healthy and malformed Plans and a Session; do not damage an owner's Plan to make a fixture. Use a named,
worktree-specific `agent-browser --headed` session.

1. Open the Project sidebar at desktop width. Confirm healthy Plan links retain their destinations, the Session
   opens, and the broken Plan shows its name and warning icon without a Project-wide parser dump.
2. Hover and keyboard-focus the warning. Confirm the explanation identifies the YAML problem and location. Dismiss
   with Escape. Check a long diagnostic near the bottom edge and a narrow sidebar for clipping or overflow.
3. At phone width, open the navigation drawer and tap the warning. Confirm the explanation is accessible without
   accidental navigation, and normal drawer scrolling still works.
4. Correct the fixture YAML, trigger the normal sidebar refresh, and confirm the warning disappears. Repeat with an
   all-malformed list and a Project-level load failure to distinguish those states.
5. Capture desktop and phone screenshots and check console/network failures. Confirm the owning PRD scenario matches
   this behavior and the shared warning pattern is documented.

## Edge Cases & Considerations

- **Historical corrupt file:** the primary copy of the reported archived ACP Plan is already valid. The fix must work
  against the old target snapshot without rewriting it, changing refs, or fetching.
- **No trustworthy metadata:** show the canonical file name and diagnostic, not a guessed status, parent, or Plan ID.
  The warning is not Plan Read Availability and does not authorize actions.
- **Multiple Epics inspect one target:** deduplicate the same source diagnostic, but retain distinct documents and
  honor registered document authority before choosing a warning or healthy row.
- **Read race:** re-read each time; do not cache a warning as permanent truth or use a previous healthy copy as authority.
- **Long parser output:** preserve the useful reason and line/column in the tooltip while keeping paths private and
  content escaped. Do not put the full error in ordinary sidebar flow.
- **Strict consumers:** display tolerance is explicit and bounded. Tests for rejection in identity and workflow paths
  must not be deleted to make partial-result tests pass.
