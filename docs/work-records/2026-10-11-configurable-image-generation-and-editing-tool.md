---
kind: "work_record"
recordId: "0b0ff924-dff9-40d5-a9b4-10a3d258f090"
status: "approved"
scope: "planned_change"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-10-11T03:18:43.358Z"
provenance:
    sourcePlans:
        - "3fff46f4-f3d0-4247-8709-e03d80dfbdca"
---

# Configurable image generation and editing tool

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. Implemented `create_image`
with Pi, Agy CLI, official Codex App Server, and experimental OpenCode Responses routes. Scoped settings select the
provider and model; Agents cannot change the billing route. The tool supports reference images, validates raster data
and output paths, converts PNG/JPEG/WebP, saves without overwriting existing files, and handles cancellation. Agent
registration, MCP access, capability-aware results, and bundled conversion assets are included. The user established
verification with the note: “This was implemented by Codex”. This is user verification, not a claim that RunWield
Workflow Validation passed.

## Deferred Work

Live provider acceptance remains: Pi generation/editing, Agy structured native output, Codex
generation/editing/cancellation, and OpenCode hosted-image capability. OpenCode remains experimental after a
model-access denial. Full-package asset acceptance and TUI/Workspace image persistence journeys also remain. Direct
Google SDK integration, graphical image-model controls, extra rendering parameters, multiple-image output, and bounded
remote generation are outside this slice.

## Future Planning Notes

Protocol fixtures and model listings do not establish live image-generation capability. Preserve explicit provider
failures without fallback to another billing route. Native CLI success requires correlated completion events and a fresh
output file within allowed storage; prompting alone is not a sandbox.
