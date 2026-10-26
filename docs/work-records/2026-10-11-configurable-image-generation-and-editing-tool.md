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

The user attested verification; RunWield Workflow Validation did not establish this result. RunWield provides create_image through Pi, Agy CLI, Codex App Server, and experimental OpenCode Responses routes. Scoped settings select the provider and model; Agents cannot change the billing route. The tool accepts reference images, validates raster data and output paths, converts PNG/JPEG/WebP, saves without overwriting existing files, and handles cancellation. The tool is registered for Agents, is available through MCP, and returns capability-aware results.

User note: This was implemented by Codex.

## Out of Scope

This work does not include direct Google SDK integration, graphical image-model controls, extra rendering parameters, multiple-image output, or bounded remote generation.

## Future Planning Notes

Protocol fixtures and model listings do not establish live image-generation capability. Preserve explicit provider failures without fallback to another billing route. Native CLI success requires correlated completion events and a fresh output file within allowed storage; prompting alone is not a sandbox.
