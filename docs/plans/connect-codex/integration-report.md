# Codex Connect integration report

The [Epic](../connect-codex.md) adds the native `$runwield:run` start/resume skill, shared Core coordination, and
artifact-based continuation between Codex and Claude Code. Both desktop and CLI are targets, with separate evidence
limits. This report records external delivery work; it is not a Core Verified attestation. Core-owned Plan lifecycle
metadata remains unchanged.

## Child delivery

Each child was implemented by a subagent in a separate managed worktree. Three independent reviewers assessed
Standards, Spec, and Tests before its branch merged into `epic/connect-codex`.

| Child                                           | Final source or repair                | Epic integration         | Child review           |
| ----------------------------------------------- | ------------------------------------- | ------------------------ | ---------------------- |
| Share host-aware coordination                   | `bce0317b6`                           | `27a7d4432`              | All three axes approve |
| Package the Codex workflow                      | `7403fbb79`                           | `983077d00`              | All three axes approve |
| Prove Codex execution and recovery              | `08fdcc8ef`, final repair `b32705f8f` | `7f992a00d`, `a2ff2ef73` | All three axes approve |
| Document Codex support                          | `871e340d7`                           | `2f3946550`              | All three axes approve |
| Repair catalog identity collisions              | `67fb8595b`                           | `f16a0f382`              | All three axes approve |
| Repair confirmed archive during turn settlement | `ed9f77f9d`                           | `4c14e1766`              | All three axes approve |

The fifth Plan repairs a baseline ordering defect exposed by Linux PR CI: authority projection could hide a conflicting
Plan ID. Same-name selection now precedes the existing rename fallback. Real filesystem fixtures cover both enumeration
orders, explicit backfill, and missing or archived authority without weakening collision rejection.

The sixth Plan repairs an independently reproduced Workspace archive race. A confirmed archive now reconciles the
original turn's durable idle or checkpointing state when its live operation disappears. Active, uncertain, or
replacement work remains protected. Twelve deterministic cases exercise both remote boundaries and replacement during
settlement. The original cancellation fixture now waits for its provider's AbortSignal instead of assuming a delay.

Live host interruption also exposed a shared cancellation gap. The MCP carrier handles native shutdown signals, and
macOS process cleanup survives the owning runtime's exit. Real process tests cover EOF, signals, owner death, and the
existing fork race. These changes preserve Claude behavior through the shared carrier.

## Whole-epic review

A new set of reviewers with clean contexts read the complete 74-file change from `875f058b7` to `f16a0f382`, the Epic,
the original five child Plans, and applicable requirements. They subsequently read the complete four-file snapshot
repair and the three-file sixth Plan against its objective and the Workspace requirements.

## Standards

Approved with no open issues or advisories. The child review's `STANDARDS-P3-001` was independently confirmed fixed:
acceptance exempts only Core's `.wld/internal/` runtime files, preserving user configuration.

## Spec

Approved with no open issues or advisories. `SPEC-P3-001` now reports unavailable host authentication as a blocked
prerequisite without recording private errors. `SPEC-P3-002` now preserves user configuration during isolation checks.

## Tests

Approved after repair, with no open issues or advisories. `T-P2-001` added workflow contract counterexamples;
`T-P3-001` protects invoking source bytes and Git state; `T-P3-002` rejects inherited worker context at the native event
boundary. Whole-epic issue `T-EPIC-001` fixed a reused snapshot producer's Claude-only configuration exclusion. Real
Codex snapshots now capture configuration creation, edits, deletion, and Git status; Claude keeps its own installation
exception. Every claimed fix was independently re-reviewed.

## Validation

- Bun 1.4.3, initialized submodules, and `bun run install:locked` were used for the implementation checkouts.
- Baseline `bun run ci` passed at `fe8e6efef` in 691.9 seconds. The epic includes `origin/main` through `875f058b7`.
- Integrated `bun run ci` passed at `d79d25c91` in 1050.0 seconds. Later repairs passed their focused tests, types,
  lint, formatting, and zero-seam checks. Documentation links and the public site build passed.
- GitHub source and Golden shards passed at `a2ff2ef73` on retry. The first attempt exposed the archive race repaired
  by the sixth Plan; the passing retry did not dismiss that reproduced defect. Final CI and the final evidence/documentation
  review are recorded on [PR #477](https://github.com/RunWield/runwield/pull/477).
- The original checkout's unrelated Plan edit was preserved. No installed user plugin or credentials were changed for
  acceptance; native installation uses disposable configuration.

## Host acceptance

The native package supplies bounded adapter metadata because plugin-root environment expansion was unavailable in the
observed host. Its one-hour MCP timeout was exercised with a 65-second call. Protocol installation and live source-skill
execution remain distinct evidence scopes. Saved summaries identify their exact source commit, digest, host version,
permissions, and limitations; they contain no raw conversation or credentials.

Both [installed protocol](../../../src/attached/codex/acceptance/results/codex-0.164.0-alpha.11.1-installed-protocol.json)
and [source-skill](../../../src/attached/codex/acceptance/results/codex-0.164.0-alpha.11.1-source-skill.json) acceptance pass
on clean integrated source `a2ff2ef73`, digest `6cb23082c7ed342e3216d5986d9e19f080aa58877c67ba72636cf319b388f697`,
with Codex `0.164.0-alpha.11.1`. All 16 live checks pass. The live journey exercises browser Plan chat, restoration, isolated implementation, interrupted validation, independent
review, forced repair and re-review, Code Review approval, Core publication, and the canonical Work Record. Native
spawn identities and direct candidate-bound diff receipts establish reviewer independence.

## Qualification limits

The Codex Compatibility Matrix remains empty. Native installed-package protocol evidence and explicit-path source-skill
evidence do not establish an installed complete workflow, desktop UI walkthrough, default-permissions acceptance, or a
stable version range. Recognized untested hosts receive a visible notice. Publishing this repository PR does not release
a new Core binary or submit the plugin to a public directory. Installation and remaining scope are documented in the
[Codex guide](../../user-documentation/connect-codex.md).

Review counts: Standards 0 issues / 0 advisories; Spec 0 / 0; Tests 0 / 0.
