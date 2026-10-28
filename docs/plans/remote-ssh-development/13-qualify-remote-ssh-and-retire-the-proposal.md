---
planId: "9c34f0ce-020b-4f3d-befe-aa1726490cab"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/remote/verify-remote-reviews.ts"
    - "src/shared/remote/verify-remote-workflows.ts"
    - "src/shared/remote/background-task-logs.ts"
    - "src/shared/remote/supervisor.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/adr/018-remote-ssh-local-personal-authority.md"
    - "docs/adr/015-file-authoritative-session-bundles.md"
    - "docs/domain-language.md"
    - "docs/research/remote-ssh-feasibility.md"
    - "docs/plans/remote-session-save-proof.md"
    - "docs/plans/remote-ssh-development.md"
    - "docs/plans/remote-ssh-development/manual-qa.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-25T21:51:42Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 13
dependencies:
    - "11-package-and-qualify-remote-ssh-support"
    - "12-confirm-a-partly-matching-remote-host"
userVerifiedAt: null
targetBranch: "epic/remote-ssh-development"
status: "in_progress"
---

# Qualify Remote SSH and Retire the Proposal

## Context

Children 01–12 deliver remote behavior and the packaged runtime. RunWield cannot claim Remote SSH support yet.

- **No real provider.** Every live run used a synthetic HTTP provider. The only real-provider evidence is the
  2026-09-20 transport proof, before Sessions or workflows existed.
- **Almost no release artifacts.** Only child 11's package gate ran release-format archives, and it covered connection,
  one tool result, and one saved Session.
- **Split journeys.** Delivery (child 07), review (child 10), and host confirmation (child 12) each ran alone. Child 10's
  rerun stopped at **Publication** with a spinner for more than three minutes.
- **Known defect.** Child 07's integration note is confirmed: after the supervisor sends SIGKILL to the TUI, the
  `runwield-background-*` log directory stays in `/tmp` (`background-task-logs.ts` removes it only on a graceful exit).

