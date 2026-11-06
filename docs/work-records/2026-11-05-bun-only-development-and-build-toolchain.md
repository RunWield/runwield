---
kind: "work_record"
recordId: "3939cf8e-fad9-4648-9278-c2ebf6d2c7c8"
status: "approved"
scope: "planned_change"
workKind: "REFACTOR"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-11-05T16:11:27.942Z"
provenance:
    sourcePlans:
        - "6356d270-7145-4aaa-b1ed-4a0e8e8a35b2"
---

# Bun-only development and build toolchain

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: This was implemented by Codex RunWield uses Bun 1.4.3 for source execution, development tools, builds, packaging, CI and test containers without an ordinary Deno dependency. Direct standard-library dependencies use Node builtins and maintained npm parsers and clocks, with adapters that preserve caller contracts. Public task names and argument behavior remain compatible with the former Deno tasks. Documentation builds separate historical Stable content from current Bun tooling and use a frozen docs dependency graph. Remote Workspace test containers run Bun as a nonroot user with durable `/data`, but do not provide Deno-equivalent filesystem or subprocess restrictions.

## Out of Scope

This work does not include production-equivalent container sandboxing or changes to deployed-host access policy.

## Future Planning Notes

- Keep root and docs dependency graphs separate, frozen and installed with lifecycle scripts disabled. Preserve test-process isolation and the source and Golden test inventories.
- Keep old-release cross-runtime lock interoperability in a separate compatibility lane. Deno support for user-project commands and Snip filters is not an ordinary toolchain dependency.
- Preserve public task names, named compile arguments, test filters, compound argument boundaries and build-prerequisite failure propagation. Immutable RC1 recovery retains its `compile:bun` fallback.
- Historical docs builds must pair the selected content with immutable tooling identity and matching dependency declarations before copying the frozen docs graph.
- Treat the Bun containers as test-only and non-hardened. Nonroot execution, a read-only root and dropped capabilities are not substitutes for Deno permissions.
- Keep the owned-code audit against executable Deno dependencies. Historical text, inert fixtures and unselected vendor runtime branches are not active toolchain requirements.
