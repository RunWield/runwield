---
planId: "8fb4ad2b-4dc7-41c2-9e8b-d384485eaa58"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/shared/session/session-transcript-manifest.ts"
    - "src/shared/session/session-export.ts"
    - "src/shared/session/runtime/reads.ts"
    - "src/shared/session/session-runtime.ts"
    - "src/shared/session/session-runtime-method-policy.ts"
    - "src/shared/session/session-transcript-projection.js"
    - "src/shared/session/root-session.js"
    - "src/ui/session-export/session-export-html.ts"
    - "src/cmd/export/index.ts"
    - "src/cmd/share/index.ts"
    - "src/cmd/registry.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
    - "docs/user-documentation/usage.md"
    - "docs/user-documentation/sessions.md"
    - "docs/user-facing-features.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-19"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
sessionName: "RunWield Session Export"
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
validatedCommit: "39549eeca4ecce28161940a316fa38a9f919c1be"
workRecord:
    status: "generated"
    recordId: "abf7b3ec-fcb3-4f22-bba6-c47b7cf089c8"
    path: "docs/work-records/2026-10-20-complete-session-export-and-gist-sharing.md"
    lastAttemptAt: "2026-10-20T23:45:54.469Z"
---

# Export and Share the Complete RunWield Session

## Context

`/export` and `/share` copy only the current Session Transcript Segment. A plan workflow moves the Session to new
segments (`planning`, then `execution`, then `semantic_repair`). After that, an export drops the conversation that
created the Plan.

Both commands call `SessionRuntime.exportSession` in `src/shared/session/runtime/reads.ts`. Both of its branches read
one segment:

```text
exportSession(sessionId, outputPath)
  managed and dormant -> readManagedCommittedProjection
                           entries = captureTranscriptEvidence(managed.transcriptPath)   # current segment only
                           exportProjectedTranscript(entries)                            # plain <pre> HTML or JSONL
  live Pi manager     -> manager.getBranch()                                             # current segment only
                           exportRootSessionToHtml | exportRootSessionToJsonl
```

The full ordered read already exists. `projectAggregateTranscript` in `src/shared/session/session-transcript-manifest.ts`
is the Aggregate Transcript Projection that the Workspace timeline uses. It checks every sealed segment against its seal
evidence and the current segment against the committed generation. It reads the raw entries of every segment, but it
returns only display events and discards the raw entries.

**What a complete Session export can contain:**

| Content                                                          | Stored where                            | In the export                                      |
| ---------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| Every segment's raw Pi and `runwield.*` entries                  | Segment JSONL files                     | Yes                                                |
| Session Name, identity, timestamps, artifacts, Plan Associations | Session Manifest                        | Yes                                                |
| Delegated Agent, validation, and AI review transcripts           | Memory only (`SessionManager.inMemory`) | No. Only their results as the parent recorded them |
| Background Task output logs                                      | Local task logs                         | No                                                 |

