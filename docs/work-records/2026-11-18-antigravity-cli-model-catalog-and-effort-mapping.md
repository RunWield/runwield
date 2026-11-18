---
kind: "work_record"
recordId: "75fbe598-ec37-45af-8d43-51eba9a9fae3"
status: "pending_verification"
scope: "planned_change"
workKind: "MAINTENANCE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-18T02:08:01.845Z"
provenance:
    sourcePlans:
        - "9278ac3d-3788-40d1-8379-e857f4f77239"
---

# Antigravity CLI model catalog and effort mapping

## Summary

RunWield supports `agy-cli/gemini-4-argon`, `agy-cli/gemini-4-hydrogen`, and `agy-cli/gemini-4-carbon` alongside Flash and Pro. The bundled `agy` preset uses Argon for Router, Slicer, Architect, Planner, Ideator, and Reviewer, while other Agents retain Flash and all configured thinking levels stay unchanged. Model selection, supported-model errors, command construction, and transcript validation share a pure catalog and effort mapping, including Hydrogen xhigh. Saved Pro selections and historical model identities remain unchanged, and unavailable models produce visible failures without automatic substitution. Invalid thinking values fail before Agent setup or CLI launch.

## Out of Scope

This work does not include live model discovery, version-dependent presets, Claude or GPT-OSS families, or authentication changes.

## Future Planning Notes

Model availability depends on the user's CLI version and account. Carbon remains selectable without local entitlement; catalog inclusion does not establish account access or image-generation support.

Preserve the shared effort mapping: off/minimal/low map to low; medium maps to medium except for Pro, where it maps to high; high maps to high. Hydrogen maps xhigh/max to xhigh, while the other families cap them at high. Omitted thinking maps to low. Session state retains the original RunWield thinking value.

Chat commands use the base family with `--effort`; image commands use the effort-suffixed model ID with `--effort`. Passive transcript validation must not initialize authentication or model runtime state. Strict verified replay requires complete, consistent concrete-model evidence; base-only backend echoes remain raw evidence and are excluded.

Historical transcripts and usage rows must not be renamed or rewritten. Calculated cost requires an exact price-catalog match; new model names must not inherit guessed prices.
