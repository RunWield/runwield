---
kind: "work_record"
recordId: "06b05a39-3df8-41bf-a084-718e1238093e"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "done_enough"
createdAt: "2026-10-22T02:48:01.980Z"
provenance:
    sourcePlans:
        - "eb894f76-005e-48bd-a56a-cb3b5977c534"
---
# Conversational Plan and Code Review

## Summary

The Epic was closed as done enough. Plan review and validation-time Code Review support conversation without treating every message as a change request. Both surfaces default to chat with a shared Review Queue that includes context automatically and allows exclusion by type; Plan Question cards can submit individual answers. Reply-only Plan review keeps the file, status, and approval unchanged, while approval warns about conversation since the latest revision. Meaningful revisions of approved or ready Plans return them to draft, formatting-only changes preserve approval, and legacy `feedback` and `in_review` statuses read as `draft`. Git-backed Code Review uses actual patch changes to trigger repair evidence and CI; unchanged patches preserve the decision, evidence, status, and CI results while the conversation continues.

## Deviations from Plan

1. Superseded requirement: `docs/prd/conversational-review-prd.md` is deleted, and no document links to it. The temporary PRD is gone, and `grep -r conversational-review-prd docs src` finds nothing.
   Replacement requirement: Delete the temporary conversational-review PRD and remove its references from lasting documentation, including READMEs, user documentation, PRDs, ADRs, and source. Do not edit old Plans; their historical references remain until archival. Exclude Plan documents from the zero-reference verification.
   Reason: The owner clarified that documentation cleanup must preserve old Plans and apply to lasting documents.

## Out of Scope

This work does not include changes to standalone Code Review (`wld review`). Non-conversation feedback and non-Git in-place Code Review turns retain the repair-and-check flow.

## Future Planning Notes

Compare the full reviewed patch after RunWield's metadata writes; an Agent's report is not proof of a patch change. Owner-requested patch changes rerun CI and reopen the same Code Review conversation without another automatic AI review. Scope changes agreed in Code Review chat require a confirmed Plan Deviation before they become authoritative.
