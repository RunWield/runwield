---
kind: "work_record"
recordId: "21ec42a1-5322-4d19-a91c-29764e5a2618"
status: "approved"
scope: "planned_change"
workKind: "REFACTOR"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-11-05T16:14:35.995Z"
provenance:
    sourcePlans:
        - "2055cb08-5938-4c85-bddd-50bb3c816386"
---

# Side-effect-free Plan reads

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: Finished with Codex. RunWield Plan listing, browsing, search, progress, and Doctor check-only inspection use existing local evidence without changing source files, taking writer locks, fetching or cloning Git data, or scheduling repair. Reads preserve registered-worktree and controller authority, and target-only documents load directly from local Git objects. CLI and Workspace surfaces show pending workflow details separately from Plan status; ID-less documents remain browsable but stay outside search. Selected Plan loads and deliberate actions retain automatic preparation, migration, and recovery while preserving document bodies and creation timestamps. This boundary separates browsing from mutation and keeps progress displays tied to applicable saved publication evidence rather than read-time remote verification.

## Out of Scope

This work does not include redesigns of Session storage, the collaboration protocol, Work Record generation, or the earlier search optimization.

## Future Planning Notes

Passive inspection must not satisfy a later action's mutation-admission checks. Actions must recheck authority and perform required preparation before relying on runtime facts. Pending or unsafe authority must not become an authoritative empty result, stale-primary fallback, or permission to mutate. Missing local Git evidence means unavailable information, not proof that children are absent or publication succeeded; implicit Git lazy fetch is also prohibited during passive reads. Saved publication receipts remain subject to current-attempt identity and invalidation rules, and publication owners retain fresh remote-proof requirements. In-memory caches and the search service's own derived index/status writes are allowed, but passive reads must not cache workflow facts across requests.
