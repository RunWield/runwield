---
kind: "work_record"
recordId: "9bd185a2-7497-48fc-b694-1fce976c02d5"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-09T13:57:46.087Z"
provenance:
    sourcePlans:
        - "fb4da170-2416-48ca-b0e8-1936c74bc548"
---

# Clickable TUI Markdown document mentions

## Summary

Project-relative Markdown mentions in Agent messages open a shared document reader while preserving visible text, transcripts, excluded content, and plain-text fallback. The lazy, token-protected reader supports concurrent tabs, current-file reloads, safe local images, Session token and root rotation, and cleanup. Closing a linked document leaves the host running and preserves document labels and Work Record notices.

## Future Planning Notes

Document mentions provide navigation only; they do not register Session Artifacts. Reuse the shared reader for passive document navigation and enforce canonical containment on every read.
