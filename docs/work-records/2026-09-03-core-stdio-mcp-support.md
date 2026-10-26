---
kind: "work_record"
recordId: "3e723bb2-cbc2-47b7-a6f9-739bd6fe0cf9"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-09-03T00:58:46.039Z"
provenance:
    sourcePlans:
        - "b42e8d67-c4cd-4f4a-a498-994e2fd02d93"
---

# Core stdio MCP support

## Summary

Core owns stdio MCP support for global, Project, and ACP-provided server definitions. MCP tools load into root Agent Sessions for Pi and Claude CLI, survive reloads and Session replacement, and shut down with the Session lifecycle. ACP accepts valid stdio MCP servers and rejects unsupported transports with safe errors.

## Future Planning Notes

Keep MCP ownership in Core. Support for stdio does not imply support for other MCP transports or ACP capabilities.
