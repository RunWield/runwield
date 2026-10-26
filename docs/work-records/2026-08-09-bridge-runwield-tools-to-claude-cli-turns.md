---
kind: "work_record"
recordId: "1df2705b-f38e-4d95-b233-b1d9f1ac6637"
status: "approved"
scope: "planned_change"
workKind: "FEATURE"
origin: "internal"
completionMode: "verified"
createdAt: "2026-08-09T19:39:38.458Z"
provenance:
    sourcePlans:
        - "e992c156-7b85-426b-9e1e-dfa7ca74540b"
---

# Bridged Tools for Claude CLI

## Summary

Claude CLI turns receive RunWield capabilities through host-neutral Bridged Tools over the loopback MCP bridge. Shared factories expose memory, code, Work Record, interview, lifecycle, multi-file editing, and caller-supplied tools. Tool composition and system-prompt declarations share the bridge contract.

## Future Planning Notes

Reuse host-neutral tool factories and the bridge composer. Do not create backend-specific copies of RunWield tools.
