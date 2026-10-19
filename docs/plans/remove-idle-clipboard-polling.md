---
planId: "15362820-c4c2-4de9-89c5-5bd5761ffaf9"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "HIGH"
affectedPaths:
    - "src/ui/tui/chat-view.ts"
    - "src/ui/tui/clipboard.ts"
    - "src/ui/tui/keybindings.ts"
    - "src/ui/tui/chat-input-controller.ts"
    - "src/ui/tui/chat-view.test.ts"
    - "src/ui/tui/chat-input-controller.test.ts"
    - "src/ui/tui/clipboard.test.ts"
    - "src/ui/tui/keybindings.test.js"
    - "src/ui/tui/testing/clipboard-command-fixture.ts"
    - "src/testing/workflow-binary-fixtures.test.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/user-facing-features.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-17"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "8ab1ed2ea0fae494e100d14333e1a1ac41e7dd13"
workRecord:
    status: "generated"
    recordId: "ee460c33-12a8-48a0-8d16-49fcc7825e03"
    path: "docs/work-records/2026-10-17-removed-idle-tui-clipboard-polling.md"
    lastAttemptAt: "2026-10-17T20:07:17.860Z"
status: "verified"
---

# Remove Idle Clipboard Polling From the TUI

## Context

Every TUI chat view on macOS starts a new `osascript` process immediately and then every 1,500 ms. It does this only
to decide whether to show the hint "Image in clipboard · ctrl+v to paste". The cost grows with each open view and runs
while the user does nothing.

The call path today:

```text
createChatView (src/ui/tui/chat-view.ts)
  void refreshClipboardImageHint()                      # immediate probe
  setInterval(refreshClipboardImageHint, 1500)          # recurring probe
    hasClipboardImage (src/ui/tui/clipboard.ts)
      port.runCommand("osascript", [...PNGf probe...])  # one new GUI process per tick
  dispose()
    clearInterval(clipboardPollingInterval)
```

Explicit paste is a separate path and must keep working:

```text
Ctrl-V (src/ui/tui/keybindings.ts)
  readClipboardImage (src/ui/tui/clipboard.ts)
    osascript probe -> temp file -> osascript extract -> base64 -i -> remove temp file
  pastedImages.push + createPastedImagePreview + handleImagePaste
```

Evidence comes from the incident handoff
(`/Users/gandazgul/Documents/web/Codex/2026-10-17/task-2/runwield-engineering-handoff.txt`): 240 distinct `osascript`
PIDs in a 36-second log window, with sampled parent relationships to `wld`. The storm stopped when all RunWield
instances stopped. The installed `~/.local/bin/wld` (v0.12.2) contains the same polling code.

> [!WARNING]
> **This change does not prove a fix for the macOS lockup**
>
> The process storm is established. The LaunchServices identifier-wrap explanation for the lockup is a hypothesis: part
> of the lookup comparison depends on unverified identifier-conversion assumptions. Removing the polling removes a real
> problem. Only normal-use observation after reboot can show whether it prevents the lockup. The Work Record and
> delivery summary must not claim a root-cause fix.

