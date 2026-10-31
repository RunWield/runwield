---
kind: "work_record"
recordId: "bab673b1-4b30-4ead-85a4-1e3f0ed6380b"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-31T21:07:19.236Z"
tickets:
    - url: "https://github.com/RunWield/runwield/issues/466"
provenance:
    sourcePlans:
        - "274d740a-4fd9-4152-824d-d2e90d84f5e3"
---
# Independent Homebrew package refresh and safe publication

## Summary

RunWield's Homebrew release tooling refreshes only wld, preserving the independently maintained Mnemoteca formula and metadata without reading its local version pin. Explicit two-package preparation and Mnemoteca-only refresh remain supported. Publication uses the exact qualified tap revision, checks non-owned content, and rejects concurrent updates through an ordinary push, preventing dependency rollbacks and lost updates. The package checker also requires the installed Mnemoteca version to match the manifest.

## Deviations from Plan

1. Superseded requirement: Implementation Step 8 requires the verified public Mnemoteca v0.3.4 repair to be published directly to tap main after the preventive fix is active. The Verification Plan requires disposable macOS qualification of Stable and Candidate packages and confirmation of the public repair's remote commit before completion.
   Replacement requirement: Finish and verify the preventive source fix in this Session, prepare the narrow Mnemoteca v0.3.4 repair with verified release checksums and GitHub asset digests, and call task_completed with a self-contained handoff for another Session. That Session must confirm the preventive workflow is active, perform the pending disposable macOS Stable and Candidate qualification, publish the verified tap repair directly with an ordinary push, and confirm the remote commit and unchanged wld package. Public publication and its native qualification are not completion requirements for this source-fix Session.
   Reason: The user directed this Session to finish the fix and hand off publication to another Session in the task_completed report.

## Out of Scope

This work does not include publication of the public Mnemoteca tap repair or disposable macOS Stable and Candidate qualification. It does not redesign Mnemoteca's release workflow or change Windows publication.

## Future Planning Notes

Qualify packages on a disposable copy: the Homebrew checker stages and commits changes in its input directory. If the tap advances, take a fresh snapshot and repeat qualification; do not force-push or copy an older manifest over newer content. Recover publication through the corrected workflow rather than rerunning historical workflows that regenerate Mnemoteca from a local pin.
