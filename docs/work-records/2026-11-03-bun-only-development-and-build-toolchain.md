---
kind: "work_record"
recordId: "6cfa2e07-17b6-4c82-aa75-deb26799c370"
status: "approved"
scope: "planned_change"
workKind: "REFACTOR"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-11-03T00:34:35.214Z"
provenance:
    sourcePlans:
        - "6356d270-7145-4aaa-b1ed-4a0e8e8a35b2"
---

# Bun-only development and build toolchain

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: This was implemented by Codex RunWield uses Bun for development, compilation, tests, release tooling, docs builds and test containers without requiring Deno in the ordinary toolchain. Node builtins and maintained npm libraries replace direct standard-library imports, while public task names and argument contracts remain compatible. Root and docs dependencies use separate frozen Bun graphs with install scripts disabled, and source and Golden tests retain process isolation. Historical docs builds use current Bun tooling with immutable source and tooling identities rather than old task scripts. An owned-code audit rejects executable Deno dependencies while preserving user-project Deno support and separate old-release compatibility checks.

## Out of Scope

This work does not include production-equivalent filesystem or subprocess enforcement for the Bun test containers, or changes to deployed-host access.

## Future Planning Notes

- Preserve public task names, argument boundaries, parser behavior and isolated test state when changing commands or dependencies.
- Keep old-release lock interoperability in a separate compatibility lane while those releases remain supported. Its Deno runtime is not an ordinary toolchain requirement.
- Treat the Bun remote image as test-only and non-hardened. Non-root execution, a read-only root filesystem and dropped capabilities do not replace Deno filesystem and subprocess permissions.
- For historical docs builds, keep source content separate from current tooling and require dependency declarations to match the frozen docs graph.
