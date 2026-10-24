---
kind: "work_record"
recordId: "e301c9e7-8eb4-495a-819d-bd85374ad38b"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-24T03:59:46.788Z"
provenance:
    sourcePlans:
        - "9b31bb6d-caba-4f4c-9756-84c06b071667"
---

# Production Reviewer benchmark and baseline

## Summary

The Reviewer benchmark runs the production Semantic Reviewer against nine isolated fixture cases, with prerequisite and admission checks before model calls and hidden oracles excluded from review projects. Persistent results support resume, retain failures in scoring denominators, and record configuration identity and actual usage. Scoring separates mechanical decisions from human-adjudicated finding quality, providing a baseline for later Reviewer changes without claiming stability from one trial. Revised fixtures isolate cache writes across refreshes, select archived records by storage location, check archive filtering and continuation cursors, and distinguish registry architecture from durability-test defects while preserving planted defects. The original baseline observations and owner adjudications remain tied to the original fixture and oracle versions.

## Out of Scope

This work does not include the shared end-to-end harness, candidate prompt changes, paired comparisons, repeated-trial stability measures, repair-state scenarios, automated model judging, or per-finding user verdicts in Core.

## Future Planning Notes

Keep the benchmark on the production review path without Plan lifecycle or Delivery Evidence writes. Keep hidden proofs and oracles outside review projects; this isolation is not a sandbox against guessed absolute paths. Evidence-path overlap suggests matches but earns no recall. Accepted novel defects require oracle correction before semantic scoring. Do not combine revised fixtures with historical observations or repeat trials to select better outcomes. Fixture changes must invalidate resume compatibility, and scoring must use the latest attempt rather than the best one.
