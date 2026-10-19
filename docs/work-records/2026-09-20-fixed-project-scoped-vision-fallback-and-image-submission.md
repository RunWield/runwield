---
kind: "work_record"
recordId: "421bead8-a69a-46da-94cb-44d08bf2ecde"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-20T03:13:15.722Z"
provenance:
    sourcePlans:
        - "6bbcd530-97b4-471e-bf8b-a6507e808f35"
---

# Project-scoped vision fallback and image submission

## Summary

Vision fallback resolves lazily within the Project across Runtime, TUI, Workspace, steering, and image viewing. Text-only startup does not validate unused fallback configuration. Image submission validates the destination model before acceptance, preserves rejected drafts and previews, prevents optimistic duplicates, and returns an HTTP 422 rejection response.

## Future Planning Notes

Keep image validation lazy and Project-scoped. Validate the model used for submission before user events, transcript writes, receipts, or composer clearing.
