---
kind: "work_record"
recordId: "684c71d5-d421-465a-94a5-34db50c2dde6"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:50:38.786Z"
provenance:
    sourcePlans:
        - "64cd784c-67b2-4ae5-a4cd-186c2d912ee7"
    evidence:
        - path: "src/shared/session/session-runtime.js"
          note: "Owns UI-independent session lifecycle, prompting, turn exclusion, cancellation settlement, snapshots, and reusable session actions."
        - path: "src/shared/session/session-runtime-events.js"
          note: "Defines the semantic event contract shared by TUI, ACP, and future sibling adapters."
        - path: "src/ui/tui/runtime-adapter.js"
          note: "Projects core runtime events and interactions into TUI rendering and terminal-specific behavior."
        - path: "src/acp/server.js"
          note: "Exposes ACP lifecycle, prompts, cancellation, events, and interactions directly over SessionRuntime."
        - path: "src/shared/session/session-state-imports.test.js"
          note: "Enforces that shared core and tools, including tests, do not depend on TUI or ACP adapters."
        - path: "plans/archived/session-runtime-sibling-adapter-boundary.md"
          note: "Preserves the verified implementation scope, ordering, acceptance criteria, and validation record."
---

# TUI and ACP sibling adapters

## Summary

SessionRuntime provides a project-isolated, UI-independent Session engine that owns lifecycle, prompting, same-Session turn exclusion, cancellation settlement, Session identity, snapshots, actions, semantic events, and interactions. TUI and ACP are sibling adapters over the same adapter-neutral contract and project-aware workflows. Rendering, terminal integration, protocol framing, and TUI composition remain outside shared Core, so additional interfaces can reuse Session behavior.

## Future Planning Notes

In-process adapters use runtime snapshots, actions, events, and interactions rather than mutable HostedSession internals. Core must not import adapter implementation.
