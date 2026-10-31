---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
  []
executionAgent: "engineer"
createdAt: "2026-10-31T15:38:43.797Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 14
dependencies:
  []
targetBranch: "epic/remote-ssh-development"
planId: "70c667eb-4bd3-4be6-b3a5-1179481899e7"
---

# Repair integration findings

## Context

The integration gate checked the Epic branch `epic/remote-ssh-development` at `dda3a42c715e555492c4c137e86abde4a84db548` and found the problems below.
The full report is `docs/plans/remote-ssh-development/integration-report.md`. This draft was created by RunWield; plan the repair from these
findings and the Epic. After this child is delivered, the integration gate verifies these findings and checks the repair for regressions.

## Objective

Resolve every finding below on the Epic branch.

## Findings

### R1-1. Remote setup does not supply SSHFS and its user-space dependencies

Source: Integration review

Requirement: Startup and version compatibility requires compatible SSHFS and its required user-space dependencies to be supplied without replacing system packages. Only FUSE kernel access and mount permission are host prerequisites.

Evidence: src/cmd/remote/index.ts calls assertRemoteHostReady before runtime preparation. The new src/shared/remote/host-prerequisites.ts rejects hosts without system sshfs and fusermount3 and directs users to install system packages. src/shared/remote/helpers.ts supplies only cymbal and ketch. src/shared/remote/sftp-mount.ts then uses host SSHFS/FUSE commands. Thus a supported host with usable kernel FUSE but no SSHFS cannot receive the promised private setup. No supplied Child Plan Deviation replaces this requirement.
