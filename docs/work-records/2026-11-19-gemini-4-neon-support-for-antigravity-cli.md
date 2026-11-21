---
kind: "work_record"
recordId: "617f16b3-0df9-48ec-8904-2c7f2221c4bc"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-19T20:54:06.899Z"
provenance:
    sourcePlans:
        - "c77d1133-5fe2-4e87-9b72-0813f050b50a"
---

# Gemini 4 Neon support for Antigravity CLI

## Summary

RunWield supports `agy-cli/gemini-4-neon` in model commands, Agent settings, and Session model changes, with shared effort mapping for chat and image generation. Neon supports low, medium, high, and xhigh effort; both xhigh and max thinking map to xhigh. The bundled `agy` preset uses Neon for Router, Slicer, Guide, Engineer, Frontend Engineer, and Init; Hydrogen for Operator; and Argon for Planner, Ideator, Architect, and Reviewer. Existing thinking levels and override precedence stay unchanged, so personal and project settings still take precedence. Neon model selection rejects concrete-family or effort mismatches, and transcript replay accepts only consistent, verified model facts.

## Out of Scope

This work does not include the Neon orchestrator entry, Claude or GPT-OSS families, changes to sign-in or tool permissions, or changes to historical transcripts. Effort-suffixed IDs remain unsupported as user-selectable model IDs.

## Future Planning Notes

- The Antigravity catalog owns family membership and xhigh support. Neon and Hydrogen support xhigh; other families retain their existing effort mappings.
- A base-family `backendModel` value does not prove the concrete effort. Preserve the raw fact, but exclude it from verified replay.
- The bundled preset requires Neon and Hydrogen access. Access failures and unsupported CLI models remain visible errors, with no automatic fallback. Flash remains selectable outside the bundled preset.
- Neon has no exact built-in price. Calculated cost remains unavailable unless an exact price is available.
