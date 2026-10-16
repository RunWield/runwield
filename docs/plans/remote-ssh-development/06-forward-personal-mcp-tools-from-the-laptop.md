---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/mcp/config.ts"
    - "src/shared/mcp/integration.ts"
    - "src/shared/remote/control.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
executionAgent: "engineer"
createdAt: "2026-10-11T00:00:00.000Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 6
dependencies:
    - "04-run-and-resume-remote-sessions-with-local-history"
    - "05-keep-memory-and-integrations-on-their-owning-machine"
targetBranch: "epic/remote-ssh-development"
planId: "5df960b5-5c59-41b7-935a-3dc7511ad917"
---

# Forward Personal MCP Tools from the Laptop

## Context

Child05 makes MCP location correct but incomplete. After child05, a remote Session does not read the server user's
personal `mcp.json`, personal servers do not start remotely, and project servers start remotely. Personal MCP tools are
missing in remote Sessions.

This child delivers the Epic's **Reviewable integration default** in
[Personal resources, integrations, and Memory](../remote-ssh-development.md#personal-resources-integrations-and-memory):
personal MCP servers run on the laptop with their existing credentials, and their tools reach the remote Agent.

This draft was split out of child05 during child05 planning. Its scope is a starting point for its own planning session.

## Objective

A remote Session lists and calls the user's personal MCP tools. Each personal server runs on the laptop with laptop
configuration and credentials. `/mcp` shows where each server runs.

## Approach

The laptop starts the effective personal MCP servers through the existing `McpIntegration`. The remote runtime gets
their tool list over the authenticated control service and registers forwarding tools. A tool call travels to the
laptop, runs there, and returns its result. Cancellation from the remote turn stops the laptop call.

```text
remote Agent tool call (personal server tool)
  control service /mcp/call        → laptop McpIntegration.call
  result or error                  ← laptop
remote turn cancelled
  control service /mcp/cancel      → laptop aborts the call
```

Do not copy credential-bearing MCP environments to the server. Do not rewrite path arguments. A personal server that
needs remote project files is best effort and may need user configuration.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/mcp/integration.ts` — laptop host for personal servers; remote forwarding tools.
- `src/shared/remote/control.ts` — authenticated tool list, call, and cancel routes.
- `src/shared/mcp/config.ts` — personal and project origin and execution location from child05.
- The owning Core and Remote SSH PRD sections — record delivered personal MCP forwarding.

## Reuse Opportunities

- The child05 MCP origin and location fields.
- The control service authentication and request-id receipt pattern used by the settings and Memory routes.
- The child02 model bridge cancellation handling.

## Implementation Steps

- A remote Session lists the tools of every enabled personal MCP server, and each personal server process runs on the
  laptop.
- A remote call to a personal tool runs on the laptop and returns its result or a redacted error to the remote Agent.
- Cancelling the remote turn stops the laptop tool call.
- Project override and disable rules still apply to personal servers.
- `/mcp` in a remote Session shows `laptop` for personal servers and `remote` for project servers.
- No MCP environment value or credential is sent to the server.
- The owning PRD requirements and scenarios describe delivered personal MCP forwarding.

## Verification Plan

- Automated: a personal MCP fixture server records its process host and cwd; a remote Session lists and calls its tool,
  and the call runs in the laptop process. Run focused tests with `deno run -A scripts/run-tests.js <paths>`, then
  `deno task seams:check`.
- Automated: cancellation of a remote turn stops a slow laptop tool call.
- Automated: captured control traffic contains no MCP environment values.
- Live (`sct`): call one network-only personal MCP tool and one project MCP tool, and confirm each process runs on the
  intended machine.

## Edge Cases

- A personal server needs both laptop credentials and remote project files. Report the limit; do not move project files
  or rewrite paths.
- The connection drops during a laptop tool call. The remote turn stops; the call is not repeated on reconnect.
