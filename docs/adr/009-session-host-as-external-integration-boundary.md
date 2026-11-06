---
status: accepted
---

# Session Host as the External Integration Boundary

## Context

RunWield's current interactive runtime stores root Agent Session, active Agent,
pending swaps, UI state, and workflow execution state in process-global
single-session state. That is sufficient for the TUI, but it blocks ACP,
Telegram, Workspace, and other external clients that need multiple independent
sessions in one process.

## Decision

Introduce a multi-session **Session Host** as the runtime owner for RunWield
Agent Sessions, and move session-scoped state out of `session-state.js` globals
into per-HostedSession state rather than adding compatibility shims. The
existing TUI becomes a client of one HostedSession, while ACP and future
transports can create, load, prompt, cancel, and observe multiple HostedSessions
through the same boundary.

## Consequences

This is a deliberate architecture-breaking refactor and should happen on an
isolation branch with TDD coverage proving both TUI behavior preservation and
two-session isolation. The payoff is a single runtime boundary for TUI, ACP,
Workspace UI, and messaging transports instead of separate TUI-only and
external-client execution paths.
