---
status: accepted
---

# ADR-015: File-Authoritative Session Bundles

## Context

Personal Workspace serves one owner moving between TUI and browser, including a phone. An open window does not own a
Session permanently. Core must preserve one conversation across those surfaces without requiring Workspace
infrastructure for local TUI or ACP use. Workspace registration, device pairing, and request receipts remain Workspace
concerns.

Pi already supplies durable JSONL transcripts. Its entries form an in-file tree with entry IDs and parent IDs; forked or
cloned transcript files also record their parent Session. RunWield can add stable cross-file segment lineage without
introducing a database authority.

## Decision

### Core Session authority is a file bundle

Every local Session uses a bundle under the Project's encoded `~/.wld/sessions/` directory:

- Pi JSONL files remain the transcript content;
- an atomic `manifest.json` stores stable RunWield Session identity, the ordered segment list, the current segment,
  committed generation evidence, writer state, and reversible archive state;
- `session.lock` is the target of the operating-system exclusive file lock; and
- each committed transcript has an adjacent `.runwield.json` recovery descriptor containing the last recoverable
  manifest.

Manifest writes use write-sync-rename-parent-sync replacement. Recovery descriptors are refreshed only after the primary
manifest commits. They are redundant recovery evidence, not a second authority.

### One writer uses an OS lock

Before TUI, ACP, Workspace, or another Runtime surface hydrates or mutates a Session, it acquires the bundle's exclusive
OS file lock. Other surfaces may read committed evidence but cannot construct a writable Pi manager.

The lock belongs to the active managed operation, not to the lifetime of an open TUI window or Workspace server. Core
explicitly releases it when the operation settles. A Session-local Background Task may keep running in its starting host
process after that operation settles, without holding the Session Writer Lock. Its later result turn takes the normal
managed-operation path before writing transcript history. This scope protects an operation's transcript context while
allowing the owner to continue from another screen between operations. An idle resumed Session is a dormant reader;
other open surfaces do not need to close first. The operating system also releases a held lock if its process or file
descriptor closes unexpectedly.

Core has no lease duration, heartbeat deadline, or forced takeover. After a crash, the next inspector can acquire the
lock and compare the current transcript with the last committed or activation-baseline evidence:

- an exact match returns the Session to idle;
- changed or ambiguous evidence requires reconciliation; and
- unfinished external effects are never replayed automatically.

Generation and rollover proofs still fence stale in-process work. The OS lock, not a database row or timeout, prevents
simultaneous writers.

### Remote Pi saves through the laptop owner

The laptop remains the only Session writer when Pi runs remotely. The remote manager holds a validated in-memory
transcript, not a transcript file. A trusted laptop caller registers an operation with its actual native writer proof;
HTTP clients cannot supply or replace that proof. The existing authenticated remote control service admits ordered,
immutable requests for that operation and checks the native lock again on every admission.

Persistence and ownership components are product-owned, not injectable ports. The laptop connection constructs its store
and operation registry. The store constructs remote owners with the same native-lock context that acquired their proofs.
Remote root managers construct their save bridge from connection data. Callers cannot supply replacement stores,
registries, or persistence bridges. Tests use real bundles and locks, with faults at network or process boundaries.

Pi's synchronous persistence hooks wait for each exact-byte save acknowledgement. A dedicated Worker handles
network progress and notifies the calling thread through shared memory. The laptop writes and synchronizes the bytes
before acknowledging them. Save acknowledgement is separate from final generation publication. Identical retries return
the saved receipt without appending again; conflicting identities and settled operations are refused.

This preserves append-before-dependent-work ordering without adding asynchronous save barriers to every caller. The cost
is a blocked remote calling thread while each save is in flight. A finite deadline bounds the application wait, not an
operating-system I/O call or lock lifetime. The independent supervisor can stop owned processes while that thread waits.
Timeout, transport loss, Worker failure, and invalid acknowledgement evidence leave a sticky operation fault, including
when a recorder catches the exception. Late replies cannot clear that fault.

