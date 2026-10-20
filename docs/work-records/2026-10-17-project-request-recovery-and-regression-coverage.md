---
kind: "work_record"
recordId: "85f37a6b-6297-46f7-a17d-399d75f3f2f2"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-17T17:51:07.369Z"
tickets:
    - url: "https://github.com/gandazgul/runwield/pull/315"
provenance:
    sourcePlans:
        - "59cd99ae-2682-4a76-8e79-047b2b4799e7"
---

# Project request recovery

## Summary

The shared Project link/relink form and maintenance operations show loaders and block duplicate submissions while requests are pending. Failed or interrupted requests restore controls, retain form values, and allow retry. Non-JSON HTTP errors show a fallback message. Directory confirmation remains intact.

## Future Planning Notes

Exercise browser handlers through native events so incorrect event bindings fail. Cover interrupted response bodies as well as rejected fetches; both can leave request controls stuck without recovery.
