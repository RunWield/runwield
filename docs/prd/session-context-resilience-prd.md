# Product Requirements Document: Session Context Resilience

Last updated: 2026-07-27 15:30 EDT

## Objective

Make long-running RunWield Agent Sessions resilient to context-window pressure during autonomous model/tool activity,
not only before a User Request or after an Agent Session becomes idle.

RunWield should compact early enough to avoid preventable overflow, continue interrupted work safely, and stop automatic
compaction when another attempt would make no useful progress.

## Problem Statement

RunWield currently checks whether compaction is needed before submitting a prepared User Request. Pi also provides its
own threshold and overflow compaction paths. Those protections do not guarantee that context is re-evaluated soon enough
during one long autonomous run that chains many model and tool turns before becoming idle.

This matters particularly for execution, validation repair, research, and other workflows that can perform many tool
calls under one outer Runtime turn. Context may grow substantially after RunWield's pre-prompt check. If compaction
happens only after overflow, the Agent Session may lose time, repeat work, or become difficult to recover. Repeated
automatic compaction can also become harmful when the remaining context is not meaningfully compressible.

The current little-coder architecture demonstrates this failure mode against the same Pi ecosystem. Its wrapper now
monitors context during autonomous activity, resumes work after mid-run compaction, and pauses automatic compaction when
a compaction fails or frees too little context. RunWield should verify the failure independently and adopt the product
semantics that prove necessary rather than copying its implementation verbatim.

## Resolved Assumptions

### Universal Runtime Reliability

- Session Context Resilience is a Core reliability capability, not a small-model adaptation.
- It should protect supported Agent/model combinations without changing Routing Intent, Agent ownership, Plan Status, or
  validation semantics.
- TUI and ACP users receive the same context protection and recovery behavior.

### Existing Controls and Useful Recovery

- Existing controls for manual compaction, automatic compaction, resume compaction, and cancellation remain valid.
- Long autonomous work receives context protection without waiting for another user message.
- A failed or ineffective compaction pauses automatic retries and offers a useful recovery action instead of looping.
- Independent Sessions remain usable while one Session compacts.

### Continuation Must Preserve Intent

- Mid-run compaction should continue the same assigned task when safe rather than strand the Agent Session at an idle
  prompt.
- Continuation context should tell the Agent to rely on the compaction summary and avoid restarting discovery or
  re-reading unchanged material without reason.
- Continuation preserves the active task, user interactions, and cancellation behavior.
- If safe continuation cannot be guaranteed, RunWield should stop and explain the condition rather than silently start a
  second unrelated User Request.

### Workflow Handoffs

Compaction protects unexpectedly long tasks. When a workflow deliberately starts a new phase with selected context, that
phase should receive the relevant instructions and evidence without carrying forward unrelated prior activity. The user
still sees the same Session and task history.

The architectural choice for these handoffs is recorded in
[ADR-012](../adr/012-segment-session-transcripts-at-execution-handoff.md).

### Failure and Cancellation

- User cancellation must abort active compaction and any associated continuation.
- Compaction failure must not wedge the Agent Session or prevent a later manual recovery action.
- Users can tell whether compaction is in progress, finished, cancelled, or paused after failing to help.

### Privacy-Safe Observability

- RunWield may record content-free context-health measurements through the existing opt-in workflow metrics surface.
- Measurements may include context percentage bands, compaction reason, duration, recovered headroom, continuation
  result, and pause/re-arm outcomes.
- Metrics must not include prompts, summaries, tool arguments or results, file contents, URLs, or other session content.

## Product Experience

For ordinary sessions, this capability should be invisible. Users should see a concise status only when RunWield:

- compacts during an active task;
- pauses automatic compaction because it made insufficient progress;
- cannot continue safely;
- or requires the user to free context, compact manually, clear the session, or select a larger-context model.

A mid-run compaction should not look like a completed task, a new routed request, or a failed Plan. The active Agent and
workflow remain unchanged.

## Delivery

Reproduce the reported long-run problem in RunWield before choosing an intervention. Compare behavior before and after
on a long autonomous task, including ineffective compaction and user cancellation. The implementation and verification
steps belong in the [Session Context Resilience Plan](../plans/automatic-session-context-resilience.md).

## Success Criteria

- A reproduced long autonomous run compacts before avoidable context overflow.
- Work safely continues after mid-run compaction without user prompting or duplicate routing.
- Ineffective compaction cannot cause an automatic retry loop or unusable Agent Session.
- Cancellation stops compaction and continuation, leaving the Session usable.
- TUI and ACP users see equivalent progress and final outcomes.
- Context intervention does not change Plan Lifecycle or validation outcomes except by allowing the assigned work to
  continue.
- A new workflow phase receives its intended context without inheriting irrelevant, nearly exhausted prior context.

## Out of Scope

- Replacing Pi's compaction summary algorithm.
- Building the Research Evidence Set described in `docs/vision/research-evidence-set-prd.md`.
- Automatically changing models or context-window configuration.
- Persisting arbitrary tool output outside normal Agent Session storage.
- Treating compaction as durable project memory or a Work Record.
- General prompt compression unrelated to demonstrated context-health failures.
- Replacing explicit planning-to-execution or semantic-repair segment boundaries with automatic compaction.

## Dependencies and Sequencing

This capability can proceed independently of selective model adaptation. It must preserve deliberate workflow handoffs
and contribute long-run reliability evidence to [Agent Evaluation and Benchmark Harness](agent-behavior-evaluation-prd.md).
