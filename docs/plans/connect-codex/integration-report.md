# Codex Connect integration report

This report tracks external Codex orchestration of the [Epic](../connect-codex.md). It is not a RunWield Verified
attestation and does not replace Core-owned lifecycle or delivery evidence.

## Baseline

- Base: `fe8e6efef` from `origin/main`.
- Bun: 1.4.3; submodules initialized and both dependency graphs installed with `bun run install:locked`.
- `bun run ci`: passed in 691.9 seconds before implementation changes.
- The original checkout's unrelated Plan edit was preserved.

## Implementation and review

| Child                              | Implementation | CI      | Fresh-context review | Epic merge |
| ---------------------------------- | -------------- | ------- | -------------------- | ---------- |
| Share host-aware coordination      | In progress    | Pending | Pending              | Pending    |
| Package the Codex workflow         | In progress    | Pending | Pending              | Pending    |
| Prove Codex execution and recovery | In progress    | Pending | Pending              | Pending    |
| Document Codex support             | Pending        | Pending | Pending              | Pending    |

## Observed host capabilities

Codex CLI `0.164.0-alpha.11.1` reported MCP client name `codex-mcp-client`, title `Codex`, and that exact version in a
real isolated probe. Its server ran in the selected project directory. A separate installed native-package probe
proved `tool_timeout_sec`: one second timed out a three-second call, while 3600 seconds allowed a 65-second call.
These narrow observations do not qualify the full FEATURE journey or the desktop UI.

Native `.codex-plugin/plugin.json` and `.mcp.json` are selected because the portable MCP schema rejected the required
timeout field. Host discovery, full workflow acceptance, final branch CI and whole-epic review remain pending.
