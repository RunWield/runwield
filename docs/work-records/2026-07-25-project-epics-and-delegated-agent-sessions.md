---
kind: "work_record"
recordId: "0e208d7f-c0e2-4732-a4a5-14802e0aee27"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-25T22:09:07.422Z"
provenance:
    sourcePlans:
        - "dfe26cae-9d6f-47cc-a555-8aaf9ecc24e5"
        - "1b4a45ba-665c-48e0-9af1-b1b2a29d9df3"
---

# PROJECT Epics and delegated Agent Sessions

## Summary

PROJECT classification alone identifies non-executable Epics, without legacy task-table or task-DAG execution. Approval leads to decomposition or child selection rather than Engineer execution of the Epic; executable child Plans remain the delivery unit. Foreground delegated Agent Sessions provide bounded, context-isolated read or write work under parent ownership.

## Future Planning Notes

PROJECT Plans must not require an additional Epic type marker or become executable containers. Epic container readiness is distinct from executable Plan readiness. The foreground delegation design uses lease-limited helpers with up to three readers or one exclusive writer, prohibits recursive delegation and commits, and leaves results and edits with the parent.
