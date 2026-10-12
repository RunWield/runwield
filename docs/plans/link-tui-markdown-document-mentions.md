---
planId: "fb4da170-2416-48ca-b0e8-1936c74bc548"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/tui/mermaid-markdown.js"
    - "src/ui/tui/blocks.js"
    - "src/ui/tui/api.js"
    - "src/ui/tui/chat-view.ts"
    - "src/ui/tui/chat-session.ts"
    - "src/ui/review/"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/routes/api/review-file-handlers.ts"
    - "src/ui/workspace/routes/api/review-image-handlers.ts"
    - "src/ui/workspace/react/ArtifactReadSurface.tsx"
    - "src/ui/workspace/react/review-types.ts"
    - "docs/user-documentation/usage.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-05T00:48:41-04:00"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
validatedCommit: "19ad9f657520f568c63b5a022e39a161f98785f0"
workRecord:
    status: "generated"
    recordId: "9bd185a2-7497-48fc-b694-1fce976c02d5"
    path: "docs/work-records/2026-10-09-clickable-tui-markdown-document-mentions.md"
    lastAttemptAt: "2026-10-09T13:57:46.087Z"
status: "verified"
---

# Link TUI Markdown Document Mentions

## Context

Guide and other Agents often cite Project documents as plain paths, for example `(docs/acp-implementation-details.md)`
or a Work Record under `docs/work-records/`. The TUI renders these paths as text. The user must copy the path or find
the document separately.

RunWield already has two useful pieces: Pi TUI Markdown can emit clickable OSC 8 terminal hyperlinks, and
`ArtifactReadSurface` provides the Workspace-styled read-only Markdown reader. The current reader launcher is temporary,
opens one fixed document immediately, and stops when that document closes. It cannot supply stable link destinations for
several paths in streamed Agent output.

The user chose to link any existing Project-relative `.md` file, not only files under `docs/` and not only registered
Session Artifacts. Session Artifact registration remains the durable record of documents produced by a Session; an
Agent's document mention is navigation only.

## Objective

Make eligible Project-relative Markdown paths in Agent chat messages clickable in terminals that support hyperlinks.
Clicking a path opens the current file in the existing read-only Markdown reader. The behavior must preserve the visible
Agent text, work for several documents during one TUI lifetime, follow the active Session's Project root, and prevent
filesystem access outside that Project.

## Approach

Add one lazy, TUI-owned document-link host. It binds to a random loopback port, uses a random bearer token, and serves
many read requests for the active Project. It does not open a browser itself; the terminal opens the OSC 8 target when
the user clicks the visible path. The host reads and validates the selected file on each browser request so refresh
shows current content.

```text
Agent text delta
  -> AgentMessageBlock keeps the original Markdown
  -> MermaidMarkdown recognizes an eligible local .md token
  -> TUI document-link host confirms the file is inside the active Project
  -> renderer emits path label + hidden loopback URL
  -> terminal click requests the token-protected reader route
  -> route revalidates and reads the current file
  -> ArtifactReadSurface renders the document
```

Keep recognition at Markdown token boundaries rather than applying one regex to the full source. Plain text tokens can
recognize forms such as `(docs/file.md)`; an inline-code token is eligible only when its complete value is a Markdown
path; an existing Markdown link can replace only its local `.md` destination. Fenced code, images, external URLs, user
messages, and tool/system output remain unchanged. If terminal hyperlink support is unavailable, render the original
path without exposing the long loopback URL.

The host rotates its token and Project root when the TUI replaces its active Session, and it stops during normal or
failed TUI disposal. Old links then fail closed instead of resolving against a different Project. Use the current safe
Workspace file-reading rules as the base, but recheck canonical real paths for both Markdown and local images before any
read.

Known artifact paths keep useful reader presentation: Plans, PRDs, ADRs, Work Records, and Epic Artifacts use their
existing labels; Work Records retain applicable lifecycle and verification notices. Other Markdown uses a generic
**Document** label and an H1-derived title with a filename fallback. A linked-read presentation keeps the common Close
control, but Close only attempts to close that browser tab; it does not stop the shared TUI host.

