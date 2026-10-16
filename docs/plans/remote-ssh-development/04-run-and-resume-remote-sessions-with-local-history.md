---
planId: "ec285d14-a71f-464c-a934-47c209958966"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/cmd/remote/index.ts"
    - "src/shared/remote/entry.ts"
    - "src/shared/remote/control.ts"
    - "src/shared/remote/target.ts"
    - "src/shared/remote/session-protocol.ts"
    - "src/shared/session/file-session-store.ts"
    - "src/shared/session/root-session.js"
    - "src/shared/session/session-runtime.js"
    - "src/shared/session/session.js"
    - "src/shared/session/file-session-storage.ts"
    - "src/shared/session/file-session-store-types.ts"
    - "src/shared/session/session-resume-list.ts"
    - "src/cmd/resume/index.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-09-21T02:05:49.975Z"
status: "verified"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 4
dependencies:
    - "02-bridge-local-models-and-personal-resources"
    - "03-guard-remote-session-writer-access"
userVerifiedAt: null
targetBranch: "epic/remote-ssh-development"
validatedCommit: "68ff6362164a60d51360741fdbd8f0bf65f1dce4"
---

# Run and Resume Remote Sessions with Local History

## Context

Children 01–03 built the parts. No production path joins them yet:

```text
laptop (wld remote)                         remote (sct)
-------------------                         ------------
startRemoteControlService                   --remote-supervisor
  sessionHandler → RemoteSessionOwner         --remote-view: status screen only
  (registered only by tests and             buildAgentSession: throws "Remote managed
   verify-remote-session-save.ts)             agent sessions are not approved"
FileSessionStore (local paths only)         RemoteSessionSaveBridge +
ensureProject: statSync/realPathSync          createRemoteRootSessionManager (tests only)
```

- The remote side shows connection facts and nothing else. There is no composer and no Agent.
- `RemoteSessionOwner` (child03) can hydrate, append, rewrite, store attachments, checkpoint, mark uncertain, and roll
  over a registered laptop bundle. Only tests create it and register it with the control service.
- `SessionRuntime` calls about 24 `FileSessionStore` methods directly and reads transcript files from disk.
- `ensureProject` in `file-session-storage.ts` runs `Deno.statSync` and `Deno.realPathSync` on the project root. A
  remote root cannot go through it.
- `RemoteTarget` (`target.ts`) has `cwd`, `home`, `gitRoot`, and `primaryRoot`. It does not identify the host.

