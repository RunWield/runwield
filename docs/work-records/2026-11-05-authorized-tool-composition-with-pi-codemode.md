---
kind: "work_record"
recordId: "b94c85fa-fa35-4edb-9a2b-69bb6a9a44bf"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-05T16:09:16.012Z"
provenance:
    sourcePlans:
        - "c4eb1eb7-e3b6-46f4-8cd2-28d6815ff711"
---

# Authorized tool composition with Pi codemode

## Summary

RunWield's Pi-backed Agents can use JavaScript to combine authorized tool calls, including root MCP tools, and return filtered results across TUI, Workspace, and ACP. Codemode preserves Agent tool limits and keeps workflow decisions as direct calls, so composition grants no additional authority. Script stores follow Session branches and resume; output supports images, cancellation retains worker capacity until exit, and auxiliary model calls retain model-attributed usage without double counting. Pi 1.5 schema validation applies coercion to direct and nested MCP calls, including numeric strings and scalar-to-array inputs, while rejecting invalid arguments before invocation. Source and standalone Bun execution use Pi's upstream sandbox through a version-checked packaging adapter.

## Out of Scope

This work does not include codemode for external CLI backends or replacement of Connect's host-owned tool loop. It does not include deferred MCP tool exposure, HTTP/OAuth configuration, or Pi's interactive MCP configuration manager.

## Future Planning Notes

Codemode belongs to the executing Pi AgentSession; the separate MCP host owns connection lifetime, not script stores or transcripts. Workflow decision tools must remain model-only and unavailable inside scripts. Failed scripts discard pending store writes but do not roll back completed external effects. Presentation settings use RunWield's project-over-global precedence and must not introduce separate .pi state. Pi upgrades must requalify the exact-version worker/WASM adapter and standalone execution without access to a development checkout.
