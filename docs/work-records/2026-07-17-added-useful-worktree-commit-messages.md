---
kind: "work_record"
recordId: "cf8d91f9-2329-4942-b941-c3e04a7c72a2"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:52:29.893Z"
provenance:
    sourcePlans:
        - "9ba48edf-2775-4b04-9ee7-822960e5d798"
---

# Plan-aware worktree commit messages

## Summary

Automatic validation and manual recovery use deterministic, Plan-aware messages for dirty-worktree commits. Plan names and summaries supply context, while callers without metadata receive a stable fallback.
