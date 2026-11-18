---
kind: "work_record"
recordId: "0eb835ce-8524-41e7-a11b-d2bf84949fec"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-03T00:32:12.289Z"
provenance:
    sourcePlans:
        - "75555277-e239-41d4-8d26-cc6c1dc2adfe"
---

# Persistent Codex model and thinking settings per role

## Summary

RunWield Connect stores Codex model and thinking-level preferences for each supported role in personal and project `connect.codex.roles` settings. Each field resolves independently from project to personal settings to native inheritance; explicit `inherit` resets that field by omitting its host spawn argument. Preferences survive process restarts and reach the next role dispatch through normal, compact, resumed, and instruction responses, including from linked worktrees. Invalid settings produce actionable diagnostics instead of silent fallback. This gives Codex roles persistent choices without coupling them to Core model presets.

## Out of Scope

This work does not include a settings UI or model preferences for other Connect hosts.

## Future Planning Notes

Codex preferences apply to the current calling host, not the workflow's origin host. Keep Codex-native model IDs and effort values separate from Core presets; an explicit model with inherited effort can use that model's default effort. Preserve fresh, independent review contexts and use fresh workers for Router or initial Planner when either field is overridden. Unsupported explicit preferences must remain visible and resumable, without silent model substitution.
