---
planId: "5a4b2c5e-bdab-4b7c-85d2-5c34cf79618b"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/attached/compatibility.ts"
    - "src/shared/attached/presentation.ts"
    - "src/attached/claude/plugin/commands"
    - "src/attached/codex/plugin/skills/run/SKILL.md"
    - "docs/prd/runwield-connect-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-02"
origin: "internal"
status: "ready_for_work"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
workRecord:
    status: "generated"
    recordId: "46a7c57c-0de6-4f2c-a3f0-ef6fe1226aaa"
    path: "docs/work-records/2026-11-03-quiet-connect-compatibility-across-qualified-release-families.md"
    lastAttemptAt: "2026-11-03T00:33:24.693Z"
---

# Quiet Connect Compatibility Across Qualified Release Families

## Context

Connect currently asks Claude Code and Codex to announce every returned compatibility notice. Core treats any host
version absent from its exact-version evidence list as untested. Models repeat those notices during ordinary work,
wasting attention and tokens.

The owner clarified that stable hosts (`1.0.0` and later) share coverage within a major, while pre-1.0 hosts share
coverage within a minor. Claude `2.x` is one qualification family; Codex `0.164.x` is one family and `0.165.x` is another.
Patch updates stay covered without individual qualification.

The owning capability is [Compatibility and honest availability](../prd/runwield-connect-prd.md#compatibility-and-honest-availability).
This Plan changes **Disclose tested host support and limitations** and its acceptance scenarios: routine untested-version
announcements disappear, qualified release families replace exact-version gating, and actionable incompatibility errors
survive.
[Preview Acceptance](../prd/runwield-connect-prd.md#preview-acceptance) and
[Codex acceptance](../prd/runwield-connect-prd.md#codex-acceptance) retain the provenance and limits of actual runs.

Current evidence includes a complete Claude `2.1.303` acceptance run. Codex `0.164.0-alpha.11.1` has separate installed
protocol and source-skill evidence, with remaining complete-installed-workflow and desktop gaps. Those facts do not
prevent adopting the owner's compatibility policy and must not become recurring notices.

## Objective

Claude `2.x` and Codex `0.164.x` remain covered without repeated qualification or routine compatibility prose in plugin
responses. Stable hosts require qualification at each new major; pre-1.0 hosts require it at each new minor. Uncovered
versions still operate quietly. Genuine host, adapter-contract, and minimum-version failures retain actionable errors.

## Approach

Keep policy in `src/shared/attached/compatibility.ts`. Represent qualified release families separately from exact
acceptance-run entries: stable coverage identifies a major; pre-1.0 coverage identifies both major `0` and a minor.
Initially seed Claude major `2` and Codex minor `0.164` from the recorded evidence. Do not represent Codex as blanket
major `[0]` coverage or seed any additional family. `testedVersions` remains a factual evidence ledger; compatible means
covered by policy, not that the installed patch was individually exercised. Do not manufacture a Codex live result.

Preserve the existing Claude minimum `2.1.303` and Codex's absence of a minimum. Apply the existing version parser and
ordering before family coverage. Prereleases and build suffixes do not change the numeric major/minor family key; a
prerelease below the minimum still fails the existing minimum check.

```text
unsupported host / adapter contract / below minimum -> actionable rejection
recognized version in qualified family             -> compatible
uncovered family or unreported version              -> continue quietly, retain internal assessment
```

Suppress all nonblocking compatibility assessments at the shared model-facing presentation boundary, for both compact
status and other operation responses, including results without a workflow. Continue assessing every evidence-carrying
operation and retain durable evidence. Blocking status diagnostics and rejection messages still reach the model.
Remove the announcement instruction from both plugins, including support for an older Core that still sends notices.

Qualification uses existing host acceptance procedures and recorded evidence before adding a stable major or pre-1.0
minor family. Codex `0.165.0` therefore needs separate qualification before gaining coverage. This change introduces no
background release watcher or automatic test scheduler. It preserves the current ability to use an uncovered version
quietly; missing qualification alone is not a new rejection.

Exact-version allowlisting was rejected because each patch release would recreate the noise and testing burden the
owner wants removed. The [SemVer specification](https://semver.org/) explains major/minor/patch ordering; the owner
explicitly chose MINOR qualification boundaries before `1.0.0` and MAJOR boundaries from `1.0.0` onward. The
[Claude plugin reference](https://code.claude.com/docs/en/plugins-reference) and
[official plugin documentation](https://learn.chatgpt.com/docs/plugins) confirm the existing packaged instructions and
MCP configuration surfaces; this Plan changes no host integration API.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/attached/compatibility.ts` and `compatibility.test.ts` — release-family coverage, truthful assessments,
  and retained refusal behavior.
- `src/shared/attached/presentation.ts`, with `src/attached/mcp.ts` callers — one shared projection that omits
  nonblocking compatibility material from model-facing results without weakening Core checks.
- Claude `plugin/commands/{request,implement,validate,plan-review}.md`, Codex `plugin/skills/run/SKILL.md`, and their
  package tests — silent normal operation and actionable rejection guidance.
- Both hosts' `mcp.test.ts` and Claude acceptance evidence/guide tests — serialized behavior and truthful evidence.
- `docs/prd/runwield-connect-prd.md`, both `docs/user-documentation/connect-*.md` guides, and
  `docs/domain-language.md` — release-family policy, qualification boundaries, and the revised Compatibility Matrix
  definition.

The Core-owned boundary in ADR-014 remains unchanged. Historical acceptance JSON records remain historical evidence.

## Reuse Opportunities

- Reuse `assessCompatibility`, `isBlockingCompatibility`, the existing parser, and host-specific update guidance.
- Reuse `compactStatus` and `compactResult`, which the shared MCP carrier already uses for both plugins.
- Reuse the real attached-workflow and MCP fixtures; no new dependency-injection seams are needed.
- Retain the existing acceptance runners and evidence schemas for future family qualification.

## Implementation Steps

1. `compatibility.ts` owns explicit qualified release families for both hosts and one family-matching rule: MAJOR for
   stable hosts, MAJOR plus MINOR for pre-1.0 hosts. `assessCompatibility` classifies eligible Claude `2.x` and Codex
   `0.164.x` releases as compatible, including patch, prerelease, and build variants within those families. Codex
   `0.165.0` does not inherit coverage. It preserves existing host, adapter-contract, minimum-version, version-parsing,
   and prerelease-ordering behavior. Uncovered families remain internally unqualified and usable. Compatible messages
   describe policy coverage without claiming an exact run.
2. `compactStatus` and `compactResult` omit nonblocking compatibility assessments on every successful response shape,
   including no-workflow results. Both MCP text content and structured content are quiet. Core's saved evidence remains
   available internally, and blocking status diagnostics and rejection/update messages remain intact.
3. All four Claude commands and Codex's run skill stop instructing models to advertise nonblocking compatibility
   notices. They continue on ordinary compatible, unknown-version, or unqualified-family results and show actionable
   blocking errors. Guidance also silences legacy nonblocking notices from an older compatible Core.
4. Behavioral tests prove stable same-major coverage, pre-1.0 same-minor coverage, real MCP response suppression,
   retained diagnostic refusals, and separate qualification at the applicable boundary. Existing tests that require
   exact-version notices are replaced; no-mutation, no-content-on-refusal,
   status recovery, and acceptance provenance checks remain protected.
5. The owning PRD, both host guides, and Compatibility Matrix glossary definition describe the delivered policy and
   matching acceptance scenarios. New stable majors and pre-1.0 minors require qualification before expanding coverage;
   stable minor/patch updates and pre-1.0 patch updates need no individual acceptance entry. Documentation distinguishes
   policy coverage from observed evidence and retains
   unresolved Codex journey gaps without restoring routine notices. Historical result dates, versions, and outcomes
   remain unchanged.

## Approval Confirmation

No Work Records are proposed for supersession.

## Verification Plan

- Use Bun `1.4.3`; run `bun run install:locked` before checks.
- Run `bun scripts/run-tests.js src/shared/attached/compatibility.test.ts src/attached/claude/mcp.test.ts
src/attached/codex/mcp.test.ts src/attached/claude/execution-plugin.test.ts src/attached/codex/plugin.test.ts
src/attached/claude/acceptance/compatibility-evidence.test.ts src/attached/claude/acceptance/guide.test.ts`
  as one command, plus any new focused presentation test file.
- Assert Claude `2.1.303`, `2.1.304`, `2.99.0`, and eligible `2.x` prereleases/build variants are compatible. Assert
  Codex `0.164.0-alpha.11.1`, `0.164.0`, `0.164.1`, and `0.164.x` prerelease/build variants are compatible despite the
  empty exact-run ledger. Codex `0.163.9`, `0.165.0`, `0.999.0`, and `1.0.0`, plus Claude `3.0.0`, must not inherit
  coverage. These tests fail under the current exact matcher, blanket Codex major-zero coverage, and an unconditional-
  compatible stub. Prove the stable/pre-1.0 distinction through the real assessment path.
- Exercise both real MCP carriers through activation, instruction reads, ordinary lifecycle responses, and status.
  Verify that text and structured responses contain no nonblocking compatibility assessment or notice for covered,
  uncovered-family (including Codex `0.165.0`), and unreported-version cases; cover no-workflow status too. Verify that
  saved workflow evidence remains
  truthful. Hiding prose only in plugin instructions cannot pass these checks.
- Retain tests for unsupported hosts, stale/new adapter contracts, Claude `2.1.302`, and the floor prerelease. Rejections
  must preserve their exact actionable update guidance, return no protected work content, and leave durable workflow,
  Plan, and worktree state untouched. Blocked status stays diagnostic and does not resume validation.
- Inspect both packaged instruction sets and updated docs together: no blanket instruction to display compatibility
  notices, no claim that Codex's remaining journey gaps were tested, and the correct qualification boundary: stable
  MAJOR, pre-1.0 MINOR. Confirm no blanket Codex `0.x` coverage claim remains.
  Existing evidence-integrity tests must still pass without altering saved results.
- Run `bun run fmt:check` with explicit changed paths. No browser UI or fresh live-host acceptance is needed to prove
  this policy change; no additional release family is being qualified by this Plan.

## Edge Cases & Considerations

- Existing records can contain old nonblocking messages. Projection must suppress them without rewriting history.
- Missing or malformed host versions remain usable quietly; they must not be relabeled as proven evidence.
- Preserve the minimum-version floor as an existing actionable blocker. Broadening support to older versions is outside
  this request.
- Pre-1.0 coverage is keyed by major `0` and minor. Codex `0.164.x` shares coverage; `0.165.0` needs its own
  qualification. Stable `1+` hosts retain MAJOR boundaries. Uncovered families remain quiet and usable.
- Policy coverage and individual test evidence are different facts. Keep their data and wording distinct so future
  qualification can add actual results without manufacturing past test runs.
