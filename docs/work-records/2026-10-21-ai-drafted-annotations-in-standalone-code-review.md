---
kind: "work_record"
recordId: "6127923c-9c2f-4fa3-8e58-eca6e7dcc09b"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-21T16:09:47.355Z"
provenance:
    sourcePlans:
        - "fd55996c-a04a-45b8-bc67-b24df82af0e2"
---

# AI-drafted annotations in Standalone Code Review

## Summary

Standalone Code Review offers a manual Run AI Review action that runs the review skill read-only across Standards, Spec, and Tests, with cancellation and usage, model, time, and cost reporting. Findings become editable, deletable annotations that the owner can post to a PR or send to Engineer, with axis and severity labels preserved in the text. Findings use inline positions only within the reviewed diff, falling back to file or general annotations when needed. Reruns replace only unedited AI annotations, preserve owner edits and manual annotations, and reject results for an older patch.

## Out of Scope

This work does not include Run AI Review controls in validation-time Code Review or Workspace owner sessions, large-patch chunking, or AI-generated code suggestions.

## Future Planning Notes

Standalone Run AI Review is distinct from Semantic Review and must not post comments or edit files itself. Resolve the review skill through the project-aware catalog so project overrides apply. Spec discovery is non-interactive; when no spec is available, report that absence without inventing requirements. Keep generation explicitly owner-triggered and disclose the additional model call.
