---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/extensions/mnemoteca/"
    - "src/cmd/sleep/"
    - "src/shared/mcp/config.ts"
    - "src/shared/mcp/integration.ts"
    - "src/shared/work-records/"
    - "src/shared/settings.js"
    - "src/shared/session/session.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
executionAgent: "engineer"
createdAt: "2026-09-21T02:05:50.618Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 5
dependencies:
    - "04-run-and-resume-remote-sessions-with-local-history"
targetBranch: "epic/remote-ssh-development"
planId: "c6ff0ec0-9d59-47dd-8232-3e853119a30f"
---

# Keep Memory and Integrations on Their Owning Machine

## Context

Remote project identity, current cwd, and personal Memory collection are different facts. Current Memory paths infer a
collection from local filesystem and Git names, while MCP servers are merged and started in one process location. Those
assumptions can merge unrelated same-named projects, run personal integrations without laptop configuration, or run
project integrations against the wrong filesystem.

This slice completes the personal-data and integration placement part of the Remote SSH PRD's **Local personal
environment** and **Local memories and saved Sessions** capabilities. It preserves Core Memory scopes, trusted Team
Memory, Work Record authority, and project override rules.

## Objective

Resolve and retain one explicit local Memory mapping for each remote project identity, and make each effective MCP or
personal integration execute in its owning location. Keep remote project evidence canonical and make integration
location visible.

## Approach

Resolve the Memory binding when remote project identity becomes known and carry it in Session context. Use that same
binding for injection, explicit tools, and `/sleep`. Add origin and execution-location facts to effective MCP
configuration: personal definitions execute through the laptop personal service, while project definitions execute
remotely after existing safety checks and overrides.

Do not copy credential-bearing MCP environments or rewrite arbitrary path arguments; transparent portability would be
false for servers that need both laptop secrets and remote files. The connection-wide mount of laptop `~/.wld` gives
direct personal file access, not authority to run the personal Memory database or authenticated model runtime remotely.
Standard SFTP grants broad trusted-user file access; it is not credential confinement.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/extensions/mnemoteca/` and `src/cmd/sleep/` — consume one explicit local collection binding instead of deriving
  different names from remote cwd.
- `src/shared/mcp/config.ts` and `src/shared/mcp/integration.ts` — preserve definition origin, override rules, execution
  location, and forwarded personal tool calls.
- Work Record retrieval — read canonical remote records while personal memory storage remains local.
- Session/settings context — retain deliberate Memory mappings and expose integration location without conflating it
  with cwd.
- The owning Core and Remote SSH PRD sections — synchronize delivered identity, Memory, and integration behavior.

## Reuse Opportunities

- Existing Mnemoteca recall/store/delete operations and backup/export behavior — keep storage semantics on the laptop.
- Existing personal-then-project MCP merge and project-file safety checks — add location to the effective result rather
  than replacing precedence.
- Existing Work Record retrieval — point them at canonical remote evidence.
- The remote locator from child 04 — reuse durable host/project identity rather than directory basename.

## Implementation Steps

- New unrelated remote projects receive distinct local Memory collections even when their directory basenames match, and
  deliberate mapping to an existing collection does not merge Session identity.
- Known remote host alias changes reuse the project mapping when host evidence and canonical path establish equivalence;
  ambiguous mappings ask once and retain the user's answer.
- Core Memory injection, explicit recall/store/delete tools, and `/sleep` use the same resolved collection and local
  backup storage for the Session.
- Personal Memory mutation acknowledgements are returned only after the laptop write completes; no personal Memory
  database is installed or treated as authoritative remotely.
- Effective MCP configuration retains personal/project origin, existing project override and disable rules, and a
  visible execution location for each server.
- Personal MCP servers start on the laptop with existing credentials and forward tool calls/results; project-defined
  servers start remotely with the remote project cwd and existing project safety checks.
- A server that needs both laptop credentials and remote project files fails with a clear configuration limit rather
  than copying secrets, rewriting arbitrary paths, or moving project tools to the laptop.
- Work Record retrieval reads canonical remote records and never treats private local transcripts as shared knowledge.
- The owning PRD requirements and scenarios match delivered mapping, backup, MCP placement, and evidence behavior while
  broader third-party portability remains best effort.

## Verification Plan

- Automated: test unrelated same-name remote projects, worktrees, known alias changes, ambiguous mapping retention,
  deliberate collection sharing, and unchanged existing local project IDs and collection names.
- Automated: prove injection, explicit Memory tools, and `/sleep` select the same collection and write backups locally.
  Use sandboxed home and Mnemoteca database paths.
- Automated: test personal/project MCP precedence, disable rules, visible location, personal forwarding, remote project
  cwd, cancellation, redacted errors, and mixed-location failure.
- Automated: verify Work Records come from the remote project and personal Memories remain local. Run focused
  tests with `deno run -A scripts/run-tests.js <test paths>`, then `deno task seams:check` and `deno task ci`.
- Live: store and recall a personal memory during a remote Session, run `/sleep`, inspect the local backup, call one
  personal network-only MCP tool and one project MCP tool, and verify each process runs on the intended machine.
- Expected: the laptop sentinel project is untouched, credentials are not copied, and two same-named remote projects do
  not share Memory unless deliberately mapped.

## Edge Cases

- A host-key fingerprint alone does not prove project identity, and alias spelling alone does not disprove it. Use the
  full effective host evidence and canonical path.
- A custom MCP definition can contain machine-specific absolute paths. Report the owning-side failure without attempting
  path translation.
- Personal integrations can access network services but must not become general laptop project-filesystem tools.
- Project Memory sharing and Session identity are separate choices; never merge Sessions as a side effect of a shared
  collection.