PRD ownership: clipboard image paste belongs to
[Compaction and image context](../prd/runwield-core-prd.md#compaction-and-image-context) in the Core PRD. That
capability has no clipboard-watching requirement today. This Plan **adds** one requirement (on-demand clipboard reads)
and one acceptance scenario. The existing requirement **Images reach the model** must survive unchanged.
`docs/user-facing-features.md` lists "Paste images into the TUI" and keeps that promise.

## Objective

- An idle TUI starts zero clipboard subprocesses: across focus changes, Session replacement, view disposal, and several
  concurrent views.
- Ctrl-V keeps the current image paste flow: one probe, one extract, one encode, preview, attachment, read ordering,
  bounded failure handling, and temporary-file cleanup.
- The ambient "Image in clipboard" hint no longer exists, because nothing watches the clipboard. The replacement
  guidance follows the decision below.
- The rebuilt binary installed at `~/.local/bin/wld` shows the same zero-idle behavior.

## Approach

Delete the probe from the chat view. Make clipboard availability detection private to the clipboard module, so the only
way to touch the clipboard is an explicit read.

```diff
 createChatView
-  let clipboardImageAvailable = false
-  clipboardImageHint renders when clipboardImageAvailable
-  void refreshClipboardImageHint()
-  setInterval(refreshClipboardImageHint, 1500)
+  clipboardPasteHint renders the action-driven notice (see decision)
 dispose()
-  clearInterval(clipboardPollingInterval)
```

```diff
 src/ui/tui/clipboard.ts
 interface ClipboardReader
-  hasClipboardImage(): Promise<boolean>
   readClipboardImage(): Promise<{ base64; mimeType } | null>
-export const hasClipboardImage
 export const readClipboardImage
```

`readClipboardImage` keeps its internal probe as its first step. Its command sequence, temp-file handling, and failure
results do not change.

> [!TIP]
> **Why hide detection instead of only deleting the caller**
>
> A public `hasClipboardImage` invites the next status line to poll again. Keeping detection inside
> `createClipboardReader` makes "the clipboard is read only on demand" a property of the module, not of one caller.

### Paste guidance decision

The current hint only appears when the poll finds an image. Without polling, RunWield cannot know that. Three options:

| Option                                 | What the user sees                                                                                                                                                                                                                 | Cost                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Action-driven notice** (recommended) | Nothing while idle. If Ctrl-V finds no image, a dim right-aligned line "No image in clipboard" appears in the old hint slot until the next keystroke or a successful paste. `?` keyboard help still lists `ctrl+v to paste image`. | One small callback from keybindings to the view.                                        |
| Static hint                            | A dim "ctrl+v to paste image" line on macOS while the composer is empty and has no images.                                                                                                                                         | One permanent composer row in every Session; it can look like the clipboard is watched. |
| Remove only                            | Nothing. Ctrl-V without an image stays silent, as today.                                                                                                                                                                           | No feedback for a failed paste.                                                         |

```wld-question
{
  "id": "paste-guidance",
  "type": "multiple_choice",
  "prompt": "Which paste guidance should replace the polled 'Image in clipboard' hint?",
  "choices": [
    { "value": "action-notice", "label": "Action-driven notice: show 'No image in clipboard' only after Ctrl-V finds no image" },
    { "value": "static-hint", "label": "Static hint: dim 'ctrl+v to paste image' while the composer is empty (macOS only)" },
    { "value": "remove", "label": "Remove the hint; keep ctrl+v only in keyboard help" }
  ],
  "default": "action-notice"
}
```

For the recommended option, the call path is:

```text
Ctrl-V -> readClipboardImage() -> null
  ctx.onClipboardImageMissing?.()            # new optional KeybindingsContext callback
    chat-view sets clipboardPasteNotice, requestRender
next editor input or successful paste
  chat-view clears clipboardPasteNotice
```

The callback is acceptable: keybindings owns the key; the view owns what the composer shows. It is not a seam.
`chat-input-controller.ts` wires it to a new `ChatView.showClipboardImageMissing()` method.

Option set aside: a persistent native helper that watches the clipboard without new processes. It needs its own
ownership, request bounds, and teardown. Scope it separately only if continuous availability becomes a product
requirement.

### Paste completion after disposal

The handoff also asks that a paste which finishes after view disposal does not render or attach. That path does not
change in this Plan, and no current evidence shows harm.

```wld-question
{
  "id": "post-dispose-paste-guard",
  "type": "yes_no",
  "prompt": "Should this Plan also add a guard so a Ctrl-V read that finishes after the chat view is disposed adds no preview and requests no render? (No = leave existing behavior and record it as a follow-up.)",
  "default": false
}
```

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent —
the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows, or
the Verification Plan no longer proves the objective.

- `src/ui/tui/chat-view.ts` — remove the polling, its in-flight flag, the `clipboardImageAvailable` state, the
  `hasClipboardImage` import, and `clearInterval(clipboardPollingInterval)`; replace the hint per the decision.
- `src/ui/tui/clipboard.ts` — make availability detection private; keep `readClipboardImage` behavior.
- `src/ui/tui/keybindings.ts` — report a Ctrl-V that found no image (recommended option only).
- `src/ui/tui/chat-input-controller.ts` — wire the keybindings callback to the view (recommended option only).
- `src/ui/tui/testing/clipboard-command-fixture.ts` — new shared test fixture: logging `osascript` and `base64` shims on
  `PATH`. Moves `installFakeClipboardCommands` out of `chat-input-controller.test.ts`.
- `src/ui/tui/chat-view.test.ts`, `src/ui/tui/chat-input-controller.test.ts` — zero-idle-subprocess and paste tests.
- `src/ui/tui/clipboard.test.ts`, `src/testing/workflow-binary-fixtures.test.ts` — detection tests move to
  `readClipboardImage`.
- `src/ui/tui/keybindings.test.js` — no-image Ctrl-V feedback; existing paste tests stay.
- `docs/prd/runwield-core-prd.md` — new requirement and scenario under Compaction and image context.
- `docs/user-facing-features.md` — name Ctrl-V as the on-demand paste key.

Not touched: `src/shared/agent-browser-session.ts` browser-daemon cleanup (handoff item 5; separate investigation),
`src/shared/session/session-help.ts` (its `ctrl+v` entry stays correct), and no domain-language change (no new term).

## Reuse Opportunities

- `installFakeClipboardCommands` in `src/ui/tui/chat-input-controller.test.ts` — the existing `PATH` shim approach.
  Extend it to append one line per invocation to a log file.
- `startComposition`, `submitText`, `waitFor`, `waitForPath` in `chat-input-controller.test.ts` — real composed TUI.
- `withSessionViewFixture` (`src/ui/tui/testing/session-view-fixture.ts`), `VirtualTerminal`, `RunWieldTui`,
  `installTerminalFocusState` — as used by the focus-recovery test in `chat-view.test.ts`.
- `makeClipboardPort` in `clipboard.test.ts` — port fake for the subprocess boundary (an existing, allowed seam).

## Implementation Steps

1. `src/ui/tui/chat-view.ts` contains no `refreshClipboardImageHint`, `clipboardCheckInFlight`,
   `clipboardImageAvailable`, `clipboardPollingInterval`, `setInterval`, or `hasClipboardImage` import, and
   `dispose()` contains no clipboard interval cleanup. `CLIPBOARD_IMAGE_HINT_TEXT` ("Image in clipboard · ctrl+v to
   paste") no longer exists.
2. `createChatView` starts no clipboard command at creation, on editor focus or blur, on terminal focus events, in
   `resetForSessionReplacement()`, or in `dispose()`.
3. `src/ui/tui/clipboard.ts`: `ClipboardReader` exposes only `readClipboardImage`; the module exports no
   `hasClipboardImage`. `readClipboardImage` still runs, on macOS, exactly: one `osascript` PNG probe; if it reports
   an image, one temp file with prefix `runwield-clipboard-` and suffix `.png`, one `osascript` extract, one
   `base64 -i <temp>`; and it removes the temp file on extract failure, encode failure, encoder exception, and success.
   Outside macOS it runs no command and returns `null`.
4. Paste guidance matches the `paste-guidance` decision. For `action-notice`: `KeybindingsContext` has an optional
   `onClipboardImageMissing()`; Ctrl-V calls it once when `readClipboardImage` resolves `null`; `ChatView` exposes
   `showClipboardImageMissing()`; the composer shows dim right-aligned "No image in clipboard" until the next editor
   input or a successful image paste; and `chat-input-controller.ts` wires the two. For `static-hint` or `remove`: the
   view renders that result with no clipboard read.
5. Ctrl-V with an image keeps today's behavior in `keybindings.ts`: preview added, `handleImagePaste` preflight, preview
   removed when preflight returns `null` or rejects, "Cannot attach pasted image" message on rejection, and later input
   waits for `pendingClipboardRead`.
6. If `post-dispose-paste-guard` is yes: a Ctrl-V read that resolves after the chat view is disposed adds no entry to
   `pastedImages`, adds no preview, and requests no render. If no: this path is unchanged.
7. `src/ui/tui/testing/clipboard-command-fixture.ts` exports a fixture that installs `osascript` and `base64` shims on
   `PATH`, appends one log line per invocation (command plus `probe` or `extract`, plus the temp path for `extract`),
   can be told whether the clipboard holds an image, returns the parsed invocation list, and restores `PATH`.
   `chat-input-controller.test.ts` uses it instead of its local `installFakeClipboardCommands`.
8. The tests in the Verification Plan exist and pass; each named "fails today" test fails when run against the current
   `chat-view.ts`.
9. `docs/prd/runwield-core-prd.md#compaction-and-image-context` has a requirement **Paste clipboard images on demand**:
   in the TUI, Ctrl-V reads the clipboard only when pressed, and RunWield does not read or watch the clipboard while
   idle; plus the decided guidance. It has the scenario "Given several idle TUI Sessions on macOS, no clipboard process
   starts until the user presses Ctrl-V." **Images reach the model** is unchanged. `docs/user-facing-features.md` says
   images paste with Ctrl-V on demand.
10. The rebuilt binary is installed at `~/.local/bin/wld`, its version matches the delivered commit, the previous
    binary is kept at `~/.local/bin/wld.pre-clipboard-fix`, and the binary checks in the Verification Plan pass.

## Verification Plan

### Automated (isolated runner only; run `bun run install:locked` first)

```bash
bun scripts/run-tests.js src/ui/tui/clipboard.test.ts src/ui/tui/keybindings.test.js src/ui/tui/chat-view.test.ts \
  src/ui/tui/chat-input-controller.test.ts src/testing/workflow-binary-fixtures.test.ts
bun run seams:check
bun run fmt:check <changed files>
```

New and changed tests. The two macOS-gated tests use `process.platform === "darwin"`, like the existing image
preflight test, because the clipboard module selects macOS at load time. Run them on this Mac.

- **`chat-view.test.ts` — idle views start no clipboard process (fails today).** Install the logging shims. Create three
  chat views at the same time on three `VirtualTerminal` + `RunWieldTui` pairs with `installTerminalFocusState`. Start
  them. Send terminal focus-out and focus-in sequences several times, call `tui.setFocus` away from and back to each
  editor, call `resetForSessionReplacement()` on one, and `dispose()` another. Wait 3,300 ms in real time (the old
  immediate probe plus two old 1,500 ms periods). Assert the shim log is empty and no screen contains "Image in
  clipboard". The current code writes at least three probe lines here.
- **`chat-input-controller.test.ts` — composed TUI: idle, text paste, and Session replacement start no clipboard
  process; Ctrl-V starts exactly the paste sequence (fails today).** Start the real composition with the shims. Wait
  3,300 ms. Send a bracketed text paste (`\x1b[200~pasted text\x1b[201~`) and assert the editor holds the text. Run
  `/new` and wait for idle. Assert the log is empty. Clear the editor, press Ctrl-V, and submit while `base64` still runs
  (existing ordering check). Assert: the model request contains the image; the log holds exactly `probe`, `extract`,
  `base64` in that order; the logged temp path no longer exists. Wait 1,600 ms more and assert no new log lines.
- **`chat-input-controller.test.ts` — Ctrl-V with no image.** Shim reports no image. Ctrl-V logs exactly one `probe`,
  creates no preview, and the screen shows the decided guidance (for `action-notice`: "No image in clipboard", gone after
  the next keystroke).
- **`clipboard.test.ts`.** Probe "none" makes `readClipboardImage` return `null` after exactly one `osascript` call and
  no temp file. The extract, encode, and cleanup tests stay. The non-macOS test asserts zero calls through
  `readClipboardImage`.
- **`keybindings.test.js`.** For `action-notice`: Ctrl-V with `readClipboardImage` resolving `null` calls
  `onClipboardImageMissing` once and adds no preview; with an image it does not call it.
- **`workflow-binary-fixtures.test.ts`.** Drop the `hasClipboardImage` assertion; keep `readClipboardImage` returning
  `null` through the fixture binaries.

Behavior that must stay protected (rewrite against the new shape, do not delete): non-macOS returns `null` with no
commands; image extract and encode with whitespace removal; temp-file cleanup on every failure; preview add and remove
on preflight result; "Cannot attach pasted image" on preflight rejection; input waits for a pending clipboard read.

Behavior that is expected to stop existing: `hasClipboardImage` as a public reader method and export, and the "clipboard
image detection reflects the AppleScript result" test in its current form (its probe-result cases move into
`readClipboardImage` tests).

### Rebuilt installed binary

1. From the execution worktree: `bun run compile --output bin/wld`. Check that `bin/wld.build.json` and `bin/wld
--version` name the delivered commit.
2. Install without truncating a running binary: copy `~/.local/bin/wld` to `~/.local/bin/wld.pre-clipboard-fix`, copy
   `bin/wld` to `~/.local/bin/wld.new`, then `mv ~/.local/bin/wld.new ~/.local/bin/wld`. Confirm `wld --version`.
3. Harness control: create a temp directory with a logging `osascript` shim (same as the test fixture) and a temp `HOME`
   and temp Git project. Start `~/.local/bin/wld.pre-clipboard-fix` in a detached `tmux` session with the shim first on
   `PATH`. Within 5 s the shim log has entries. This proves the harness detects polling.
4. Start three `~/.local/bin/wld` instances in detached `tmux` sessions with the same `PATH`. Leave them idle 30 s; send
   one focus change by switching `tmux` windows. Expected: the shim log is empty, and sampling `ps -axo pid,ppid,comm`
   every 200 ms shows no `osascript` whose parent is a `wld` process.
5. Send Ctrl-V (`tmux send-keys C-v`) to one instance. Expected: the log gains exactly `probe` plus, if the shim reports
   an image, `extract`; and then stays unchanged for a further 10 s.
6. Stop all harness sessions and remove the temp directories.

### Manual (Carlos)

- In the installed `wld` on macOS, copy a real screenshot and press Ctrl-V: the preview appears and the image reaches
  the model. Paste text with Cmd-V: it enters the editor. Press Ctrl-V with only text copied: the decided guidance
  appears and nothing attaches.
- After reboot, follow the handoff's post-reboot verification and normal-use observation. This is outside delivery and
  is the only way to learn whether the lockup recurs.

## Edge Cases & Considerations

- **Root cause not proven** — the delivery summary states that polling stopped and that lockup prevention needs
  post-reboot observation.
- **macOS-only proof** — on Linux CI the macOS-gated tests return early; the clipboard module chooses the platform at
  load time. The proof runs on this Mac and through the installed-binary harness.
- **Real-time waits** — the idle tests add about 3.3 s each. This is acceptable for a direct test of timer removal;
  fake timers inside the composed TUI would risk changing unrelated scheduling.
- **`PATH` mutation in tests** — the isolated runner gives each test file its own process; the fixture restores `PATH`
  in `finally`.
- **Replacing a running binary** — copy then `mv` keeps running `wld` processes on their old inode; a direct `cp` over
  the file could corrupt them. The backup allows a quick rollback.
- **A hung `osascript` on explicit paste** — existing behavior has no timeout. This Plan does not add one; it only runs
  on user action.
- **Assumption:** `action-notice` text "No image in clipboard" is also shown outside macOS, where image paste is not
  supported. It is still true from RunWield's view.
- **Out of scope:** browser-daemon cleanup in `src/shared/agent-browser-session.ts`, and a persistent native clipboard
  helper.
