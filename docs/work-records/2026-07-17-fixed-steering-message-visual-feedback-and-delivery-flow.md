---
kind: "work_record"
recordId: "cd816b58-b948-4f79-97d3-077022e01568"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:46:54.074Z"
provenance:
    sourcePlans:
        - "24298e8c-0a8d-466b-bcb0-4f3f13d4879f"
    evidence:
        - path: "src/shared/session/session-runtime.js"
          note: "Owns the small per-session message queue and publishes queued, consumed, and dequeued transitions."
        - path: "src/shared/session/session-runtime-events.js"
          note: "Defines the adapter-neutral queued-message lifecycle event contract used by current and future UIs."
        - path: "src/ui/tui/runtime-adapter.js"
          note: "Projects core queue snapshots and lifecycle events into TUI message blocks without owning queue state."
        - path: "src/ui/tui/chat-session.js"
          note: "Recalls the latest core-queued message into the editor when the user presses Up on an empty input."
---

# Core-owned steering queue, feedback, and delivery

## Summary

SessionRuntime owns queued steering messages in a per-Session array, while interfaces consume Core snapshots and queued, consumed, and dequeued lifecycle events. Messages show immediate steering feedback, become normal user messages when consumed, and retain image attachments. Up on an empty input recalls the latest Core-queued message into the editor without losing earlier entries, even when the underlying Agent API supports only whole-queue clearing. Failed steering or a Session that is no longer streaming sends messages to the local submission queue instead. Cancellation cleanup and local queue recall preserve the delivery flow.
