---
kind: "work_record"
recordId: "0dad7cd1-7093-4b8e-8dae-42e355c8a50f"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-05T16:07:07.448Z"
provenance:
    sourcePlans:
        - "75555277-e239-41d4-8d26-cc6c1dc2adfe"
---

# Persistent Codex model and thinking preferences per role

## Summary

RunWield Connect for Codex stores model and thinking-level preferences for each supported workflow role in personal and project `connect.codex.roles` settings. Each field resolves independently from project settings, then personal settings, then native Codex inheritance; explicit `inherit` resets that field without changing the other. Current-host dispatch metadata carries these preferences through normal, compact, resumed, and instruction responses, including linked worktrees. Codex worker guidance applies explicit spawn arguments and omits inherited arguments, keeping Connect preferences separate from Core model settings.

## Out of Scope

This work does not include a new settings UI, generated Codex agent files, or changes to Core model presets or Claude model selection.

## Future Planning Notes

Resolve saved preferences at the next role dispatch using the current calling host, not the workflow's origin host. Do not restart active workers after settings edits. Inherited effort with an explicit model delegates effort selection to Codex and can use that model's default. Codex owns model and effort availability; unsupported explicit preferences must not trigger silent substitution. Preserve fresh independent review contexts and use fresh workers for Router or initial Planner when either field is overridden.
