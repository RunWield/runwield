---
kind: "work_record"
recordId: "1357718d-3f80-4e75-bb42-b23d3d0cbb0c"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-27T21:58:49.371Z"
provenance:
    sourcePlans:
        - "443c871e-f69d-414e-a55a-9a4ba0f2c3c2"
---
# Plan ordering independent of filenames

## Summary

RunWield uses descriptive filenames without added ordinal prefixes for new Plans, including Slicer children and integration repairs. Child menus and completions use front matter `order`, so reordering preserves paths, Plan IDs, and dependency references. Draft regeneration reuses an exact descriptive name or a unique legacy numbered match and rejects ambiguous matches or name collisions before writes. Integration repairs receive their order from child metadata, including children present only on the target branch, rather than from filename digits.

## Out of Scope

This work does not include renaming historical Plans or Work Records, changing top-level menu or Workspace sidebar priorities, redesigning board groups, or changing dashboard activity sorting.

## Future Planning Notes

Plan storage owns shared child naming and ordering. Change `order` to change sequence; change dependencies only when prerequisites change. Filename prefixes and display fallbacks must never define execution order: missing or duplicate child orders allow manual browsing but block automatic next-child selection. Regeneration is limited to drafts, and duplicate descriptive slugs require distinct names rather than ordinal prefixes.
