---
kind: "work_record"
recordId: "b8079944-3169-4e06-b724-fd53a271e9d4"
status: "pending_verification"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-31T19:58:42.202Z"
provenance:
    sourcePlans:
        - "d21a5c60-a381-443a-9c8d-bbd26cfdc90f"
---

# Workspace Plan parse warnings

## Summary

Workspace keeps healthy Plans and Sessions visible when an active Plan has malformed front matter. The sidebar names the affected document and provides a warning tooltip through hover, keyboard focus, or touch; its link opens the Plan Board, which shows named diagnostics alongside healthy content. Refresh removes warnings after correction or deletion. Active target discovery excludes archived Plans before parsing. Partial results support browsing only; strict identity, detail, and action readers retain their existing contracts.

## Out of Scope

This work does not include automatic YAML repair, archive editing, a malformed-document editor, or unrelated sidebar redesign.

## Future Planning Notes

Display catalogs must resolve document authority before choosing healthy content or diagnostics; a broken authoritative document must not expose a stale healthy copy. Malformed metadata must not supply guessed IDs, statuses, or parent relationships, and partial reads must not authorize actions. Passive reads must not repair files, assign IDs, fetch target data, or create runtime state. Browser diagnostics must remain escaped text and must not expose absolute local paths or raw error objects.
