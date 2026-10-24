---
kind: "work_record"
recordId: "ebea1860-80bb-4dff-bcd7-87e95a942bbf"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-27T04:07:42.506Z"
provenance:
    sourcePlans:
        - "8fda9ae2-072a-4c8e-91dd-c635c67ffb14"
---

# Candidate release and Stable promotion

## Summary

Release workflows support Candidate creation, Candidate promotion, and direct Stable publication with explicit build identity. Candidate releases remain prerelease and not latest; Stable releases become latest.

## Future Planning Notes

Tag pushes require fail-closed preflight, and CI remains the sole release creator. Candidate and Stable tags that share source require explicit build identity.
