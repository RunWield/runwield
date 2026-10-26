---
kind: "work_record"
recordId: "d5c9b240-39a9-4d59-9c67-0b2fed44f46a"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-05T03:42:31.979Z"
provenance:
    sourcePlans:
        - "28e93cd2-f201-4fd7-873c-c7ca4fbe9d5d"
---

# ACP v1 protocol conformance

## Summary

The ACP v1 adapter negotiates protocol version 1, reports the generated RunWield version, and sends schema-valid cumulative USD usage cost. Cancellation returns only after Runtime settlement and pending updates.

## Out of Scope

This work does not include HTTP/SSE MCP, MCP prompts or resources, ACP v2, or broader client delegation.

## Future Planning Notes

Keep ACP SDK upgrades explicit and covered by schema characterization tests. ACP cost remains Session-cumulative, and Runtime settlement owns cancellation completion.
