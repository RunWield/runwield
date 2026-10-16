---
planId: "8923c678-c0ac-477b-8129-a2473a51c3b9"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/workspace/server/"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/layouts/WorkspaceLayout.astro"
    - "src/ui/workspace/static/workspace-shell.ts"
    - "src/ui/design-system/"
    - "src/ui/workspace/routes/owner-api.js"
    - "src/ui/workspace/pages/"
    - "src/ui/workspace/components/"
    - "src/ui/workspace/islands/"
    - "src/ui/workspace/react/ArtifactReadSurface.tsx"
    - "src/shared/work-records/"
    - "src/shared/owner-coordination/"
    - "src/shared/session/"
    - "src/plan-store.js"
    - "docs/prd/runwield-workspace-prd.md"
    - "docs/design-system.md"
    - "docs/domain-language.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-09-03T00:54:21.444Z"
origin: "internal"
parentPlan: "personal-remote-workspace-v2"
order: 4
dependencies:
    - "03-plan-centered-workspace-home-and-navigation"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "3e0962cf00fb4a687ede869533992fc1b59e8d37"
---

# Unified Workspace Search and Artifact Reading

## Context

V2 needs one owner search path across durable Project knowledge and Session entry points. The old child draft still
promised Cymbal search and code-server, but the Epic now removes source-code search, Cymbal federation, code-server, and
another Code Surface from v2.

Search must be useful without becoming a second authority. The index can be rebuilt. Plans, Work Records, docs, and
Sessions remain canonical in their owning files and stores.

Scope comes from the [v2 Epic](../personal-remote-workspace-v2.md). On 2026-09-15, the owner confirmed that a persistent
per-Project search opt-out is deferred. V2 searches enabled registered Projects; Project and content-type filters narrow
the query, but do not change Project settings.

Owning requirements and proposed changes:

- [Workspace: Durable knowledge search](../../../prd/runwield-workspace-prd.md#durable-knowledge-search), **Retrieve
  eligible artifacts with scope and confidence visible** — add the unified v2 search journey, explicit source list,
  ranking, freshness, and Session entry points. Preserve Work Record confidence and notices. Mark opt-out, general
  research retrieval, full transcript search, and historical search filters as deferred rather than delivered.
- [Workspace: Browser Sessions](../../../prd/runwield-workspace-prd.md#browser-sessions), **Read Session artifacts
  comfortably on desktop and phone** — preserve loading feedback, one Workspace header, phone Contents controls, and
  Back to Session for existing Session readers. Search opens documents without a Session and returns to Search instead.
- Workspace: Human cross-Project code search and Main-checkout Code Surface — remove them from the
  personal v2 milestone, not from future product intent. Fix contradictory milestone and capability references.
- [Core: Work records](../../../prd/runwield-core-prd.md#work-records) — preserve current approved eligibility, source
  links, approval distinctions, and completion confidence. This slice does not change record lifecycle or Agent
  retrieval.

The file-authority boundary in [ADR-015](../../../adr/015-file-authoritative-session-bundles.md) remains unchanged. No
Session authority moves to the search store or owner coordination database.

## Objective

Provide one Spotlight-style quick search and one full search page that call the same service with the same query,
filters, order, and result model. Search covers Plans, PRDs, ADRs, current approved Work Records, each registered
Project's `../../../design-system.md` when present, applicable domain-language documents, Session Names, and the first user
message when present.

Every result names its Project and content type, rechecks canonical source evidence before display or navigation, and
opens the owning Plan, Session, Work Record, or read-only artifact destination.

## Approach

Use the Epic's separate, rebuildable SQLite FTS5 database. Re-read candidates from their canonical sources before
returning them. Keep the search database separate from owner coordination data.

Current Plan Board search uses client-side Fuse over card metadata; retain that local board filter. The new global
search uses one owner API and service for both quick search and the full page. `createOwnerWorkspaceApp` owns service
startup and cleanup; `startWorkspaceServer` must connect shutdown to that cleanup. Indexing starts in the background.

The existing artifact route requires a Session artifact registration. Add a Project-scoped read-only route for search
results instead of manufacturing a Session registration. Both routes use `ArtifactReadSurface`, with return navigation
suited to their source. A search result opens the existing Plan or Session route when available; Work Records and
supported documentation use the new type-aware reader.

```text
registered Project scope
  eligible source readers
  rebuildable FTS index
  query with Project/type filters and shared ranking
  canonical hydration, freshness check, and valid-result pagination
  existing Plan/Session route or Project artifact reader
  destination rechecks source before rendering
```

The option set aside is Cymbal/code-server search. It would add code indexing and browser IDE trust cost before v2 has
an actionable code workflow.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../src/ui/workspace/server`, `server.js`, and `routes/owner-api.js` — add one owner search API/service used by both
  views, manual refresh, per-Project freshness, type-aware readers, and authenticated destination routing. Own scanner
  startup, shutdown, and database closure here. Include `../../../../src/cmd/workspace/serve.ts` where needed so application cleanup
  completes before the caller closes the owner coordination store.
- `../../../../src/ui/workspace/layouts/WorkspaceLayout.astro` and `static/workspace-shell.ts` — add the global Search action and
  shortcut to the shared quick-search view. Child 03 deliberately leaves out Search; this child adds the working action
  within that shared shell, without duplicating navigation.
- `../../../../src/ui/workspace/pages`, `components/`, and `islands/` — add the centered quick-search surface, `Cmd+K` / `Ctrl+K`,
  visible Search action, filters, and full search page.
- `../../../../src/ui/workspace/react/ArtifactReadSurface.tsx` and `server/astro-owner-data.js` — add Project-level Work Record and
  documentation payloads, design-system/domain-language labels, and Search return navigation. Preserve Session artifact
  routes and standalone review behavior.
- `../../../../src/ui/design-system` — reuse semantic tokens, the theme bridge, React controls, and the shared dots loader; put any
  new reusable search interaction pattern here, not in copied page CSS.
- `../../../../src/shared/work-records` — reuse canonical Work Record hydration and include only current approved Work Records by
  default.
- `../../../../src/shared/owner-coordination` and a separate rebuildable Workspace search database — get registered Project scope
  without mixing index schema or state into registration, device, or operation receipt authority.
- `../../../../src/shared/session` — read cataloged Session Names and available first user messages without full Session Transcript
  search.
- `../../../../src/plan-store.js` — provide canonical Plan identity and authority-aware hydration for searchable current Plans.
- Canonical Plan, Work Record, Session, and artifact write completion paths — request refresh only after successful
  writes. Keep refresh failure independent from write success; the scanner also catches changes from other processes.
- `../../../../src/ui/workspace/personal-remote-workspace-v2.acceptance.test.ts` — add search integration coverage to this proposed
  Epic suite (it does not exist at planning time). Add focused store, route, and browser tests beside their owners.
- `../../../prd/runwield-workspace-prd.md` — synchronize the linked requirements and acceptance scenarios with the delivered
  search scope. Keep opted-out Projects and code search as deferred intent, not current v2 behavior.
- `../../../design-system.md` — document reusable quick-search or result-list patterns only if they are new.
- `../../../domain-language.md` — define implemented Workspace search language and its relationship to Project Knowledge
  Search and Session Transcript search.

Owner coordination registration and authentication remain unchanged; no search opt-out setting or schema migration is
needed there. Agent Project Knowledge Search, source-code tools, and local Plan Board filtering stay outside this slice.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `src/shared/work-records/search.js:readWorkRecordById`, `list.js:isCurrentWorkRecord`, and `store.js:listWorkRecords`
  — reuse eligibility and hydrated metadata, with explicit current-only access. The current ID reader defaults to all
  records, creates the directory during lookup, and selects the first duplicate ID. Extend or compose these readers so
  both enumeration and hydration are non-creating and reject ambiguous IDs. Preserve explicit historical CLI reads and
  Agent retrieval behavior. Do not turn the Mnemoteca adapter into a generic search service.
- `../../../../src/ui/workspace/react/ArtifactReadSurface.tsx` — extend the read-only document presentation instead of building
  separate viewers for each document type.
- `src/ui/workspace/server/owner-projects.js:requireOwnerProjectRoot` and `sessionBelongsToOwnerProject` — registered
  root checks and Session membership. Workspace Project IDs and Session catalog Project IDs are not interchangeable.
- `src/ui/workspace/server/plan-adapter.js:loadWorkspaceDetail` and
  `src/plan-store.js:listPlanResources/findPlanEvidenceById` — canonical identity and authoritative execution-worktree
  Plan selection. Avoid `loadPlanBodyById` as a generic reader: it is for editing and rejects Epics.
- `../../../../src/shared/session/session-transcript-manifest.ts` and `file-session-store.ts` — verified committed evidence and
  catalog identity. `server/session-continuation.js` supplies display-name conventions, but its raw JSONL reads and
  100-character first-message summary are not sufficient search evidence. Read the first message from verified saved
  evidence without indexing later messages or storing a second transcript. `projectAggregateTranscript` verifies saved
  entries; `summarizeResumableTranscript` can extract their full first user message. Do not use the continuation
  service's `timeline()` as a search reader: it can initialize generations and overlay unverified name data. Session
  enumeration must cover all catalog pages and avoid catalog writes; `listProjectSessions` defaults to writing and
  limits each page to 100 entries.
- `../../../../src/ui/design-system` — existing dialog, command, list, badge, and empty-state patterns.

## Implementation Steps

- Quick search and full search call one search service with the same query, filters, ranking model, pagination model,
  and result identity model.
- A visible global Search action and `Cmd+K` / `Ctrl+K` open a centered quick-search surface. It focuses the query,
  supports keyboard result selection and Enter navigation, traps focus while open, and restores focus on Escape.
  Project/type filters, Refresh, and View all results remain usable by touch. Use existing control and dialog patterns.
- View all results preserves query, order, filters, and result model on the full search page. Full-page URL state and
  return links preserve that search when a result is opened and the owner returns. Both views show loading, no matches,
  and Project-specific indexing/failure states without clearing the query. Older request responses cannot replace newer
  query results. Blank input shows a query prompt rather than an invented recent-history feature.
- Search indexes only the scoped sources named in the Epic: current Plans in the normal Plan store, PRDs from
  `../../../prd`, ADRs from `../../../adr`, current approved Work Records, `../../../design-system.md`, applicable domain-language
  documents, Session Names, and available first user messages. Include Epics, On-Hold Plans, and terminal Plans still in
  the normal store, with execution-worktree Plan authority where applicable. Session search uses the full available text
  of the first user message, not only its truncated display summary; later messages remain excluded. A named Session
  without a user message can match by name. A Session with neither a name nor a meaningful first user message is hidden.
  Enumeration covers all catalog pages without changing canonical Session evidence or registering new Sessions.
- Documentation readers follow `docs/domain-language-map.md` to the applicable context glossaries when present, or use
  `../../../domain-language.md` for a single context. Enumeration is limited to supported Markdown sources, not arbitrary
  links or files. All paths resolve inside the registered root; symlink escapes and traversal are rejected. General
  research files and the map itself are not added as separate searchable document types.
- Archived Plans, Markdown files without durable Plan IDs, Draft and Pending Verification Work Records, Superseded Work
  Records, Archived Work Records, Session messages after the first user message, arbitrary Markdown, tool output,
  reasoning, source code, and Plan-worktree code are absent.
- Ranking uses one flat order: exact document or Session Name matches first, then title and heading matches, then body
  and first-message matches; recency only breaks otherwise similar matches.
- Project and content-type filters apply before ranking and pagination.
- One canonical source contributes at most one result, ranked by its strongest matching field.
- Each result carries canonical Project ID, content type, source identity, source revision or fingerprint, freshness
  state, and browser-safe destination. Work Record results also retain their summary, source links, completion
  confidence, and applicable notices rather than presenting all completed work as equally verified.
- Query hydration rechecks Project eligibility, accepted path, identity, and current source evidence before display. A
  changed candidate is re-read and matched/ranked from current content, or withheld until refreshed; cached titles or
  snippets cannot pass as current evidence. Rejected candidates do not consume page slots or hide later valid matches.
  Destinations repeat the checks at open time, including after a Project is disabled or a document is replaced.
- Result identity is Project ID plus content type plus canonical source ID. For documentation without durable IDs, use
  its validated Project-relative path, not an index row ID; for Plans, Work Records, and Sessions use their durable IDs.
  Exact ranking ties have a stable identity-based order. Rebuilding the index does not change result identity. Browser
  payloads and error messages do not expose absolute paths or raw index content from ineligible Projects.
- The search database uses its own schema version and file separate from owner coordination; corrupt or newer-schema
  index state is quarantined and rebuilt asynchronously.
- Workspace startup and healthy Projects remain usable while indexing builds or one Project fails. Freshness follows
  observed source evidence, not elapsed time alone. Each Project failure identifies the failed reader without leaking
  local paths. Closing the server stops scans and releases the search database; repeated startup does not duplicate
  scans. Direct app users and tests close the app, not only its Session continuation service. Server shutdown awaits
  search cleanup before its caller closes the owner coordination store.
- RunWield-owned writes commit canonical state first and request best-effort incremental refresh after. Connect actual
  Plan write completion, Work Record generation/supersession, Session Name/first-message commits, and completed artifact
  writes rather than only browser routes. Where a writer runs in another process, use a bounded best-effort refresh
  request readable by the owner service; no durable delivery queue or dependency on a running Workspace is required. The
  background scan remains the fallback for missed requests and other filesystem edits.
- A bounded background scan detects eligible manual edits within a default interval of at most 30 seconds, and manual
  refresh forces an earlier scan.
- Work Record, PRD, ADR, design-system, and domain-language results open through type-aware canonical readers in the
  shared read-only artifact surface. No Plan parsing, identity assignment, Session creation, writer activation, or
  review exit request occurs to open these documents. Work Records show source links, confidence, and applicable
  notices. Project-level readers have one Workspace header and Back to Search; existing Session readers retain Back to
  Session. Reader payloads explicitly distinguish Project, Session, and standalone launches; a missing return query in a
  Project launch falls back to Search, never `/api/review/exit`. Project-reader return URLs accept only local Search
  destinations. Project payloads do not copy the existing absolute `imageBaseDir`. New document labels do not expand
  Session artifact registration types merely for display.
- Search and refresh routes use existing owner pairing and request protections; refresh changes only derived search
  data. No search or reader endpoint can send messages, approve Plans, or perform lifecycle actions.
- `../../../prd/runwield-workspace-prd.md` records the delivered v2 scope and matching acceptance scenarios. Opt-out, full
  transcript search, research retrieval, history filters, code search, and Code Surface remain explicitly deferred.
  Preserve the original requirement names and stable links; reconcile milestone references rather than deleting future
  capabilities or claiming the rest of v2 has shipped.
- `../../../design-system.md` records any reusable new quick-search or result-list pattern.
- `../../../domain-language.md` describes implemented Workspace search language, avoided aliases, and stable relationships
  to Project Knowledge Search, Work Records, Plans, and Session Transcript search. Describe owner-only Session entry
  lookup as part of Workspace search, not shared knowledge or cross-Session Agent retrieval. Keep the current glossary's
  transcript privacy rule and reconcile the PRD's broader proposed terminology only where this change makes it true.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

- Automated: run `deno task workspace:build` before destination integration tests. Search acceptance must assert
  successful rendering through the built Astro app; HTTP 503 or a missing build is a failure, not accepted evidence.
- Automated: create or extend `../../../../src/ui/workspace/personal-remote-workspace-v2.acceptance.test.ts`, then run
  `deno run -A scripts/run-tests.js src/ui/workspace/personal-remote-workspace-v2.acceptance.test.ts`. Use the
  production owner app, registered temporary Git Projects, canonical Plan/Work Record files, committed file-backed
  Sessions, and the real search database. Exercise API requests and returned destinations; mocked result arrays do not
  prove search. Use `defineGitFixture` / `makeValidationProjectRoot` and the sandboxed test runner. Add no injection
  seam for owned readers or writes. Tests that change HOME or cwd use `withProcessGlobalTestLock`.
- Automated: add adversarial ranking fixtures that prove exact names outrank heading matches, headings outrank body or
  first-message matches, and recency cannot outrank a stronger text match.
- Automated: seed more than one result page, including same-named artifacts in two Projects, several matching fields in
  one document, and an eligible filtered result below the unfiltered page cutoff. Assert exact result IDs/order,
  filter-before-limit behavior, no duplicate sources, stable ties, and quick/full search agreement. Place deleted and
  changed candidates before valid matches and prove they neither fill nor shorten the valid result page. Browser tests
  verify View all results carries the same query and filters and retains the same ordered result prefix.
- Automated: prove current Plans, Epics, On-Hold Plans, terminal Plans, current approved Work Records, PRDs, ADRs,
  design-system docs, single- and multi-context domain-language docs, Session Names, and first user messages are
  eligible. Give main-checkout and authoritative execution-worktree Plans different search text; only the authoritative
  version matches. Match a token beyond character 100 of a first user message and a Session beyond the first 100 catalog
  entries. Name-only Sessions remain searchable. Scan and query leave committed Session generations unchanged.
- Automated: give each excluded source unique text: Archived Plans; Draft, Pending Verification, Superseded, and
  Archived Work Records; Markdown without durable Plan IDs; later Session messages, tools, and reasoning; arbitrary
  Markdown; source code and Plan-worktree code. None matches. A Plan without an ID yields a repair diagnostic and its
  bytes stay unchanged after scans, queries, and failed opens. Duplicate Plan and Work Record IDs are diagnosed, not
  silently selected. A Project without a Work Record directory still has none after enumeration, hydration, or a failed
  open. An issued Work Record link refuses a record that became ineligible after indexing.
- Automated: corrupt the search database and use a newer schema version; prove quarantine and async rebuild do not block
  Project registration, Session reads, Plan reads, or Dashboard. Search reports rebuilding until results are available;
  a single failed Project does not suppress healthy Project results. Assert actual recovered results after rebuild, not
  just successful responses. Close and restart both the direct owner app and production HTTP server; prove old scan
  tasks and database handles are released before owner coordination closes.
- Automated: externally add, edit, and remove eligible documents with the owner server running. Prove automatic scan
  updates without query-triggered full scanning or manual refresh. Use a bounded wait within the configured interval;
  verify the default is at most 30 seconds. A manual refresh requests an earlier scan. Run representative production
  Plan, Work Record, Session Name/first-message, and artifact writers; prove refresh requests follow commits, and broken
  indexing cannot change write success. Restart and rebuild to verify stable identities and automatic catch-up.
- Automated: after indexing, replace content at the same path, remove its identity, disable its Project, and create
  symlink/traversal escapes. Check before the next scheduled refresh, with the database still holding the old
  fingerprint. Queries and already-issued destination URLs must recheck current sources. No stale snippet, cross-Project
  Session, raw local path, or outside-root file is returned. Test a committed Session prefix against an uncommitted
  appended name/message and a same-size source mutation; unverified text must not become searchable.
- Automated: open every supported result type through its real destination. Assert correct current Markdown, type,
  Project, and return link; Work Records retain confidence/notices. No Session or artifact registration is created.
  Denied pairing and invalid refresh request protection remain enforced. A Project reader without return state remains
  read-only and returns to Search without invoking standalone review exit. Reject external or non-Search return URLs;
  assert no absolute image directory in its payload. Preserve standalone Close and Session Back to Session behavior.
  These checks fail for a static result list or cache-only reader.
- Automated regression: run
  `deno run -A scripts/run-tests.js src/ui/workspace/owner-workspace.test.js
src/ui/workspace/workspace-board.test.js src/ui/workspace/workspace-lifecycle.test.js
src/ui/workspace/session-artifact-route.integration.test.ts src/ui/workspace/workspace-review.test.js
src/shared/work-records/work-records.test.js src/shared/session/session-transcript-manifest.test.js
src/shared/session/file-session-store.test.js src/plan-store.test.js`
  as one command. Then run `deno task workspace:check` and `deno task seams:check`; run `deno task ci` for final
  integration.
- Preserve regression coverage for pairing, request protection, registered roots, local board filtering, Plan lifecycle
  checks, current-only Work Record reads, committed Session evidence, unrelated-Session artifact rejection, standalone
  readers, and read-only Plan listing. No existing runtime behavior is intentionally removed in this slice; only the old
  v2 promises of code search and a Code Surface are retired from this milestone.
- Manual headed browser: run `deno task workspace:dev` at `http://127.0.0.1:5173`, with search/reader fixtures linked
  from `/dev`. At desktop and phone widths, open Search by button and shortcut, type, move through results by keyboard,
  apply both filters, and open View all results. Verify Escape/focus return, touch access, query preservation on Back,
  flat order, visible Project/type labels, loading/no-match/failure states, and no horizontal overflow with long names.
  Open each document type: one header, phone Contents closed initially, working Contents toggle, and Back to Search.
  Existing Session artifacts must still offer Back to Session. Check browser console and failed network requests.
- Manual real-server check: use two registered Projects with same-named Plans and artifacts of every supported type;
  mutate and remove indexed files externally and verify stale candidates cannot masquerade as current results.
- Expected result: the owner can find known project knowledge or a Session entry point from one search surface without
  browsing each Project and without adding code search or a Code Surface.
- Semantic Review: confirm the linked PRD requirements/scenarios, milestone references, and glossary agree with the
  delivered scope. Owner-only Session entry search must not be described as full transcript or Agent knowledge search.
  Opt-out and other deferred features must not be claimed as delivered. Confirm the service owns one ranking path and
  retains no Session/Plan authority; existing local board filtering remains separate.

## Edge Cases & Considerations

- A Plan without a durable Plan ID is not onboarded by a read. Search reports a repair diagnostic and leaves onboarding
  to deliberate repair.
- Search candidates are disposable. Path existence alone is never enough to display or navigate a result.
- One failed Project reports stale or unavailable search while healthy Projects continue.
- Design-system search means each registered Project's canonical `../../../design-system.md` when present.
- This slice must not add Cymbal search, code-server, Web Push, closed-tab notification delivery, collaborator policy,
  persistent per-Project search opt-out, or source-code handoff.
- Read-only documentation identity follows its accepted relative path. A rename can change that identity; it does not
  justify writing IDs into PRDs, ADRs, or glossaries. Typed readers must not accept arbitrary file paths from the
  browser.
- The exact search module/file names and page size are implementation choices. Use one bounded pagination model and the
  existing design system; do not add a provider plug-in layer or an external search service.