Recovery discards the failed remote manager and reads laptop evidence under the native lock. It retains complete saved
entries and can discard an incomplete, uncommitted final append tail; it does not discard malformed complete lines or
replay external effects. Legacy migration records durable before/after digest intent before atomic transcript
replacement, so a later locked inspector can reconcile either exact outcome. Rollover commits predecessor evidence and
successor lineage while the laptop retains ownership. Lifecycle paths that bypass the persistence hooks are refused
remotely instead of creating local files.

Session attachments are also laptop-owned. Remote vision reads receive bytes, MIME type, and stable attachment
references, not laptop or connection-specific paths. Project image paths still refer to the remote project. The
personal-resource mount and mounted lock results never authorize managed Session writes; the local-writer guard remains
in force. This is writer coordination, not confinement of the trusted host's broad personal-file access.

### Execution ownership belongs in the transcript

The active branch carries a versioned execution workflow snapshot from the first execution turn, not only after a Pair
checkpoint. State transitions write snapshots; release writes an explicit null tombstone. Pause and Stop remain state,
not absence. The writable operation restores this evidence after transcript hydration and before root Agent activation,
under the existing writer lock. Segment rollover and manual or automatic compaction preserve the latest snapshot,
including the tombstone. A newer snapshot takes precedence over an older Pair checkpoint, while the Pair journal
continues to supply checkpoint context and assent evidence.

Older transcripts without a snapshot can recover from matching active-branch typed execution association and persisted
Plan context, with a persisted Plan execution owner. Recovery requires exactly one matching registry entry, active
status, its attached Git worktree and branch, and an execution checkout Plan with the same Plan ID and `in_progress` or
`implemented` status. The primary Plan may still say `ready_for_work`; the execution checkout is authoritative here. The
checkout's execution policy owner must match the persisted Agent. An existing Pair journal takes precedence over legacy
inference and retains its selected style, checkpoint count, and pause state. Without that journal, legacy recovery uses
the checkout's collaboration recommendation. A successful recovery writes a snapshot once; subsequent hydration reads it
without appending another recovery entry.

Name-only lookup or the latest planning association is excluded: neither proves execution ownership. Wrong IDs,
ambiguous or missing worktrees, finished Plans, a later non-execution owner, terminal task-completion evidence, and
explicit Pair clear or Stop evidence do not grant legacy writable ownership. An explicit snapshot clear also forbids
Pair or legacy fallback. This keeps repair in the shared writable runtime rather than making individual tools guess
which Plan they may mutate. It requires no additional lock, database authority, or replay of external work.

### Archive state follows the same authority and lock

Archive state belongs in the file-authoritative manifest, not Workspace SQLite or an ACP mapping. This keeps one
reversible visibility decision across local surfaces without making Workspace registration a Core prerequisite. Missing
archive metadata means active for older bundles. Archive does not change stable identity, transcript segments, Plan
Associations, or Plan and workflow state; it is not hard deletion or ACP resource closure.

Archive and Unarchive acquire the existing Session Writer Lock, reread and validate the current manifest, and change
only archive metadata. Idempotent transitions preserve current generation and turn evidence rather than overwriting a
cached manifest. Busy work must stop through its owner and settle before the transition; a held lock or active
activation prevents the write. Workspace asks for confirmation before stopping work; an explicit ACP `session/delete`
request supplies that confirmation. Stop, settlement, and persistence failures are recoverable errors, not successful
archive outcomes. Existing crash inspection and reconciliation rules still apply; archive does not bypass them or replay
unfinished external effects.

Atomic manifest commits refresh the transcript-adjacent recovery descriptors with archive state. Reopening the store or
rebuilding Workspace projections therefore retains committed archive state. Ordinary history and TUI resume omit
archived Sessions, while Plan-associated listings retain their links and archived status. Project settings offers
Unarchive. Direct links and explicit loading remain available and do not silently restore ordinary-list visibility.

### Every Session is segmented

There is no managed/unmanaged or split/normal product distinction after a Session is persisted.

