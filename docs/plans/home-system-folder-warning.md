---
planId: "c4ba50dd-3739-4076-8547-31e3bb841304"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/cli.ts"
    - "src/cmd/registry.js"
    - "src/shared/project-directory.ts"
    - "src/ui/tui/chat-session.ts"
    - "src/shared/owner-coordination/projects.js"
    - "src/ui/workspace/routes/owner-api.js"
    - "src/ui/workspace/pages/projects/"
    - "src/ui/design-system/components/react/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173"
devServerHmr: true
createdAt: "2026-10-11"
origin: "internal"
status: "ready_for_work"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "plan/home-system-folder-warning"
---

# Warn Before Using Home or System Folders

## Context

RunWield currently starts project work in the home directory, filesystem root, or a system folder without a folder
warning. Terminal startup can also offer Init and the Tutorial there. Workspace accepts these folders as Project roots
without specific confirmation.

The user chose these boundaries:

- Match **home, filesystem roots, and a fixed list of system folders themselves**, not every descendant. Resolve symlink
  aliases.
- Warn at terminal startup. After Continue, suppress both automatic Init and Tutorial offers. Explicit Init and Tutorial
  commands remain available.
- Warn when Workspace adds a Project or relinks its root. Enforce confirmation on the server, not only in browser code.
- Check CLI commands that operate on project files or expect a project/repository. With terminal input, offer
  Continue/Quit. Without terminal input, stop unless the user supplies `--allow-system-directory`.
- Leave global commands and services alone.

Owning capabilities:

