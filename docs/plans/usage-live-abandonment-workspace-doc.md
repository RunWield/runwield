---
planId: "f2513932-1007-4700-9022-fc67c0754db0"
classification: "PLANNED_CHANGE"
workKind: "DOCUMENTATION"
complexity: "LOW"
affectedPaths:
    - "docs/user-documentation/workspace.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-24T03:34:02.786Z"
origin: "internal"
targetBranch: "main"
status: "ready_for_work"
userVerifiedAt: null
deliveryBranch: "main"
---

# Document Usage Page and Measurement Gaps in Workspace Guide

## Context

Workspace includes a Usage page that displays collected measurements of RunWield usage across Projects and Sessions. When users first encounter the Usage page, gaps in the measurement record (periods with no visible data) may suggest no work occurred. The documentation should clarify that gaps reflect the collected history rather than zero activity, since measurement can be disabled, paused, or started at different times.

## Objective

Add one paragraph to the "What Workspace can do" section of `docs/user-documentation/workspace.md` describing what the Usage page shows and how to interpret gaps in the collected measurements.

## Approach

Insert the paragraph after the existing description of Sessions and Plan Board, before the sentence mentioning the `wld plans ui` command. Use language from the domain glossary (Sessions, Projects, measurements, Workspace) and keep the explanation brief and direct.

## Expected Change Surface

- `docs/user-documentation/workspace.md` — one new paragraph in the "What Workspace can do" section

## Implementation Steps

- `docs/user-documentation/workspace.md` contains a new paragraph positioned after the existing Sessions and Plan Board description and before the `wld plans ui` reference
- The paragraph names the Usage page, explains it displays collected measurements, notes that gaps do not indicate zero work, and uses only existing product terminology
- No other sections, headings, code examples, or existing content in the file change
- No changes to application code, tests, dependencies, CI configuration, `worktree_setup_command`, `.wld/settings.json`, or user-created work

## Verification Plan

- The new paragraph is present, readable, and correctly positioned
- The documentation builds without lint or rendering errors
- Verification passes the project's full CI (`bun run ci`)
