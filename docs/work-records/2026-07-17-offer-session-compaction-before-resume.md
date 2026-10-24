---
kind: "work_record"
recordId: "d72f0c3e-8ab5-460b-97b6-05b8d3506f64"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:50:01.896Z"
provenance:
    sourcePlans:
        - "a1d46cfe-1b25-4144-bd33-f71e4316e09d"
---

# Session compaction before resume

## Summary

The /resume workflow estimates the selected Session's token use before loading it. Sessions above the configured context-window threshold offer Compact now, Resume as-is, or Cancel. The flow handles model-context fallback, compaction failure or cancellation, and normal message restoration.
