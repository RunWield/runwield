---
kind: work_record
recordId: f200e205-abde-4b65-b479-a71091e7fbf9
status: approved
scope: feature
origin: external
completionMode: verified
createdAt: 2026-07-14T08:32:00-04:00
provenance:
    evidence:
        - path: src/agent-definitions/router.md
          note: Defines bug-report precedence, read-only Diagnostic Triage, and the default QUICK_FIX routing boundary.
        - path: router-judgements.csv
          note: Captures the repeated tool-call and thinking-block symptom as a QUICK_FIX golden-set regression case.
---

# Bug report routing precedence

## Summary

Router treats an unqualified defect report as an implicit request to diagnose and repair the problem before applying the generic informational fallback. Unknown-cause bugs receive read-only Diagnostic Triage and default to QUICK_FIX when the likely repair is bounded, while evidence of broader design or multi-file scope can still escalate the work to FEATURE or PROJECT. INQUIRY remains available when the user explicitly requests explanation, confirmation, report-only handling, or no changes.
