---
planId: "6e195a92-3697-477e-b097-45ac5bd648d7"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/runwield-owned-paths.ts"
    - "src/shared/worktree.js"
    - "src/shared/workflow/execution-start.ts"
    - "src/shared/workflow/validation-publication.ts"
    - "src/shared/isolated-publication.ts"
    - "src/shared/workflow/validation-merge-repair.ts"
    - "src/shared/project-runtime-layout.ts"
    - "docs/prd/runwield-core-prd.md"
    - ".gitignore"
    - "src/shared/worktree-runtime-state-isolation.test.ts"
    - "src/shared/runwield-owned-paths.test.ts"
    - "src/shared/worktree-merge.test.js"
    - "src/shared/workflow/publication-machine.e2e.test.ts"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-29T03:04:59.963Z"
status: "validated"
origin: "internal"
parentPlan: "consolidate-project-runtime-state"
order: 7
dependencies:
    - "06-wire-project-entry-guards"
userVerifiedAt: null
targetBranch: "epic/consolidate-project-runtime-state"
---

# Enforce Git and Publication Safety

## Context

The old `../../../../.gitignore` contract enumerates many runtime paths under `../../../../.wld`. The Epic requires one
current ignored boundary, `../../../../.wld/internal`, while user-derived `.wld` files stay trackable. Git safety must
also keep known legacy runtime hazards out of staging and publication.

Children 01–05 provide the layout, migration, and moved stores. Child 06 must provide project entry guards before this
child executes. This child makes repository and publication policy match that layout.

Discovery on 2026-09-14 used both the dirty `main` checkout and read-only Git inspection of
`epic/consolidate-project-runtime-state`. The Epic branch contains children through 05, not the completed child 06.
Execute after child 06 on the existing target branch. Recheck its delivered entry interface; do not rebuild missing
prerequisites here. Preserve unrelated working-tree edits, including execution-start and Core PRD changes.

