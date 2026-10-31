---
planId: "f323ab7f-e2de-4d65-9beb-4cb29cb76c10"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/pages/usage/"
    - "src/ui/workspace/pages/usage.astro"
    - "src/ui/workspace/layouts/"
    - "src/ui/workspace/react/UsageReport.tsx"
    - "src/ui/workspace/react/UsageSettings.tsx"
    - "src/ui/workspace/routes/owner-api.js"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/server/owner-usage.ts"
    - "src/ui/workspace/server/owner-usage-settings.ts"
    - "src/ui/workspace/pages/api/owner/[...segments].ts"
    - "src/ui/design-system/"
    - "src/shared/extensions/metrics-exporter.ts"
    - "packages/langfuse-exporter/package.json"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/user-documentation/settings.md"
    - "docs/user-documentation/workspace.md"
    - "docs/design-system.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-09-21T19:28:55.399Z"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 9
dependencies:
    - "08-langfuse-exporter-package"
userVerifiedAt: null
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
validatedCommit: "f26093a3792e0e70814f2c57eea2a09cced9fe20"
status: "verified"

archivedAt: "2026-10-30T03:46:23.660Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/reliable-usage-dashboard-and-langfuse-export/09-workspace-export-settings-and-delivery-status.md"
---

# Workspace Export Settings and Delivery Status

## Context

Child 05 shipped `/usage`, a read-only report. Children 06–08 made export real in Core, but **no owner can use it yet**:

- Export grants and credentials exist only as Core functions (`metrics-export-grants.ts`). Child 07 deliberately added
  no command-line setup.
- Clearing measurement history exists only as a Core function (`clearUsageHistory` in `usage-reporting.ts`). No user
  surface calls it.
