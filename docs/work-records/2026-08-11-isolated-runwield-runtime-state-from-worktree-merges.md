---
kind: "work_record"
recordId: "dc1e7c94-a38a-418d-9c63-4550fb3583ca"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-11T16:31:08.168Z"
provenance:
    sourcePlans:
        - "ea4f8a95-7e76-435f-90d2-d811f8450885"
---

# Isolated RunWield Runtime State from Worktree Merges

## Summary

RunWield now redirects project settings from linked execution worktrees to the primary checkout, classifies
RunWield-owned runtime paths, excludes that runtime state from git staging and merge-risk checks, restores missing
worktree registry entries from Plan evidence, and documents the non-destructive recovery path. This prevents
RunWield-owned `.wld` state from blocking publication or causing users to discard finished work.

## Deviations from Plan

`deno task ci` still failed in unrelated or remaining workflow and golden-scenario tests after the targeted
implementation passed. Manual verification against the external `tow-mvp-epic/01-convert-source-and-tests-to-typescript`
project state was not run because that state was required.

## Deferred Work

Investigate the remaining `deno task ci` failures in `src/shared/workflow/validation-publication-pause.test.js`,
`src/ui/tui/golden-scenarios/project-workflow.test.ts`, and
`src/ui/tui/golden-scenarios/repaired-merge-publication.test.ts`. Run the external manual recovery check when the
required project state is available.

## Future Planning Notes

Keep RunWield-owned runtime paths enumerated, not treated as all of `.wld`, because project-owned agents, skills, prompt
templates, and settings can be valid deliverables. Use real git fixtures for worktree and registry behavior instead of
injection seams.
