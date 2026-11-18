# Composed Plan store migration evidence

This records Plan 13 qualification on 2026-11-17. Automated integration results and actual SSH observations are separate.
Plans 14 and 15 cover history and retention separately. This report does not accept the proposed architecture ADR.

## Automated integration

The isolated runner uses Bun 1.4.3, disposable homes, real stores, native locks, real Git repositories and child processes.
Managed tests replace only external SSH transport and model/index commands. They exercise production managed startup,
owner registration and Project-store operations without a laptop checkout.

| Scenario                                                                                                   | Owner arrangement                                                  | Observed result                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Import, sibling edit and saved host continuation](../../src/shared/workflow/composed-store-local.test.ts) | One local account; primary and execution checkouts                 | Passed. Explicit Epic import preserves source bytes and relationships. A later planning entry sees the unpublished sibling edit. Browser review refuses stale input. A fresh host discovers the exact saved workflow, revision and action.                                                                                                              |
| [First record after cleanup and moved Session](../../src/shared/workflow/composed-store-recording.test.ts) | One local account; bare Git target; two Session writer processes   | Passed. Both copy settings are off. Delivery reaches the target, execution cleanup finishes before the first canonical record, and retry retains sealed prose, original validated commit, Plan and record IDs. Rename preserves Session identity, exact native lock contention and historical segment cwd. Rebuild/search returns the canonical record. |
| [Interrupted runtime relocation](../../src/shared/workflow/composed-store-recovery.test.ts)                | One local account; primary and linked checkouts                    | Passed at copying and published boundaries. A fresh process preserves repair bytes, permissions, user changes and Git registrations. An unlink can precede its journal retirement bit; in that case the already-published destination must contain exact bytes. At least one source remains at the interruption.                                        |
| [Managed and independent manual ownership](../../src/shared/remote/composed-store-ownership.test.ts)       | Separate laptop and execution homes; same-ID remote-personal decoy | Passed. Managed sibling edits and the eligible Epic record use the laptop owner. Git publication and cleanup use remote-home runtime. With laptop service stopped, ordinary remote execution independently delivers its own Plan. Decoy source bytes remain unchanged.                                                                                  |
| [Lost settlement acknowledgement](../../src/shared/remote/composed-store-recovery.test.ts)                 | Real managed service and Git target; external HTTP reply loss      | Passed. The real target ref changes before the successful owner reply is discarded. A fresh process replays the same operation result and resumes cleanup with one canonical record. Wrong owner, attempt and parent revision are refused.                                                                                                              |

The same managed recovery file also proves the actual pathname resolution route: name-only lookup imports nothing,
explicit file selection imports through the owner, source bytes remain unchanged, and repeated selection preserves
current canonical edits. The unchanged resolver failed this test before the bounded delegation repair.

The focused baseline matrix also passed Epic sibling planning, attached Project continuity, managed activation,
managed publication, remote runtime workflows, root Session checks, Project continuity and publication/Session restart.
The full CI portfolio is owned by the delivery workflow and is not claimed here.

## Sensitivity and repairs

The composed journey exposed Session resume selecting a newly encoded directory after a Project move, followed by
returning an old cwd after synchronization. Existing Session owners now resolve admitted storage and return the
synchronized current cwd. Native writer exclusion remains unchanged.

Managed parent recording initially failed with a 409 because the child owned the sealed preparation. The existing
recording operation now carries that retained reference, locks both identities and validates the retained Work Record
owner, exact attempt/input and parent revision before reserving a record.

The actual managed TUI publication retry exposed another composition gap: Git staging read the local checkout adapter
and reported `Plan not found in its execution worktree`. The staging entry now queries the selected owner. Managed Git
staging requires a reviewed Plan and matching reserved attempt; the existing seal and Git settlement retain completion
authority. The new route regression failed before this repair, then passed with draft and wrong-attempt rejection and
`reviewed` status before matched Git settlement. The managed non-Git completion checkpoint remains separate.

After real Git publication and execution cleanup, the completion report exposed a local-only sealed-record read.
`readPublishedRecordMarkdown` now uses the existing managed delivery-proof and publication-manifest reads. The public
post-cleanup record-read regression failed with the exact refusal to read a managed package locally before repair and passed afterward,
including refusal of a path outside the record directory.

A temporary stale checkout read in the planning entry failed specifically on the unpublished sibling sentinel.
Temporarily bypassing managed selection on reconnect returned the remote-personal decoy and failed the laptop sibling
sentinel assertion. Skipping owner publication settlement failed specifically on `reviewed` instead of `verified` after
real Git delivery. These temporary changes were removed.

## Runtime writer audit

