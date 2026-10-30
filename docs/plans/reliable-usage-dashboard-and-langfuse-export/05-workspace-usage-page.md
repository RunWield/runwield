---
planId: "37973a15-e366-46b6-81f4-aeadd197c306"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/pages/"
    - "src/ui/workspace/routes/owner-api.js"
    - "src/shared/workflow/usage-reporting.ts"
    - "src/ui/workspace/server/"
    - "src/ui/workspace/layouts/"
    - "src/ui/design-system/"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield.md"
    - "docs/design-system.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-10-08T21:01:48-04:00"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 5
dependencies:
    - "04-core-usage-reporting-retention-and-clear"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
userVerifiedAt: null
status: "validated"
validatedCommit: "b89551273312b4f1ac8b5d0c72db118f4075ed13"
---

# Workspace Usage Page

## Context

Core can now report usage, and there is no surface to see it. The parent Epic adds a Workspace-level **Usage**
destination, proposed route `/usage`, separate from the attention-first home. It must not replace home or Session
navigation.

Existing owner routes already enforce the access model this page needs: `requireOwnerProjectRoot` requires enabled
roots, and `sessionBelongsToOwnerProject` compares canonical roots because Workspace and Core Project IDs differ
(`src/ui/workspace/server/owner-projects.ts`, used throughout `server.js` and `routes/owner-session-api.js`).

Two identity domains meet on this page. Workspace Project IDs come from the registration store; Core's validated
`queryUsageReport` (`src/shared/workflow/usage-reporting.ts`, child 04) keys its per-Project reports and links by an
opaque journal identity — a hash of the journal directory name — not the Workspace Project ID. The owner route resolves
Workspace Projects to roots, passes roots to Core, and must correlate the returned identities back to Workspace Projects
for labels, the Project filter, and Session/Plan links. Core gains one small additive export for that mapping so the
identity rule stays in one module instead of being re-encoded in Workspace.

Recording state: the owner withdrew default-on recording on 2026-10-06; recording is opt-in and default-off. This page
shows coverage notes from the report itself — gap reasons already say which days recording was disabled or never
collected. The effective on/off state indicator and the Settings affordance land with child 09's settings surface, which
the Epic assigns that display.

