# Codex Connect integration report

This report tracks external Codex orchestration of the [Epic](../connect-codex.md). It is not a RunWield Verified
attestation and does not replace Core-owned lifecycle or delivery evidence.

## Baseline

- Base: `fe8e6efef` from `origin/main`.
- Bun: 1.4.3; submodules initialized and both dependency graphs installed with `bun run install:locked`.
- `bun run ci`: passed in 691.9 seconds before implementation changes.
- The original checkout's unrelated Plan edit was preserved.

## Implementation and review

| Child                              | Implementation                          | CI                        | Fresh-context review           | Epic merge          |
| ---------------------------------- | --------------------------------------- | ------------------------- | ------------------------------ | ------------------- |
| Share host-aware coordination      | `3923d9365`; signal repair in progress  | CI regressions repaired   | Approved; signal delta pending | `f2b256a5b`         |
| Package the Codex workflow         | `7403fbb79`                             | Focused checks pass       | Approved on all axes           | `983077d00`         |
| Prove Codex execution and recovery | `59f405297`; review repairs in progress | Focused checks pass       | Three findings under repair    | Pending             |
| Document Codex support             | `d79d25c91`                             | Documentation checks pass | Approved on all axes           | Awaiting dependency |

The children were implemented by separate subagents in separate managed worktrees. Dependency merges assemble the
later Plans without declaring earlier Plans reviewed. The epic also includes `origin/main` through `875f058b7`.

Focused checks cover shared host compatibility, current-host roles, read-only resume inspection, bidirectional
continuation, real MCP framing, native package installation, explicit invocation, and acceptance evidence rejection.
Documentation link checks and the public site build passed. The first runtime CI exposed a saved-Plan guidance
regression; it was repaired and the affected regression test passed. A later full gate passed 813 test files, failed
three, and skipped two. Two stale status assertions were updated to pin the new bounded preview without exposing the
full request; the timeout case passed unchanged. All three affected files passed in the focused repair run. The assembled
source at `d79d25c91` is running a full gate, with subsequent review repairs tracked separately.

Two earlier tool-owned CI sessions ended without surviving completion evidence. Neither counts as a pass. The runtime
rerun has a detached supervisor, retained log, and atomic exit-code file. A combined run was deliberately superseded
before completion so final validation can include the handoff and acceptance repairs and the updated main branch.

Integration inspection found and repaired a bidirectional handoff gap: Claude's resume commands now inspect saved work
without advancement, disclose the Plan or request, current step, and originating host, then continue through ordinary
status. The existing explicit resume authorizes the handoff; no additional approval is introduced.

The independent reviews read every changed-file entry in all four child ranges. Standards approved all four Plans.
Spec approved Plans 1, 2, and 4; `SPEC-P3-001` requires unavailable host authentication to be identified as a prerequisite.
Tests approved Plans 1 and 4, then approved Plan 2 after `T-P2-001` was repaired with workflow contract tests and its
parent-written-review counterexample was independently checked. `T-P3-001` (invoking-checkout isolation) and `T-P3-002`
(inherited worker context at the subprocess boundary) remain under repair. No advisories were reported.

## Observed host capabilities

Codex CLI `0.164.0-alpha.11.1` reported MCP client name `codex-mcp-client`, title `Codex`, and that exact version in a
real isolated probe. Its server ran in the selected project directory. A separate installed native-package probe
proved `tool_timeout_sec`: one second timed out a three-second call, while 3600 seconds allowed a 65-second call.
These narrow observations do not qualify the full FEATURE journey or the desktop UI.

Native `.codex-plugin/plugin.json` and `.mcp.json` are selected because the portable MCP schema rejected the required
timeout field. The final native `$runwield:run` package passed isolated installation, complete tool discovery, activation,
stale-revision and transcript rejection, Planner handoff, fresh-process restoration, and remove/reinstall restoration.
Its sanitized summary records the exact source digest and explicitly excludes model-turn and desktop UI qualification.

A preliminary source-skill journey reached Core delivery and a Work Record after browser chat, isolated implementation,
interrupted validation, repair, and re-review. The simplified CLI event stream did not prove worker independence, so
that result did not qualify support. The final acceptance carrier uses native app-server events to associate fresh
worker identities with direct instruction and complete diff reads; no raw prompts or model responses are retained in
the saved summary. The next live run identified a genuine shutdown gap: native Codex terminates its MCP subprocess
with a signal, while the shared carrier handled only closed input. Graceful signal cancellation and its regression
coverage are under repair; the failed live result does not qualify support. Final live evidence, branch CI, and
whole-epic review remain pending.

## Qualification limits

The package targets both Codex desktop and CLI. Native installation/protocol evidence and explicit-path source-skill
evidence remain separate. Neither establishes a desktop UI walkthrough or default-permissions acceptance. The Codex
Compatibility Matrix remains empty; recognized untested hosts receive a visible notice. Publication of this repository
PR does not release a new Core binary or submit the plugin to a public directory.