The exercised local and linked checkouts preserve settings, Agent overrides, legacy import sources and unrelated user
changes. Their checks reject recreated `.wld/internal/` and `.wld/plans`. The migration owner retains its explicit legacy
source and recovery paths; those paths are not a new-format write fallback. Plan persistence boundary checks report
zero violations and injection-seam checks report zero owned seams. These source checks supplement the filesystem and
Git assertions above.

## Actual platform observations

macOS arm64 ran the automated matrix. No Windows host was available in this session; Windows local qualification is
unproved. The Linux SSH host was reachable and inspected before implementation. It had Git, Python, SSHFS, fusermount3
and writable `/dev/fuse`. Snip was absent, but the documented fail-open behavior makes it optional for these steps.

A matched development bundle with build ID
`a33e1ac6db450d8cc056e125c141761ca7030c317e79804bfa90bdc903da1117` connected from macOS to
Fedora Linux x86_64 (`7.2.14-200.fc44.x86_64`). Production SSH, forwarding, supervisor, TUI and a real SSHFS mount
were observed. The laptop HOME and remote repositories were disposable; the installed MCP binary was not replaced.

The default remote HOME `/home/gandazgul` is a symlink. Runtime admission refused an explicit Plan load with
`Runtime authority uses a symbolic link`. A command-scoped disposable remote HOME avoided that environmental constraint
without weakening path checks or changing the account configuration. One launch ended before supervisor readiness;
a subsequent launch reached the TUI. The first directly controlled terminal also lost its connection before a workflow
ran. These attempts are not passing composed workflows.

The live managed TUI then exposed a documented pathname-import gap: `/load-plan docs/plans/family.md` rejected an existing
source while `/plans` remained CLI-only. The managed resolution branch selected only existing packages and omitted the
explicit import delegation used locally. The existing public import now handles that selection before managed resolution,
while preserving canonical and unfinished retained-attempt precedence. The new bundle
`b3dda48052c7fe7c7795887ab75fb92fe24ed2e8eb72946b5287fdd680b9de83` passed the actual TUI imports, browser Plan approval,
remote implementation and browser Code Review. The controlled reconnect preserved the same Session and execution attempt.
Its publication retry exposed the staging defect described above. A corrected matching bundle
`0e10ad15044cc760f08e342b3ae89a1eed483d4e8ece6e2a5614b6a43d21110a` resumed that same attempt through Git publication and cleanup. At 15:50 UTC its bare target contained `remote delivered`. Canonical settlement marked the child verified
with validated commit `894258ce51ba0e6cc588162da9af2955e0c7896c` and published commit
`fb70dca3cbced3f35f70d20a347fd94a6ebbde80`; cleanup removed the execution directory. The post-cleanup report error above
left the TUI completion paused. Guide's real `work_record_read` subsequently returned the approved parent record
`f511b0d3-67c2-41b9-8297-151ad39bce53` and its Markdown from the laptop owner. The synthetic provider repeated that read
three times and triggered the repeat guard; the reads were identical and performed no mutation.
The first actual fixture mistakenly nested copy settings under `custom`; the public settings format puts `plans` and
`workRecords` at the top level. Both primary and execution files contained the same mistake. This attempt correctly froze
the defaults, Plan copies off and Work Record copies on. Its immutable policy was preserved. The primary disposable
settings were corrected for a subsequent attempt; this first run does not prove actual both-copy-disabled publication.

Ordinary SSH using the corrected binary independently imported the same three source Plans into the remote account.
The remote catalog reported both children as draft while the laptop retained its reviewed first child. The remote sibling
contained `Original sibling`; the laptop sibling retained `SSH sibling sentinel`. The ordinary TUI subsequently reviewed, executed and delivered its own first child (`0ffaa03d`) through real SSH,
verification, semantic review and browser Code Review. Its sealed policy has both copies false, generation true and
`copies: []`. The target contains `ordinary remote delivered`, canonical status is verified, and remote record
`0d7f2bd8-a919-4f01-84d4-2bdbf6125a31` exists separately from the laptop record. The native TUI reached Session complete.
The existing first-run delivery copy remained unchanged; this run created no new delivery copies.

Ordinary cleanup retained its worktree after external Mnemoteca 0.3.4 failed to initialize `onnxruntime.so` in the disposable
HOME. The delivered commit and record remained usable. The documented qualification-local `mnemoteca setup` reported its
runtime and embedding model installed. A fresh `wld wr index rebuild` indexed one canonical record with zero failures,
and `wld wr search remote` returned that approved record. Normal `/load-plan family/first` then offered removal of the
published worktree and branch, completed cleanup, and removed the execution directory. No global install or account
runtime configuration was changed.

## Managed rename qualification