A brand-new empty TUI start is the exception: it is only an in-memory shell until the first submitted user message. It
uses the explicitly requested starting Agent, or Router when none was requested, and may show that Agent and its model
in the footer. It must not create a Session bundle, catalog entry, transcript, planning segment, generation, or embedded
lineage. If the user exits before the first message, `/resume` must not show that empty shell.

The first submitted message is the persistence boundary. The UI renders that message and enters busy state before any
durable Session work begins. RunWield then creates the stable Session ID, transcript, planning segment, and embedded
lineage, appends the submitted message, and contacts the model. The first generation and its evidence are published when
the turn is checkpointed. This persistence and model work happens behind the already-visible busy state and must not
delay the user's immediate feedback. Execution and semantic repair create successor Pi JSONL segments under the same
stable persisted Session.

Resuming a persisted Session reconstructs its committed conversation, last active Agent, and last active model as
in-memory projections. Projection must not rerun a model turn, tool call, workflow action, or other historical side
effect. Normal resumes remain dormant and do not construct a writable root Agent Session until the user's next message.
On that message, RunWield acquires the Session lock, hydrates the transcript, restores the last persisted Agent and
model, and continues normally. Router and current configuration defaults are fallbacks only when the transcript does not
contain an available choice.

Opening an older single Pi transcript silently creates its bundle and planning segment. If manifests are missing,
RunWield groups lineage-bearing transcripts by stable Session ID and orders them through parent segment and parent Pi
Session IDs. Older planning roots that predate embedded lineage can be recovered from their successor's parent IDs.
Malformed or branching lineage fails closed instead of guessing.

### Named Invocation context uses append-only edits

A Named Invocation keeps its compact user message in raw history. RunWield appends the invocation metadata, the compact
user entry, and a Pi context edit that targets that user entry and contains the exact expanded text and image blocks.
Provider requests and compaction use Pi's canonical context projection, so they receive the expansion without rewriting
the raw message.

When writable activation opens an older transcript that has invocation metadata but no applicable edit, RunWield appends
one repair edit under the existing Session Writer Lock. The repair follows only the active branch, changes only retained
user entries, respects later replacements or omissions, and is idempotent. Read-only listing and history rendering do
not repair or otherwise mutate transcripts.

An older database-only stable ID may be replaced during file migration when the transcript contains no copy of that ID.
This is an internal identity migration: the visible conversation and transcript are preserved without prompting the
user.

### Read synchronization and live interactions

Read-only projection verifies saved transcript evidence across the ordered segments. It does not acquire a writer lock
or construct a writable Pi manager. Event pagination is a display concern: a successful verified projection with another
page is not corrupt history. Writable hydration uses the current segment; the browser need not render every historical
event before Core can accept a new request.

Open readers use committed generations to discover saved changes without replaying model calls or tool effects. During
an operation, Core exposes a private local socket identified by the existing Session and operation IDs. Workspace reads
Core's live events, pending question, and steering queue through that socket. Answers, steering messages, and Stop reach
the same running agent. The socket closes with the operation; it stores no conversation or recovery state. Both surfaces
run as the same OS user on the same machine or inside the same container. File projection supplies saved history; the
socket supplies live activity.

Pair Execution is different from a live pending question. Typed checkpoint report, resolution, and clear records are
stored in the Session JSONL and tied to one workflow attempt. After turn settlement, reload, or compaction, Core
restores the current checkpoint plus its execution owner, working directory, tools, and attempt before root activation.
A later accepted user turn can resolve it. Same-turn output, generated continuation, quoted text, and stale attempts
cannot.

Pi persists completed tool calls and interaction answers. Background Task IDs, running work, and pending result delivery
are process-local, not manifest state. Saved delivered results remain transcript history; process exit does not recover,
replay, or transfer an unfinished task to another host. Stop and host shutdown cancel owned tasks, while ordinary turn
settlement and a browser tab closure do not. The Session manifest also keeps the most recently presented Plan review's
Plan ID, name, and planning Agent as a durable bookmark. It is updated under the Session Writer Lock before presenting
the review. The bookmark does not store a pending interaction, decision, or approval. A later request to review again
checks the current Plan's identity and eligibility and starts a new managed review when the Session is idle; if the
original review is still live, Core returns its current link when available or reports that the review is starting. The
bookmark does not reconstruct a lost wait or grant authority to execute the Plan.

