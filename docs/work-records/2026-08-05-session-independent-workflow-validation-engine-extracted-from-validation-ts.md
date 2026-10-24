---
kind: "work_record"
recordId: "23132ec9-d776-4762-94c4-971c940f64c4"
status: "approved"
scope: "planned_change"
workKind: "REFACTOR"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-05T04:29:06.200Z"
provenance:
    sourcePlans:
        - "4a63fb51-d786-4e68-8772-2cbb4e928198"
---

# Session-independent Workflow Validation engine

## Summary

Workflow Validation sequencing, convergence policy, and gate predicates live in a Session-independent engine. A Session adapter supplies Agent turns, interactions, progress, and isolated review through typed capability contracts. The public composition root preserves existing callers, while Plan Lifecycle, registry, and lock operations remain engine-owned machinery.

## Future Planning Notes

Keep external capabilities behind typed ports and RunWield-owned state transitions as direct dependencies. Session adapters must translate backend messages into semantic outcomes rather than expose transcript inspection to the engine.
