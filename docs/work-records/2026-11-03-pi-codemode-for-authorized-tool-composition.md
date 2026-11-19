---
kind: "work_record"
recordId: "32f639f0-7748-419f-86b6-898977d3ac09"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-03T00:32:45.520Z"
provenance:
    sourcePlans:
        - "c4eb1eb7-e3b6-46f4-8cd2-28d6815ff711"
---

# Pi codemode for authorized tool composition

## Summary

RunWield's Pi-backed Sessions use codemode to combine authorized tool calls in JavaScript and return selected output. Root Agents receive codemode alongside existing tools, including MCP tools, while delegated and isolated Agents retain their explicit tool limits. Workflow decisions remain direct tool calls and cannot run inside scripts. The Pi 1.5.0 integration supports discovery, cancellation, branch-local successful-script stores, image results, and model calls through RunWield's configured credentials and usage accounting.

## Out of Scope

This work does not include codemode for external CLI backends or changes to Connect's host-owned tool loop. It does not include deferred MCP tool exposure, tool_search, or a new image or classifier interface.

## Future Planning Notes

Register codemode in the executing Pi AgentSession, not in the separate Session-owned MCP connection host. Scripts must use the same tool authorization and execution guards as direct calls; workflow advancement tools must remain model-only. Codemode stores belong to the executing Session branch, and script failure or cancellation does not roll back external effects. Compiled delivery uses a version-checked adapter for Pi's worker and QuickJS assets. Pi upgrades and additional package targets must preserve execution without access to a development checkout.
