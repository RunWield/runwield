---
kind: work_record
recordId: ac7469b4-a3b4-41bd-b61b-b65be06eae18
status: approved
scope: feature
origin: external
completionMode: verified
createdAt: 2026-07-14T08:32:00-04:00
provenance:
    evidence:
        - path: src/shared/session/agent-switching.js
          note: Implements the sole active-Agent transaction, including root, handler, model policy, execution CWD, and configured tools.
        - path: src/shared/session/session.js
          note: Provides strict turns on an already-active root plus the separate disposable isolated-Agent session path.
        - path: src/shared/session/session-runtime.js
          note: Owns atomic activation plus aggregate busy lifecycles for prompts and direct model or workflow operations.
        - path: src/shared/session/agent-handler.js
          note: Produces explicit completion or handoff results without scheduling mutable agent-switch state.
        - path: src/shared/session/session-runtime-events.js
          note: Publishes completed semantic agent changes for sibling consumers without a presentation dependency.
        - path: src/ui/tui/runtime-adapter.js
          note: Consumes Runtime agent-change events and renders authoritative Runtime snapshot state without a core UI setter.
        - path: src/shared/session/architecture-boundary.test.js
          note: Enforces the consumer-neutral boundary and absence of the deleted two-phase activation API.
---

# Atomic active Agent switching

## Summary

RunWield performs active Agent transitions as one Runtime-owned operation, committing the root Agent Session, handler, model policy, execution context, and tools together. Handler construction failures preserve the previous usable pair. Interactive root turns cannot switch their own root, and disposable subagents use isolated Sessions. TUI and ACP consume the same semantic Runtime state and events, while Runtime owns aggregate busy state.
