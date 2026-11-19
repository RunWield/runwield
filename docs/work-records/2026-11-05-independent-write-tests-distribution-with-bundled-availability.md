---
kind: "work_record"
recordId: "0506633d-ea5f-4f79-bde3-61cb86939b5e"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-05T16:10:10.224Z"
provenance:
    sourcePlans:
        - "ced024e1-f8ce-4da0-96c5-bf810f3a5106"
---

# Independent Write Tests distribution with bundled availability

## Summary

The Write Tests Skill is available under MIT terms from `RunWield/skills` without a Core installation. RunWield retains the same instructions as a bundled Skill, available through `/skill:write-tests` without the public checkout. Both distribution paths preserve the existing test-authoring guidance and catalog precedence. Independent content comparisons and compiled-package invocation checks protect against instruction drift and missing bundled assets.

## Out of Scope

This work does not include a RunWield release or changes to test-authoring policy.

## Future Planning Notes

Maintain the public package and bundled copy together; only their license-path metadata may differ, and license bytes must match. Accepted sync hashes do not replace independent content parity checks. Publish the public Skills revision before pinning it in Core, and preserve bundled invocation without runtime access to the public checkout.
