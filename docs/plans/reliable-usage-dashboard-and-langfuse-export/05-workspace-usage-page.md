---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/pages/"
    - "src/ui/workspace/routes/owner-api.js"
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
createdAt: "2026-09-21T19:28:54.927Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 5
dependencies:
    - "04-core-usage-reporting-retention-and-clear"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
planId: "37973a15-e366-46b6-81f4-aeadd197c306"
---

# Workspace Usage Page

## Context

Core can now report usage, and there is no surface to see it. The parent Epic adds a Workspace-level **Usage**
destination, proposed route `/usage`, separate from the attention-first home. It must not replace home or Session
navigation.

Existing owner routes already enforce the access model this page needs: `requireOwnerProjectRoot` requires enabled
roots, and `sessionBelongsToOwnerProject` compares canonical roots because Workspace and Core Project IDs differ
(`src/ui/workspace/server/owner-projects.ts`, used throughout `server.js` and `routes/owner-session-api.js`).

Owning PRD: this change creates the Workspace **Personal usage and outcomes** capability in
`docs/prd/runwield-workspace-prd.md`, referencing Core measurement rules rather than restating them.
[Attention dashboard](../../prd/runwield-workspace-prd.md#attention-dashboard) keeps home's next-action role. The root
PRD capability ownership map gains the link.

## Objective

An owner-only `/usage` page showing active days, reported tokens, estimated cost, published changes, validation and
repair counts, ongoing and abandoned delivery, a daily trend, and per-Project and per-model breakdowns — with coverage
and exclusion notes adjacent to the numbers they qualify, and gaps that break the trend instead of drawing a misleading
zero.

## Approach

```text
browser -> /usage (Astro server-rendered)
             -> owner API resolves registered + enabled + available Projects
             -> Core reporting query(projectIds, period, hostTimeZone)
             -> render: summary tiles, coverage notice, trend, tables, links
```

The server resolves Project authorization first and passes identities to Core. Core never imports Workspace SQLite. A
disabled or removed registration stops browser access without deleting measurements.

The page shell mirrors the Epic's sketch: period presets and a date range, a Project filter, the host time zone and
recorded-through marker displayed, and a Settings affordance. Local recording state shows as on with export off; export
controls arrive in child 09.

Set aside: a client-side charting library. It would have shipped faster and added a dependency the Epic rejects, plus a
second place where day boundaries could disagree with the server.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `src/ui/workspace/pages/` — a new `usage` destination alongside the existing `plans/`, `projects/`, and `review/`
  pages.
- `src/ui/workspace/routes/owner-api.js` — an owner usage report route following the existing `ownerDashboardApi` /
  `ownerProjectBoardApi` shape and error sanitization.
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
- Unavailable or excluded Projects are identified without reading their files or including their totals.
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
- Local recording state displays as on with export off; no export control is present yet.
- Colors come from `--rw-*` semantic tokens through the theme bridge, with no hard-coded values.
- Any new shared visual pattern exists in `src/ui/design-system/` and is documented in `docs/design-system.md` in this
  same change.
- `docs/prd/runwield-workspace-prd.md` contains the **Personal usage and outcomes** capability with named observable
  requirements and acceptance scenarios that link Core measurement rules; `docs/prd/runwield.md` ownership map and links
  are updated.

## Verification Plan

- Automated: `deno task workspace:test`, `deno task workspace:check`, `deno task workspace:build`, then `deno task ci`
  and `deno task doc-links:check`.
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
- A large journal must still render promptly; the page relies on Core's incremental cache and must not rescan history
  per request.
- The remote Shared Space server is not this page's host; the owner Workspace process is.
- Assume `/usage` as the route and the Epic's sketch as the first-release layout; no custom query builder or
  charting-platform dependency.
