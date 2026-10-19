---
kind: work_record
recordId: 9ccacfea-705e-4268-a70c-d944a7ea542f
status: approved
scope: feature
origin: external
completionMode: verified
createdAt: 2026-07-15T11:06:24-04:00
provenance:
    evidence:
        - path: src/agent-definitions/workflow-prompts/manual-qa-prompt.md
          note: Defines the user-facing Markdown checklist contract and manual-only QA guidance.
        - path: src/shared/workflow/validation.js
          note: Runs the isolated checklist prompt after successful QUICK_FIX and FEATURE validation.
        - path: src/shared/workflow/orchestrator.js
          note: Supplies QUICK_FIX request and implementation-summary context to post-verification checklist generation.
        - path: src/shared/session/agent-handler.js
          note: Restores preserved checklist context when QUICK_FIX validation resumes after an interrupted repair.
---

# Post-verification manual QA checklists

## Summary

RunWield follows successful QUICK_FIX Mechanical Validation and FEATURE Workflow Validation with a concise manual verification checklist. FEATURE checklists use the Plan; QUICK_FIX checklists use the original request and Engineer completion summary, including after interrupted repair resumes. Failed or canceled validation produces no checklist. Checklist-generation failures do not invalidate successful automated verification.
