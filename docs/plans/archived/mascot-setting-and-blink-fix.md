---
planId: "29398c6b-fa02-4bb6-bada-14b2f8429451"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/settings.js"
    - "src/ui/mascot/mascot.ts"
    - "src/ui/tui/agent-mascot.ts"
    - "src/ui/tui/chat-view.ts"
    - "src/cmd/settings/index.ts"
    - "src/ui/workspace/server/session-continuation.js"
    - "src/ui/workspace/islands/SessionSurface.jsx"
    - "docs/settings.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-03T11:26:09-04:00"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
sessionName: "Mascot Visibility Setting"
targetBranch: "main"
status: "validated"
validatedCommit: "a94f7e11246bb5809716984debf3d9b585b873d9"
workRecord:
    status: "generated"
    recordId: "21b92d3b-60a4-4506-815a-48d48d54c168"
    path: "docs/work-records/2026-10-04-mascot-visibility-control-and-stable-tui-blinking.md"
    lastAttemptAt: "2026-10-04T00:55:05.481Z"
archivedAt: "2026-10-26T13:28:34.961Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/mascot-setting-and-blink-fix.md"
---

# Mascot visibility setting and base-mascot blink fix

## Context

The agent mascot is always visible today. Two problems:

1. Users cannot turn it off. The mascot renders in the TUI chat view (`src/ui/tui/chat-view.ts`) and the Workspace
   composer (`RunWieldMascot` in `src/ui/workspace/islands/SessionSurface.jsx`) with no setting controlling it.
2. The base mascot's blinking dot makes the whole mascot slide left and right. The dot occupies columns 15–16 while the
   body is 13 wide, and `TuiAgentMascot.render` centers the drawing on its per-frame trimmed width. The padding changes
   by ~2 cells every time the dot appears or disappears, so the mascot moves instead of blinking in place.

The user decided: the setting is honored on both surfaces, but toggling happens only through the TUI `/settings` menu or
by editing settings files. A Workspace settings page may be built later; this Plan does not add Workspace toggle UI.

