---
status: accepted
---

# ADR-012: Segment Session Transcripts at the Execution Handoff

## Context

Planner conversation and tool history consume context and can expose exploratory or superseded reasoning to the
Engineer. Reusing one Pi `SessionManager` across the planning-to-execution Agent switch therefore puts execution at a
disadvantage. Filtering one shared JSONL would be difficult to prove complete, while creating a separate user-facing
Session would break continuous scrollback and Plan workflow ownership.

## Decision

A stable RunWield **Session** may own multiple ordered Pi session JSONL files, each represented in the product as a
**Session Transcript Segment**. The UI projects all segments as one continuous Session Transcript, but the active root
Agent receives model context only from the current segment.

For **Approve & Run**, RunWield activates a fresh persisted execution segment transactionally after the Readiness Gate
and execution preparation succeed, immediately before the Engineer's first turn. The segment starts from the approved
Plan, approval annotations and images, and current execution state; it does not copy or summarize planning messages.
**Approve for Later** does not create an execution segment.

The initial execution segment remains current through implementation and Workflow Validation until a defined successor
context boundary is activated. Isolated Reviewer sessions do not replace it. When Semantic Code Review rejects the
implementation, RunWield seals the current execution or repair segment and activates a fresh persisted semantic repair
segment under the same stable Session. That segment receives the bounded repair packet, not predecessor model history,
and remains current through the repair attempt and its recovery boundaries. Each later semantic repair receives another
successor segment. The Engineer remains active after validation until a new request requires fresh Router triage.

The stable Session ID owns an ordered set of segment IDs and paths, with one current writable segment. The Session
Writer Lock covers segment changes as described in [ADR-015](015-file-authoritative-session-bundles.md). Plan Lifecycle
and worktree records own workflow facts; there is no separate Plan Workflow Lease.

## Consequences

Resume, Workspace/TUI projection, context reporting, cross-process generation tracking, image rehydration, and
transcript search must treat the Session Transcript as an ordered aggregate without injecting sealed segments into
current model context. Segment rollover must be atomic so failed or canceled execution preparation or repair dispatch
cannot leave an empty successor segment current.

This creates fresh implementation and semantic-repair contexts without splitting one user workflow into multiple visible
Sessions, losing earlier owner-visible history, inventing a lossy handoff summary, or changing Plan workflow ownership.
Reviewer sessions remain disposable because they are read-only and do not own recoverable project effects; Engineer
repair segments are persisted because they mutate the worktree and must survive interruption and process loss.