A pending interaction remains an in-memory wait in its live process. An ACP interview can end a question's protocol
request while keeping that Runtime operation and writer lock active for a later answer request. The connection retains
undelivered updates between requests, not a durable tool wait. An answer must reach that process to continue the wait;
it does not require a separate durable interaction state machine. Browser disconnection does not cancel the wait. If the
process is lost, `/plan-review` can start a new review from the current saved Plan; for other interactions, the user can
ask the Agent to retry from saved history. Runtime stacks and unfinished external effects are not reconstructed
automatically.

### Plan actions and notification delivery

Plan Lifecycle, Plan content, and worktree evidence own their respective workflow facts. A consequential action checks
current evidence at action time. A Session's past association with a Plan does not grant permanent ownership or prove
that an operation is still running. HTTP receipts deduplicate request delivery; they do not own workflow progress.

Core emits semantic notification events and adapters deliver them. Notifications do not require durable attention
records, acknowledgements, or resolution state.

### Workspace database is Workspace-only

Workspace SQLite stores explicitly registered Projects, paired devices, bounded endpoint receipts, and rebuildable
Workspace projections. It does not own Session identity, archive state, segment order, generations, or writer
coordination. Endpoint receipts carry stable Session IDs as values and do not foreign-key them to the retired SQLite
Session catalog.

Deleting or rebuilding the Workspace database removes Workspace registration, pairing, receipts, and projections. It
does not prevent TUI or ACP from listing, opening, or continuing local Sessions. Registering the Project again lets
Workspace rediscover file-backed Sessions.

### Hosted evolution uses the same contract

`SessionRuntime` consumes a Session-store contract rather than a Workspace database. Local Core implements that contract
with file bundles and OS locks. A hosted RunWield service may later implement it with transactional object storage and a
cloud lock service while preserving stable identity, ordered segments, committed generations, and single-writer
semantics. Workspace remains a consumer and projection layer rather than the source of Session truth.

## Consequences

- TUI and ACP operate with files only and never open the Workspace database.
- A user does not run a migration script, enable an activation protocol, or choose a Session type.
- Workspace database loss is recoverable independently from Session transcripts.
- Transcript deletion still loses the deleted transcript content; manifests do not duplicate conversation history.
- The SQLite Session catalog, activation, generation, and segment tables remain readable only for compatibility and
  migration history. Production Session operations do not write them.
- This ADR defines current Session storage, writer coordination, and continuity. Prior designs are available in Git
  history, not as additional current architectural rules.

## Rejected Alternatives

### Require SQLite in every Core process

This makes the harness heavier, couples local correctness to Workspace lifecycle, and turns a derived product database
into a prerequisite for intact transcripts.

### Use only Pi parent Session headers

Pi parent pointers identify a fork relationship but do not contain RunWield's stable Session ID, segment kind, complete
ordered manifest, committed generation evidence, or writer state. Embedded RunWield lineage complements Pi rather than
replacing it.

### Persist remote Sessions through SFTP or an asynchronous save queue

The product contract is
[Core laptop-owned remote Session saves](../prd/runwield-core-prd.md#laptop-owned-remote-session-saves).

The owner selected synchronous laptop-owned saves after the Session-save proof. Mounted locks cannot establish native
cross-machine exclusion. Guarded stock SFTP and a custom Session SFTP server were set aside; the personal-resource mount
is a separate concern. A queue flushed only at turn end would let synchronous Pi appends return before saving records
that authorize dependent work. The explicit save bridge keeps that ordering at the existing persistence boundary.

### Use a renewable file lease

A timeout cannot prove that the old process stopped or that external side effects are safe to repeat. The OS already
releases a real lock on process loss, so an application-level expiry adds unsafe takeover behavior without benefit.