Owning PRD capability: [Agent mascots](../prd/runwield-core-prd.md#agent-mascots) in `docs/prd/runwield-core-prd.md`.
This Plan adds a visibility setting to that capability and fixes the TUI centering behavior its acceptance scenario
already describes ("the mascot centered at each sidebar width").

## Objective

1. A `mascot` boolean setting, on by default, that hides the mascot in TUI and Workspace when set to `false`, with a
   toggle entry in the TUI `/settings` menu.
2. The TUI mascot renders at a stable horizontal position while the base mascot's dot blinks — the dot appears and
   disappears in place, with no left-to-right shift.

## Approach

Follow the established custom-setting pattern (`notifications`, `cleanupMergedWorktrees`): one key read through
`getMergedCustomSetting` (project overrides global), only a literal `false` disables it.

```text
isMascotEnabled(projectRoot)
  cached = mascotEnabledCache.get(projectRoot)   // module-level Map in src/shared/settings.js
  if cached  return cached
  value = getMergedCustomSetting("mascot", projectRoot)
  enabled = value !== false                       // default true; any other value keeps it on
  mascotEnabledCache.set(projectRoot, enabled)
  return enabled
```

> [!NOTE]
> **Why a cache**
>
> `getMergedCustomSetting` performs two locked file reads plus JSONC parsing. The TUI re-renders on every animation
> frame (up to ~14 renders/second), so the per-render read must not touch the file system. The cache is cleared by
> `setCustomSetting` and `setExactProjectCustomSetting` (so the `/settings` toggle takes effect on the next render) and
> by the `/reload` command (so manual settings edits take effect, matching the documented "use /reload after changing
> settings" behavior).

TUI consumption — `renderMascot` in `src/ui/tui/chat-view.ts` checks the setting first and returns `[]` when disabled,
so no animation timer ever starts. The rail layout already tolerates empty mascot lines
(`Math.max(0, bodyHeight - mascotLines.length)`), so no layout surgery is needed.

Workspace consumption — the setting travels through the existing session-options payload:

```diff
 listSessionOptions(projectId)          // src/ui/workspace/server/session-continuation.js
   ...
   return {
+    mascot: isMascotEnabled(projectRoot),
     defaults: {...},
```

`SessionSurface.jsx` renders `<RunWieldMascot>` only after session options load and only when `mascot !== false`. This
avoids flashing the mascot to a user who disabled it while options load.

Blink fix — the centering width becomes a stable per-mascot value instead of a per-frame value:

```diff
 // src/ui/mascot/mascot.ts — precomputed once, shared by both renderers
 export const MASCOTS = animations.map((animation) => ({
     role: animation.role,
+    drawingWidth: maxTrimmedLength(all frames + idle + answering lines),
     frames: ...,
 }));

 // src/ui/tui/agent-mascot.ts
-const drawingWidth = Math.max(...lines.map((line) => line.trimEnd().length));
+const drawingWidth = mascot.drawingWidth;   // compact face keeps its fixed 7-cell width
```

For the base mascot this yields a constant 17-cell width (widest frame, with the dot), so padding never changes between
dot-on and dot-off frames — or between poses. The browser mascot is unaffected: it renders inside a fixed SVG viewBox.

Option set aside: moving the dot closer to the body so frame widths match. Rejected because it redraws an approved
design to fix a centering bug; stable centering fixes every role, not just base.

## Expected Change Surface

- `src/shared/settings.js` — new `isMascotEnabled(projectRoot)` helper with the module-level cache and invalidation in
  `setCustomSetting`, `setExactProjectCustomSetting`, and `__resetSettingsForTests`.
- `src/ui/mascot/mascot.ts` — precompute a stable `drawingWidth` per mascot.
- `src/ui/tui/agent-mascot.ts` — center on `mascot.drawingWidth` instead of the per-frame trimmed width.
- `src/ui/tui/chat-view.ts` — `renderMascot` returns `[]` when the setting is disabled; project root comes from the
  session snapshot's `cwd` (already read there).
- `src/cmd/settings/index.ts` — new top-level "Mascot" toggle entry in the `/settings` menu.
- `src/ui/workspace/server/session-continuation.js` — `listSessionOptions` includes `mascot`.
- `src/ui/workspace/islands/SessionSurface.jsx` — conditional `RunWieldMascot` render.
- `src/cmd/reload/index.ts` — clears the mascot setting cache so manual edits apply.
- `docs/settings.md` — `mascot` table row and settings section.
- `docs/prd/runwield-core-prd.md` — Agent mascots capability gains the setting requirement and acceptance scenario.
- `docs/prd/runwield-workspace-prd.md` — the composer mascot mentions honor the Core setting (one-line reference updates
  where the composer mascot is described).
- `docs/design-system.md` — one sentence in the Agent mascots section noting the `mascot` setting hides it on both
  surfaces.

Tests (new or updated):

- `src/shared/settings.test.js` — `isMascotEnabled` behavior and cache invalidation.
- `src/ui/tui/agent-mascot.test.ts` — stable centering across blink frames and poses.
- `src/ui/tui/agent-mascot-view.test.ts` — disabled setting removes the mascot from the live TUI without breaking the
  rail or compact layouts.
- `src/cmd/settings/index.test.ts` — mascot toggle writes the global setting and reports it.
- `src/ui/workspace/session-continuation.integration.test.ts` — session-options payload carries the setting.
- `src/ui/workspace/workspace-session-ux.test.tsx` — composer hides/shows the mascot per the payload.

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent.

## Reuse Opportunities

- `getMergedCustomSetting` / `setCustomSetting` in `src/shared/settings.js` — the existing custom-setting read/write
  path; no new settings machinery.
- `shouldCleanupMergedWorktrees` in `src/shared/settings.js` — the `!== false` default-on helper pattern to copy.
- The `/settings` menu loop in `src/cmd/settings/index.ts` — the "compaction" entry shows how a toggle entry with
  description, write, system message, and `requestRender` is structured.
- `MASCOTS` precomputation in `src/ui/mascot/mascot.ts` — `drawingWidth` belongs there; no pixel work during animation.

## Implementation Steps

1. `src/shared/settings.js` exports `isMascotEnabled(projectRoot)`, which returns
   `getMergedCustomSetting("mascot",
projectRoot) !== false` behind a module-level cache keyed by project root.
   `setCustomSetting`, `setExactProjectCustomSetting`, and `__resetSettingsForTests` clear the cache.
   `src/shared/settings.test.js` covers: default `true` with no settings file, `false` disables, project `false`
   overrides global `true`, non-`false` values (including `true`, strings, `0`) leave it enabled, and a write through
   `setCustomSetting` changes the next `isMascotEnabled` read without a process restart.
2. `src/ui/mascot/mascot.ts` computes `drawingWidth` for each mascot as the maximum `trimEnd()` line length across all
   `frames`, `idle`, and `answering` lines, and `MASCOTS` entries expose it.
3. `src/ui/tui/agent-mascot.ts` pads every non-compact render against `mascot.drawingWidth`; the per-frame
   `Math.max(...lines.map(...))` calculation is gone. The compact two-row face keeps its fixed 7-cell width and
   centering.
4. `src/ui/tui/chat-view.ts` `renderMascot` returns `[]` without calling `mascot.render` when
   `isMascotEnabled(projectRoot)` is `false`, where project root is the session snapshot's `cwd` (falling back to
   `getCwd()` when no snapshot exists). Both placements — the wide rail and the compact bottom dock — disappear, and no
   animation timer runs while disabled.
5. `src/cmd/settings/index.ts` adds a top-level menu entry "Mascot: on|off" (effective merged value in the description,
   with "(project override active)" when a project-scope `mascot` key exists, matching the compaction entry's
   convention). Selecting it writes `setCustomSetting("mascot", !enabled, "global", projectRoot)`, appends a system
   message, and calls `uiAPI.requestRender?.()`. The toggle takes effect on the next render without a restart.
6. `src/cmd/reload/index.ts` clears the mascot setting cache on successful reload so manual settings-file edits apply.
7. `src/ui/workspace/server/session-continuation.js` `listSessionOptions` returns `mascot: isMascotEnabled(projectRoot)`
   in its payload.
8. `src/ui/workspace/islands/SessionSurface.jsx` renders `<RunWieldMascot>` only when `sessionOptions` has loaded and
   `sessionOptions.mascot !== false`; when disabled, no mascot markup appears in the composer and the composer layout
   shrinks cleanly (no reserved gap).
9. Tests updated per the Expected Change Surface list: stable centering (identical padding across base dot-on/dot-off
   frames and across poses for one non-base role), disabled-setting TUI rendering, `/settings` toggle write, Workspace
   payload, and composer show/hide. Each test fails if its behavior is replaced by a stub or pass-through.
10. Documentation updated in the same change: `docs/settings.md` gains the `mascot` row (boolean, default `true`,
    global + project, hides the agent mascot in TUI and Workspace) and a short `### mascot` section; the Agent mascots
    capability in `docs/prd/runwield-core-prd.md` states the setting requirement and an acceptance scenario (default on;
    `mascot: false` hides it on both surfaces; the TUI `/settings` menu toggles it; the blink stays in place);
    `docs/prd/runwield-workspace-prd.md` composer mascot references point to the Core setting; `docs/design-system.md`
    notes the setting in the Agent mascots section. No doc claims a Workspace toggle UI — that is explicitly deferred.

## Approval Confirmation

No `supersedes` Work Record IDs are proposed.

## Verification Plan

- Automated: `deno task test` (or `deno run -A scripts/run-tests.js`) — with the focused tests from Implementation Step
  9 passing, in particular:
    - `src/ui/tui/agent-mascot.test.ts`: renders the base mascot at two consecutive animation frames (dot on, dot off)
      into the same width and asserts the leading padding is identical — this fails against the current per-frame
      centering.
    - `src/ui/tui/agent-mascot-view.test.ts`: with `mascot: false` in the fixture project settings, the rendered live TUI
      contains no mascot drawing lines in either rail or compact widths, and the input/composer remain intact; with the
      setting absent, the mascot still renders.
    - `src/cmd/settings/index.test.ts`: selecting the Mascot entry writes `mascot` to global settings and appends the
      confirmation message.
    - `src/ui/workspace/workspace-session-ux.test.tsx`: a session-options payload with `mascot: false` renders no
      `RunWieldMascot` markup; a payload without the field still renders it.
- Manual:
    - TUI: run a session, `/settings` → Mascot → off; the mascot disappears immediately (no restart) and the composer and
      sidebar keep their layout. Toggle back on; it returns and animates.
    - TUI: set `"mascot": false` in `~/.wld/settings.json` while a session is open, run `/reload`; the mascot disappears.
    - TUI: watch the base mascot (Router or Init agent) during a busy turn; the dot blinks in place with no horizontal
      shift of the W body.
    - Workspace: with the setting off, open a Session; the composer shows no mascot and no reserved gap; with it on, the
      mascot renders and animates as before.
- Behavior that must still be protected afterwards: mascot identity/alias mapping, delegated inheritance, compact face
  on narrow terminals, animation clock reset on session replacement, reduced-motion/hidden-tab browser behavior, and the
  answering pose. No tested behavior is expected to stop existing — the centering test in `agent-mascot.test.ts` changes
  its assertion from "centered per frame" to "identical padding across frames", which is the intended fix, not a
  coverage loss.

## Edge Cases & Considerations

- Risk: per-render file reads would make the TUI slow and contend with settings writes. Mitigation: the cached
  `isMascotEnabled` helper (see Approach callout).
- Risk: a stale cache after a manual settings edit. Mitigation: `/reload` clears it; documented behavior already tells
  users to run `/reload` after changing settings.
- Compatibility: the session-options payload gains an optional field; older clients and existing test mocks without
  `mascot` keep working (missing field means enabled). The `/settings` menu gains an entry; existing entries are
  unchanged.
- Scope note: `brand/mascot/loops/` preview pages are standalone brand studies, not product UI; the setting does not
  apply to them.
- Deferred by user decision: a Workspace settings page with toggle UI. Workspace honors the setting only.
- Assumption: the setting key is `mascot` (single lowercase word, matching `notifications` and `guidedReview`
  conventions), read merged with project override, written to global scope by the TUI `/settings` toggle (matching
  `activeModelPreset` writes).