- Local recording is **opt-in** (child 01 withdrew the Epic's default-on policy). The only way to turn it on is to edit
  `settings.json`.

This child adds the owner's browser surface for all three, plus a recording and delivery summary on `/usage`. It is the
only user-facing way to set up export.

```text
Core (owner of every fact)                      Workspace (this child)
src/shared/extensions/metrics-exporter.ts   ->  exporter state: not installed / unapproved / approved
src/shared/workflow/metrics-export-grants.ts ->  create, update, revoke grants; edit allowlist; write credentials
src/shared/workflow/metrics-export-scheduler.ts::readMetricsExportStatus -> delivery counts and codes
src/shared/workflow/usage-reporting.ts::clearUsageHistory -> clear history
src/shared/settings.js (workflowMetrics)    ->  effective recording state
```

### Owning requirements

- [Personal usage and outcomes](../../prd/runwield-workspace-prd.md#personal-usage-and-outcomes) — **change** "The page
  does not show a raw event list, recording controls, Settings controls, or export controls." **Add** requirements and
  scenarios for recording state, export settings, delivery status, clear, and revoke.
- [Core usage measurement and export](../../prd/runwield-core-prd.md#usage-measurement-and-export) — **change** the
  maturity note "browser export controls remain target behavior" and the line "Core functions manage Export grants" to
  name the Workspace settings surface. Core rules stay authoritative; Workspace links to them.
- [Project access and navigation](../../prd/runwield-workspace-prd.md#project-access-and-navigation) — **preserve**: only
  registered, enabled Projects are accessible, and removing a Project changes Workspace access only.

### Decisions carried from the Epic and siblings

- **Exporter approval stays on the host.** Approving executable code happens only through `wld install <source>`
  (child 06). The browser shows the state and tells the owner how to approve. No browser installation or approval.
- **Credentials are write-only.** They go through an authenticated same-origin route into child 07's Core credentials
  file (`~/.wld/metrics-export/credentials.json`, mode `0600`), never `settings.json`. Responses report only configured
  or not configured.
- **Status is rendered as Core reports it.** Workspace computes no grant, start position, eligibility, or delivery
  count.
- **Integration notes to close:** child 06 — map `listInstalledMetricsExporters` to the three states and never write
  `metricsExporterApprovals`; child 07 — call the four grant functions, show `readMetricsExportStatus` counts including
  confirmed, and update `settings.md`; child 05 — update `usage-rendering.test.ts`, use one server source for the
  `/usage` summary, and keep `/usage` readable after a clear.

## Objective

The paired owner can see whether recording is on, whether an exporter is installed and approved, where data goes, which
Projects are approved, and what happened to each delivery. The owner can set up and change export, enter credentials,
clear history, and revoke export. Every irreversible part is stated before the action.

## Approach

### Placement

**Decision (owner):** Report and Settings are peer views under **Report | Settings** underline tabs in the Workspace
header, the same pattern as Projects | Devices (`SettingsLayout.astro`, `docs/design-system.md#settings-and-devices`).

```text
header:  Usage   [ Report | Settings ]

/usage            Report tab (child 05 report, plus one status strip)
  Recording on · Export: Langfuse — 12 accepted, 3 pending, 1 delivery unconfirmed

/usage/settings   Settings tab
  Local recording      global toggle; per-Project effective state and where it is set
  Metrics exporters    not installed | installed, not approved (approve on host) | approved
  Destinations         endpoint, external project, credentials state, approved Projects, delivery status, Revoke
                       Add destination (only when an approved exporter exists)
  Clear history        choose Projects -> confirmation dialog
```

Each tab is its own URL, so a phone can open Settings directly and Back returns to the Report. Both tabs keep the
64rem content width used by Projects and Devices. The status strip keeps the recording and export state visible on the
Report without a second click.

> [!NOTE]
> **One tab layout, not a copy**
>
> The tabs reuse the `header-tabs` slot of `WorkspaceLayout.astro` and the `rw-underline-tabs` class. A small
> `UsageLayout.astro` (or a `SettingsLayout` variant) owns the two tab links and their `aria-current`, so the Report and
> Settings pages do not each repeat the tab markup.

### Local recording control

The page shows the effective state of each registered, enabled Project. The state comes from
`isWorkflowMetricsEnabled(getMergedCustomSetting("workflowMetrics", root))`. Each row also says where the value is set:
global, Project settings file, or default (off).

**Decision (owner):** the owner can turn recording on or off from the browser with one global toggle.

The global toggle writes only the global `workflowMetrics` value. A Project-scope value overrides it, so that row says
"Set in this Project's settings file" and the toggle does not change it. The browser never writes a Project's
`.wld/settings.json`, because that file lives in the repository.

Core records the collection boundary lazily at the next append (`metrics-journal.ts`). That is the existing behavior for
any settings edit, so the toggle needs no new Core code.

> [!NOTE]
> **Why a toggle is low risk**
>
> Recording is local-only and reversible. Without a toggle, most owners see an empty Usage page and must edit a
> settings file to fix it. Turning recording off never hides older measurements.

### Export setup and the credential form

The owner creates a destination by choosing an approved exporter, then entering the endpoint, the external project, the
Projects to approve, and the credentials. The server calls `grantMetricsExportDestination`, then
`setMetricsExportCredentials`.

**Decision (owner):** the exporter manifest declares its own credential fields. The exporter owns its credential shape,
so a later destination needs no Workspace change. Set aside: a Workspace field map keyed by exporter ID (Langfuse detail
leaks into Workspace) and generic key/value rows (the owner must know key names from a README).

The declaration grows one optional field. This touches child 06's reader and child 08's manifest; both siblings are
verified, so the change lands here.

```diff
 "wld": {
     "metricsExporter": {
         "contract": 1,
         "id": "langfuse",
-        "entry": "./exporter.ts"
+        "entry": "./exporter.ts",
+        "credentials": [
+            { "key": "publicKey", "label": "Public key", "secret": false },
+            { "key": "secretKey", "label": "Secret key", "secret": true }
+        ]
     }
 }
```

### Request path

```text
UsageSettings.tsx  (React island)
  fetch /api/owner/usage/settings            GET  -> settings view
  fetch /api/owner/usage/settings/...        POST -> one mutation, returns the new view
owner-api.js        thin handlers: pairing, CSRF, origin (existing middleware), JSON errors
owner-usage-settings.ts                       new server module, the only Workspace caller of export Core functions
  maps Workspace projectIds <-> canonical roots (requireOwnerProjectRoot)
  maps exporters to opaque exporterKey values
  calls Core; strips roots, sources, and secrets from every result
Core functions (unchanged except the optional credential declaration)
```

`/api/owner/usage` gains `recording` and `export` summary fields. `owner-usage.ts` builds them with the same
`owner-usage-settings.ts` functions, so `/usage` and `/usage/settings` cannot disagree.

### Identity rules at the browser boundary

- **Projects.** The browser sends Workspace `projectId` values. The server resolves each one with
  `requireOwnerProjectRoot` (registered and enabled). It never accepts a root path.
- **Unregistered grant Projects.** A grant can hold a root that Workspace does not know or has disabled. The view shows
  only a count ("2 approved Projects are not available in Workspace"). An allowlist edit from the browser keeps those
  roots: `newRoots = grantRootsNotResolvable ∪ selectedRegisteredRoots`.
- **Exporters.** The browser sees an opaque `exporterKey` (a hash of ID and source) plus ID and version. The server
  recomputes the key over `listInstalledMetricsExporters()` to find the source. Raw sources and installed paths never
  reach the browser.

```text
removing a Project in Workspace  -> stops browser access only; the export grant keeps its root
unchecking a Project in a grant   -> updateMetricsExportProjects; export of that Project stops
```

### Destructive actions

| Action                     | Core call                                        | The dialog states                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clear history              | `clearUsageHistory(roots)`                       | Removes measurement history and pending export payloads for the chosen Projects. Sessions, Plans, worktrees, and settings stay. Data already exported to the destination is not erased. A request already sent cannot be recalled. |
| Revoke destination         | `revokeMetricsExportDestination`                 | Stops new sends now. A request already sent cannot be recalled. Enabling export again starts a new boundary; pending items are not sent.                                                                                           |
| Change endpoint or project | `grantMetricsExportDestination` with the same ID | Starts a new export boundary. Items still pending under the old settings are not sent.                                                                                                                                             |

After each action the result is shown. When Core reports `deliveryInFlight: true`, the page says that one request was
already sent and cannot be recalled.

Confirmation uses a new shared `RunWieldDialog` built on the installed `@radix-ui/react-dialog`.
`docs/design-system.md#dialogs` already describes this primitive but has no source for it. Native `confirm()` cannot
hold a Project checklist or several paragraphs readably on a phone.

### Delivery status

Each destination shows Core's counts for pending, accepted, confirmed, delivery unconfirmed, and rejected, the latest
sanitized codes, and the last attempt time. Fixed text explains each state:

- **Delivery unconfirmed** — the destination may or may not have the item. RunWield does not resend it, so remote totals
  are not inflated. This is an export state, not a workflow failure.
- **Rejected** — when credentials were the cause, updating the credentials lets those items send again.

There is no "retry all" or "resend" control.

Set aside: browser-side package installation or approval. It would make code trust reachable from a phone, and the Epic
keeps that decision on the host.

## Expected Change Surface

This list is guidance, not an allowlist. Verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent —
the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or
the Verification Plan no longer proves the objective.

- `src/ui/workspace/server/owner-usage-settings.ts` (new) — the settings view and every mutation; the only Workspace
  module that calls export Core functions.
- `src/ui/workspace/routes/owner-api.js` and `src/ui/workspace/server.js` — the GET and POST routes and the
  `/usage/settings` page route, behind the existing owner middleware.
- `src/ui/workspace/server/owner-usage.ts` — adds the `recording` and `export` summary fields; handles a clear made by
  another process.
- `src/ui/workspace/pages/usage/settings.astro`, `src/ui/workspace/react/UsageSettings.tsx` (new), and
  `src/ui/workspace/pages/usage.astro` — the Settings tab, and the shared Report | Settings header tabs through one
  layout in `src/ui/workspace/layouts/`.
- `src/ui/workspace/react/UsageReport.tsx` and `src/ui/workspace/usage-rendering.test.ts` — the status strip and link;
  the test changes from "absent" to "present in the strip".
- `src/ui/workspace/pages/api/owner/[...segments].ts` and a dev fixture beside `dev-usage-fixture.ts` — in-memory
  settings data for `workspace:dev`, so pair checkpoints never touch the developer's real `~/.wld`.
- `src/ui/design-system/components/react/` and `components.css` — `RunWieldDialog` and any status pattern the page needs.
- `src/shared/extensions/metrics-exporter.ts` and `packages/langfuse-exporter/package.json` — optional credential field
  declaration.
- `docs/prd/runwield-workspace-prd.md`, `docs/prd/runwield-core-prd.md` — requirement and maturity updates.
- `docs/user-documentation/settings.md`, `docs/user-documentation/workspace.md`, `packages/langfuse-exporter/README.md` —
  remove "export is not available"; explain the settings page and credential fields.
- `docs/design-system.md` — Dialog source, and the Usage Report | Settings tabs and settings layout.

Deliberately unchanged: the scheduler, ledger, record builder, grant rules, and journal. `docs/domain-language.md` needs
no change; Export grant, Delivery unconfirmed, and the delivery states are already defined there.

## Reuse Opportunities

- `grantMetricsExportDestination`, `updateMetricsExportProjects`, `revokeMetricsExportDestination`,
  `setMetricsExportCredentials`, `clearMetricsExportCredentials`, `readMetricsExportGrants`
  (`metrics-export-grants.ts`) — all grant and credential writes.
- `readMetricsExportStatus` (`metrics-export-scheduler.ts`) — counts, codes, credential state, exporter approval.
- `listInstalledMetricsExporters` (`metrics-exporter.ts`) — the three exporter states.
- `clearUsageHistory` (`usage-reporting.ts`) — returns per-Project `persisted`, `reason`, and `deliveryInFlight`.
- `listOwnerProjects`, `requireOwnerProjectRoot` (`owner-projects.ts`) — Project authorization.
- `ownerJson`, `ownerErrorJson`, `sanitizeOwnerError`, `sanitizeOwnerDiagnosticValue` (`owner-api.js`) — response
  sanitization.
- `authenticateOwnerRequest` (`owner-auth.ts`) — pairing, origin, and CSRF for every POST.
- `withMetricsExportFixture` (`src/testing/metrics-export-fixture.ts`) and `pairedHeaders` in
  `owner-usage-report.integration.test.ts` — real exporter, real grants, local destination, paired requests.
- `SettingsLayout.astro` — the `header-tabs` slot and `rw-underline-tabs` pattern for Report | Settings.

## Implementation Steps

### Server

- `owner-usage-settings.ts` exports `loadUsageSettings(store)`, which returns: `recording` (global value and one row per
  registered, enabled Project with `projectId`, label, effective `enabled`, and `setBy` of `global`, `project`, or
  `default`); `exporters` (each with `exporterKey`, `id`, `version`, `state` of `installed_unapproved` or `approved`);
  and `destinations` (each with `destinationId`, exporter ID, `exporterApproved`, `endpoint`, `insecureLocalEndpoint`,
  `externalProject`, approved registered Projects as `projectId` and label, `unavailableProjectCount`,
  `credentials.configured`, credential fields, `counts`, `latestCodes`, `lastAttemptAt`).
- `destinations[].counts`, `latestCodes`, `lastAttemptAt`, and `credentials.configured` equal the matching
  `readMetricsExportStatus()` values exactly. No Workspace module counts ledger items or evaluates eligibility.
- No settings response contains a filesystem path, a package source, a credential value, or observation content. A test
  walks the whole JSON and fails on any value that matches the fixture HOME, Project root, package path, or secret.
- `exporterKey` resolves back to exactly one installed exporter. An unknown key, or a key for an unapproved exporter,
  returns 400 and writes nothing.
- Create calls `grantMetricsExportDestination` with the resolved exporter, endpoint, external project,
  `allowInsecureLocalEndpoint`, and the roots of the selected `projectId` values, then `setMetricsExportCredentials`
  when credentials are present. A new registered Project is never added unless the owner selects it.
- Endpoint and external-project updates call `grantMetricsExportDestination` with the existing `destinationId`. The
  response marks `newBoundary: true` when Core issued a new `grantId`.
- Allowlist updates call `updateMetricsExportProjects` with the selected registered roots plus every existing grant root
  that does not resolve to a registered, enabled Project.
- Credential updates accept only declared field keys, string values up to 4096 characters, with no CR or LF. They call
  `setMetricsExportCredentials` or `clearMetricsExportCredentials`. The response contains only `configured`.
- A malformed request body on any route returns a fixed message. The message never contains body text, because a JSON
  parse error can quote the secret.
- Revoke calls `revokeMetricsExportDestination` and returns `deliveryInFlight`.
- Clear requires `confirmed: true` and at least one `projectId`. It resolves each through `requireOwnerProjectRoot`,
  calls `clearUsageHistory`, and returns per-Project `cleared`, a readable reason for `lock_timeout`,
  `recovery_pending`, or `storage_failure`, and `deliveryInFlight`.
- The recording toggle writes only global `workflowMetrics`. It preserves other keys
  when the saved value is an object. It never writes Project-scope settings.
- When `remotePersonalResourcesActive()` is true, the settings view reports export as unavailable on this host and every
  mutation returns a readable 409.
- `owner-usage.ts` adds `recording` and `export` summary fields built from the same `owner-usage-settings.ts`
  functions. It retries the Core query once on `usage_history_changed` and turns `history_clear_pending` into a readable,
  retryable message instead of the raw code.
- `server.js` serves `GET /usage/settings`, `GET /api/owner/usage/settings`, and the POST routes under
  `/api/owner/usage/settings/` and `/api/owner/usage/clear`. All go through the existing owner middleware, so an
  unpaired request is refused and a POST without a valid CSRF header and origin is refused.

### Credential field declaration

- `readMetricsExporterDeclaration` accepts an optional `credentials` array of at most 8 entries. Each has a `key`
  matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`, a non-empty `label` of at most 64 characters, and a boolean `secret`. A
  malformed list makes the declaration invalid, the same as other malformed fields. `InstalledMetricsExporter` exposes
  `credentialFields`.
- Approval identity does not change: adding or editing `credentials` does not alter ID, source, installed path, or
  version matching.
- `packages/langfuse-exporter/package.json` declares `publicKey` (not secret) and `secretKey` (secret).
- An exporter with no declared fields shows "This exporter needs no credentials" and no credential form.

### Browser

- `/usage` and `/usage/settings` share **Report | Settings** underline tabs in the Workspace header, built from one
  layout that sets `aria-current="page"` on the active tab. The tabs use the existing `header-tabs` slot and
  `rw-underline-tabs` class; no second tab style exists.
- The Report tab shows a status strip with the recording state ("Recording on", "Recording off", or "Recording on for 1
  of 2 Projects") and one line per destination with its counts. The strip reads the same `/api/owner/usage` response as
  the report.
- The Settings tab renders the four sections in Approach. Each section has a readable loading, empty, and error state
  with Retry.
- Exporter states: none installed shows "No metrics exporter is installed" and how to install one with `wld install` on
  the host; installed but not approved shows the ID, version, and "Approve it on the host: run `wld install` for this
  package again"; approved enables **Add destination**.
- Credential inputs are never prefilled. Secret fields use `type="password"` and `autocomplete="new-password"`. After a
  save, the inputs are cleared and only "Configured" or "Not configured" shows. No credential reaches `localStorage`,
  `sessionStorage`, the URL, or rendered markup.
- An `http:` endpoint is accepted only with the "Local development endpoint" checkbox, and then shows a visible
  "Local development (HTTP)" badge. Core's rejection message appears unchanged for any other non-HTTPS endpoint.
- Each destination lists approved Projects as checkboxes over registered, enabled Projects. Unselected Projects read
  "Not exported". The unavailable count appears with the text "Removing or disabling a Project in Workspace does not
  change export approval".
- The delivery panel shows the five counts with the fixed explanations in Approach, the latest codes, and the last
  attempt time. No control resends or retries items.
- Clear, revoke, and endpoint or project changes open `RunWieldDialog` with the exact statements in the Approach table.
  The confirm button is the danger action. Results show `deliveryInFlight` when true.
- `RunWieldDialog` traps focus, returns focus to its trigger, closes on Escape unless a request is running, and is
  labeled by its title. It lives in `src/ui/design-system/components/react/` and is documented in
  `docs/design-system.md#dialogs`.
- All colors use `--rw-*` tokens. The page works at 390 px and compact desktop widths, and every control is reachable
  in a logical Tab order.
- The `workspace:dev` route serves the settings view and mutations from an in-memory fixture. It never reads or writes
  the developer's real global settings, credentials file, or `~/.wld/metrics-export/`.

### Documents

- `docs/prd/runwield-workspace-prd.md#personal-usage-and-outcomes` replaces the "does not show … recording controls,
  Settings controls, or export controls" sentence. It adds named requirements for recording state, export settings,
  write-only credentials, delivery status as Core reports it, and confirmed clear and revoke, each with acceptance
  scenarios that link to the Core rules.
- `docs/prd/runwield-core-prd.md#usage-measurement-and-export` says browser export controls are current and that
  Workspace usage settings manage Export grants and credentials through Core functions.
  `#metrics-exporter-approval` names the optional credential field declaration.
- `docs/user-documentation/settings.md` no longer says dashboards or export are unavailable or that "export delivery
  remains target behavior". It points to Usage settings for setup and documents the credential declaration in
  **Metrics exporter packages**. `docs/user-documentation/workspace.md` has a short Usage and Usage settings section.
- `packages/langfuse-exporter/README.md` tells the owner to set up the destination in Workspace Usage settings.
- `docs/design-system.md` documents `RunWieldDialog` with source, and the Usage Report | Settings tabs and settings
  layout under **Usage reports** and **Settings and devices**.

## Verification Plan

### Automated

```sh
bun scripts/run-tests.js src/ui/workspace/owner-usage-settings.integration.test.ts \
  src/ui/workspace/usage-settings-rendering.test.tsx src/ui/workspace/usage-rendering.test.ts \
  src/ui/workspace/owner-usage-report.integration.test.ts src/shared/extensions/metrics-exporter.test.ts
bun run workspace:test
bun run workspace:check
bun run workspace:build
bun run seams:check
bun run doc-links:check
```

`owner-usage-settings.integration.test.ts` (new) uses a real `createOwnerWorkspaceApp`, real paired cookies and CSRF
headers, `withMetricsExportFixture` for a real fixture exporter and local destination, and real Core files in the
runner's disposable HOME. It proves:

- **Exporter states:** not installed, installed but not approved, and approved each appear as that state. Create is
  refused for the first two, and `metricsExport` stays absent from global settings.
- **Grant through Core:** create with Project A writes a grant whose roots contain only A's canonical root. A Project
  registered afterwards is listed as "Not exported" and is absent from the grant.
- **Status equals Core:** after `runMetricsExportCycle` against endpoints that accept, accept then drop, and return 400,
  the settings counts, codes, and last attempt equal `readMetricsExportStatus()`, including one confirmed item and one
  unconfirmed item. A handler that computed its own counts fails this test.
- **Secrets stay write-only:** a credential `sk-SECRET-<uuid>` is saved. It appears in `credentials.json` (mode
  `0600`). It is absent from every response, from global `settings.json`, from captured server log output, and from the
  error returned for a malformed body that contains it.
- **Unavailable Projects are preserved:** disabling Project B in Workspace leaves B's root in the grant. The view shows
  `unavailableProjectCount: 1` and no path. A later allowlist edit for A keeps B's root.
- **Boundaries:** an endpoint change returns `newBoundary: true` and a new `grantId`. Old pending rows are not sent in
  the next cycle.
- **Revoke:** the grant is gone, `deliveryInFlight` is reported while the destination holds a request open, and the next
  cycle sends nothing.
- **Clear:** without `confirmed: true` it returns 400 and changes nothing. With it, the Project's report is empty, its
  Session and Plan files and settings remain, and `deliveryInFlight` is reported for an open request. `/api/owner/usage`
  returns 200 right after the clear.
- **Access:** unpaired GET and POST are refused; a POST without CSRF is refused; a disabled or unknown `projectId` in an
  allowlist or clear request returns 400 and writes nothing.
- **Endpoint policy:** non-loopback `http:` is refused; loopback `http:` with the local development flag is accepted and
  reported as `insecureLocalEndpoint: true`.
- **Recording toggle:** turning it on writes global `workflowMetrics`, and a following
  `recordWorkflowMetric` persists for a Project without an override. A Project with a Project-scope `false` shows
  `setBy: "project"` and stays off.
- **No path leak:** the JSON walk described in Implementation Steps passes for every GET and POST response.

`usage-settings-rendering.test.tsx` (new) renders `UsageSettings` against fixed views. It proves each exporter state, the
unconfirmed and Project-removal explanations, the dialog statements, empty secret inputs after save, and the absence of
any "Retry all" or "Resend" control.

`usage-rendering.test.ts` now asserts that "Recording on" and "Recording off" appear in the status strip and that the
Report and Settings tabs link to `/usage` and `/usage/settings` with `aria-current` on the active one. It still asserts
that "Recorded activity" and "Download" are absent.

`metrics-exporter.test.ts` proves that valid credential fields are exposed, malformed lists
invalidate the declaration, and approval identity ignores the field list.

### Headed browser checks (mandatory)

- **Design loop:** run `bun run workspace:dev`, open `http://127.0.0.1:5173/usage`, then select the **Settings** tab.
  Check each section, every exporter state the fixture offers, the dialogs, the status strip, and that the tab highlight
  and Back navigation match Projects | Devices. Open `/usage/settings` directly and confirm Settings is the active tab.
- **Real host:** with `HOME` set to a new temporary directory, run `bun src/cli.ts install <absolute path to
packages/langfuse-exporter>` and decline approval. Start `bun src/cli.ts workspace serve`, pair a browser, and
  register a Project.
    - Settings shows "installed, not approved" and offers no destination form.
    - Approve with `bun src/cli.ts install` again. Settings shows approved.
    - Add a destination at a loopback fake (for example the server in `packages/langfuse-exporter/test-fixture.ts`) with
      the local development flag. The badge appears, and the new Project is not exported until checked.
    - Enter credentials. DevTools Network responses, Application storage, and page source contain no secret.
    - Turn recording on, do work, and wait for a cycle. Counts appear, and an unconfirmed item shows its explanation.
    - Disable the Project in Workspace. Settings shows it as unavailable, and the grant is unchanged.
    - Clear history and revoke through their dialogs. The irreversible text is shown, Sessions and Plans remain, and
      `/usage` loads.
- Resize to 390 px and to a compact desktop width. Tab through every control, open and close each dialog with the
  keyboard, and confirm focus returns to the trigger.

### Protected behavior

- Child 05 report rendering, filters, links, and coverage notes; pairing; Project access; home and Session navigation;
  Project settings; existing design-system patterns.
- Child 06 approval rules: no Workspace code writes `metricsExporterApprovals`.
- Child 07 rules: the existing `metrics-export-*` tests pass with unchanged assertions.
- Expected to stop existing: only the child 05 assertion that recording state and Settings are absent from `/usage`.

### Documents

- The Workspace PRD scenarios match the integration test cases above. The Core PRD and `settings.md` no longer call
  browser export controls target behavior. Nothing claims a public package release or certified Langfuse Cloud support.

## Edge Cases & Considerations

- **Outages are normal states.** Destination outage, quotas, authentication errors, and ambiguous acceptance appear as
  delivery states and codes. They create no Plan workflow chore.
- **Unconfirmed is never retryable.** No control resends it. A credential change resumes only items Core rejected for
  correction.
- **Two hosts.** The TUI may run a cycle while Workspace shows status. Status is a snapshot; the page offers Refresh and
  does not poll.
- **Clear during a report.** A clear from another process can make one report request see `usage_history_changed`. The
  loader retries once; a crash-left `history_clear_pending` shows a readable message with Retry.
- **Endpoint change resets consent.** The dialog must appear before the write, not after, because Core issues the new
  boundary immediately.
- **Credentials without a grant.** Create writes the grant first. If the credential write then fails, the destination
  exists with "Not configured" and the error is shown; the owner can retry the credential save alone.
- **Remote personal resources.** Core refuses export configuration on a remote-backed host. The page says so instead of
  failing silently.
- **Assumption — one Refresh, no live stream.** Delivery status updates on page load, after each action, and on Refresh.
- **Assumption — codes shown as reported.** Latest codes appear as Core sanitized them, with a short label only for
  `process_lost` and deadline codes.
- **Assumption — clear scope.** Clear acts only on registered, enabled Projects the owner checks in the dialog. History
  for unregistered Projects cannot be cleared from the browser.
