---
planId: "2661bce2-39e8-4ff0-af97-558420127efb"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/ui/tui/blocks.js"
    - "src/ui/tui/api.js"
    - "src/ui/tui/types.js"
    - "src/ui/tui/runtime-adapter.js"
    - "src/shared/session/session-help.js"
    - "src/ui/tui/chat-view.ts"
    - "src/ui/tui/blocks.test.js"
    - "src/ui/tui/api.test.js"
    - "src/ui/tui/runtime-adapter.test.js"
    - "src/shared/session/session-help.test.ts"
tickets:
    - url: "https://app.todoist.com/app/task/collapse-the-tool-calls-between-thinking-to-1-block-with-1-line-per-tool-call-th-6hFmCQXVQHH8V7Vj"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-09-07T16:36:57-04:00"
status: "validated"
origin: "internal"
userVerifiedAt: null
workRecord:
    status: "generated"
    recordId: "b44de949-fa27-4c59-b7b4-eda624c44dfe"
    path: "docs/work-records/2026-09-08-collapsed-tui-tool-calls-into-compact-groups.md"
    lastAttemptAt: "2026-09-08T13:12:53.925Z"
archivedAt: "2026-09-15T18:26:59.380Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/collapse-tui-tool-call-groups.md"
targetBranch: "main"
---

# Collapse TUI Tool Calls into Compact Groups

## Context

The TUI currently gives each tool call a full block with its title, an output preview, duration, and expansion hint. A
short sequence of calls can therefore use most of the screen and make the Agent conversation difficult to follow. The
Todoist Ticket asks for each run of tool calls between conversation items to appear as one compact group with one line
per call, while full results remain available when needed.

The TUI already uses `Ctrl+O` for tool-output expansion. It has no mouse-selection model. The agreed interaction is to
keep this shortcut and make it toggle all tool groups that remain in the bounded conversation view. Failed calls stay
compact and use the existing error background on their own row. Tool-result images collapse with the text result.

## Objective

Make contiguous TUI tool activity compact by default: render one full-width physical line per tool call with no blank
lines or vertical padding between rows. Each row shows the existing tool title and uses the pending, success, or error
background for that call. `Ctrl+O` expands every visible group into separate full tool blocks with complete text and
image results, and a second press restores the compact rows.

Do not change Session Transcript data, Runtime event authority, ACP presentation, tool execution, or tool result
contents.

## Approach

Add a TUI-owned `ToolExecutionGroupBlock` that contains ordered `ToolExecutionBlock` instances. `createUiApi` opens a
group on the first visible tool start, adds later contiguous tool starts to it, and closes the group before the next
visible non-tool conversation item. Tool updates and completion still find the owned child by tool-call ID.

```text
Runtime TOOL_START / UPDATE / END
  TUI runtime adapter
  createUiApi active tool lookup
  ToolExecutionGroupBlock
    compact:  one status-colored title row per call
    expanded: existing full ToolExecutionBlock per call, including images
```

The default presentation is a dense stack; `Ctrl+O` replaces it with the separate full result blocks:

```text
[error background]   $ td --help …
[success background] read docs/domain-language.md
[success background] code_search ToolExecution
```

Titles stay one physical line at narrow widths. Expanded mode shows complete text and images, not the current six-line
preview.