Owning PRD: this change creates the Workspace **Personal usage and outcomes** capability in
`docs/prd/runwield-workspace-prd.md`, referencing Core measurement rules rather than restating them.
[Attention dashboard](../../prd/runwield-workspace-prd.md#attention-dashboard) keeps home's next-action role. The root
PRD capability ownership map gains the link.

### Epic Scope Changes

- `09-workspace-export-settings-and-delivery-status.md` — its Context claimed child 05 would show "local recording on
  and export off." Corrected: child 05 shows the report with coverage notes; the effective recording-state indicator,
  the Settings affordance, and the export controls all land in child 09.

## Objective

An owner-only `/usage` page showing active days, reported tokens, estimated cost, published changes, validation and
repair counts, ongoing and abandoned delivery, a daily trend, and per-Project and per-model breakdowns — with coverage
and exclusion notes adjacent to the numbers they qualify, and gaps that break the trend instead of drawing a misleading
zero.

## Approach

```text
browser -> /usage (Astro page shell + report island)
             -> GET /api/owner/usage?start&end&projectId?
             -> owner route: listOwnerProjects -> enabled + available Projects -> roots
             -> Core queryUsageReport(roots, period, hostTimeZone)
             -> route correlates Core identities back to Workspace Projects
             -> render: summary tiles, coverage notice, trend, tables, links
```

The server resolves Project authorization first and passes roots to Core. Core never imports Workspace SQLite. A
disabled or removed registration stops browser access without deleting measurements.

The report island fetches the owner API for the first render and every filter change — one data path, following the
`DeviceList` pattern (`pages/devices.astro`). The page shell mirrors the Epic's sketch: period presets and a date range,
a Project filter, and the host time zone and recorded-through marker displayed from the server result. Coverage notes
from the report are the only state the page claims; the recording-state indicator, Settings affordance, and export
controls arrive in child 09.

Set aside: a client-side charting library. It would have shipped faster and added a dependency the Epic rejects, plus a
second place where day boundaries could disagree with the server.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `src/ui/workspace/pages/` — a new `usage` destination alongside the existing `plans/`, `projects/`, and `review/`
  pages.
- `src/ui/workspace/routes/owner-api.js` — an owner usage report route following the existing `ownerDashboardApi` /
  `ownerProjectBoardApi` shape and error sanitization, including the Workspace-Project correlation and period validation
  (`invalid_usage_period` from Core surfaces as a sanitized error).
- `src/shared/workflow/usage-reporting.ts` — one small additive export mapping a root to its Core usage identity, so the
  owner route correlates without re-encoding the journal-path/identity rule; the validated child 04 query surface is
  otherwise unchanged.
- `src/ui/workspace/server/` — Project resolution reusing `listOwnerProjects` and `requireOwnerProjectRoot`, and a
  loader beside `astro-owner-data.js`.
- `src/ui/workspace/layouts/WorkspaceLayout.astro` and shell navigation — the new destination without disturbing home or
  Session navigation.
- React islands and `src/ui/design-system/` — trend and table rendering with `--rw-*` tokens; a new shared pattern, if
  one is genuinely needed, lands in the shared layer and `docs/design-system.md` in this same change.
- `docs/prd/runwield-workspace-prd.md` and `docs/prd/runwield.md` — new capability, scenarios, and ownership-map links.

## Reuse Opportunities

- `requireOwnerProjectRoot`, `sessionBelongsToOwnerProject`, `listOwnerProjects` — existing pairing and Project access
  control.
- `ownerJson`, `ownerErrorJson`, `sanitizeOwnerError`, `scrubLocalPaths` (`routes/owner-api.js`) — existing response
  sanitization.
- `WorkspaceLayout.astro`, existing loaders, notices, and `react/RunWieldPrimitives.tsx` — established visual patterns.
- `docs/design-system.md` and `src/ui/design-system/tokens.css`, `theme-bridge.ts` — semantic tokens instead of
  hard-coded colors.
- Existing integration test helpers in `src/ui/workspace/` (`workspace-test-helpers.js`, the `*.integration.test.ts`
  set).

## Implementation Steps

- `/usage` renders for a paired owner and is not reachable without pairing.
- The report covers only registered, enabled, available Projects; a crafted Project ID that is disabled, unregistered,
  or removed cannot be queried and cannot contribute totals.
- Unavailable or excluded Projects are identified without reading their files or including their totals; the queryable
  set comes from `serializeOwnerProject`'s `enabled` flag (lifecycle enabled and health available), not lifecycle alone.
- The owner route calls `queryUsageReport` once with the full authorized root set — no per-Project queries merged
  route-side, which would double-count aliased roots and re-encode Core's gap/dedup rules — and correlates the returned
  Core identities back to Workspace Project IDs through the exported Core helper; labels, the Project filter, and
  Session/Plan links use Workspace IDs, and two Workspace registrations aliasing one primary root (a worktree) are
  labeled without double-counting their shared totals.
- Session and Plan links use the existing authorized Workspace routes
  (`/projects/:projectId/sessions/:runwieldSessionId`, `/projects/:projectId/plans/:planId`); the engineer verifies the
  Core link ID domains (`managedSessionId`, `planId`) match those routes' ID domains before rendering a link.
- The host time zone and recorded-through marker are displayed and come from the server result, so phone and desktop
  show the same day boundaries.
- Summary figures show coverage and exclusion counts adjacent to the number they qualify.
- A gap breaks the daily trend; a known zero in a covered period draws a point. The two are visually distinguishable.
- Active operations appear as pending measurement, not final spend.
- Every trend has a readable table equivalent.
- Empty, loading, and error states are present, readable, and accessible.
- Links open existing authorized Session and Plan surfaces; a missing or deleted target leaves the measurement readable
  with no fabricated navigation.
- Sidebar, Session navigation, paired phone behavior, keyboard access, and compact desktop layout all still work.
- No recording on/off indicator, Settings affordance, or export control is present; coverage notes from the report are
  the only state the page claims. Child 09 adds the rest.
- Colors come from `--rw-*` semantic tokens through the theme bridge, with no hard-coded values.
- Any new shared visual pattern exists in `src/ui/design-system/` and is documented in `docs/design-system.md` in this
  same change.
- `docs/prd/runwield-workspace-prd.md` contains the **Personal usage and outcomes** capability with named observable
  requirements and acceptance scenarios that link Core measurement rules; `docs/prd/runwield.md` ownership map and links
  are updated.
- A focused integration test (proposed `src/ui/workspace/owner-usage-report.integration.test.ts`) exercises the owner
  usage route end to end with fixture journals: known token and cost totals come back exactly, a gap day is
  distinguishable from a covered zero day, a crafted disabled or unregistered Project ID is rejected and contributes no
  totals, and an unpaired request is refused.
- The same test registers two Workspace Projects aliasing one primary root (a worktree) with known usage in the shared
  journal and asserts the route returns the known totals exactly once with both registrations labeled; it also
  deep-equals the route's `totals`, `daily` (each day's `tokens` null-vs-number), `backends`, and `models` against a
  direct `queryUsageReport(allEnabledRoots, period, timeZone)` call on a two-Project fixture with mixed gap and covered
  days. A route that queries per Project and merges route-side fails both checks.
