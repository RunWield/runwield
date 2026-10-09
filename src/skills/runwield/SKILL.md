---
name: runwield
description: Use when the user asks how RunWield or wld works, how to do a task in RunWield, why RunWield routed, planned, validated, reviewed, or recovered work a certain way, or how to configure RunWield/wld.
---

# RunWield

Use this skill to answer user-facing questions about RunWield usage. It ships with the running `wld` binary and matches
that binary version, so prefer it over memory or the repository docs when a user asks how RunWield works.

If the question is about the user's own configuration or Plan state, inspect their real files: `~/.wld/settings.json`,
project `.wld/`, `RUNWIELD.md` or `AGENTS.md`, and Plan files under `docs/plans/`. Do not answer those questions only
from defaults.

For depth, link to the user documentation at `https://docs.runwield.dev` by appending the page name, for example
`https://docs.runwield.dev/usage/`.

Describe state-changing `wld` commands to the user. Do not run them only to demonstrate behavior. Never run destructive
commands such as `wld plans unshare` or `wld plans archive` as an example.

If the task is to change RunWield source behavior, read the source and tests. This skill is an orientation map, not an
implementation specification.

## What RunWield is

RunWield is an opinionated coding harness built on Pi. It adds routing, role-scoped Agents, durable Plans, browser Plan
review, worktree execution, Workflow Validation, recovery, project Memory, Work Records, and customization layers.

`wld acp` is supported for external Agent Client Protocol clients. See
https://github.com/gandazgul/runwield/blob/main/docs/acp-implementation-details.md

## Routing intents

| Intent      | Owner     | Use                                                                    |
| ----------- | --------- | ---------------------------------------------------------------------- |
| `INQUIRY`   | Guide     | Answer, explanation, repository guidance, or general help.             |
| `IDEATION`  | Ideator   | Interview, research, PRD, or idea sharpening before implementation.    |
| `OPERATION` | Operator  | Direct non-code repository or environment work with self-verification. |
| `QUICK_FIX` | Engineer  | Bounded no-Plan implementation followed by Mechanical Validation only. |
| `FEATURE`   | Planner   | Non-trivial work that needs a reviewable Plan before execution.        |
| `PROJECT`   | Architect | Large work that needs an Epic and Slicer decomposition.                |

User-selectable Agents are `router`, `guide`, `ideator`, `operator`, `planner`, `architect`, `engineer`, and `tester`.
Workflow-only pseudo-Agents include Slicer for PROJECT decomposition and Reviewer for semantic code review.

## Context pointers

- Read `COMMANDS.md` when the user asks about `wld` commands, slash commands, TUI input, sessions, shell execution, file
  references, image paste, or Work Record commands.
- Read `PLANS.md` when the user asks about Plans, Plannotator, review, statuses, worktrees, validation, repair, PROJECT
  Epics, Slicer, Work Records, recovery, or Shared Spaces.
- Read `CUSTOMIZATION.md` when the user asks about `.wld/`, instructions, agents, prompt templates, skills, themes,
  bundled skills, or `/reload`.
- Read `SETTINGS.md` when the user asks about settings files, model presets, `visionFallback`, providers,
  authentication, or how to make an Agent use a different model.

Start with the relevant sibling file, answer at surface depth, and link to the docs for reference detail.