The option set aside is changing Agent prompts to require explicit web links. That would be inconsistent across custom
Agents, would not repair replayed answers, and would still need a safe local URL provider.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/tui/mermaid-markdown.js` — recognize eligible paths from parsed inline tokens and render them as OSC 8 links
  without changing canonical message text, code fences, external links, or no-hyperlink fallback output.
- `src/ui/tui/blocks.js`, `src/ui/tui/api.js`, and `src/ui/tui/chat-view.ts` — give normal Agent message blocks access
  to the required concrete document-link owner without adding an optional test-only dependency seam.
- `src/ui/tui/chat-session.ts` — own lazy host lifetime, active Project rebinding, token rotation, and disposal across
  startup failure, Session replacement, and normal exit.
- A focused module under `src/ui/review/` — own path-to-reader URL resolution and the TUI-lifetime multi-document host;
  keep the existing one-document `startArtifactReadSurface` behavior unchanged for `wld plans read`, `wld wr read`, and
  explicit artifact review.
- `src/ui/workspace/server.js` and a focused reader route/helper — authenticate linked reads, hydrate the requested
  current Markdown, classify its reader presentation, and return safe not-found/forbidden responses without registering
  review decisions.
- `src/ui/workspace/routes/api/review-file-handlers.ts` — extract or reuse canonical real-path containment and safe text
  loading rather than creating a weaker second path resolver.
- `src/ui/workspace/routes/api/review-image-handlers.ts` — require final real-path containment for images used by linked
  documents while preserving valid current review uploads and Project-local images.
- `src/ui/workspace/react/ArtifactReadSurface.tsx` and `review-types.ts` — support the generic Document label and a
  linked-read Close mode that does not end the shared server.
- Focused TUI, reader-server, Workspace review, and lifecycle tests beside the changed modules — prove rendering,
  current-file hydration, containment, rebinding, and cleanup through real temporary Projects and a real loopback host.
- `docs/user-documentation/usage.md` — document that Agent messages link existing Project-relative Markdown in capable
  terminals and state the plain-text fallback.

The planned Workspace unified-search work can later use the same generic document presentation, but this change does not
add search, indexing, Workspace registration, or Session Artifact inference.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- Pi TUI `getCapabilities()` and `hyperlink()` plus its Markdown token renderer — preserve terminal capability
  detection, wrapping, and OSC 8 behavior.
- `MermaidMarkdown.renderToken()` / `renderInlineTokens()` — keep document linking localized beside the existing
  RunWield Markdown adaptation and preserve completed Mermaid rendering.
- `ArtifactReadSurface`, `Viewer`, and `SidebarContainer` — retain the current Contents navigation, Markdown rendering,
  print behavior, theme, and reader layout.
- `createReviewWorkspaceApp`, `renderAstroReviewPage()`, and static review assets — reuse the current token-protected
  Workspace page pipeline without treating passive reads as Plan review decisions.
- `readWorkspaceTextFile()` containment behavior, `readWorkRecord()`, and `workRecordNotices()` — preserve canonical
  file boundaries and Work Record status notices.
- `InteractiveLifecycleHandle` and the `startInteractiveSession()` disposable stack — ensure the host cannot outlive the
  TUI process lifecycle.

## Implementation Steps

- A concrete TUI document-link host lazily binds only to `127.0.0.1` on an operating-system-selected port, generates an
  unguessable token, and returns reader URLs only for existing regular `.md` files whose canonical real path is inside
  the active Project. It performs no Project-wide scan, opens no browser by itself, and adds no optional or conditional
  dependency-injection seam.
- The host serves concurrent reader tabs for several documents. Each authenticated page request re-resolves the path,
  confirms the `.md` extension and regular-file type, rejects traversal and symlink escape, and reads current content.
  Missing or moved files produce a safe not-found page, and malformed, absolute, non-Markdown, directory,
  NUL-containing, or out-of-Project requests cannot disclose file contents or absolute local paths.
- Session replacement changes the host's active Project root and token before new Agent output is rendered. URLs from
  the prior Session receive an unauthorized response and cannot resolve their old path under the new root. Disposal and
  startup-error cleanup stop the loopback server exactly once.
- Normal Agent chat messages recognize complete Project-relative Markdown mentions in plain text, balanced surrounding
  punctuation, exact inline-code values, and existing relative Markdown-link destinations. The visible path or explicit
  link label remains unchanged; repeated rendering during streaming does not duplicate punctuation, leak the token, or
  turn a partial/non-path token into unrelated linked text.
- Agent message linking does not change the persisted Session Transcript, model context, User Request rendering, tool
  logs, system messages, image syntax, fenced or indented code, `http:`, `https:`, `mailto:`, `file:`, fragment-only
  links, or non-Markdown repository paths. Existing Mermaid and LaTeX rendering remains unchanged.
- Hyperlink-capable terminals receive OSC 8 links whose target is hidden behind the original visible path. Terminals
  without hyperlink capability receive the same readable text as today and never print the loopback origin, bearer
  token, or an extra URL fallback.
- The linked reader classifies known canonical locations as Plan, PRD, ADR, Work Record, or Epic Artifact and uses
  existing hydration where status notices matter. All other eligible `.md` files render as Document. Titles use the
  current document H1 when available and otherwise use the filename; the Project-relative path remains visible.
- `ArtifactReadSurface` has an explicit linked-read mode. Its Close control attempts browser-tab closure and gives
  honest manual-close guidance when blocked, but it does not call the review-exit endpoint, resolve a review decision,
  or stop the TUI host. Closing one tab does not invalidate other document links.
- Linked-document image requests allow only supported Project-local image files whose final canonical real path remains
  inside the Project. Existing valid review-upload image behavior remains available, while symlinks to outside files
  fail closed.
- `docs/user-documentation/usage.md` describes the implemented Agent-message link scope, click behavior, security
  boundary, and no-hyperlink fallback without claiming that a mention becomes a Session Artifact.

## Approval Confirmation

No Work Record supersession is proposed. The existing browser-reader and Session Sidebar Work Records remain accurate;
this Plan reuses those capabilities for passive Agent-message navigation. The Session Sidebar completion record notes
that its verification was attested by the user rather than established by RunWield Workflow Validation, but this change
does not replace that record.

## Verification Plan

- Automated focused tests:
  `deno run -A scripts/run-tests.js src/ui/tui/mermaid-markdown.test.js src/ui/tui/blocks.test.js src/ui/tui/chat-session.test.ts src/ui/workspace/workspace-review.test.js src/ui/workspace/workspace-lifecycle.test.js`
  plus the focused new host/reader test file discovered during implementation.
- Automated repository gates: `deno task workspace:check`, `deno task workspace:test`, `deno task workspace:build`,
  `deno task test:golden-tui`, `deno task seams:check`, and `deno task ci`.
- A real temporary Project and real loopback host test must render or resolve all four example shapes from the User
  Request, fetch at least two linked documents concurrently, modify one file, and prove browser reload returns the new
  content. This test must fail if the implementation only underlines paths, emits `file://` URLs, serves one fixed
  payload, or returns stale cached Markdown.
