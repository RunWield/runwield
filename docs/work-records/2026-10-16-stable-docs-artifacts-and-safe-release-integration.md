---
kind: "work_record"
recordId: "3947320a-8ed1-4533-bd1f-9380fa904ae2"
status: "pending_verification"
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

Implemented qualified Stable docs archives with checksum and publication gates. Docs deployment now runs from `docs/stable` and uses published bytes when the source matches, while preserving correction and legacy recovery paths. Stable publication creates one docs commit per release, reuses it on retries, and preserves cumulative corrections through push races. CI now integrates Release Branches into `main` without force and requires fresh remote ancestry checks before leased deletion. Candidates remain unchanged. Release policy, the Public documentation PRD, and setup guidance were updated. Focused verification reported 130 passing tests and mutation checks for key failure paths.

## Deferred Work

Two existing broken PRD links remain in `docs/plans/archived/home-system-folder-warning.md`; the archived Plan was left unchanged.

## Future Planning Notes

Pages authorization uses the workflow run's ref, not its checkout ref. Keep release deployment dispatched on `docs/stable`; changing the checkout alone does not resolve tag-ref rejection.
