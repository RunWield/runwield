---
kind: "work_record"
recordId: "4fcf6a50-cd7e-444d-b619-1335087591f2"
status: "approved"
scope: "epic"
origin: "internal"
completionMode: "user_verified"
createdAt: "2026-10-31T15:47:02.730Z"
provenance:
    sourcePlans:
        - "15ff3966-cc0b-4049-864d-36cbb9139cc3"
---

# Remote SSH development with laptop-owned personal data

## Summary

The user attested verification; RunWield Workflow Validation did not establish this result. User verification note: the only defect is docs RunWield opens remote-only Linux x86-64 and ARM64 projects through `wld remote`, using OpenSSH configuration and a matching remote runtime without a laptop checkout or source synchronization. The remote TUI, Agent, tools, and delivery workflows operate on the server, while the laptop owns model authentication, personal settings, Memory, and saved Session history. Personal resources use direct SSHFS access; managed Session entries use synchronous laptop-owned saves under native writer locks before dependent work continues. Plan Review and Code Review open in the laptop browser through automatic forwarding, with stable review URLs across conversation and revision rounds. Connection loss stops owned work, and reconnect uses saved history and remote evidence rather than automatically replaying uncertain actions.

## Deviations from Plan

1. Superseded requirement: Not changed: review frontend and design system, review tokens and decision handling, the review host's dispatch (from 09-host), ACP browser questions.
   Replacement requirement: Merge main into the execution branch and preserve its conversational review behavior. A conversation-only message must not refresh the reviewed content; refresh only when the reviewed code changes. Verify that the same review URL remains active until approval; if it does not, retain the review surface and URL across those conversation and revision rounds. Preserve token authorization, revision-safe decisions, the shared review host, and ACP browser behavior.
   Reason: The user requests integration of main's conversational reviews and stable review URLs until approval, which can require review lifecycle changes excluded by the original Plan.
2. Superseded requirement: Then trigger the release workflow with `workflow_dispatch` on the Epic branch and confirm that both Linux `native-package-check` legs pass the SSH check. Record each leg's duration and the total release wall time compared with the previous run.
   Replacement requirement: Add a qualification-only workflow dispatch mode that builds release-format candidate archives from the selected branch without publication. Use that mode on the Epic branch to confirm that both Linux native-package-check legs pass the SSH check, and record each leg's duration and total qualification wall time compared with the previous release run. Delivery of the changed workflow to GitHub remains subject to RunWield's delivery boundary.
   Reason: The current manual dispatch accepts an immutable existing release tag and can proceed to publication; it cannot safely qualify unpublished Epic-branch candidate bytes.
3. Superseded requirement: `verify-remote-workflows.ts` keeps its scripted runtime client for stage-exact cuts (validation, publication proven,
   publication uncertain, rollover then disconnect). Its `WLD_LIVE_SOURCE=0` path already accepts a production binary; it
   reruns with the release `wld` from the Linux archive. It changes only if it cannot accept that binary.

- `verify-remote-workflows.ts` journeys `delivery`, `validation-cut`, `publication-proven`, and `publication-uncertain`
  pass with the release `wld` as the production binary.
  Replacement requirement: Keep the existing scripted runtime-client journeys as separate code-level evidence, not release-CLI qualification. Qualify delivery, validation-cut, publication-proven, publication-uncertain, and rollover then disconnect through the unchanged release CLI in a PTY with the synthetic provider. Adapt the qualification drivers to use supported terminal commands and assert visible state plus durable Session, Git, and publication evidence instead of claiming raw runtime reports. Retain stage-specific fault cuts, reconnect and /resume checks, conservative handling of uncertain outcomes without automatic replay, laptop Session ownership, and per-case cleanup. Do not add a product command or protocol solely for qualification. All other Group R, Group S, Group A, release-artifact, real-profile safety, and proposal-retirement requirements remain unchanged.
  Reason: The existing production-binary option runs only a save smoke check. Workflow commands and in-memory reports come from a separately compiled test entry that the release CLI does not expose. Terminal-driven journeys preserve release qualification without adding a product API.

## Out of Scope

This work does not include unattended execution, remote macOS or Windows hosts, remote ACP clients, Claude CLI or Antigravity CLI backends, hostile-server isolation, or automatic installation of arbitrary project and custom-Skill dependencies. It does not include private installation of SSHFS and its user-space dependencies; remote startup relies on host-provided SSHFS and fusermount3, usable FUSE, and mount permission.

## Future Planning Notes

Keep remote project identity, execution cwd, and personal Memory binding distinct. Only the laptop owns managed Session persistence and native writer locks; the personal mount and connection timeouts never grant writer authority. Save faults must stop dependent work, and recovery must not replay uncertain external effects. The full personal mount and standard SFTP permit broad laptop-account file access, not sandboxed access. Personal MCP servers run on the laptop, while project MCP servers run remotely under the existing override rules.
