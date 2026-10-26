---
planId: "9c34f0ce-020b-4f3d-befe-aa1726490cab"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/remote/verify-remote-workflows.ts"
    - "src/shared/remote/verify-remote-reviews.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/adr/018-remote-ssh-local-personal-authority.md"
    - "docs/adr/015-file-authoritative-session-bundles.md"
    - "docs/domain-language.md"
    - "docs/plans/remote-ssh-development/manual-qa.md"
executionAgent: "engineer"
createdAt: "2026-10-25T21:51:42Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 13
dependencies:
    - "11-package-and-qualify-remote-ssh-support"
    - "12-confirm-a-partly-matching-remote-host"
userVerifiedAt: null
targetBranch: "epic/remote-ssh-development"
---

# Qualify Remote SSH and Retire the Proposal

## Context

Children 01–12 deliver remote behavior and the packaged runtime. RunWield cannot claim Remote SSH support until the
full journey and the failure cases pass with release-format artifacts on the advertised matrix. Earlier evidence used
synthetic providers, development bundles, and separate partial journeys.

Then the transient [Remote SSH PRD](../../prd/remote-ssh-prd.md) is folded into
[RunWield Core](../../prd/runwield-core-prd.md) and removed.

### Matrix (owner, 2026-10-25)

- **Live:** macOS arm64 laptop → Fedora Server x64 (`sct`), real provider `openai-codex/gpt-5.6-luna` through Pi.
- **ARM64 servers:** supported on the evidence of child 11's release gate on GitHub's ARM64 runner (synthetic
  provider, real SSH and SSHFS).
- **Docs wording:** list exactly what was tested. Other glibc distributions with `python3`, `sshfs`, and `fuse3` are
  expected to work but are untested. Windows laptops and Claude CLI/Antigravity CLI remain unsupported.

## Objective

Prove the complete remote delivery, review, disconnect, and reconnect journeys with release-format artifacts and a real
provider. Then publish only the support claims that evidence backs, with one lasting PRD owner for each requirement.

## Approach

To be shaped in this child's planning session. Starting points:

- Build release-format archives from the qualification commit with the release scripts, and connect through the release
  launcher's laptop cache (child 11). A published Candidate cannot exist before the Epic merges.
- Extend the existing drivers (`verify-remote-workflows.ts`, `verify-remote-reviews.ts`) with a real-provider mode
  rather than writing a new harness.
- Record evidence in `manual-qa.md`, then move lasting requirements and scenarios into Core.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/remote/verify-remote-*.ts` — real-provider and release-artifact modes.
- `docs/prd/runwield-core-prd.md` — owns every lasting delivered and deferred Remote SSH requirement and scenario.
- `docs/prd/remote-ssh-prd.md` — removed when nothing is orphaned; references fixed.
- ADR-015, ADR-018, `docs/domain-language.md` — confirmed against delivered behavior; links updated after removal.

## Reuse Opportunities

- The live drivers and evidence format from children 07 and 10.
- The release gate script from child 11.

## Implementation Steps

- The complete remote-only journey passes on the live matrix with release-format artifacts and the real provider:
  connection, planning, local Plan Review, isolated execution, validation, AI review and repair, Code Review,
  confirmed publication, disconnect, offline history, reconnect, and saved continuation. The laptop sentinel tree is
  unchanged.
- The failure cases pass on the live matrix: normal exit, Stop, browser close, transport kill, a blocked network path
  (not a killed tunnel), launcher death, personal-resource server death, Session-owner and Worker death,
  save-acknowledgement loss, storage stall, interrupted setup, and loss during write, rollover, commit, review, merge,
  and publication. Unrelated processes survive.
- The compatibility cases pass: remote home outside Git, missing paths, missing FUSE prerequisites, direct personal file
  edits, project overrides, missing custom Skill dependencies, unsupported CLI models, alias and partial host matches,
  same-name projects, worktrees, and reconnect after uncertain publication.
- The publication stall seen in child 10's rerun (spinner at **Publication** for more than three minutes) is reproduced
  and either resolved or shown to be a provider or fixture artifact.
- The integration note from child 07 is checked: a forced TUI kill leaves no transient background log directories.
- Core owns every lasting Remote SSH requirement and scenario, including the tested matrix and deferred scope. The
  transient PRD is removed and every link resolves. ADR-015, ADR-018, and the glossary describe only delivered behavior.

## Verification Plan

- Automated: `bun run doc-links:check` after PRD removal; the full CI runs after implementation.
- Manual: the journeys and failure cases above, recorded with evidence paths in `manual-qa.md`.
- Documentation: confirm no requirement in the removed PRD lacks a Core owner, and no document claims an untested
  platform or provider.

## Edge Cases & Considerations

- A qualification finding that needs a different architecture returns to the owner. Do not ship an unlocked,
  downgraded, or silently reduced fallback.
- A blocked network path needs a real firewall or route change on the laptop or server, not `kill` on the SSH process.
