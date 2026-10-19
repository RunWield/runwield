---
status: accepted
---

# ADR-014: Attached Workflow Coordination Boundary

## Context

Attached Mode lets an External Agent Host such as Claude Code own the user conversation, model access, and every agent
turn while RunWield remains authoritative for Plans, Plan Lifecycle transitions, review, execution isolation,
validation, recovery evidence, Work Records, and organizational memory.

ADR-010 established the TUI and Agent Client Protocol (ACP) server as sibling adapters over `SessionRuntime`. Those
adapters still ask RunWield to construct and execute a Hosted Session. Attached Mode is materially different: no
RunWield Hosted Session or Pi `AgentSession` exists for the host conversation, and importing the host transcript is
explicitly prohibited. Treating Attached Mode as another `SessionRuntime` adapter would either make RunWield the model
executor or force `SessionRuntime` to represent a conversation and transcript it does not own.

The current workflow orchestrator and validation loop interleave durable workflow decisions with Pi session turns.
Agent-neutral authorities already exist below that coupling, including the Plan Lifecycle state machine, Plan Store,
worktree registry, review ledger, merge safeguards, and Work Record generation. Attached Mode must reuse those
authorities without copying their state machines into a Claude-specific adapter.

Claude Code also exposes different integration surfaces for different responsibilities. A command starts the workflow,
Model Context Protocol (MCP) tools carry structured model-facing operations, and subagents supply isolated workers. No
one host transport covers the complete integration. The first release must remain local and on demand rather than
requiring an always-running RunWield daemon.

RunWield follows the Pi approach to agent tools: it gives the model good instructions and trusts it to follow them. In
Core, the Planner has unrestricted edit, write, and shell tools and is told to write only Plan files. Only the Guide is
restricted, because a safe read-only agent is its purpose. Attached Mode uses the same trust model.

## Decision

Introduce an `AttachedWorkflowCoordinator` as a sibling runtime to `SessionRuntime`, not as a `SessionRuntime` adapter.

The coordinator owns only Attached Workflow concerns:

- binding one explicitly activated External Agent Host request to one durable Attached Workflow;
- capability preflight and disclosed fallback decisions;
- determining the next required RunWield role or external action;
- delivering versioned role and structured-outcome contracts to the host adapter;
- validating host-submitted outcomes against current durable state;
- checkpointing pending external effects and safe continuation after process loss; and
- invoking existing RunWield domain authorities for Plan, worktree, validation, review, recovery, Work Record, and
  memory transitions.

The coordinator must not construct a Hosted Session or `AgentSession`, invoke a model provider, persist a Session
Transcript, or mutate Plan Status directly. Host assertions are orchestration evidence, not authority to bypass domain
guards.

Use short-lived `wld attached ...` command-line interface (CLI) operations as the canonical local coordination boundary.
Every operation loads durable state, validates the current workflow checkpoint and ownership, performs one bounded
transition or reports the next required action, then exits. This preserves on-demand Core operation and makes process
loss recoverable from artifacts rather than process memory.

Store each Attached Workflow Record in the user's home, at
`~/.wld/attached/<encoded primary checkout root>/workflows/<workflowId>.json`. The key uses the same encoding as
Sessions and execution worktrees, so every linked worktree of a repository finds the same records. When no home
directory exists, records fall back to the primary checkout's internal runtime directory, as worktrees do. The record
keeps the canonical primary checkout root as binding evidence. When the key and that root disagree, for example after
the project folder moves, the coordinator reports a recovery case and never matches the record to another project.

Attached Workflow Records are not Project Runtime State under ADR-017. Like a Session, a record describes one host
request, not Plan controller state. Keeping it in home means that activation and Triage write nothing to the repository:
no `.wld/internal/` directory and no managed `.gitignore` block. The first repository write happens when an Attached
Workflow submits a Plan. That step records the Plan reference on the Attached Workflow Record and previews the
repository setup it needs. The record does not claim exclusive ownership of the Plan: a Plan written in an Attached
Workflow is an ordinary Plan, and the user can later run it with `wld`. A later Plan Store change moves these records
together with Sessions.

Provide MCP as a thin protocol adapter over the same coordinator operation surface for model-facing structured tools.
The MCP adapter may translate framing and schemas but must not contain Plan Lifecycle, validation, worktree, or recovery
logic.

Deliver role instructions at run time. Each coordinator response that hands a role to the host carries that role's
current instructions, resolved from the project, home, and bundled agent definitions in the same order Core Sessions
use, and a map from RunWield tool names to host tool names. The adapter package ships no generated Skills or copied role
prompts, so no copy can go stale. In Claude Code these instructions arrive as a tool result rather than a system prompt;
that is an accepted compromise of the Attached model. Subagents receive the instructions in their task prompt.

Do not add hooks or permission rules that restrict host tools during an Attached Workflow. Role boundaries, such as "the
Planner writes only Plan files," come from the role instructions, as they do in Core.

Before the Claude FEATURE Preview is implemented, extract the Workflow Validation sequencing, convergence policy, and
gate predicates from the Pi-coupled validation loop into a separately planned session-independent validation engine.
Both `SessionRuntime` orchestration and the `AttachedWorkflowCoordinator` must consume that engine. The extraction must
preserve existing Native and Managed behavior and is a hard prerequisite for Attached execution and validation.

## Consequences

- Attached Mode cannot reuse ACP as its coordination boundary: ACP remains a client protocol for RunWield-executed
  Sessions, while Attached keeps the External Agent Host as executor.
- `SessionRuntime` remains unchanged by the Attached integration and does not import Attached modules. Both runtimes
  depend downward on shared domain authorities; neither runtime may use the other as a source of truth.
- Plan Lifecycle, worktree, validation, review, and Work Record semantics remain shared structurally. A Verified Plan
  cannot acquire an Attached-specific meaning.
- The Attached coordinator needs its own durable request binding and external-action checkpoints, but these records must
  reference rather than duplicate Plan Status, Plan Events, worktree registry state, or validation evidence.
- Attached Review Rounds persist identity and the actual reviewed revision before opening Plannotator. A browser
  decision applies through Core and commits its Attached outcome before acknowledgment. The MCP process hosts the
  surface, reuses its page across rounds, and stops it when the host transport closes. `status` rehosts a pending round
  after process loss or returns its saved outcome; `/runwield:plan-review` can find the project's most recent open
  workflow in a fresh host conversation. No host transcript enters the payload or record. Core's local
  `waitForDecision()` promise remains a waiter, not Attached review authority.
- The adapter needs a versioned compatibility matrix and black-box coverage for supported Claude Code versions, subagent
  isolation, cancellation, and worktree handoff.
- The only runtime restriction on Attached code is that it never starts a model turn. Attached modules may import shared
  code that also loads Pi packages, such as settings and agent-definition loading, provided they do not construct a
  Hosted Session or `AgentSession` or call a model provider.
- Planning in Claude Code has the same guarantees as planning in Core: the Planner is instructed, not sandboxed.
  Documentation must not describe the instructions as a hard gate.
- Validation-engine extraction is delivered and verified independently before the Attached Epic can execute its
  validation journey. This avoids implementing and later discarding a second 2,000-plus-line validation loop.
- Future Codex, OpenCode, and Pi adapters may reuse the same coordinator and CLI/MCP semantics, but they remain outside
  the Claude FEATURE Preview scope and require capability-specific Preview Epics.
- The existing Claude CLI execution-backend project remains a distinct Managed-mode integration. Its MCP transport may
  later share protocol utilities, but neither project depends on the other's model-execution direction.
