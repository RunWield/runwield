---
kind: "work_record"
recordId: "4da4c2b4-fec3-427a-80f8-deb6ec142bbf"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-26T01:57:45.766Z"
provenance:
    sourcePlans:
        - "e4419e07-9327-4305-91b3-7570aadffa90"
---
# Child Plan deviations in Epic integration context

## Summary

Epics show confirmed child Plan deviations in a managed Child Plan Deviations subsection under the Objective. Deviation blocks and Integration Notes are written in the child's execution checkout and travel with its delivery to the Epic branch. Integration review treats confirmed replacements as user-approved and reports affected Epic outcomes as advisories rather than findings for gaps caused only by those replacements. Unrelated defects and missing work required by a replacement remain findings.

## Out of Scope

This work does not include Sequence containers or changes to sibling review context.

## Future Planning Notes

Child Plan front matter remains the authority for confirmed deviations; the Epic subsection is a projection, not Epic-level deviation metadata. Epic Work Records must continue to aggregate child front matter rather than the projection to avoid duplicates. Projection updates must remain idempotent and run on recording retries and before both publication checkpoints. Integration review must continue to read the Epic document from the Epic branch head.