Then the transient [Remote SSH PRD](../../prd/remote-ssh-prd.md) is folded into
[RunWield Core](../../prd/runwield-core-prd.md) and removed. Core already has a
[Remote connection](../../prd/runwield-core-prd.md#remote-connection) capability; most lasting requirements land there
or in the capability that already owns the shared behavior.

### Matrix (owner, 2026-10-25)

- **Live:** macOS arm64 laptop → Fedora Server x64 (`sct`), real provider `openai-codex/gpt-5.6-luna` through Pi.
- **ARM64 servers:** supported on the evidence of child 11's release gate on GitHub's ARM64 runner (synthetic
  provider, real SSH and SSHFS).
- **Docs wording:** list exactly what was tested. Other glibc distributions with `python3`, `sshfs`, and `fuse3` are
  expected to work but are untested. Windows laptops and Claude CLI/Antigravity CLI remain unsupported.

### What existing evidence covers

A read-only survey mapped each qualification case to current evidence. The pattern:

| Evidence kind                                      | Covers                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated tests (no SSH)                           | Save-acknowledgement loss, Worker death, Session-owner death, rollover, CLI-model refusal                                                                                                                                 |
| Opt-in Linux FUSE tests (`WLD_TEST_SSHFS_STALL=1`) | Normal exit, transport close, launcher death, storage stall, unrelated processes survive                                                                                                                                  |
| Live `sct`, development build, synthetic provider  | Delivery cuts, review journeys, transport kill, host confirmation                                                                                                                                                         |
| Live, release archives, synthetic provider         | Cold and warm setup, missing `sshfs` refusal, one Session save                                                                                                                                                            |
| **Not covered anywhere**                           | Real blocked network path, laptop SFTP child kill, live interrupted setup, loss while a review is pending, loss during Git checkpoint or merge, live missing path, live same-name project question, live project override |

## Objective

Prove the complete remote delivery, review, disconnect, and reconnect journeys with release-format artifacts and a real
provider. Fix the defects that qualification finds within the delivered architecture. Then publish only the support
claims that evidence backs, with one lasting PRD owner for each requirement.

## Approach

### Release-format artifacts without a published release

A published Candidate cannot exist before the Epic merges. Build `v0.0.0-rc.<n>` archives from the qualification commit
with `scripts/release-assets.js`, as child 11 did. The macOS arm64 archive supplies the laptop launcher. The Linux x64
archive goes into the laptop runtime cache (`releaseRuntimeCacheDirectory` in `release-artifact.ts`). The launcher then
uses its normal cache path; no URL override or test seam is needed.

Rebuild the archives after any product fix, and rerun the cases that the fix can affect. Evidence from an older build ID
does not qualify a newer one.

### One terminal driver, two provider modes

`verify-remote-reviews.ts` already drives the compiled launcher in a real pseudo-terminal (PTY), records browser-open
requests through an `open` shim, and supplies a synthetic provider through an isolated HOME. It becomes the journey
driver for both provider modes.

```diff
 verify-remote-reviews.ts main
-  require compiled executable + adjacent Linux binary
+  accept a release archive directory + VERSION, or the existing compiled pair
+  seed the laptop runtime cache from the Linux archive
   create remote scratch project, bare origin, local same-name sentinel tree
-  write synthetic models.json, auth.json, settings.json into HOME/.wld
+  if provider mode is synthetic: write them into an isolated HOME (unchanged)
+  if provider mode is real: write nothing under HOME/.wld
   start PTY launcher, record PIDs and browser URLs
```

> [!WARNING]
> **The driver must never write to a real personal profile**
>
> Today the optional HOME argument still receives synthetic `models.json`, `auth.json`, and `settings.json`. Real-provider
> mode must write nothing under that HOME's `.wld`, or it would overwrite the owner's model sign-in and settings.

`verify-remote-workflows.ts` keeps its scripted runtime client for stage-exact cuts (validation, publication proven,
publication uncertain, rollover then disconnect). Its `WLD_LIVE_SOURCE=0` path already accepts a production binary; it
reruns with the release `wld` from the Linux archive. It changes only if it cannot accept that binary.

### Which provider runs which case

The real provider proves that real model behavior flows through the whole product. A fault cut needs a precise,
repeatable stage, and the provider does not take part in the fault path. The split:

| Group                            | Provider                         | Cases                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R — real journey**             | Real `openai-codex/gpt-5.6-luna` | Full delivery journey; Stop during a turn; browser close and reopen; offline history; reconnect and saved continuation; unsupported CLI model refusal; direct personal file edit; project override; missing custom Skill dependency; same-name project question                                                                                                           |
| **S — timed faults**             | Synthetic, release archives      | Normal exit; transport kill; blocked network path; launcher death; laptop SFTP child kill; storage stall; interrupted setup; loss during write, pending review, Git checkpoint, merge, and publication; reconnect after uncertain publication; remote home outside Git; missing path; alias match; linked worktree; unrelated processes survive (checked after every cut) |
| **A — cited automated evidence** | None                             | Save Worker death, save-acknowledgement loss, Session-owner death, Session generation commit and rollover interruption. The release binary runs the same compiled code, and no external signal can kill a Worker thread without a new seam.                                                                                                                               |

**Decision (owner, plan review round 1):** use this split. Group R uses the real provider, group S uses the synthetic
provider on release archives, and group A cites automated tests.

### Laptop profile for the real journey

The product promise is "your laptop environment, on a remote project". The real laptop HOME tests that promise: real
personal Skills, real Memory, real Sessions, and real OAuth renewal. An isolated HOME with a copied `auth.json` was set
aside because an OAuth refresh in the copy can rotate the refresh token and sign the real profile out.

**Decision (owner, plan review round 1):** group R uses the owner's real laptop HOME. Test Sessions stay in real history,
and the scratch project gets its own Memory collection. Group S keeps an isolated HOME.

### A real blocked network path

Killing the SSH process sends a clean close, so both ends see the loss at once. A partition sends nothing. The supervisor
must detect it from missed health replies (5 seconds × 3).

A macOS `pf` anchor drops TCP to `sct`'s address and SSH port only. The driver cannot use `sudo`, so the owner runs the
command. Other laptop traffic is unaffected, and the anchor is flushed after the check.

| Option                                    | Real packet loss                  | Needs root               | Automatable |
| ----------------------------------------- | --------------------------------- | ------------------------ | ----------- |
| **macOS `pf` anchor (selected)**          | Yes                               | Laptop `sudo`, owner-run | No          |
| `nftables` drop on `sct`                  | Yes                               | Server root              | No          |
| Freezing TCP relay through `ProxyCommand` | No; sockets stay open, data stops | No                       | Yes         |

**Decision (owner, plan review round 1):** use the macOS `pf` anchor. The owner runs `sudo pfctl` during a paired
checkpoint.

### The publication stall

The stall happened before publication started. The laptop Session's last workflow entry is `stage: "human_review"`, and
neither a Manual QA, Work Record, nor publication-progress message appeared. That excludes the model, `git push`, and the
bare `origin`.

What remains is the window between Code Review approval and the first publication emit:

```text
Code Review approved
  runPlansDoctor, claimValidation          (validation-supervisor.ts)
  withPlanLock                             waits silently up to 5 minutes (plan-store.js)
  checkpointExecutionWorktree              real `git commit` in the remote worktree
  startPublicationAttempt + save bridge
  onProgress("preparing")                  ← first visible publication message
```

The most likely causes are a silent Plan-lock wait or a blocked Git checkpoint. The journey driver captures, on `sct`
during any wait at **Publication** longer than 60 seconds: Plan lock files, `ps` for `git`, and the validation log.

### Background logs after a forced kill

The supervisor already removes its own connection directory `/tmp/wld-remote-<hex>` in its `finally` block, even after it
SIGKILLs the TUI. Placing the background-log directory inside a supervisor-owned connection path makes that existing
cleanup remove it. The view still removes it on graceful exit.

### Folding the proposal into Core

The fold follows the requirement map from the read-only survey. Lasting requirements move to their Core owner; evidence
narratives do not move, because Work Records and `manual-qa.md` already hold them.

| Remote SSH PRD section                                 | Core owner                                                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote connection and setup                            | [Remote connection](../../prd/runwield-core-prd.md#remote-connection), [Installation](../../prd/runwield-core-prd.md#installation-and-updates)                                                                 |
| Local personal environment                             | [Customization](../../prd/runwield-core-prd.md#agent-and-skill-customization), [Models](../../prd/runwield-core-prd.md#models-and-providers)                                                                   |
| Local memories and saved Sessions                      | [Project context](../../prd/runwield-core-prd.md#project-context-and-initialization), [Session continuity](../../prd/runwield-core-prd.md#session-continuity)                                                  |
| Remote workflows and local review                      | [Remote connection](../../prd/runwield-core-prd.md#remote-connection), [Plan Review](../../prd/runwield-core-prd.md#plan-review), [Delivery](../../prd/runwield-core-prd.md#execution-validation-and-recovery) |
| Disconnect and recovery                                | [Remote connection](../../prd/runwield-core-prd.md#remote-connection), [Recovery](../../prd/runwield-core-prd.md#workflow-completion-and-automatic-recovery)                                                   |
| Audience and scope "not included" list, deferred items | [Remote connection](../../prd/runwield-core-prd.md#remote-connection) scope                                                                                                                                    |

Core also contains stale statements that contradict delivered children 07, 08, and 10. They are corrected in the same
change, not only relinked.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/remote/verify-remote-reviews.ts` — release-archive input, laptop-cache seeding, real-provider mode, PID and
  stall-diagnostic recording. It stays an opt-in driver outside the test inventory.
- `src/shared/remote/verify-remote-workflows.ts` — only if its production-binary path cannot run the release `wld`.
- `src/shared/remote/background-task-logs.ts`, `src/shared/remote/supervisor.ts` — the background-log directory lives
  under supervisor-owned connection storage.
- Workflow or remote code on the publication path — only if the stall reproduces with a RunWield root cause.
- `docs/prd/runwield-core-prd.md` — owns every lasting Remote SSH requirement, scenario, the tested matrix, and deferred
  scope; stale lines corrected.
- `docs/prd/remote-ssh-prd.md` — removed.
- `docs/adr/018-…`, `docs/adr/015-…` — links retargeted; ADR-015's "Deno Worker" wording updated; both checked against
  delivered behavior.
- `docs/domain-language.md` — the Remote SSH connection relationship and qualification wording describe delivered
  behavior.
- `docs/research/remote-ssh-feasibility.md`, `docs/plans/remote-session-save-proof.md`, the Epic, and its child Plans —
  links retargeted to Core anchors so `doc-links:check` passes.
- `docs/plans/remote-ssh-development/manual-qa.md` — child 13 evidence; earlier child checklists checked where this run
  proves them.

Release scripts, the release workflow, and `scripts/check-remote-ssh-package.ts` are deliberately out of scope: child 11
qualified them, and this child only consumes their output.

## Reuse Opportunities

- `scripts/release-assets.js` — builds and verifies the candidate archives.
- `releaseRuntimeCacheDirectory`, `extractReleaseRuntime` (`release-artifact.ts`) — seed and verify the laptop cache, as
  `scripts/check-remote-ssh-package.ts` does.
- `verify-remote-reviews.ts` — PTY driver, `open` shim, headed `agent-browser` session, synthetic provider state machine.
- `verify-remote-workflows.ts` — stage-exact delivery and publication cuts.
- The evidence layout of children 10 and 11 in `manual-qa.md`: build ID, run root, evidence paths, explicit limits.

## Implementation Steps

### Driver and artifacts

- `verify-remote-reviews.ts` accepts a release archive directory and VERSION. In that mode it extracts the macOS arm64
  launcher, seeds `releaseRuntimeCacheDirectory` in the chosen HOME with the Linux x64 archive and its `.sha256`, and
  refuses to start when the two archives' build IDs differ. The existing compiled-pair mode still works.
- In real-provider mode, `verify-remote-reviews.ts` creates, modifies, or deletes no file under `<HOME>/.wld`. A run
  against a disposable HOME that contains sentinel `models.json`, `auth.json`, and `settings.json` leaves all three
  byte-identical.
- `verify-remote-reviews.ts` records the launcher, laptop SSH, and laptop SFTP child PIDs in `qualification.json`, and
  writes a `stall-<n>.txt` on `sct` diagnostics (Plan lock files, `ps` for `git`, validation log tail) whenever the
  terminal shows **Publication** for more than 60 seconds without a later publication message.
- Candidate archives for the qualification commit exist, `scripts/release-assets.js` verifies them, and every live
  result in `manual-qa.md` names the build ID it ran.

### Defects

- After the supervisor SIGKILLs a remote TUI that started at least one background task, no `runwield-background-*`
  directory for that connection remains on the server. An opt-in Linux supervisor test (same gate as the existing
  `WLD_TEST_SSHFS_STALL=1` cases) proves this and fails against the current `background-task-logs.ts`.
- The publication stall has one recorded outcome in `manual-qa.md`: either a root cause with a fix and a regression
  test that fails before the fix, or "not reproduced" in the real journey and three synthetic publication runs, with
  the captured diagnostics and the excluded causes. "Not reproduced" is not recorded as "resolved".
- Any other defect found during qualification is fixed in this child when the fix stays within the delivered
  architecture, and the affected cases rerun on rebuilt archives. A finding that needs a different architecture stops
  the run and returns to the owner.

### Live qualification on macOS arm64 → `sct`

- **Group R passes with the real provider on release archives.** One connection to a remote-only scratch project, with
  a same-named laptop folder holding a sentinel tree, completes: cold laptop and server caches, planning, Plan Review in
  the laptop browser with one feedback revision, **Approve & Run**, isolated execution, validation, AI review and any
  repair, Code Review, confirmed publication to the scratch `origin`, `/exit`, `wld remote sessions` with `sct`
  unreachable, reconnect, `/resume`, and one further turn that uses saved context. The laptop sentinel tree is
  unchanged.
- Within group R: Stop during a real turn cancels the laptop provider request with no model substitution; closing the
  browser during a pending review keeps it pending, and the TUI action reopens the same URL; selecting a Claude CLI or
  Antigravity CLI model is refused before any provider request; a personal file edited through a remote Agent changes
  the laptop file; a project override takes precedence and stays remote; a personal Skill calling a missing command
  reports the failure and the next core command works; the same-name project question appears once and the answer is
  kept.
- **Group S passes with the synthetic provider on release archives.** Each case records detection time, cleanup result,
  and that a separately started remote `sleep` survives: normal exit; SSH process kill; blocked network path; launcher
  kill; laptop SFTP child SIGKILL; storage stall (SIGSTOP of that child); launcher kill during runtime transfer with an
  empty server cache, then a reconnect that repairs setup; loss during a tool write; loss while a Plan Review and a
  Code Review are pending; loss during Git checkpoint, merge, and publication, each followed by reconnect and `/resume`
  that reports proven and uncertain outcomes without replay; `wld remote sct` into a home outside Git; a missing path
  that fails without creating it; an alias match; a connection to a linked worktree that runs a workflow.
- `verify-remote-workflows.ts` journeys `delivery`, `validation-cut`, `publication-proven`, and `publication-uncertain`
  pass with the release `wld` as the production binary.
- Group A cases cite their test files and names in `manual-qa.md`, under a heading that states they are automated, not
  live.
- After every case, the laptop has no owned SSH, SFTP, or review-forward process for that connection, and `sct` has no
  owned supervisor, view, mount, or connection directory.

### Documents

- `manual-qa.md` has a child 13 section: build ID, matrix, each case with result and evidence path, and explicit
  limits. Checklist items in children 01, 02, 05, 08, 10, 11, and 12 that this run proves are checked and point to it;
  the rest stay unchecked with a reason.
- Core's [Remote connection](../../prd/runwield-core-prd.md#remote-connection) scope states the tested matrix exactly:
  macOS arm64 laptop → Fedora Server x64 with `openai-codex/gpt-5.6-luna` through Pi, Linux ARM64 through the release
  gate with a synthetic provider, other glibc distributions untested, Windows laptops and CLI backends unsupported.
  The "not included" list and deferred items (remote `/sleep`, Windows laptop, CLI backends, remote ACP, server-side CLI
  review) are present.
- Every named requirement and acceptance scenario of `remote-ssh-prd.md` exists in its Core owner or is deliberately
  dropped as evidence-only, and the Plan's execution notes list each dropped item. Core adds the missing items the
  survey found: the broad-access notice scenario, jump-host and port preservation, "paths are data", best-effort custom
  Skills, project-override scenario, MCP placement scenarios, local browser review of remote work, the unattended-work
  prohibition, process-cleanup limits, and the remote Git-credential rule.
- Core no longer says remote workflows "follow in their owning child Plans" or "remain separate qualification", that
  remote resume is conversation-only, or that it "does not claim recovery of an interrupted remote edit or
  publication". Core's stale Deno compiler and `deno run` references in remote passages use Bun.
- `docs/prd/remote-ssh-prd.md` does not exist, and no file outside `docs/plans/archived/` links to it.
- ADR-018 and ADR-015 link only to Core; ADR-015 says "Worker", not "Deno Worker"; both describe only delivered
  behavior.
- `docs/domain-language.md` no longer says a Remote SSH connection "does not yet start ordinary project execution", no
  longer mentions the native Pi bridge proof or a "guarded writer" for target remote Sessions, and its qualification
  sentence names the tested matrix.

## Verification Plan

- **Automated:**
    - `WLD_TEST_SSHFS=1 WLD_TEST_SSHFS_STALL=1 bun scripts/run-tests.js src/shared/remote/supervisor.test.ts` on `sct`
      (Linux, FUSE, non-root), including the new background-log case. Run it once against the unfixed code to see it fail.
    - `bun scripts/run-tests.js` on any publication-path regression test added for the stall.
    - `bun run doc-links:check` and `bun run seams:check`.
    - Full CI runs after implementation.
- **Driver safety:** run real-provider mode once against a disposable HOME with sentinel `.wld` files and compare their
  hashes before and after.
- **Manual (paired):** groups R and S as stated in Implementation Steps. The owner runs the blocked-network command and
  watches the real journey in the laptop browser. Each result names its build ID.
- **Expected results:** publication confirms in group R; blocked-network loss is detected within about 15 seconds of
  health replies stopping; no case leaves an owned process or mount; the unrelated `sleep` survives every case.
- **Protected behavior:** existing opt-in supervisor and mount tests pass unchanged; the compiled-pair mode of the review
  driver still works; development-bundle connections are unaffected; graceful view exit still removes the background-log
  directory.
- **Documentation:** for each `remote-ssh-prd.md` heading, a reviewer finds its Core owner; no document claims a
  platform, distribution, or provider outside the tested matrix.

## Edge Cases & Considerations

- **`sct` availability.** Child 11 saw SSH banner timeouts and a failing laptop DNS resolver. If `sct` is unreachable,
  stop and report; do not substitute another host and call it the matrix.
- **Real-provider nondeterminism.** The real Agent may ask questions or take a different route. That is expected; record
  what happened. A real-model failure that is not a RunWield defect is retried, not counted as a pass.
- **Real-provider cost.** Group R is one journey plus short interactive checks. Timed faults use the synthetic provider
  to avoid repeated paid runs.
- **"Loss during commit" (assumption).** This means the Git checkpoint commit in the publication window (live, group S)
  and the Session generation commit (automated, group A).
- **Fixes invalidate earlier evidence.** A product fix requires rebuilt archives and reruns of the affected cases;
  unaffected cases keep their evidence only if the fix cannot reach them.
- **Architecture findings.** A finding that needs a different architecture returns to the owner. Do not ship an
  unlocked, downgraded, or silently reduced fallback.
- **Blocked network.** It needs a real packet drop, not `kill` on the SSH process. Flush the rule after each run so the
  laptop's SSH to `sct` recovers.
- **Personal mount roots.** The proposal's "other personal roots can be mounted separately" is implemented for the
  agents root and installed package roots (`sftp-mount.ts`); Core states exactly those, not arbitrary roots.