- [Core: Project context and initialization](../prd/runwield-core-prd.md#project-context-and-initialization): add
  **Confirm home and system folder use**; change automatic eligibility under **Offer an optional guided first change**.
  Preserve **Confirm Init's project file changes mechanically**. Folder consent does not replace Init consent.
- [Workspace: Project access and navigation](../prd/runwield-workspace-prd.md#project-access-and-navigation): add
  **Confirm home and system Project roots**. Preserve **Limit Workspace reach to registered Projects**, root validation,
  deduplication, and relink safeguards.

These are proposed changes, not claims of delivered behavior. No existing requirement is removed.

## Objective

Users can stop an accidental launch or Project registration in a broad or system folder before project work starts. They
can also deliberately continue. Ordinary project directories keep their current behavior.

## Approach

Use one read-only directory classifier across CLI, terminal startup, and Workspace. Keep presentation in each surface;
do not put terminal prompts in the shared Session runtime.

```text
CLI project command / terminal startup
  inspect selected directory
  matching folder -> Continue / Quit, or explicit CLI override
  approved -> normal operation, without automatic Init or Tutorial

Workspace add / relink
  validate and classify root on server
  matching folder without matching confirmation -> confirmation-required response
  Continue -> resubmit and recheck -> existing registration transaction
  Quit -> keep form, make no registration change
```

### Folder policy

Compare normalized absolute paths and their existing canonical paths by exact equality. Canonicalize known paths too, so
aliases such as `/bin` to `/usr/bin` and `/var` to `/private/var` work. No recursive scan is needed.

Use the account home from `getHomeDir()`. In Workspace this is the server account, not the browser's machine. Use
`getCwd()` for current-directory access. Do not cache either value at module load.

**Reviewable list assumption:** the fixed standard list below implements the user's cross-platform choice. Missing
platform entries are ignored; descendants are not inferred.

| Platform          | Exact locations                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All               | Current account home; filesystem roots, including Windows drive and UNC share roots                                                                                                                                                                                                                                                       |
| Linux and macOS   | `/bin`, `/sbin`, `/etc`, `/usr`, `/usr/bin`, `/usr/sbin`, `/usr/lib`, `/usr/lib64`, `/usr/local`, `/usr/local/bin`, `/usr/local/sbin`, `/usr/local/lib`, `/var`, `/var/log`, `/var/lib`, `/var/cache`, `/var/run`, `/tmp`, `/opt`, `/home`, `/root`, `/lib`, `/lib64`, `/boot`, `/dev`, `/proc`, `/sys`, `/run`, `/srv`, `/mnt`, `/media` |
| macOS additions   | `/Applications`, `/Library`, `/System`, `/Users`, `/Volumes`, `/private`, `/private/etc`, `/private/tmp`, `/private/var`                                                                                                                                                                                                                  |
| Windows additions | Windows directory from `SystemRoot`/`WINDIR`, Program Files locations, ProgramData, and the standard Users container on the system drive; use standard OS defaults when these environment values are absent                                                                                                                               |

Windows comparison ignores case and accepts its separator forms. POSIX comparison must not blanket-lowercase paths. A
project such as `~/projects/app`, `/opt/app`, or `/tmp/app` is not warned about unless its resolved path is
independently a listed location. A folder merely named `bin` is not special.

### CLI and terminal behavior

The warning reads **“System or home folder detected. Continue?”**, followed by the selected path, with exactly
**Continue** and **Quit** choices. Quit is the default. Escape, Ctrl-C, cancellation, or end of input stop the
operation. A normal explicit Quit exits successfully; noninteractive refusal exits nonzero and writes guidance to
stderr.

Place the CLI check after help/version resolution but before special `plans`/`guided-review` dispatch, registry
execution, or default Router execution. A check only in `startInteractiveSession()` is too late: Init extracts assets
and Load Plan can repair identity before reaching it.

Also guard direct `startInteractiveSession()` entry before opening the Session store, creating a runtime Session,
scanning for an Empty Project Directory, or setting up a model. Reuse process-local consent for the same canonical
directory so a CLI command that starts the TUI does not ask twice. Do not persist a trusted-folder setting. A later
process asks again.

| CLI category                                                                                                              | Handling                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Default startup/request, `router`, named `agent`/`agents`, `onboard`, `resume`, `load-plan`, `sleep`, `init`/`initialize` | Check before project access or work                                                                        |
| `plans` and `wr`, including their project inspection commands                                                             | Check; existing list/read paths can enter runtime or create project directories                            |
| `guided-review`                                                                                                           | Check without consuming its piped request input                                                            |
| Help/version, unnamed Agent listing, global auth/model/theme/install/remove/update/snip-filter commands                   | No folder gate                                                                                             |
| `workspace serve` / `workspace pair`                                                                                      | No cwd gate; browser root selection is checked separately                                                  |
| Agent Client Protocol (ACP), Model Context Protocol (MCP), remote connection and private remote entries                   | No new terminal gate or protocol output; their request-specific directory policies are outside this change |

Keep command classification next to the existing registry definitions and account for special dispatch entries and
aliases. Do not maintain a second drifting registry. Commands do not become Git-only.

`wld --allow-system-directory <command>` is an explicit, invocation-only acknowledgement. Consume this leading global
flag before forwarding command arguments. It does not change `--continue`, skip operation-specific consent, or become
text in an Agent request. Do not reinterpret the same text inside a quoted request or after `--`.

After Continue, use the classification to suppress the automatic Init offer and automatic Tutorial eligibility in
`chat-session.ts`. Do not record Init as offered/done or mark Tutorial Skip globally. Do not show the empty-folder
starter hint for a classified folder. Explicit `/init`, `/onboard`, `wld init`, and `wld onboard` retain their normal
consent and behavior after folder acknowledgement.

### Workspace behavior

The registration and relink owners already normalize paths and resolve symlinks. Reuse that inspection rather than
introducing a second path policy in browser code. Enforce consent against the same canonical root used by the
registration transaction, before any Project or root-evidence write.

For a matching root without valid acknowledgement, return HTTP 409 with a stable `directory_confirmation_required` code,
the warning text, and an opaque confirmation value bound to the submitted and canonical root. Continue resubmits that
value. Recompute it for the current target before a write. This is a warning acknowledgement, not a new authentication
mechanism; it needs no durable token store.

Keep existing authentication, request-forgery protection, error sanitization, and successful response shapes. Do not
disclose the server home or resolved absolute path in API responses. The browser can show the root the user entered.
Ordinary registration remains one request with HTTP 201; ordinary relink retains its current success response.

Use one small shared root-form interaction for add and relink. Keep the surrounding Astro pages and their other
controls. Use the existing React/design-system conventions for an accessible modal with Continue/Quit, initial focus on
Quit, keyboard containment, Escape dismissal, and focus return. Quit cancels the operation and keeps entered form
values; it does not close Workspace. Disable repeated submission while a request is pending. Reset confirmation when the
submitted root changes.

A browser-only warning was rejected because API callers could bypass it. A ban on whole system trees was rejected by the
user because valid projects can live below those folders.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/project-directory.ts` and its new tests — own exact directory classification and reusable read-only
  canonical inspection.
- `src/cli.ts`, `src/cmd/registry.js`, and CLI help/tests — classify commands, consume the override, and stop before
  dispatch. Targeted command changes may be needed when an operation selects another project root.
- `src/ui/tui/chat-session.ts`, terminal startup presentation, and composition tests — early consent, cleanup, and
  automatic-offer suppression.
- `src/shared/owner-coordination/projects.js` and tests — share root inspection and enforce acknowledgement before
  registration/relink writes without weakening existing path rules.
- `src/ui/workspace/routes/owner-api.js` and `owner-workspace.test.js` — structured confirmation response and
  acknowledgement transport.
- `src/ui/workspace/pages/projects/index.astro`, `pages/projects/[projectId]/settings.astro`, and a shared root-form
  component/test — add/relink confirmation and cancellation.
- `src/ui/design-system/components/react/`, shared styles, and `docs/design-system.md` — smallest reusable dialog
  extension needed for this confirmation, using `--rw-*` tokens.
- Owning Core and Workspace PRD capabilities, `docs/user-documentation/usage.md`, and
  `docs/user-documentation/workspace.md` — requirements, scenarios, flag help, and add/relink guidance stay
  synchronized.

No Session persistence migration, new trust database, ACP/MCP protocol change, or remote-project implementation is
included. No new domain term is needed; existing Project, Init, Session, and Tutorial meanings remain unchanged. No
architectural decision record needs replacement.

## Reuse Opportunities

- `src/constants.js` — dynamic `getCwd()` and `getHomeDir()`.
- `src/ui/tui/blocks.js` — `PromptSelectBlock`; initialize only the theme/terminal needed for early consent, not the
  full chat Session.
- `src/ui/tui/chat-session.ts` — existing lifecycle cleanup and Init/Tutorial eligibility; do not reuse
  `skipModelWelcome` as folder suppression.
- `src/shared/owner-coordination/projects.js` — absolute-root validation, canonical deduplication, and symlink-retarget
  protection.
- `src/ui/design-system/components/react/RunWieldPrimitives.tsx` and existing modal patterns — compact controls,
  accessible interactions, and semantic tokens.
- `VirtualTerminal`, real temporary Git fixtures, and sandboxed command fixtures — exercise actual startup and storage
  boundaries without new injection seams.

## Implementation Steps

1. `src/shared/project-directory.ts` implements the exact-match policy above, with no content scan or writes. Existing
   Workspace path validation uses the same read-only canonical inspection. Tests distinguish matching roots and aliases
   from ordinary descendants and similarly named directories on each supported platform.
2. CLI classification covers every current CLI command/alias and special dispatch path. `src/cli.ts` applies the gate
   before guarded handlers run. Nonterminal refusal is nonzero, preserves stdin, and explains
   `wld --allow-system-directory <command>`. The leading flag is removed from handler arguments and request text. Help
   and exempt commands remain available from matching folders.
3. Terminal consent works before direct interactive Session creation and shares invocation-local acknowledgement with
   CLI dispatch. Quit/cancel returns without runtime entry, project scanning, initial request submission, or Init work.
   Terminal resources are restored on all exits. Callers handle cancellation rather than continuing with an absent UI.
   When a command selects a different effective project root, it checks that root before operating there; a path change
   is not covered by a different root's consent.
4. A continued classified-folder Session skips automatic Init, Tutorial, and empty-folder starter offers. Suppression
   changes no persisted offer settings. Explicit commands still work and keep their own consent. Normal folders retain
   model setup, empty-project guidance, Init offers, Tutorial eligibility, and Session continuation behavior.
5. `registerProject` and `relinkProject` require matching acknowledgement for classified roots before their transactions
   write Project records or root evidence. Owner API handlers expose the structured 409 response and accept the
   acknowledgement. Ordinary roots and existing validation errors retain their current contracts. Changed input or a
   changed symlink target cannot reuse an earlier acknowledgement.
6. Both Workspace root forms use the same Continue/Quit interaction. Quit, Escape, and dismissal leave registration and
   form input intact. Continue resubmits only the confirmed operation; pending requests prevent duplicate actions.
   Accessible dialog behavior and shared styles are documented with the implementation.
7. Core and Workspace owning requirements and acceptance scenarios describe the delivered warning, exact-match scope,
   suppressed offers, relink behavior, and noninteractive override. CLI reference/help explains the flag. Documentation
   leaves excluded protocol/remote behavior unchanged and does not claim a security sandbox or universal unsafe-path
   detection.

## Approval Confirmation

No Work Record supersession is proposed.

## Verification Plan

### Automated behavior

Use the sandboxed runner only. Wrap in-process home/cwd mutations in `withProcessGlobalTestLock`. Add focused files
where listed as new below, or record the actual replacement names if implementation consolidates them.

- `deno run -A scripts/run-tests.js src/shared/project-directory.test.ts src/shared/owner-coordination/projects.test.ts`
    - Cover the full directory table, home and root, trailing separators, `.`/`..` normalization, real symlink aliases,
      Windows casing/drive/UNC roots, ordinary descendants, and paths such as `/binary`.
    - Registration and relink without acknowledgement must leave both Project rows and root evidence unchanged. Correct
      acknowledgement permits the operation. Wrong-root or stale-target acknowledgement does not.
- `deno run -A scripts/run-tests.js src/cmd/__tests__/directory-warning.test.ts src/cmd/__tests__/registry.test.ts src/ui/tui/chat-session.test.ts`
    - In a sandbox whose cwd equals its fake home, exercise real CLI subprocess refusal for `init`, `plans`, `wr`, and
      piped `guided-review`; assert nonzero status, stderr guidance, unconsumed request input where applicable, and no
      project artifacts or saved Session.
    - Prove the override reaches a real operation, for example `plans` listing in a sandbox home fixture with a real Plan.
      Assert the normal Plan output, not merely an exit code.
    - Exercise the actual pre-start terminal selector with `VirtualTerminal`: pending consent performs no project work;
      Quit, Escape, and Ctrl-C restore the terminal and stop; Continue starts once. Cover startup with an initial request
      and continuation as well as empty startup.
    - In a continued classified folder with a configured model, verify both automatic offers are absent and their stored
      markers are unchanged. Verify initial request delivery occurs only after Continue. In a normal nonempty and normal
      empty project, preserve the existing offer/guidance tests. Verify explicit Init still shows its file consent and
      explicit Onboard still shows its own consent.
    - Cover aliases, every command classification, help/version, the global override prefix, `--continue`, `--`, and
      flag-like text in a request. Check a CLI-to-TUI path asks once, not twice. A changed effective project root must be
      classified before work there; prior consent for another root must not authorize it.
- `deno task workspace:build && deno run -A scripts/run-tests.js src/ui/workspace/owner-workspace.test.js src/ui/workspace/project-root-form.test.tsx`
    - Exercise authenticated add and relink requests through the real server/store. A bare matching-root request returns
      409 and no writes; confirmation succeeds; ordinary roots retain their previous status/payload. Changed-root and
      retargeted-symlink requests cannot reuse confirmation.
    - Assert warning responses preserve absolute-path redaction and authentication protections. Check duplicate
      registration and existing retarget-conflict regressions still hold.
    - Form tests cover add/relink Continue, Quit, Escape, preserved input, root edits, pending-state duplicate prevention,
      error display, and focus return.

The refusal/write assertions and continued-folder offer assertions must fail if the classifier is replaced with “always
ordinary” or a guard becomes a pass-through. The confirmed-success and descendant tests must fail if the implementation
simply blocks all locations.

### Manual terminal and headed-browser checks

- Use a temporary fake home and isolated memory database. Do not run a mutating command at the developer's real home or
  a real system root for verification. Read-only classifier checks can use real system paths.
- Start the TUI at fake home with and without an initial request. Check warning text, path, Quit default, keyboard
  choices, terminal restoration, and no automatic Init/Tutorial after Continue. Restart and confirm the warning is not
  permanently dismissed.
- Use `deno task workspace:dev` at `http://127.0.0.1:5173` for UI development. For full owner API checks, build
  Workspace and run `deno run -A src/cli.ts workspace serve --no-open --port 8787` with isolated home/storage; use
  `http://127.0.0.1:8787/projects`. Keep the server scoped to this worktree.
- In a named headed `agent-browser` session, exercise add and relink on desktop (1440×1000) and narrow mobile (390×844).
  Check long-path wrapping, focus containment, Quit default, Escape, focus return, pending state, and no accidental
  navigation on cancellation. Confirm Continue registers/relinks once and opens the normal result. Inspect console and
  network errors and capture screenshots.
- Semantic review must trace both CLI dispatch and direct TUI startup: consent precedes runtime/store creation and
  directory scanning, not merely initial message submission. Trace registration/relink: consent precedes the write
  transaction, not merely the success response. A warning after work starts does not satisfy this Plan.
- Review that PRD scenarios, command help, and the design-system dialog reference match the implemented result.
  Unrelated protocol and global-command behavior must remain unchanged.

## Edge Cases & Considerations

- **This is consent, not a sandbox.** Continue permits normal behavior in the selected folder. It does not remove other
  permissions or operation-specific checks.
- **Exact matching is deliberate.** A descendant is allowed unless separately named in the fixed list. Do not broaden
  this to ownership, permission, or path-prefix heuristics.
- **Read failures are not consent.** An inaccessible selected root must not be treated as safely inspected. Keep
  path-validation failures distinct from a user choosing Quit. Missing optional system-list entries must not break
  startup.
- **Changed roots require a new decision.** Bind consent to inspected paths, not a process-wide unrestricted boolean.
  Recheck before registration/relink; preserve existing symlink-retarget conflicts.
- **Existing Workspace Projects are not revoked.** This change checks new add/relink attempts, including duplicate-add
  requests, not normal navigation to an already registered Project.
- **API compatibility changes only for classified roots.** Existing clients must handle confirmation-required and retry
  explicitly. Do not change ordinary success serialization or leak server paths.
- **Startup can still prepare global helpers.** The promise is no project work before consent, not zero process or
  user-level runtime setup.
- **No new injection seams.** Use real filesystem/storage fixtures and the existing external terminal/subprocess
  boundaries. Do not add fake policy or lifecycle callbacks for tests.
