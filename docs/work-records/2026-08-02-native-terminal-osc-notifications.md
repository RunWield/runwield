---
kind: "work_record"
recordId: "5fc75401-ff91-49a3-a893-3f3cdc6050d1"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-02T21:46:32.503Z"
tickets:
    - url: "https://github.com/anomalyco/opencode/issues/4454"
provenance:
    sourcePlans:
        - "7525b0d3-0dbe-4b0b-a3fa-ce7cacb8de1a"
---

# Native terminal notifications

## Summary

TUI notifications use Kitty OSC 99, WezTerm/Ghostty OSC 777, or iTerm2 OSC 9, with BEL as the fallback for unsupported terminals. Notification text is sanitized, and notifications are suppressed by default when the terminal is known to have focus. Focus reporting is separated from normal input and cleaned up with the TUI lifecycle.

## Future Planning Notes

Keep notification protocols in the TUI layer and preserve Golden TUI suppression. Unknown focus must not suppress notifications.