A per-group mouse or keyboard focus model was set aside. It would add a new terminal interaction system and platform
compatibility work when the existing global `Ctrl+O` control meets the requested access requirement.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/ui/tui/blocks.js` — own grouped compact/expanded rendering, per-row status backgrounds, complete results, and
  result images while preserving terminal-width safety.
- `src/ui/tui/api.js` and `src/ui/tui/types.js` — form contiguous groups, route active updates, toggle visible groups,
  and keep active groups safe during bounded-list pruning.
- `src/ui/tui/runtime-adapter.js` — attach Runtime result images to the matching tool block, with the current standalone
  fallback when no visible block exists.
- `src/shared/session/session-help.js` and `src/ui/tui/chat-view.ts` — describe `Ctrl+O` as the group expansion control.
- The matching tests under `src/ui/tui/` and `src/shared/session/session-help.test.ts` — prove density, boundaries,
  colors, full expansion, image ownership, bounded retention, and help text.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `src/ui/tui/blocks.js` — reuse `ToolExecutionBlock`, title normalization, width helpers, ANSI handling, and existing
  pending/success/error theme tokens.
- `src/ui/tui/api.js` and `src/ui/tui/keybindings.ts` — retain active-call lookup, timers, bounded history, global
  `toolsExpanded` state, and the existing `Ctrl+O` dispatch.
- `src/ui/tui/runtime-adapter.js`, `src/ui/tui/ui-api-overrides.ts`, and `src/ui/theme/theme.js` — reuse image
  collection, current terminal image limits, and semantic colors. Do not add a new seam, visual token, or image
  pipeline.

## Implementation Steps

- `ToolExecutionGroupBlock` owns an ordered set of real `ToolExecutionBlock` children. Its default render has exactly
  one physical full-width row per child, no body preview, no footer, and no blank line or vertical padding between
  children. Each row uses that child's live `toolPendingBg`, `toolSuccessBg`, or `toolErrorBg`; therefore one failed
  call changes only its row to the error background.
- Compact rows preserve the normalized tool title and show elapsed or completed duration on the same row when terminal
  width permits. Long or multiline titles remain one safely truncated physical line at narrow widths.
- An expanded group renders each child as a separate existing-style tool block with spacing between calls and with the
  complete text result. The former six-line collapsed preview is not part of compact mode and cannot hide lines in
  expanded mode. A second state change returns the same group to its one-row-per-call form without losing results.
- `ToolExecutionBlock` owns any display images from its result and renders them with the current TUI image theme and
  size limits as part of the expanded full result. Compact groups do not render these images.
- `createUiApi.startToolExecution` adds consecutive visible tool starts to one current group and appends only that group
  plus one trailing spacer to `messageList`. A visible thinking, Agent, user, review, system, or persisted prompt item
  closes the current group before it is appended, so later tool activity starts a new group and chronological order
  stays clear.
- Tool update and completion events still reach the correct real child by tool-call ID. Parallel active calls, repeated
  tool-start IDs, elapsed timer cleanup, output suppression, `clearMessages`, and `dispose` keep their current behavior.
- Message-list pruning treats any group that contains an active call as active. It never removes a live group because
  `activeToolBlocks` now contains child blocks, and it does not add an unbounded registry for completed groups.
- `toggleToolOutputsExpanded` changes every `ToolExecutionGroupBlock` still present in the bounded `messageList` and
  updates the default for groups created later. Completed groups can therefore expand, unlike an implementation that
  only iterates `activeToolBlocks`.
- On `TOOL_END`, the TUI Runtime adapter adds each image from `collectRuntimeDisplayImages` to the matched block before
  ending it. If the tool is intentionally hidden or its visible block is unavailable, the current standalone
  `appendImage` fallback still presents the image.
- Full keyboard help and the startup help line say that `Ctrl+O` expands/collapses tool groups. The keybinding remains
  `Ctrl+O`, and no mouse or per-group focus behavior is added.

## Approval Confirmation

This Plan does not supersede a prior Work Record. The records for elapsed tool timers and the TUI keyboard-help block
remain valid behavior that this change preserves and adapts.

## Verification Plan

- Automated: run
  `deno run -A scripts/run-tests.js src/ui/tui/blocks.test.js src/ui/tui/api.test.js src/ui/tui/runtime-adapter.test.js src/ui/tui/keybindings.test.js src/shared/session/session-help.test.ts`.
- Automated behavior: prove three pending/success/error calls render as exactly three compact physical lines with no
  separator and the correct per-row backgrounds; long and multiline titles stay on one row at narrow widths.
- Automated behavior: expand calls with more than six output lines and an image; prove all content appears under the
  matching separate block, then collapses without result text or images remaining visible.
- Automated behavior: prove contiguous grouping, non-tool boundaries, global toggling of completed and active groups,
  inherited mode for new groups, active-group pruning safety, and bounded completed history.
- Automated behavior: prove the Runtime adapter attaches a result image before tool completion without duplicate
  standalone output, while a hidden or missing block keeps the standalone fallback.
- Automated: run `deno task check`, `deno task seams:check`, and `deno task test` after focused tests pass. Run
  `deno task ci` as the final repository gate. Do not use `deno test` directly.
- Manual pair checkpoint: run `deno task cli` in a disposable Session and produce three contiguous calls: one failed
  command, one file read, and one code search. Confirm that the default view matches the agreed dense three-row shape,
  each row changes from pending to its own success/error background, and Agent conversation text remains easy to scan.
- Manual: press `Ctrl+O` after all calls complete. Confirm that every visible group expands, complete long outputs and
  any tool-result image are available, a second press restores the compact rows, and scrolling remains usable at a
  narrow terminal width.
- Preserve live/final durations, ANSI-safe output, clickable review links in expanded output, duplicate tool-start
  visibility, timer cleanup, bounded memory, user-message images, hidden-tool behavior, and Runtime/ACP contracts.
- Stop the separate default six-line previews and per-tool compact footers. Rewrite their tests against the new group;
  do not delete that coverage.

## Edge Cases & Considerations

- Several tools can run at once. Their compact rows update independently, and one completion must not close or recolor
  another row.
- A non-tool item can close a group while a call is active. Later updates and images still reach that earlier call;
  system status items stay separate and in event order, and expanded review links remain clickable.
- Hidden tools create no empty group and keep the standalone image fallback.
- Long titles, controls, ANSI, tiny widths, empty output, and missing trailing newlines cannot break the one-line
  compact invariant.
- Global expansion can make visible history tall; this is accepted, and the 1,000-child bound remains. Expansion is
  TUI-only and is not persisted in the Session Transcript.