**PRD:** no current capability owns local `/export` or `/share`. This Plan adds a requirement to
[Session continuity](../prd/runwield-core-prd.md#session-continuity) in the Core PRD.

**Behavior that must stay the same:**

- the Workspace [Session snapshot sharing](../prd/runwield-workspace-prd.md#session-snapshot-sharing) capability stays
  undelivered and separate from Gist sharing;
- the Workspace [Session export](../prd/runwield-workspace-prd.md#session-export) browser download stays undelivered;
- an export never changes the transcript (`managed-read-non-mutation.test.ts`).

## Objective

`/export` and `/share` copy the complete committed Session, with all its segments in order and the Session Manifest
facts, in two formats that RunWield owns:

- **HTML:** one self-contained page with a header for each segment, messages, collapsible tool calls, collapsed
  thinking, and RunWield theme tokens.
- **JSON:** one lossless document that holds the raw entries of every segment.

`/share` uploads both files to one secret GitHub Gist. It shows the Gist URL and a `gistpreview.github.io` link that
displays the HTML.

Decisions from planning:

- **HTML:** a new RunWield-owned renderer built from the projection events. We do not use Pi's template.
- **JSON:** raw entries for each segment. `.jsonl` export is retired, and `/export x.jsonl` shows a message that points
  to `.json`.
- **Share:** both files in one Gist, with the Gist URL and a gistpreview link.

## Approach

Core reads the Session one time and returns data. Consumers render and write files. ADR-010 does not let
`src/shared/session/` import `src/ui/`, so the HTML renderer lives under `src/ui/`.

```text
/export, /share  (src/cmd)
  runtime.readSessionExport(sessionId)                     # new public read-only Runtime method
    readVerifiedTranscriptSegments(manifest, generation)   # NEW: one verified read of every segment
    projectSegmentReplayEvents(verified)                   # the replay-event fold, moved out of projectAggregateTranscript
    -> { document: SessionExportDocument, timeline: SessionRuntimeEvent[] }
  .json  -> JSON.stringify(document, null, 2)
  .html  -> renderSessionExportHtml({ document, timeline })   # src/ui/session-export
  .jsonl -> refuse; point to .json
```

**1. One verified read for projection and export.** `projectAggregateTranscript` is split into two parts:

- `readVerifiedTranscriptSegments` keeps the ordering, sealed-segment, and committed-generation checks. It returns each
  segment's metadata and raw entries.
- `projectSegmentReplayEvents` creates the replay events. It keeps the `agentProjectionState` that carries across
  segments.

`projectAggregateTranscript` then calls both and applies its paging as it does today. The export calls the same two
functions without paging. The two operate on one pinned read, so the document and the timeline always describe the
same generation.

> [!TIP]
> **One owner for segment verification**
>
> If export had its own reader, the seal and generation checks would exist in two places. The split keeps one verified
> reader that the Workspace timeline and the export both use.

**2. The export data shape** (`src/shared/session/session-export.ts`):

```ts
type SessionExportSegment = {
    ordinal: number;
    kind: "planning" | "execution" | "semantic_repair" | "session";
    label: string; // "Planning segment 1"
    piSessionId: string;
    sealed: boolean;
    current: boolean;
    entries: TranscriptEntry[]; // raw JSONL lines, including the Pi "session" header line
};

type SessionExportDocument = {
    format: "runwield.session-export";
    version: 1;
    exportedAt: string;
    session: {
        runwieldSessionId: string | null;
        name: string | null;
        cwd: string;
        createdAt: string | null;
        updatedAt: string | null;
    };
    artifacts: SessionArtifactReference[];
    planAssociations: ManifestPlanAssociation[];
    segments: SessionExportSegment[];
};

type SessionExport = { document: SessionExportDocument; timeline: SessionRuntimeEvent[] };
```

The `timeline` is only for rendering, and the JSON file does not include it. The JSON file holds the raw entries, so a
reader can rebuild the timeline from them.

**3. The HTML renderer** (`src/ui/session-export/session-export-html.ts`) builds the page from `timeline` and
`document`:

```text
<header>  Session Name, ID, project path, created/updated, exported at
<nav>     artifacts and Plan Associations
for each segment (from event.segmentOrdinal / segmentKind):
  <section> "Planning segment 1" / "Execution segment 2" / "Semantic Repair segment 3"
    user message          -> escaped text
    assistant text deltas -> combined per message, Markdown through `marked` with raw HTML escaped
    thinking              -> <details> (closed)
    tool start + end      -> <details> with the tool header, arguments, and result
    system status / error -> one-line notice
```

Styles come from `renderRunWieldThemeCss()` (`src/ui/design-system/theme-bridge.ts`) and a small inline stylesheet
that uses only `--rw-*` tokens. The page loads no external scripts, stylesheets, or fonts.

> [!WARNING]
> **Transcript text is untrusted**
>
> Through gistpreview, the shared page runs in a browser. All transcript text, tool arguments, and tool results must
> be escaped. The Markdown renderer must not pass raw HTML through. A `<script>` in a user message or tool result must
> appear as text.

The renderer has its own small grouping of events. We set aside `reduceSessionEvents`
(`src/ui/workspace/components/SessionTimeline.jsx`) for this purpose. It is a Workspace React module with interaction,
busy, and review state, so importing it would pull React into the CLI. This duplication is acceptable because the
export folds only five event kinds and stays read-only.

**4. Commands.**

- `/export [path]`:
    - with no path, it writes `session-<iso>.html` in the project root, as today;
    - `.json` writes the document;
    - `.jsonl` fails with a message that points to `.json`;
    - every other path writes HTML.
- `/share` writes `runwield-session.html` and `runwield-session.json` in a private temporary directory. It then runs
  `gh gist create --public=false --desc "<Session Name> — RunWield Session" <html> <json>` and removes the directory
  afterwards. It reports the Gist URL and `https://gistpreview.github.io/?<gist-id>/runwield-session.html`.

**5. Sessions with no Session Manifest.** A Session that is not yet managed (for example, one with no submitted message)
exports one segment of kind `session`. That segment holds the live branch, and the timeline is built with the same
replay fold. Because of this, `/export` and `/share` never fail only because a Session is new.

**6. Retired code.** `exportSession`, `exportProjectedTranscript`, `exportRootSessionToHtml`, and
`exportRootSessionToJsonl` have no other callers. They are removed.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/session-transcript-manifest.ts`: split the verified segment read and the replay-event fold out of
  `projectAggregateTranscript`, without a change to its result.
- `src/shared/session/session-export.ts` (new): the export types, and a builder that assembles the document from
  verified segments and Session Manifest facts.
- `src/shared/session/runtime/reads.ts`: replace `exportSession` with `readSessionExport` (managed path and unmanaged
  fallback).
- `src/shared/session/session-runtime.ts` and `session-runtime-method-policy.ts`: make `readSessionExport` public as
  `read_only`, and remove `exportSession`.
- `src/shared/session/architecture-boundary.test.ts`: update the public Runtime method inventory.
- `src/shared/session/session-transcript-projection.js` and `root-session.js`: remove the retired exporters.
- `src/ui/session-export/session-export-html.ts` (new): the self-contained HTML renderer.
- `src/cmd/export/index.ts` and `src/cmd/share/index.ts`: choose the format, write the files, and upload to the Gist.
- `src/cmd/registry.js`: update the descriptions, usage, and notes for `/export` and `/share`.
- Tests: `src/cmd/export/index.test.js`, `src/cmd/share/index.test.ts`,
  `src/shared/session/managed-read-non-mutation.test.ts`, `src/ui/tui/document-link-lifecycle.test.ts`, the new tests
  below, and `scripts/bun-test-files.json` if the inventory needs the new files.
- `docs/prd/runwield-core-prd.md`: add the export and share requirement and its scenarios.
- `docs/domain-language.md`: add the **Session Export** term.
- `docs/user-documentation/usage.md`, `docs/user-documentation/sessions.md`, and `docs/user-facing-features.md`: change
  "HTML or JSONL" to "HTML or JSON", and describe the complete-Session and Gist preview behavior.

Not touched: Workspace routes and UI. The browser download stays undelivered. Delegated Agent and validation
persistence is also out of scope.

## Reuse Opportunities

- `src/shared/session/session-transcript-manifest.ts`: `requireOrderedManifest`, `verifySealedSegment`,
  `verifyCurrentSegment`, `normalizeSegmentKind`, and `segmentLabel` stay the single verification and labeling owners.
- `src/shared/session/session-transcript-projection.js`: `createReplayEvents` and `captureTranscriptEvidence`.
- `src/shared/session/file-session-store.ts`: `listSessionTranscriptSegments`, `listSessionArtifacts`,
  `listSessionPlanAssociations`, `getSessionById`, and `inspectSessionActivation` (the committed generation).
- `src/shared/session/runtime/reads.ts`: `readManagedCommittedProjection` shows the existing pattern: pin the
  generation, list the segments, and map failures through `toProjectionFailure`.
- `src/ui/design-system/theme-bridge.ts`: `renderRunWieldThemeCss`.
- `marked` (already a dependency, used in `src/shared/workflow/plan-review-actions.ts`).
- `src/shared/session/segment-rollover.test.js`: the test "segment rollover keeps aggregate projection readable" shows
  how to build a real multi-segment Session for tests.
- `src/cmd/testing/runtime-command-fixture.ts` and the fake `GitHubCliPort` in `src/cmd/share/index.test.ts`.

## Implementation Steps

1. `src/shared/session/session-transcript-manifest.ts` exports `readVerifiedTranscriptSegments(options)` and
   `projectSegmentReplayEvents(verified, options)`:
    - `readVerifiedTranscriptSegments` returns, for each segment in ordinal order, its `segmentId`, `ordinal`,
      normalized `kind`, `label`, `piSessionId`, `sealed`, `current`, and raw `entries`. It applies the existing
      sealed-segment and committed-generation checks and throws on any mismatch.
    - `projectAggregateTranscript` gets its events and snapshot only through these two functions. Its result shape,
      paging, `latest`/`beforeEventId` behavior, and cursor-reset behavior do not change.
2. `src/shared/session/session-export.ts` exports the types `SessionExportDocument`, `SessionExportSegment`, and
   `SessionExport`, and a builder that produces a document from verified segments and Session Manifest facts:
    - `format` is `"runwield.session-export"` and `version` is `1`;
    - `segments[i].entries` is exactly the verified raw entries of segment `i`.
3. `SessionRuntime.readSessionExport(sessionId)` exists and is classified `read_only` in
   `session-runtime-method-policy.ts`. `exportSession` no longer exists on `SessionRuntime`, in `runtime/reads.ts`, or in
   the architecture-boundary inventory.
    - For a managed Session, the method reads the committed generation one time, reads every segment through
      `readVerifiedTranscriptSegments`, and builds `timeline` from the same verified segments. It fills `session`,
      `artifacts`, and `planAssociations` from the Session Store.
    - For a Session with no managed metadata, the method returns one `session` segment that holds the live branch, and a
      timeline from `createReplayEvents`.
    - The method never opens a writable Pi manager or writes to a transcript or manifest.
4. `exportProjectedTranscript` (`session-transcript-projection.js`), `exportRootSessionToHtml`, and
   `exportRootSessionToJsonl` (`root-session.js`) are removed. No source file references them.
5. `src/ui/session-export/session-export-html.ts` exports `renderSessionExportHtml(exported: SessionExport): string`.
   The page it returns:
    - shows the Session Name, ID, project path, and timestamps;
    - lists the artifacts and Plan Associations;
    - has one section per segment, in ordinal order, with the segment label as its heading;
    - shows user messages and combined assistant Markdown;
    - puts each completed tool call in a `<details>` element with its tool header, arguments, and result;
    - puts thinking in a closed `<details>` element;
    - includes `renderRunWieldThemeCss()` output and only `--rw-*` token colors;
    - has no `<script src>`, `<link rel="stylesheet">`, or other external resource;
    - escapes all transcript-derived text, including Markdown output, so that raw HTML in a message, argument, or result
      appears as text.
6. `runExportCommand` (`src/cmd/export/index.ts`) uses `readSessionExport`:
    - with no path, it writes HTML to `session-<iso>.html` in the project root;
    - a `.json` path receives `JSON.stringify(document, null, 2)`;
    - any other non-`.jsonl` path receives HTML;
    - a `.jsonl` path returns `"failed"`, writes no file, and shows a message that names `.json` as the replacement;
    - missing parent directories are created;
    - the editor reset in `finally` stays.
7. `runShareCommand` (`src/cmd/share/index.ts`) does the following:
    - it keeps the `gh --version` and `gh auth status` preflight and its messages;
    - it writes `runwield-session.html` and `runwield-session.json` in a new private temporary directory (mode `0o700`);
    - it runs `gh gist create --public=false --desc "<Session Name or 'RunWield Session'> — RunWield Session"` with both
      paths;
    - on success it reports the Gist URL and `https://gistpreview.github.io/?<gist-id>/runwield-session.html`, where
      `<gist-id>` is the last path part of the URL;
    - it removes the temporary directory after success and after failure.
8. In `src/cmd/registry.js`, the `/export` and `/share` entries describe the complete-Session HTML/JSON export and the
   two-file Gist with the preview link. `/export` usage lists `/export`, `/export output.html`, and
   `/export output.json`, and does not list `.jsonl`.
9. `docs/prd/runwield-core-prd.md` [Session continuity](../prd/runwield-core-prd.md#session-continuity) has a
   requirement, **Export or share the complete Session**, with acceptance scenarios that match the delivered behavior:
    - every segment in order, plus the Session Manifest facts;
    - HTML and JSON formats, with `.jsonl` retired;
    - a secret Gist with a preview link;
    - in-memory Delegated Agent, validation, and AI review transcripts are excluded, and this is labeled as current
      scope.

    The Workspace PRD's Session export and snapshot sections still say undelivered and still separate Gist sharing from
    snapshots.

10. `docs/domain-language.md` defines **Session Export**: a file copy of one Session's complete committed Session
    Transcript across all Session Transcript Segments, with Session Manifest facts, written as HTML or JSON by `/export`
    or uploaded by `/share` to a secret GitHub Gist. It is not a Shared Session Snapshot.
    - _Avoid_: Pi export, segment export.
11. `docs/user-documentation/usage.md`, `docs/user-documentation/sessions.md`, and `docs/user-facing-features.md`
    describe `/export` as HTML or JSON for the complete Session, and `/share` as a secret Gist with a preview link. No
    `.jsonl` export claim remains.
12. Tests (see the Verification Plan) exist and pass:
    - `src/shared/session/session-export.test.ts` (new);
    - `src/ui/session-export/session-export-html.test.ts` (new);
    - updated `src/cmd/export/index.test.js` and `src/cmd/share/index.test.ts`.

## Verification Plan

**Automated (focused):**

```sh
bun run install:locked
bun scripts/run-tests.js \
  src/shared/session/session-export.test.ts \
  src/ui/session-export/session-export-html.test.ts \
  src/cmd/export/index.test.js \
  src/cmd/share/index.test.ts \
  src/shared/session/managed-read-non-mutation.test.ts \
  src/ui/tui/document-link-lifecycle.test.ts \
  src/shared/session/segment-rollover.test.js \
  src/shared/session/session-transcript-manifest.test.js \
  src/shared/session/architecture-boundary.test.ts \
  src/cmd/__tests__/registry.test.ts
bun run seams:check
```

`scripts/bun-test-files.json` lists the two new test files.

**Tests that prove the objective:**

- `session-export.test.ts`: **complete multi-segment export**. Build a real managed Session with the segment-rollover
  fixture pattern:
    - a planning segment with user text `plan the export` and assistant text `planned`;
    - a roll to an execution segment with assistant text `implemented`.

    `readSessionExport` must return two segments in order (`planning`, `execution`). Segment 0's raw entries must contain
    `plan the export`, and segment 1's raw entries must contain `implemented`. The `timeline` must contain the user
    message with `segmentOrdinal: 0` and the assistant text with `segmentOrdinal: 1`. `session.runwieldSessionId` must
    match the Session Manifest. **This test fails against today's current-segment-only export.**

- `session-export.test.ts`: **integrity is kept**. After a byte of the sealed planning segment changes,
  `readSessionExport` rejects with the verification error and writes nothing.
- `session-export.test.ts`: **unmanaged fallback**. A new interactive Session with no submitted message returns one
  `session` segment that contains its Pi `session` header.
- `session-export-html.test.ts`: from a hand-built `SessionExport` with two segments, the HTML:
    - contains both segment labels in order;
    - shows a tool call inside `<details>` with its result;
    - shows thinking inside a `<details>` that has no `open` attribute;
    - shows the user text `<script>alert(1)</script>` and an assistant Markdown `<img onerror>` as escaped text, so no
      executable `<script>` or `onerror=` attribute is present;
    - contains `--rw-` variables;
    - contains no `<script src` and no `<link rel="stylesheet"`.
- `src/cmd/export/index.test.js`, against a real runtime Session:
    - `/export out.json` writes JSON that parses with `format === "runwield.session-export"` and a non-empty `segments`;
    - `/export out.jsonl` returns `"failed"`, the message names `.json`, and no file exists;
    - `/export` with no path writes a `.html` file that starts with `<!doctype html>`;
    - the error path still clears the editor.
- `src/cmd/share/index.test.ts`, with the fake `GitHubCliPort`:
    - the gist call includes `--public=false`, `--desc`, and exactly two file arguments, named `runwield-session.html`
      and `runwield-session.json`;
    - the uploaded JSON parses with the export `format`;
    - the success message contains the Gist URL and `https://gistpreview.github.io/?fixture/runwield-session.html`;
    - the temporary directory is gone after success and after a gist failure;
    - the preflight-failure and no-session tests keep their current assertions.

**Behavior that existing tests must still protect:**

- `managed-read-non-mutation.test.ts`: change the `exportSession` case into a `readSessionExport` case. It must still
  prove the read leaves transcript bytes, digest, and modification time unchanged.
- `document-link-lifecycle.test.ts`: still prove that the exported content holds exactly one assistant text equal to
  the rendered output. Read it from `readSessionExport` segment entries instead of a `.jsonl` file.
- `segment-rollover.test.js` and other `projectAggregateTranscript` callers: the projection result stays the same.

**Behavior that is expected to stop existing:** `.jsonl` export, and the `"type":"session"`-only JSONL upload that the
current share test checks.

**Manual:**

1. In the TUI, run a small request through planning and execution so the Session has at least two segments.
2. Run `/export`. Open the HTML in a browser and confirm that the planning conversation appears before the execution
   segment heading, that tool calls expand, and that the page uses the RunWield dark theme.
3. Run `/export out.json` and confirm that `segments.length >= 2`.
4. Run `/share`. Open both printed links and confirm that the Gist is secret with two files and that the gistpreview
   page renders the HTML.

**Docs check:**

- The Core PRD requirement and domain-language entry describe only delivered behavior.
- The Workspace PRD export and snapshot capabilities remain undelivered.

## Edge Cases & Considerations

- **Export during a running turn.** The export reads the committed generation, so a slash command that runs while the
  Agent is busy exports the last committed history, not partial output. This is acceptable and matches the Workspace
  timeline.
- **Repair segments in worktrees.** A `semantic_repair` segment's JSONL can be in the worktree's session directory. The
  export reads absolute `transcriptPath` values from the Session Manifest, so it does not depend on the project
  directory.
- **Verification failure.** A missing file or a bad seal makes the export fail with the projection's message. It does
  not produce a partial export that claims to be complete.
- **Large Sessions and images.** Raw entries can hold base64 image data, so the JSON can be large. The HTML shows image
  attachments as `[image]` placeholders to keep the page small. The JSON stays lossless.
- **Gist preview depends on a third party.** `gistpreview.github.io` is an external service. The Gist URL is always
  shown, so the share still works if the preview is unavailable.
- **Retired `.jsonl` format.** Any user script that runs `/export x.jsonl` gets a clear message. There is no silent
  format change.
- **Delegated Agent, validation, and AI review transcripts are out of scope.** They are never saved to disk. If they
  are saved later, they can become extra parts of the same document.
- **Assumption: share content privacy.** The exported files include thinking (closed in HTML, raw in JSON) and full
  tool output. Today's `/share` already uploads the same data in raw JSONL. Anyone with the secret Gist link can read
  it.

> **Question (share_thinking_privacy):** Should /share and /export keep model thinking in the files (closed in HTML, raw in JSON), as today's /share already does? Choose No to remove thinking blocks from both formats.
>
> **Answer:** Yes (recommended; not answered in review)