The existing [Epic](../consolidate-project-runtime-state.md) and
[ADR-017](../../../adr/017-project-runtime-state-under-wld-internal.md#git-behavior-during-and-after-migration) settle
the policy. Core's [work protection](../../../prd/runwield-core-prd.md#work-protection) capability owns the proposed
named requirement **Keep Project Runtime State out of repository changes**, with scenarios for runtime exclusion,
trackable configuration, preserved ignore rules, and non-destructive refusal. Extend the child 06 requirement if it
already covers this outcome rather than duplicate it. Preserve **Preserve user work and require deliberate destructive
actions** and
[execution, validation, and recovery](../../../prd/runwield-core-prd.md#execution-validation-and-recovery), including
**Publish successfully or end only by deliberate user abandonment**. No product requirement is removed.

## Objective

Ensure current runtime state and known legacy runtime hazards cannot enter implementation commits or publication
commits, while `../../../../.wld/settings.json`, local Agents, Skills, and prompts remain eligible repository changes.

## Approach

Reuse `isCurrentProjectRuntimePath()` and `isLegacyProjectRuntimeHazardPath()` from child 01. The first owns the whole
Project Internal Root, including new descendants not listed today. The second remains a bounded safety catalog, not
permission for normal writers to use old paths. Keep their union for Git safety only.

```text
successful Project Runtime Entry
  reconcile one managed ignore block, report broad user rules
preparation / implementation checkpoint / validation artifacts
  inspect HEAD and index for runtime hazards before changing the index
  stage eligible user changes; verify the resulting index; commit
local or remote publication, including saved attempts and repair
  check incoming commit history and runtime hazards in each commit checkout
  assemble safely; recheck final candidate history; update target or push
```

Current branch evidence: `RUNWIELD_GITIGNORE_BLOCK` still emits the aggregate old/new path list. Checkpoint staging
filters new additions but does not protect against hazards already in the index.
`untrackOwnedRuntimePathsAbsentFromMergeTarget()` can make a removal commit without removing the earlier runtime content
from history. `commitPublicationMetadata()` and `finalizeMergeRepair()` use unrestricted `git add -A`.
`assertPreMergeCandidateUnchanged()` ignores runtime paths; it is not a publication safety check.

Replace silent tracked-runtime cleanup with the Epic's explicit refusal. Inspect HEAD as well as the index so staged
removals and renames cannot hide tracked hazards. Check before staging, then check the resulting index before each
RunWield commit. Untracked current state is ignored and excluded even without `../../../../.gitignore`; untracked legacy
hazards are excluded by Git helpers, while Project Runtime Entry retains its own migration/refusal rules.

Publication checks must inspect every commit newly reachable from the intended target, including side parents of merge
commits. A clean final tree or endpoint diff is not enough: adding runtime data in one commit and deleting it in another
must still refuse publication. Check incoming history before merge/ref movement, then the assembled or repaired
candidate before publication. Do not scan or rewrite all historical target commits. Existing runtime files in the
target's current tree still require refusal under ADR-017. Reuse the existing target/lease and saved-attempt evidence;
do not introduce a second publication state machine.

Use NUL-delimited Git path output without trimming filenames. Inspect both sides of renames, or disable rename detection
where separate add/delete paths give the same proof. Keep `--untracked-files=all`; a collapsed `../../../../.wld` status
cannot separate runtime data from user files. Treat Git-reported paths as literal filenames when passing them back to
Git.

Reconcile ignore rules after successful entry, including already-adopted projects, and before preparation in new or
reused execution checkouts. Migration refusal must precede ignore writes. Carry broad-rule warnings through existing
command or workflow reporting; a return value nobody reads is not a report. Do not silently swallow reconciliation
errors as success.

The main option set aside is ignoring all of `../../../../.wld`: it hides user configuration. A removal commit is also
insufficient because it leaves runtime data in published history. This child does not add automatic history rewriting.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `../../../../src/shared/runwield-owned-paths.ts` — keep existing classifiers; emit and reconcile one managed entry;
  report broad rules without changing them. Do not merely change the unused `runwieldOwnedPathspecExclusions` export.
- `../../../../src/shared/project-runtime-layout.ts` — connect reconciliation to the successful entry path delivered by
  child 06, without writes on migration refusal or recursive entry.
- `../../../../src/shared/worktree.js` — protect preparation and implementation checkpoints, dirty-path checks, index
  handling, and local merges; replace silent untracking with refusal and inspect Git paths without losing rename
  endpoints.
- `../../../../src/shared/workflow/execution-start.ts` — cover new and reused worktrees and preserve existing worktree
  reuse rules.
- `../../../../src/shared/workflow/validation-publication.ts`, `../../../../src/shared/isolated-publication.ts`, and
  `../../../../src/shared/workflow/validation-merge-repair.ts` — apply the same safety rules to validation artifacts,
  local and remote publication, metadata commits, saved attempts, and repair commits.
- Owned-path, runtime-isolation, merge, execution-progress, validation-publication, isolated-publication, and
  publication process-death tests — prove real commit/index/ref behavior, not only predicates. Add focused repair
  coverage where needed.
- `../../../../.gitignore` — reconcile this repository's old standalone entries and managed block without changing
  unrelated rules.
- `../../../prd/runwield-core-prd.md` — synchronize the owning work-protection requirement and acceptance scenarios in
  this change; link shared recovery requirements and ADR-017.

No new domain term or architectural decision is needed. Preserve the Project Runtime State definitions delivered by
children 01–06. Broader Doctor reports, release documentation, and final Epic-wide test cleanup remain child 08 work.

## Reuse Opportunities

- `../../../../src/shared/runwield-owned-paths.ts` — reuse managed-block replacement and path normalization.
- `../../../../src/shared/worktree.js` — reuse existing staging and merge-protection code paths; shared safety code must
  be called by the real commit/publication paths, not added as an unused wrapper.
- Child 06 Project Runtime Entry and the existing publication failure handling — preserve refusal details and the same
  recoverable workflow. Do not add test-only dependency injection for Git safety or RunWield-owned state.
- `../../../../src/shared/git-test-fixture.ts` — use real Git fixtures for tracked, staged, intent-to-add, renamed,
  deleted, and ignored paths.

## Implementation Steps

- [ ] Exactly one managed `../../../../.gitignore` block contains only `../../../../.wld/internal`. Reconciliation
      removes complete duplicate managed blocks and exact obsolete RunWield lines, including the previously emitted
      directory forms with and without trailing slashes. Unrelated comments, negations, custom patterns, and line
      endings remain byte-equivalent except necessary newlines adjoining the managed block. A second reconciliation
      makes no write.
- [ ] Broad user-authored ignore rules such as `../../../../.wld` remain unchanged and produce an observable warning
      that names the hidden configuration. Successful entry covers new and already-adopted projects; new and reused
      execution checkouts have the canonical block. Entry refusal leaves `../../../../.gitignore` unchanged. Unmatched
      markers do not cause unrelated user content to be deleted; they produce a non-destructive diagnostic.
- [ ] Preparation, implementation completion, validation artifacts, and publication/repair commits exclude untracked
      current state and legacy hazards. Runtime paths in HEAD or the index, including intent-to-add, staged deletions,
      and either endpoint of a rename, cause explicit refusal before automatic staging or commit. The refusal preserves
      index entries, HEAD, user bytes, and runtime bytes. No silent `git rm --cached` cleanup remains on these paths.
- [ ] Local and remote publication reject runtime hazards in newly incoming commit history, including add-then-delete
      and merged side-branch history, before advancing a target or pushing. Saved-attempt and repair paths cannot bypass
      this check. Candidate sealing, target leases, and publication receipts retain their existing meaning.
- [ ] Refusal identifies safe exact paths without printing runtime content or secret values. It does not mark delivery
      complete, delete the execution/repair checkout, or end the workflow. Existing recovery retains work and permits
      retry after authorized repository cleanup. A tracked secret also carries the existing exposure/rotation warning.
- [ ] `../../../../.wld/settings.json`, `.wld/agents/**`, `.wld/skills/**`, and `.wld/prompts/**` remain eligible
      changes. Real checkpoint and publication fixtures include them while excluding runtime data. A broad user ignore
      rule is the explicit exception; RunWield warns rather than force-adding configuration against that rule.
- [ ] Real Git tests cover the state matrix below and the actual preparation, checkpoint, metadata, repair, and
      publication callers. Existing work protection tests remain active; the old final-tree-only cleanup expectation is
      replaced with non-destructive refusal and history assertions, not dropped without replacement.
- [ ] Production source contains no current direct write target for known pre-0.10.0 project runtime paths outside
      migration/safety and bounded diagnostics. Follow remaining references to their actual writer and distinguish
      global `~/.wld` paths. Report a missing prerequisite rather than redo store migration here.
- [ ] Core's work-protection requirement, acceptance scenarios, and affected references describe delivered Git safety
      and preserved user configuration. Keep unmet recovery and child 08 documentation targets explicit. Existing
      glossary definitions and ADR-017 remain consistent with the implemented behavior.

## Verification Plan

Use the sandboxed runner only:

```sh
deno run -A scripts/run-tests.js src/shared/runwield-owned-paths.test.ts src/shared/project-runtime-layout.test.ts src/shared/worktree-runtime-state-isolation.test.ts src/shared/worktree-merge.test.js src/shared/workflow/execution-progress.test.ts src/shared/workflow/validation-publication.test.ts src/shared/isolated-publication.test.ts src/shared/workflow/publication-machine.e2e.test.ts
deno task seams:check
deno task ci
```

Run new focused repair tests through the same runner. CI must pass before child 08 starts; do not skip the safety cases
below to obtain a pass. Use `defineGitFixture`; use the process-global lock if a test changes home or working directory.

### Behavioral evidence

| Starting condition and action                                                                                                                                                  | Required evidence                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old managed block, duplicate blocks, standalone obsolete entries, custom rules; reconcile twice                                                                                | Exactly one canonical block; obsolete exact lines gone; unrelated bytes retained; second call performs no write. Include CRLF and missing final newline.                                                                                                                            |
| Broad `../../../../.wld` rule; enter project or prepare execution                                                                                                              | Rule unchanged; a real caller reports which user configuration it hides. An unconsumed helper warning fails this test.                                                                                                                                                              |
| Entry refuses migration; attempt normal startup/preparation                                                                                                                    | `../../../../.gitignore` bytes unchanged; no commit or target advance. Preserve child 06 no-write help/empty-startup coverage.                                                                                                                                                      |
| Untracked current state, including an unlisted future descendant, and user configuration; exercise the shared staging operation without ignore rules, then a normal checkpoint | Staging excludes runtime without relying on ignore rules. The checkpoint commits user files; runtime stays on disk outside the index/tree. With the canonical block, `git check-ignore` matches only runtime, not settings/Agents/Skills/prompts.                                   |
| Recognized untracked legacy paths, including registry/secret temporary files and Work Record locks; invoke direct Git staging helper boundary                                  | Legacy data never enters the index or commit. Normal guarded entry may instead refuse unsupported legacy state; do not weaken that policy to make the fixture succeed.                                                                                                              |
| Runtime paths tracked in HEAD, force-staged additions/modifications, intent-to-add, staged/unstaged deletions, or renames in either direction; checkpoint                      | Explicit path-specific refusal; before/after HEAD, index entries, target refs, and file bytes match. Include partially staged user content beside the hazard.                                                                                                                       |
| Safe paths with spaces, tabs, newlines, leading/trailing spaces, or Git pathspec characters; runtime/user rename pair                                                          | Both rename endpoints are checked; no quoted/trimmed path bypass or accidental staging of another path. Safe ordinary files still commit.                                                                                                                                           |
| Runtime file committed then deleted; or introduced on a merged side branch; publish locally and to a local bare remote                                                         | Publication refuses even though the final tree is clean. Local target and remote target refs do not move; no runtime-bearing commit becomes newly reachable.                                                                                                                        |
| Saved publication or completed repair contains staged or committed runtime data; retry                                                                                         | Same refusal and preserved checkout. Include runtime committed and later deleted, so this path cannot substitute a tip-only check. Test `commitPublicationMetadata` through real isolated publication and `finalizeMergeRepair` with a real Git merge, not mocked safety callbacks. |
| Clean execution containing implementation and all four user configuration categories; local and remote publication                                                             | Publication succeeds; intended files and lifecycle artifacts reach the target; no runtime path appears in newly published commit trees or changed paths. Source primary edits remain intact.                                                                                        |
| Process stops during publication, then resumes                                                                                                                                 | Existing process-death matrix still proves confirmed publication and safe cleanup; successful resumed target history contains no runtime data.                                                                                                                                      |

Entry integration may install `../../../../.gitignore` or refuse legacy state before checkpointing. Test
ignore-independent staging through the shared production operation used by commit callers; do not add a test-only
export, bypass entry, or inject fake RunWield safety. Separately prove that each caller uses that operation and
preserves entry refusal.

Snapshot the index's staged entries and working bytes, not only `git status`. Inspect every newly reachable commit and
its changed paths with NUL-delimited Git output; a final `ls-tree` or endpoint diff alone cannot prove absence from
history. Refusal tests must observe the public checkpoint/publication result, not merely call the classifier. The
force-staged test fails if safety is only an ignore rule. The add-then-delete test fails if safety is only a removal
commit or tip-tree check. The safe publication case fails if the implementation refuses all work.

Preserve existing tests for ignored-working-copy deletion
(`checkpoint preserves removal of a tracked file whose working
copy is now ignored`), ordinary tracked/untracked
commits, dirty primary overlap protection, execution reuse, candidate sealing, target leases, detached merge repair,
publication receipts, and interruption recovery. Behavior that stops:
`previously committed runtime state is removed before merge` becomes a refusal test; enumerated generated ignore lists
become one-root assertions. Keep legacy predicate coverage, now explicitly safety-only.

### Inspection and manual evidence

- Trace all automatic `git add`/`commit`, merge, and push callers in the expected surface. Confirm each real path
  reaches the index/history check, including preparation without a target ref and saved attempts that skip initial
  checkpointing.
- Inspect remaining legacy path constructors and writers. Source search is supporting evidence, not the safety proof.
- In a disposable project, enter twice with an old ignore block and custom rules. Check one canonical block and stage
  settings, an Agent, a Skill, and a prompt. Then force-stage a runtime file and attempt a checkpoint: confirm a precise
  refusal with the staged work retained. Do not use the developer's real runtime files or credentials.
- Review Core PRD scenarios against these tests. Confirm the glossary still excludes user configuration from Project
  Runtime State and that no new requirement is presented as delivered without evidence.

## Edge Cases & Considerations

- `../../../../.gitignore` does not untrack existing files or remove committed secrets. Follow ADR-017's explicit
  cleanup policy; do not rewrite history or delete uncertain state. Refusal is recoverable, not an automatic terminal
  workflow outcome.
- A user broad-ignore rule may be intentional; report it rather than deleting it or force-adding files without
  authority.
- Renames and deletions of tracked runtime files are still repository changes. Runtime-to-user renames cannot hide the
  source path; staged deletions cannot disappear merely because `ls-files` no longer includes them.
- Recheck the exact candidate that will advance the target, including repaired/saved publication copies. An earlier
  clean execution checkpoint is not proof about a later metadata or repair commit.
- If required Git evidence cannot be read, refuse the operation without claiming safety. Preserve existing workflow
  recovery; do not turn a failed inspection into an empty safe path list.
- Historical target commits are not rewritten by this child. Previously exposed secrets can require rotation and
  separate authorized repository-history cleanup even when the present target tree is clean.
- The target branch must include child 06 before execution. No source edits or branch switches are part of planning.
