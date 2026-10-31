---
kind: "work_record"
recordId: "018b70db-22f4-4b54-aee7-53306bf6e515"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-04T03:15:30.275Z"
provenance:
    sourcePlans:
        - "5d5685b0-9234-495d-ae78-00f0f2eb7edc"
---

# Persistent Agent switch notices

## Summary

RunWield displays and replays notices when Session ownership moves to a different root Agent. Active-Agent transcript markers store canonical names and display names. Runtime events distinguish root handoffs from quiet profile refreshes, and replay preserves notices across transcript segments.

## Future Planning Notes

Keep committed active-Agent markers as the durable source for root-Agent identity. Treat temporary Prompt Template profiles and same-Agent rebuilds as presentation updates, not ownership handoffs.
