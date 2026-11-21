---
kind: "work_record"
recordId: "82123c4f-9165-485e-b99b-1c93331132b9"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-16T22:32:46.218Z"
provenance:
    sourcePlans:
        - "b1af5661-1331-4c06-843c-21857e18c59a"
---

# Independent Plannotator fork and contribution worktrees

## Summary

The `gandazgul/plannotator` fork provides a contribution workspace separate from RunWield, with `backnotprop/plannotator` as upstream. Host HTML restrictions and annotation context have independent feature worktrees created from the same upstream base. Both worktrees contain the agreed feature Plans, shared proposal, and repository-specific handoff guidance, so each contribution can proceed without coupling it to RunWield's dependency pin.

## Out of Scope

This work does not include either feature implementation, RunWield integration, submodule or dependency-pin changes, or upstream pull request publication.

## Future Planning Notes

Execute the feature Plans in the Plannotator project using its own guidance and checks. Keep the two contributions independent and exclude copied planning documents from upstream feature diffs. Preserve RunWield-only links as external references rather than copying RunWield policy or workflow machinery into Plannotator.