A separate disposable Linux repository reproduced managed Session visibility after rename with the corrected bundle.
An ordinary Guide turn saved `Managed rename qualification sentinel 13`. After a clean exit, reconnecting to the same
path and selecting `/resume` restored that conversation. After another clean exit and renaming only the repository,
connecting with the same laptop HOME succeeded, but `/resume` reported `No recent sessions found to resume`.
The original transcript remained in the laptop Session store, and offline `wld remote sessions` still listed its original target label.

The owner approved verified rebinding within Plan 13. The Session store now retains trusted Git Project, repository,
checkout, execution-account home and laptop-owner identity while the original exact root and host are authorized.
Fresh matching inspection permits a new root on the same authenticated host. Inspection does not require laptop
Plan-store admission. The Session namespace and native writer lock remain fixed. Missing historical identity cannot
be inferred after a move; legacy and non-Git history retain exact-root lookup.

The two [managed rebinding regressions](../../src/shared/remote/managed-session-rebinding.test.ts) use real Git identity,
the production Session HTTP control and native locks, with only SSH transport replaced. The original implementation
returned zero Sessions after rename instead of one. After repair, discovery and hydration preserve the same Session,
historical header cwd and transcript. A competing operation is refused until settlement. Different host, personal
owner, Project, repository and checkout identities cannot list or acquire the saved Session. The missing-historical-
identity scenario preserves offline history but refuses discovery at the new root. Removing the personal-owner
comparison or historical-root check temporarily caused the corresponding assertion to fail; both changes were undone.

Matched development bundle `5026a16bdbf053a24a1651d5204e74a153b66bb06dfb9194e7392a05d0c293cc` then ran the real
macOS-to-Linux SSH, SSHFS and production TUI journey. Guide saved
`Keep this conversation: managed verified rename sentinel 13.` at `/tmp/wld-remote-reviews-t84nZdpghS` and exited
cleanly. Renaming only that disposable repository to `/tmp/wld-remote-reviews-t84nZdpghSRenamed` and reconnecting from
the same disposable laptop HOME offered the original conversation through `/resume`. The TUI restored Guide and its
saved reply. A new turn read the remote `sentinel.txt` successfully while the footer showed the renamed directory.
Session `b625b7fd-4ed4-44b2-9472-6717cdf32c1e` and namespace `remote-23ae6fb183750e8e88503d98e5560421` stayed
unchanged; the current root and reconnect label moved. The original transcript header retained its historical cwd.
The external model HTTP response was synthetic; SSH, mount, identity inspection, persistence and the file read were real.

The six-file focused run passed managed rebinding, laptop Session control, host confirmation, managed store activation,
composed ownership and composed recovery (238.6 seconds). Type checking passed 1,964 source/test entries. Plan persistence
boundary and injection-seam checks reported zero violations. This adds two tests without deleting or replacing tests,
bringing this child's new composed coverage to nine tests across six files. Full CI remains the delivery workflow's gate.

## Corrected both-copy-disabled managed journey

Bundle `adfcbc8a239c7d9a8a1bc0a0bb4370ec6216f0f4a4d1b7426382fb808a11afd5` ran the second managed child through the normal
TUI. Its browser Plan review rendered the unpublished sibling sentinel before approval. Disposable settings were corrected
to top-level account keys after native worktree creation correctly refused conflicting uncommitted Project settings.
Both account policies were false/false before the new worktree. The browser Code Review showed the distinct
`sentinel-second.txt` change and accepted its current review revision.

Attempt `a40c7596` froze Plan copies false, Work Record copies false and generation true. Its sealed manifest has
`copies: []`. Real target `main` contains `managed both copies disabled` in `sentinel-second.txt`, and retains the independent
ordinary delivery in `sentinel.txt`. Validated commit `34b8fbe051e8d2bd483a13274c71eef787623a5d` changes only the sentinel file;
published commit is `7c0404de9ce5205840c704e370937d0f685c3c8e`. Canonical status is verified, record generation retained
`6ce6ddbb-caa9-48bd-8758-6b4d4e3a0094`, execution cleanup removed its worktree, and the native TUI reached Session complete.
The target's delivery-copy paths match the pre-run list exactly: only the unchanged record copy from the initial
misconfigured attempt remains. No new Plan or Work Record copies were added by either corrected journey.

A final fresh managed connection selected the original `family/second` Session from `/resume`, restored its completed
conversation at the primary cwd, and used Guide's real `work_record_read` to retrieve approved record
`6ce6ddbb-caa9-48bd-8758-6b4d4e3a0094` from the laptop owner. Only the primary Git worktree remained. The final primary
checkout inspection found neither `.wld/internal` nor `.wld/plans` (including symlink entries).