This child delivers the user journey in the Remote SSH PRD
[Local memories and saved Sessions](../../prd/remote-ssh-prd.md#local-memories-and-saved-sessions) capability: the
**Preserve local history** requirement and its "Given a saved remote conversation, when SSH closes…" scenario. It also
delivers the same-named-folder part of **Keep project knowledge correctly scoped** for Sessions. Memory scoping is
child05.

It uses the Core [Laptop-owned remote Session saves](../../prd/runwield-core-prd.md#laptop-owned-remote-session-saves)
contract without changing it. The [Session continuity](../../prd/runwield-core-prd.md#session-continuity) outcomes must
survive: Sessions appear only after the first message, and saved history can be reopened.

### Decisions from planning

- **Conversation turns only.** Remote turns support any Agent and the core project tools. Workflow handoffs, child
  Sessions, write delegation, Plan review, and segment rollover stay unimplemented in remote mode. This child adds no
  refusal messages, placeholder screens, or partial denied paths for them. The current fail-closed guards stay where
  they are. Child06 makes them work.
- **Small laptop Session-control boundary.** The remote runtime talks to the laptop through a few Session-control
  operations. Activation proofs and file paths never leave the laptop.
- **Separate history command.** `wld remote <target>` stays connect-only. `wld remote sessions` lists saved remote
  Sessions on the laptop and opens one read-only, with no connection. Inside a connected remote TUI, `/resume` lists
  that target's Sessions through the laptop and continues one. Local TUI, ACP, and Workspace lists hide remote Sessions.
- **Read-only view.** `wld remote sessions` replays the transcript in the normal TUI renderer with no composer, plus one
  footer line that names the target and how to continue.
- **Host identity.** Only an exact match reuses a saved host identity: the same effective hostname, user, and port, plus
  the same host key. Anything else is a new target, and history is never merged. The confirmation prompt for an
  ambiguous match moves to child08.

### Epic Scope Changes

- `06-carry-remote-context-through-delivery-workflows` — receives the live segment rollover test, and the removal of the
  remote guards for workflow handoffs, child Sessions, write delegation, and Plan review.
- `08-package-and-qualify-remote-ssh-support` — receives the confirmation prompt for an ambiguous SSH alias or host
  match.

## Objective

A user runs `wld remote sct:~/proj`, submits normal Pi turns that read and edit remote project files with a laptop
model, and exits. The conversation is saved only on the laptop. With the host offline, `wld remote sessions` shows it
read-only. After reconnecting, `/resume` continues the same Session.

Project identity, execution cwd, temporary mount paths, and personal storage identity stay separate facts.

## Approach

### Turn path

The laptop owns every Session fact. The remote process runs the normal TUI and `SessionRuntime`, but its Session store
is a remote implementation that calls the laptop.

```text
remote TUI submit (first message)
  RemoteSessionControl.create        → laptop: ensureRemoteProject, create bundle, acquire lock,
                                        register RemoteSessionOwner, return operation id
  RemoteSessionSaveBridge.hydrate    → laptop: RemoteSessionOwner.handle("hydrate")
  createRemoteRootSessionManager     (in-memory Pi manager, no file)
  Pi turn + project tools            (remote cwd, laptop model bridge from child02)
    each entry → bridge append       → laptop write + sync, then ack
  RemoteSessionControl.checkpoint    → laptop: publish generation, release lock, unregister owner
```

Later turns call `RemoteSessionControl.begin` instead of `create`. That call reacquires the laptop lock, registers a new
owner, and returns a new operation id. The hydrate step then reads the committed laptop evidence.

### The Session-control boundary

The remote store is selected once, when the root Session is built. `SessionRuntime` keeps `#runManagedOperation`
(acquire, hydrate, run, checkpoint, release). It calls one interface instead of individual store methods:

```ts
interface RemoteSessionControl {
    create(request: CreateRemoteSession): OperationHandle; // first message only
    begin(sessionId: string): OperationHandle; // later turns and /resume
    checkpoint(operation: string): void;
    markUncertain(operation: string): void;
    list(): RemoteSessionSummary[]; // this target only
}
```

The laptop implements these with `FileSessionStore`, `createFileSessionControl`, and `RemoteSessionOwner`. The remote
side sends only the operation id, Session id, and the request data. It never sends proofs, paths, or lock handles.

> [!TIP]
> **Why not forward the full store**
>
> Forwarding all ~24 `FileSessionStore` methods would send activation proofs over HTTP. Child03 forbids that. It would
> also make every store change a protocol change.

### Remote project identity

A remote project record stores the host identity and the canonical remote path. It does not store a laptop path:

```diff
 interface FileSessionProject {
     projectId: string;
     displayName: string;
     registeredRoot: string;
     currentRoot: string;
+    remote?: { host: RemoteHostIdentity; root: string };
     ...
 }
```

- `RemoteHostIdentity` contains `hostname`, `user`, `port` (from `ssh -G <alias>`), and the host key fingerprint. The
  alias the user typed is a display label only.
- The project id comes from the host identity and the remote `primaryRoot`, or from `gitRoot` or `cwd` when there is no
  worktree parent. A remote worktree shares its parent's project id. Its execution cwd is stored separately.
- `ensureRemoteProject` creates or finds the record without any filesystem call on the root. `ensureProject` stays
  unchanged for local roots.
- Every local list skips records with `remote`. This covers TUI `/resume`, ACP, Workspace project scans, and the
  `/load-plan` chooser. A missing `remote` field still means a local project.

### Read-only history

`wld remote sessions` is a laptop-only command:

```text
wld remote sessions
  pick a Session (target label, title, last update)
  replay transcript in TUI, no composer
  footer: Saved on sct:~/proj. Connect with `wld remote sct:~/proj`, then /resume.
```

It reads committed laptop evidence. It does not take the Session Writer Lock and does not start SSH.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/remote/index.ts` — computes host identity before connecting; adds the `sessions` subcommand; gives the
  control service the laptop store.
- `src/shared/remote/target.ts` — reports the host key fingerprint from the authenticated connection.
- `src/shared/remote/control.ts` — serves the Session-control operations and owns `RemoteSessionOwner` registration and
  release for real connections.
- `src/shared/remote/session-protocol.ts` — validates the control requests. It still forbids paths and proofs.
- `src/shared/remote/entry.ts` and the supervisor — start the normal remote TUI in place of `--remote-view`. The status
  screen in `src/ui/tui/remote-connection-view.ts` is removed or reduced to the startup phase.
- `src/shared/session/session.js` — the `buildAgentSession` guard admits only a root Session that has a laptop save
  bridge.
- `src/shared/session/root-session.js` and `session-runtime.js` — select the remote control once at root creation; the
  managed operation calls it.
- `src/shared/session/file-session-storage.ts` and `file-session-store-types.ts` — add the `remote` project locator and
  `ensureRemoteProject`; local lists skip remote records.
- `src/shared/session/session-resume-list.ts` and `src/cmd/resume/index.ts` — local lists hide remote Sessions; a
  connected remote `/resume` lists through the laptop.
- A read-only TUI replay mode that reuses the existing transcript renderer.
- `docs/prd/remote-ssh-prd.md`, `docs/prd/runwield-core-prd.md`, `docs/domain-language.md` — record delivered behavior.

Not in this change: workflow, Plan, worktree, and child-Session code (`src/shared/workflow/`); Memory (child05);
Workspace UI apart from skipping remote project records.

## Reuse Opportunities

- `RemoteSessionOwner` (`src/shared/session/file-session-store.ts`) — the only laptop writer for remote saves.
- `RemoteSessionSaveBridge`, `session-save-worker.ts`, and `createRemoteRootSessionManager` — synchronous per-entry
  saves and in-memory hydration.
- `createFileSessionControl` (`src/shared/session/file-session-control.ts`) — laptop lock, phase, and generation
  publication.
- `SessionRuntime.#runManagedOperation` — keep its acquire, hydrate, run, checkpoint, release order.
- `remotePersonalResourcesActive`, `personalGlobalRoot`, and the child02 model bridge — resources and models for the
  remote runtime.
- `verify-remote-session-save.ts` and `remote-session-process-fixture.ts` — reuse their real laptop-store and process
  setup for the new integration tests.
- The existing TUI transcript replay used by `/resume` — the read-only view renders through it.

## Implementation Steps

1. `wld remote <host>[:<dir>]` computes a `RemoteHostIdentity` from `ssh -G` (hostname, user, port) and the host key
   fingerprint, before the remote TUI starts. Two aliases that resolve to the same values give the same identity. A
   different port, user, hostname, or key gives a different identity.
2. `FileSessionProject` has an optional `remote` locator. `ensureRemoteProject` in `file-session-storage.ts` creates or
   finds a remote record and makes no `stat`, `realPath`, or other filesystem call on the remote path. Same-named remote
   folders on two hosts produce two project ids. A remote worktree produces its parent's project id, and the Session
   stores the worktree as execution cwd.
3. `listProjectsFromDisk` callers that serve local surfaces skip records with `remote`. Local TUI `/resume`, ACP Session
   lists, Workspace project scans, and `/load-plan` do not show remote Sessions or stat remote roots. Records without
   `remote` behave as before.
4. The laptop control service serves `create`, `begin`, `checkpoint`, `markUncertain`, and `list` for the connected
   target. `create` and `begin` acquire the native Session Writer Lock, register a `RemoteSessionOwner`, and return only
   an operation id. `checkpoint` publishes the generation, releases the lock, and unregisters the owner. No request or
   response contains a file path, a `FileActivationProof`, or a lock handle.
5. `list` and `begin` accept only Sessions whose project `remote.host` and `remote.root` match the current connection. A
   Session from another target is refused.
6. The supervisor starts the normal TUI and `SessionRuntime` in the remote process with the remote cwd, the personal
   resources from child02, and the laptop model bridge. The status-only view no longer is the main screen.
7. A new remote TUI with no submitted message creates no laptop bundle, catalog record, transcript, lock, or owner.
8. On the first submitted message, the root Session calls `create`, hydrates through the bridge, and saves the user
   message through the laptop before the model request starts. Every later Pi entry, including metadata and compaction,
   is saved through `RemoteSessionSaveBridge` before dependent work continues.
9. The `buildAgentSession` guard in `session.js` admits a remote Session only when it is the root Session and has a
   laptop save bridge. Every other remote Session still fails at the current guard. No new refusal message, menu item,
   or placeholder is added for workflows, child Sessions, write delegation, Plan review, or rollover.
10. Image attachments chosen in the remote TUI are stored through the bridge `attachment` request into laptop
    Session-owned storage. Vision reads use `attachment-read`. Transcript entries hold stable references with no remote
    mount path and no connection-specific path.
11. A lost connection or save fault stops the turn. The laptop marks the operation uncertain and releases it, using the
    existing `RemoteSessionOwner.markUncertain` and `recoverUncertain`. On reconnect, `begin` hydrates only committed
    laptop evidence. No model request, tool call, or remote edit is repeated.
12. In a connected remote TUI, `/resume` lists this target's Sessions through `list` and continues the selected one
    through `begin`.
13. `wld remote sessions` runs with no SSH connection. It lists every saved remote Session on the laptop with its target
    label, title, and last update. Selecting one replays the transcript in the TUI with no composer and one footer line
    that names the target and says to connect with `wld remote <target>` and then use `/resume`. It takes no Session
    Writer Lock.
14. `wld remote` with no subcommand and `wld remote --help` show both forms in `REMOTE_USAGE`. A host alias named
    `sessions` is still reachable as `sessions:` or with a path.
15. The Remote SSH PRD **Local memories and saved Sessions** capability marks **Preserve local history** delivered for
    conversation turns. Its scope note names `wld remote sessions` and remote `/resume`. Workflow context on resume
    stays target behavior for child06. The **Domain Language and Proposed Relationships** section and the Core PRD
    Session continuity references match.
16. `docs/domain-language.md` **Remote SSH connection** says a connection can create and continue a saved Session whose
    history is on the laptop. It adds the remote project locator relationship. It does not claim remote workflows,
    Memory, or review.

## Verification Plan

Run focused tests with `deno run -A scripts/run-tests.js <paths>`, then `deno task seams:check`. Use real laptop stores
(`makeValidationProjectRoot`, `defineGitFixture`) and the real process fixture. Do not add storage seams.

### Automated

- **Dormant start:** start a remote runtime against the fixture, send no message, exit. The laptop has no bundle,
  catalog record, transcript, lock, or registered owner.
- **First message and per-entry save:** submit one message with a stub model provider. The laptop transcript has the
  user message before the provider sees the request. Hold the laptop ack; the provider call does not start until it
  returns. This test fails if saves are buffered or written remotely.
- **No remote transcript:** after a turn, the remote fixture home and project contain no Session files, and the remote
  mount was not used for Session writes.
- **Boundary content:** capture every control request and response. None contains a laptop path, a remote mount path, a
  proof, or a lock handle.
- **Project identity:** two hosts with the same folder name give two project ids. Two aliases with the same hostname,
  user, port, and key give one. A changed key gives a new id. A worktree shares its parent's id and stores its own cwd.
- **Local surfaces:** with a remote project record on the laptop, local `/resume`, ACP list, Workspace project scan, and
  `/load-plan` do not show it and make no filesystem call on the remote root. Existing local tests still pass unchanged.
- **Target scoping:** `begin` for a Session from another target is refused.
- **Guard:** in remote mode, building a non-root Session still throws at the current guard. A root Session without a
  bridge also throws.
- **Attachments:** an image attached remotely is stored on the laptop. A fresh remote manager reads it through
  `attachment-read`. The transcript reference has no path.
- **Interruption:** cut the connection during an append and during checkpoint. Complete saved entries remain. The
  operation is uncertain. Reconnect with `begin` hydrates committed evidence. The stub provider and a counting tool
  record no repeated call.
- **Offline history:** with no connection, `wld remote sessions` lists the Session and replays it read-only. The lock
  stays free, and no SSH process starts.
- **Remote resume:** after reconnecting, remote `/resume` lists only this target's Sessions, and continuing appends to
  the same Session id.

### Paired live flow (`sct`)

- Create a remote-only Git project and a same-named laptop folder with different sentinel content.
- Run `wld remote sct:~/proj`. Ask the Agent to read the remote sentinel, use it in a second model request, and write a
  remote file. Confirm the laptop sentinel tree is unchanged.
- Attach an image and ask about it.
- Exit. Make the host unreachable. Run `wld remote sessions` and read the conversation.
- Reconnect, run `/resume`, continue the conversation, and confirm the earlier context is present.
- Kill the transport during a turn. Reconnect and confirm saved entries remain and nothing is repeated.

### Behavior to protect and behavior that ends

- Protect: all local Session formats, ids, directories, and the child03 save-bridge tests
  (`session-save-bridge.test.ts`, `remote-session-owner.test.ts`, `remote-session-lifecycle.test.ts`,
  `session-worker-death.test.ts`).
- Ends: the status-only remote screen as the main remote UI, and the rule that a connection never creates a Session.
  Tests that assert either are rewritten for the new behavior, not deleted without replacement.
- The rollover live check moves to child06. Child03's rollover unit tests stay.

### Documents

- The Remote SSH PRD and glossary describe conversation turns, `wld remote sessions`, and remote `/resume` as delivered.
  Workflows, Memory scoping, and review stay target. `deno task doc-links:check` passes.

## Edge Cases & Considerations

- **Host key reporting (assumption).** The fingerprint is read over the authenticated SSH connection after OpenSSH has
  checked `known_hosts`. If OpenSSH cannot give a stable fingerprint for a configuration (for example, with a
  certificate authority), the identity uses the hostname, user, and port. The executing Engineer records this limit in
  the PRD.
- **Alias change.** An alias change with the same values reuses history. Any difference creates a new target, so older
  Sessions appear under a second target until child08 adds the confirmation prompt. History is never merged.
- **Edit before save.** A remote edit can finish before its result entry is saved. The Session reports uncertainty.
  There is no rollback and no replay.
- **Laptop crash during an operation.** The native lock and `recoverUncertain` handle it on the next `begin`, as in
  child03.
- **Workflows in this slice.** Any remote path that builds a non-root Session or needs a local Session writer fails at
  an existing guard (`buildAgentSession`, `requireLocalSessionWriter`). This is an accepted intermediate Epic state.
  Child06 removes those guards.
- **Host alias named `sessions`.** The subcommand is matched only as the bare single argument.
