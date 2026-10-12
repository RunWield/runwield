---
planId: "f323ab7f-e2de-4d65-9beb-4cb29cb76c10"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/pages/"
    - "src/ui/workspace/routes/owner-api.js"
    - "src/ui/workspace/server/"
    - "src/ui/design-system/"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/design-system.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-09-21T19:28:55.399Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 9
dependencies:
    - "08-langfuse-exporter-package"
userVerifiedAt: null
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
---

# Workspace Export Settings and Delivery Status

## Context

Child 05 shipped `/usage` showing local measurements with coverage notes from the report. Children 06–08 made export
real. The owner now needs to see and control recording and export from the browser — including the effective local
recording-state indicator and the Settings affordance on `/usage` that this child adds.

The Epic bounds this surface deliberately: local collection state, installed exporter status, destination URL,
host-secret references, approved Projects, and delivery status. No extension marketplace and no browser package
installation. Secrets live in host configuration; if credentials are entered through the browser, they go through
authenticated same-origin mutation routes and the response returns only configured/not-configured state.

Owning PRD: the Workspace **Personal usage and outcomes** capability created in child 05 gains the export control and
delivery status requirements.
[Project access and navigation](../../prd/runwield-workspace-prd.md#project-access-and-navigation) keeps its rule that
only registered, enabled Projects are accessible.

## Objective

A settings surface where the owner can see whether local collection is on, whether an exporter is installed and
approved, what destination and Projects are approved, and what happened to each delivery — and can clear history or
revoke export, with the irreversible parts stated plainly.

## Approach

```text
/usage -> Settings
  local collection:  on / off            (state only, toggled through host settings)
  exporter:          not installed | installed unapproved | approved
  destination:       endpoint + external project + allowlist
  credentials:       configured / not configured     (never a value)
  delivery:          accepted | pending | unconfirmed | rejected   counts + reasons
  actions:           clear history | revoke export
```

Two controls must read as distinct, because they are:

```text
removing a Project in Workspace -> restricts browser access only
revoking a Project from export  -> changes the separate host export grant
```

Destructive actions state what cannot be undone: clearing does not erase previously exported Langfuse data, and
already-dispatched requests cannot be recalled.

Set aside: browser-side package installation. It would have made approval reachable from the phone and put
executable-code trust in a surface the Epic keeps out of the browser.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `src/ui/workspace/pages/` — the settings destination reached from `/usage`, following the child 05 page shape.
- `src/ui/workspace/routes/owner-api.js` — read routes for collection, exporter, destination, and delivery status, plus
  authenticated same-origin mutation routes for credential configuration, clear, and revoke.
- `src/ui/workspace/server/` — host-configuration access beside the existing owner data loaders; secrets are read as
  presence, never as values.
- `src/ui/design-system/` and React islands — status and notice patterns using `--rw-*` tokens; a new shared pattern
  lands in the shared layer and `docs/design-system.md` in this same change.
- `docs/prd/runwield-workspace-prd.md` — export control and delivery status requirements and scenarios under **Personal
  usage and outcomes**.

## Reuse Opportunities

- The child 05 `/usage` page, loader, owner route shape, and Project resolution.
- `ownerJson`, `ownerErrorJson`, `sanitizeOwnerError`, `sanitizeOwnerDiagnosticValue`, `scrubLocalPaths`
  (`routes/owner-api.js`) — existing response sanitization, which credential handling depends on.
- Core export status from child 07 — rendered as reported, with no browser-side recomputation of delivery state.
- Existing notices, confirmation dialogs, and `RunWieldPrimitives.tsx` patterns.

## Implementation Steps

- The settings surface is reachable from `/usage` and is owner-only.
- Local collection state displays as on or off and matches the effective host setting, including an explicit
  project-scope opt-out.
- Exporter status distinguishes not installed, installed but unapproved, and approved.
- Destination configuration shows endpoint and external project identity, with HTTPS enforced and an explicit local
  development exception surfaced as such.
- Approved Projects are listed, and a new Project is visibly not included by default.
- The owner can create, update, and revoke a destination grant and add or remove Projects. Each action calls child 07's
  Core grant functions (`metrics-export-grants.ts`); the browser computes no grant, start position, or eligibility.
- Credentials display only as configured or not configured; no secret value appears in a response payload, browser
  storage, rendered markup, log, or diagnostic.
- A credential entered through the browser goes through an authenticated same-origin mutation route that writes child
  07's Core credentials file (`~/.wld/metrics-export/credentials.json`, mode `0600`), never `settings.json`, and returns
  only configured/not-configured state.
- Delivery status comes from child 07's `readMetricsExportStatus()` and adds **Confirmed** to the states shown.
- Delivery status shows accepted, pending, unconfirmed, and rejected counts with their reasons, and unconfirmed is
  explained as an exporter status rather than a workflow failure.
- Browser Project removal is explained as restricting browser access only, distinctly from revoking a separate export
  grant.
- Clear history requires deliberate confirmation, states that it removes measurement history and pending payloads only,
  that Sessions, Plans, worktrees, and configuration survive, that previously exported Langfuse data is not erased, and
  that already-dispatched requests cannot be recalled.
- Revoke export requires deliberate confirmation and states that re-enabling begins a new export boundary rather than
  resuming old pending work.
- Empty, loading, and error states are present, readable, and accessible; the surface works on a compact desktop width
  and a phone viewport.
- Keyboard access and focus order are correct, and colors come from `--rw-*` semantic tokens through the theme bridge.
- Any new shared visual pattern exists in `src/ui/design-system/` and is documented in `docs/design-system.md` in this
  same change.
- `docs/prd/runwield-workspace-prd.md` names the export control and delivery status requirements with acceptance
  scenarios linking the Core measurement rules.

## Verification Plan

- Automated: `deno task workspace:test`, `deno task workspace:check`, `deno task workspace:build`, then `deno task ci`
  and `deno task doc-links:check`.
- Headed browser checks are mandatory. Run `deno task workspace:dev` and open `http://127.0.0.1:5173/usage`, then
  navigate to Settings.
- With no exporter installed, the surface shows not installed and no destination controls; install and leave unapproved,
  and status changes without any send becoming possible.
- Approve an exporter and configure a destination; status reflects each step and the approved Project list shows new
  Projects excluded by default.
- Enter a credential through the browser and confirm the response, rendered markup, browser storage, and server logs
  contain no secret value — only configured state.
- Trigger deliveries and confirm accepted, pending, unconfirmed, and rejected appear as Core reported them, with
  unconfirmed explained as an exporter status.
- Remove a Project from Workspace registration and confirm browser access stops while the export grant is visibly
  unchanged and separately revocable.
- Run clear history through its confirmation; verify Sessions, Plans, and configuration survive, measurement history is
  gone, and the irreversible-parts text was shown.
- Run revoke and confirm the new-boundary explanation appears and old pending work is not swept into a later grant.
- Resize to compact desktop and phone viewports; tab through the surface for focus order and announced states.
- Attempt the read and mutation routes unpaired and against a disabled Project; both are rejected.
- Existing protected behavior: child 05 `/usage` rendering, pairing, Project access, home and Session navigation, and
  design-system patterns all still pass. Expected to stop existing: nothing.

## Edge Cases & Considerations

- Destination outage, quotas, authentication errors, and ambiguous acceptance are normal states to display, not user
  chores in the Plan workflow.
- An unconfirmed item must never be presented as retryable-by-default or as a workflow failure.
- No “retry everything” affordance may appear; credential correction can resume only a proven non-accepted item.
- The remote Shared Space server is not this surface's host; the owner Workspace process is.
- A disabled or removed Project registration stops browser access but must not delete measurements or silently change a
  separate export grant.
- Assume the settings surface lives under `/usage` rather than a new top-level destination; Planner fixes the route.