- A page-level check (the `workspace-surface-parity.test.ts` source-assert pattern or the integration test's rendered
  output) pins gap-vs-zero trend rendering and the absence of recording/export controls on the page.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/ui/workspace/owner-usage-report.integration.test.ts` — **totals
  fidelity:** a fixture journal with known token and cost totals and one gap day queried through the owner route returns
  exactly those totals with the gap day distinguishable from a covered zero day; a page or route returning placeholder
  or recomputed numbers fails this check. **Alias dedup:** two Workspace registrations aliasing one primary root return
  the shared journal's totals exactly once. **Aggregate parity:** the route's `totals`, `daily`, `backends`, and
  `models` deep-equal a direct `queryUsageReport` call over all enabled roots on a two-Project fixture with mixed gap
  and covered days; a route that queries per Project and merges route-side fails this check. Then
  `deno task workspace:test`, `deno task workspace:check`, `deno task workspace:build`, `deno task ci`, and
  `deno task doc-links:check`.
- Headed browser checks are mandatory. Run `deno task workspace:dev` and open `http://127.0.0.1:5173/usage`.
- With real registered Projects, one report shows correct period and backend totals with adjacent coverage notes.
- Change the period preset and a custom date range; totals and day boundaries update and stay consistent with the
  server-reported zone.
- Filter to one Project; excluded Projects contribute nothing and are named as excluded.
- Confirm a gap interval breaks the trend line while a covered zero-activity day draws a zero point.
- Resize to a compact desktop width and to a phone viewport; layout, navigation, and tables remain usable.
- Tab through the page: focus order is sensible, the table equivalents are reachable, and states are announced.
- Click a Session link and a Plan link; both open existing authorized surfaces. Remove or disable a target and confirm
  the measurement stays readable with no broken navigation.
- Attempt a crafted disabled/unregistered Project ID against the owner route; it is rejected and contributes no totals.
- Confirm home, Session navigation, and the sidebar are unchanged.
- Existing protected behavior: pairing, Project access, and current Workspace routes still pass. Expected to stop
  existing: nothing; this is additive.

## Edge Cases & Considerations

- Browser Project removal restricts browser access only. It does not delete measurements and does not change a separate
  export grant; child 09 must explain those controls distinctly.
- Legacy and partial records display only understood fields, labeled legacy/partial.
- Two Workspace registrations can alias one primary root (a worktree and its primary checkout). Core dedups them into
  one report; the page labels the shared report without implying two histories, and filtering to either registration
  queries the same journal.
- A large journal must still render promptly; the page relies on Core's incremental cache and must not rescan history
  per request.
- The remote Shared Space server is not this page's host; the owner Workspace process is.
- Assume `/usage` as the route and the Epic's sketch as the first-release layout; no custom query builder or
  charting-platform dependency.
