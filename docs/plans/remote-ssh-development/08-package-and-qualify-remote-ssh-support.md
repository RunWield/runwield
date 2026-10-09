---
planId: "a65417c5-35b5-4192-9355-c5000440568f"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "scripts/compile.js"
    - "scripts/release-assets.js"
    - "scripts/release-check.js"
    - "src/cmd/install/"
    - "src/cmd/update/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/adr/018-remote-ssh-local-personal-authority.md"
    - "docs/adr/015-file-authoritative-session-bundles.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
createdAt: "2026-09-21T02:05:52.824Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 8
dependencies:
    - "01-establish-the-remote-connection-and-matched-runtime"
    - "02-bridge-local-models-and-personal-resources"
    - "03-guard-remote-session-writer-access"
    - "04-run-and-resume-remote-sessions-with-local-history"
    - "05-keep-memory-and-integrations-on-their-owning-machine"
    - "06-carry-remote-context-through-delivery-workflows"
    - "07-open-remote-reviews-in-the-local-browser"
targetBranch: "epic/remote-ssh-development"
---

# Package and Qualify Remote SSH Support

## Context

The preceding children establish behavior, but RunWield cannot claim remote SSH support until released builds contain
matching Linux x64 and ARM64 runtimes, compatible SSHFS helpers and broad-access notices, and full journey and failure
evidence on the advertised matrix. Prototype success on one host, synthetic filesystem tests, or a killed tunnel are not
sufficient release evidence.

This slice closes the Remote SSH proposal into the lasting Core PRD, verifies ADR and glossary consistency, and retires
the transient PRD only after delivered and unresolved requirements have durable owners.

## Objective

Ship a non-destructive, verified remote runtime package for the supported matrix and prove the complete remote delivery,
review, disconnect, and reconnect journeys. Publish only support claims backed by actual stock components and built
artifacts.

## Approach

Extend existing compile, release-asset, private-helper, checksum, licensing, and release-check machinery. Qualify the
exact artifacts users receive on clean supported targets. Run one combined acceptance matrix that crosses all child
boundaries, then consolidate lasting requirements and remove the transient proposal according to project policy.

Do not treat the ordinary personal installer as the remote bootstrap; profile mutation and unpinned dependency selection
violate the architecture.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `scripts/compile.js`, `scripts/release-assets.js`, release checks, and helper packaging — produce verified matching
  remote runtimes and compatible dependency assets for Linux x64 and ARM64.
- Installer/update/runtime preparation modules — install only private versioned remote cache resources and repair
  interrupted setup without changing profiles or personal storage.
- Release metadata, licenses, and source notices — describe shipped OpenSSH/SSHFS/FUSE-related dependencies and verified
  compatibility limits.
- `docs/prd/runwield-core-prd.md` and affected references — own the lasting delivered requirements, acceptance
  scenarios, verified matrix, and deferred limits.
- `docs/prd/remote-ssh-prd.md`, ADR-015, ADR-018, and `docs/domain-language.md` — consolidate accepted truth, fix
  references, and retire the transient PRD when no requirement is orphaned.

## Reuse Opportunities

- Existing Linux x64/ARM64 compile and release-asset pipelines — add remote runtime composition rather than a separate
  release system.
- Existing private helper packaging, checksum verification, atomic install, license, and source-notice patterns.
- Acceptance tests and live evidence from children 01–07 — combine them into release gates rather than replacing their
  focused checks.
- Core PRD capability ownership and transient-PRD retirement policy — preserve one lasting owner for each requirement.

## Implementation Steps

- Release builds publish matching Linux x64 and ARM64 remote runtimes with the compiled review UI, Core project tools,
  protocol metadata, checksums, and all required license/source notices.
- Required SSHFS and user-space helpers are pinned, verified, installed atomically in private versioned storage, and
  selected without replacing system packages or attempting root escalation; unavailable FUSE prerequisites fail clearly.
  The release qualifies the full laptop `~/.wld` mounted at a fresh private remote path, direct personal file edits,
  remote project `.wld` ownership, and the synchronous laptop-owned Session-save bridge selected on 2026-10-06. It does
  not package copied personal resources or a special resource synchronization service.
- Development builds require a matching development artifact, and released launchers require the same release/protocol
  identity; neither can silently downgrade or run an arbitrary remote PATH installation.
- Interrupted setup, stale connection resources, and partial helper installs repair automatically without deleting
  remote project edits, local Session history, or package-managed installations.
- The supported matrix names only laptop systems, remote GNU/Linux architectures, personal-resource SFTP behavior, FUSE
  prerequisites, Session-save Worker behavior, and Pi providers exercised by the release evidence; untested platforms
  and CLI backends remain excluded or deferred.
- The complete remote-only delivery journey passes with actual built artifacts: bootstrap, planning, local Plan Review,
  isolated execution, validation, AI review and repair, Code Review where selected, confirmed publication, disconnect,
  offline local history, reconnect, and saved continuation.
- Failure qualification covers normal exit, Stop, browser close, transport kill, a blocked network path, launcher death,
  personal-resource serving-owner death, Session-owner and Worker death, save-acknowledgement loss, storage stall,
  interrupted setup, and loss during write, sync, rollover, commit, review, merge, and publication.
- Lasting delivered and unresolved requirements, observable outcomes, and acceptance scenarios move into their Core
  capability owners; references are fixed and the transient Remote SSH PRD is removed only when nothing is lost.
- ADR-018 is accepted, ADR-015 matches the implemented writer extension, and the glossary defines only shipped
  relationships and avoided aliases.

## Verification Plan

- Automated: run artifact manifest, checksum, architecture, protocol-version, compiled-review-UI, helper-license,
  interrupted-install, and release-upgrade checks against the actual candidate assets.
- Automated: run `deno task doc-links:check`, `deno task seams:check`, `deno task ci`, and the full safe test suite with
  `deno task test`; never invoke `deno test` directly.
- Paired live matrix: on clean remote Linux x64 and ARM64 targets, use supported laptop builds and at least the verified
  Pi provider matrix to perform the complete journey with a same-named laptop sentinel tree.
- Paired failure matrix: test each listed failure against actual OpenSSH, stock SFTP, SSHFS, native Deno locks, built
  runtime, review UI, and provider. Continuously probe competing writers and confirm unrelated processes survive.
- Compatibility: test remote home outside Git, missing paths, missing FUSE permission, direct personal file edits, broad
  SFTP notice, remote project overrides, missing custom Skill dependencies, unsupported models, alias changes, same-name
  projects, worktrees, and reconnect after uncertain publication.
- Documentation: verify Core owns every lasting requirement and scenario, all links resolve after transient PRD removal,
  ADR statuses match implementation, and the glossary does not promote unverified support.

## Edge Cases

- One successful Fedora x64 run does not establish every GNU/Linux distribution or libc. Record the exact tested
  baseline.
- Strict per-entry laptop write/sync acknowledgements, native writer exclusion, sticky save faults,
  duplicate/conflicting request reconciliation, and stale-operation refusal are Session-storage release gates on each
  advertised build. SFTP/SSHFS qualification remains required for personal resources; Session history is not written
  through that mount.
- A killed SSH tunnel is not a real blocked-network-path test, and launcher death alone does not prove Session-owner
  exclusion or sticky save-fault behavior.
- SSHFS has maintenance risk. Keep Session ownership and bundle formats transport-independent enough that a later
  transport can replace it without changing authority.
- Release qualification can uncover an architectural mismatch. Return that decision for review rather than shipping an
  unlocked, downgraded, or silently reduced fallback.
