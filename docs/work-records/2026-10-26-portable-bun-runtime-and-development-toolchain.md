---
kind: "work_record"
recordId: "b82a93f7-bb4a-44a6-a576-858b76666183"
status: "approved"
scope: "planned_change"
workKind: "REFACTOR"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-10-26T14:05:08.047Z"
provenance:
    sourcePlans:
        - "f79cd8d2-970c-4adf-859d-f6db48ef8e1a"
---

# Portable Bun runtime and development toolchain

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: this was done by codex RunWield supports Bun execution for CLI/TUI, Workspace, Session persistence, local workflows and remote laptop transport while preserving Session identity, file formats, recovery and writer exclusion. Standalone Bun executables embed application resources, Workspace assets, the image worker and Photon WASM without requiring the build checkout or its dependencies. The development toolchain provides separate frozen root and docs dependency graphs and isolated execution of the source and golden test inventory. Runtime handling explicitly closes native Bun SQLite connections, drains accepted browser answers, closes MCP upstream transport on stdin EOF and ignores buffered Claude output after an accepted lifecycle signal. Windows storage preserves lock ownership and open-reader bytes during atomic replacement, while Git publication respects CRLF filters without weakening dirty-work protection.

## Out of Scope

This work does not include the production runtime and distribution cutover, repository or licensing separation, Windows remote-host support, or UNC-root support.

## Future Planning Notes

- Preserve atomic-write durability ordering, native lock interoperability and exact ownership evidence. On Bun for Windows, derive lock timestamps from bigint nanoseconds floored to milliseconds; floating-point timestamps can prevent safe lock retirement.
- Keep test files in separate processes with disposable HOME, temporary paths and database state. Use real filesystem, Git and process fixtures rather than injection seams for owned machinery.
- Keep root and docs dependency graphs separate. Mixed package-manager operations require separate checkouts or serialized replacement of both generated dependency directories.
- Distinguish Windows laptop transport from Linux remote-host execution. Git long-file-path support requires its long-path opt-in and does not establish support for arbitrarily deep repository or worktree roots.
