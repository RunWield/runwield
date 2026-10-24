---
kind: "work_record"
recordId: "e783887f-bba0-442e-a730-5a29991547b4"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-04T03:29:45.805Z"
provenance:
    sourcePlans:
        - "7b1479d6-e11e-4965-884c-efec5f892f59"
---

# Claude CLI root-turn thinking compatibility

## Summary

Claude CLI root turns build and run when an Agent or model preset has a non-off thinking level. Unsupported thinking on auxiliary Prompt Template turns still fails before model execution.

## Future Planning Notes

Keep backend thinking-level rejection scoped to auxiliary Prompt Template turns without workflow authority.