- Token-level rendering tests must cover a plain parenthesized path, list wrapping, an exact backticked path, an
  explicit Markdown link with label text and a `docs/file.md` destination, `README.md`, Unicode and percent-encoded
  names, adjacent sentence punctuation, a streamed partial path, heading fragments, and repeated mentions. They must
  also prove no links are created inside code fences, for images, external URLs, fragment-only destinations,
  non-Markdown files, missing files, or user/system/tool blocks.
- Capability tests must force hyperlinks on and off. With support on, the rendered Agent block contains one valid OSC 8
  target and the original visible label. With support off, output contains the original path but no loopback host,
  token, `file://` URL, or duplicate destination text.
- Server security tests must cover bad and prior-session tokens, absolute paths, `..` traversal, encoded traversal, NUL,
  directories, non-Markdown files, missing files, Markdown symlink escape, image symlink escape, and concurrent
  requests. A valid Project-local document and image must still render. Responses and fallback pages must not expose
  absolute filesystem paths.
- Lifecycle tests must prove lazy startup, token/root rotation before links from a replacement Session, old-link
  rejection, continued service for new links, and idempotent cleanup on normal exit and startup failure. Use real
  temporary Projects and the real host rather than a fake server or optional dependency callback.
- Existing behavior protected after reshaping: Mermaid and LaTeX rendering, OSC 8 wrapping, Plan/Work Record command
  readers and their Close-to-stop lifecycle, explicit artifact review, Work Record notices, review-upload images, TUI
  Session replay/replacement, and Escape/Ctrl+C behavior. No existing behavior is expected to stop; only eligible Agent
  path text gains a hidden link target.
- Manual TUI and headed-browser check: run `deno task cli` in a disposable initialized Project with a capable terminal.
  Ask Guide to cite a root Markdown file, a normal document, and a Work Record using plain parentheses, backticks, and
  an explicit Markdown link. Hover or inspect each terminal link to confirm the visible text is unchanged, then click
  each and verify the Workspace-styled reader opens the correct current file with Contents, path, type label, and
  applicable Work Record notices.
- In the same manual check, keep two reader tabs open, edit one document, reload it, and confirm current content
  appears. Use Close on one tab and then open another TUI link; the host must remain available. Confirm a terminal
  configured without OSC 8 support keeps clean readable paths without printing local URLs or tokens. Exit the TUI and
  confirm its former URLs no longer respond.

## Edge Cases & Considerations

- A path can appear before the final Agent delta. Recognition must remain stable as punctuation or a Markdown closing
  delimiter arrives.
- Backticked filenames can contain spaces. Plain unquoted filenames with spaces are ambiguous and do not need automatic
  linking; Agents can use backticks or explicit Markdown links.
- A heading fragment can remain a browser navigation hint, but it must not participate in filesystem resolution. Source
  line suffixes must not be mistaken for part of a filename.
- A positive link can become stale after rendering because the file is renamed or deleted. The request-time canonical
  check is authoritative and must show a safe unavailable result.
- Session replacement can move from the primary checkout to an execution worktree. The root and token rotate together;
  an old scrollback URL must never silently read from the new root.
- The bearer token appears only in the hidden terminal target and browser address. Binding to loopback, rotating on
  Session replacement, no-store responses, and shutdown on TUI disposal limit its lifetime.
- A fresh empty TUI Session can start the host without creating Session files, but lazy startup avoids even the loopback
  listener until an eligible Agent document mention is rendered.
