---
kind: "work_record"
recordId: "3947320a-8ed1-4533-bd1f-9380fa904ae2"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-16T23:48:52.572Z"
provenance:
    sourcePlans:
        - "1b83df5e-6d5a-44bb-9920-f82e96f81968"
---

# Stable docs artifacts and safe release integration

## Summary

Stable docs archives use checksum and publication gates. Docs deployment uses the Stable docs branch and published bytes when the source matches, while retaining correction and legacy recovery paths. Stable publication creates one docs commit per release, reuses it on retries, and preserves cumulative corrections through push races. CI integrates Release Branches into main without force and requires fresh remote ancestry checks before leased deletion; Candidate publication remains unchanged.

## Future Planning Notes

Pages authorization uses the workflow run’s ref, not its checkout ref. Dispatch release deployment on the Stable docs branch; changing the checkout alone does not resolve tag-ref rejection.
