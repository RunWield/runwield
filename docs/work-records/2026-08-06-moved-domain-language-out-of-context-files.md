---
kind: "work_record"
recordId: "94b82c81-ed72-45ed-a2fe-495b7abe143b"
status: "approved"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-06T16:38:27.187Z"
provenance:
    sourcePlans:
        - "fba5a66e-a528-4abf-bad8-e9b109625a75"
    evidence:
        - path: "docs/plans/move-domain-language-out-of-context-files.md"
          note: "Plan Front Matter contains accepted Objective-Failing Check waivers."
---

# Dedicated domain-language documents

## Summary

RunWield keeps domain definitions and their map in dedicated domain-language documents rather than CONTEXT files. CLI startup supports exact-uppercase legacy filename migration without treating lowercase names as equivalent. Agent, Skill, and initialization guidance use the canonical domain-language documents.

## Future Planning Notes

Filename migration tests must account for filesystem case sensitivity. Use separate scenarios or a case-sensitive fixture when names differ only by case.
