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

Implemented and verified clickable Project-relative Markdown mentions in Agent messages, preserving visible text,
transcripts, excluded content, and plain-text fallback. A lazy, token-protected reader supports concurrent tabs,
current-file reloads, safe local images, Session token/root rotation, and cleanup. Linked Close leaves the host running;
known document labels and Work Record notices remain intact. Updated usage docs and Core requirements. Automated checks
and real CLI/browser checks passed. Publication remains pending; this work is not yet merged or delivered.

## Future Planning Notes

Document mentions provide navigation only; they do not register Session Artifacts. Reuse the shared reader for passive
document navigation, with canonical containment checks on every read. Run Workspace tests through the existing isolated
runner to prevent process-state conflicts.
