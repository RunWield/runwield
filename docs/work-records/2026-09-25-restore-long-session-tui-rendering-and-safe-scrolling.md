---
kind: "work_record"
recordId: "15a3c6c3-168f-493f-99e5-f1457295f94f"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-25T18:30:43.114Z"
provenance:
    sourcePlans:
        - "ac424dd4-8296-41f1-aad1-2684d9d920e9"
---

# Long-session TUI rendering and safe scrolling

## Summary

The TUI caches retained transcript rendering so unchanged blocks do not render repeatedly. Terminal input framing prevents fragmented mouse-wheel input from corrupting drafts or cancelling Agent turns. Deliberate Escape cancellation remains intact.
