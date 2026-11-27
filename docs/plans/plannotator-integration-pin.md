---
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "HIGH"
affectedPaths:
    - ".gitmodules"
    - "third_party/plannotator"
    - "third_party/plannotator-revision.txt"
    - "third_party/README.md"
    - "src/ui/workspace/astro.config.ts"
    - "package.json"
    - "bun.lock"
    - "src/ui/workspace/react/"
    - "docs/adr/006-local-first-workspace-plan-board.md"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/plan-review"
devServerHmr: true
parentPlan: "product-planner-sequence"
order: 1
createdAt: "2026-11-12"
status: "draft"
planId: "118c3dd9-ce93-4ae1-b150-a79ec58ce237"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
---

# Pin Plannotator to the Fork Integration Branch

## Context

Local prototype review needs two Plannotator options that are still open upstream:

| PR                                                            | Branch on `gandazgul/plannotator` | Head when checked | Option                                                          |
| ------------------------------------------------------------- | --------------------------------- | ----------------- | --------------------------------------------------------------- |
| [#3907](https://github.com/backnotprop/plannotator/pull/3907) | `feat/host-html-restrictions`     | `b18131870`       | `resourcePolicy="self-contained"`                               |
| [#4032](https://github.com/backnotprop/plannotator/pull/4032) | `feat/html-annotation-context`    | `1a89dcaec`       | displayed context on annotations (`displayedContextAttributes`) |

**Owner decision (2026-11-12):** do not wait for upstream. Combine both PRs on the owner's fork and pin RunWield to that
combination now. This is the fallback recorded in the [local prototype review](local-prototype-review.md) Plan. Return
to an upstream pin after both PRs merge; that later re-pin is not part of this Plan.

This Plan delivers no product capability. It makes the dependency available so the next two children can build on it.
The requirements it serves remain targets in [interactive prototype review](../prd/product-planner-prd.md#interactive-prototype-review).

### Epic Scope Changes

- New first child. Moved the pin update and fork-integration work out of `local-prototype-review`, which now consumes
  this pin and starts at order 2. `product-planner-workflow` moves to order 3.

## Objective

RunWield's `third_party/plannotator` points at one pushed, fetchable commit on the fork that contains current upstream
`main` plus both PR branches. Existing Plan Review, Code Review, and Workspace screens still work on that version.
RunWield can import both new options from the pinned source.

## Approach

### Two repositories, in order

```text
~/web/plannotator (fork clone)
  integration branch = upstream/main + merge PR #3907 head + merge PR #4032 head
  focused Plannotator tests, then push to origin
~/web/runwield (execution worktree)
  .gitmodules url/branch -> fork integration branch
  gitlink + plannotator-revision.txt -> same commit
  adapt RunWield to the newer Plannotator source
```

The setup Plan already worked on `~/web/plannotator` from a RunWield workflow, so this Plan does the same. The owner
authorized creating and pushing the integration branch to the fork. Do not push to `backnotprop/plannotator` and do not
change either PR branch.

### Fork integration branch

**Reviewable naming assumption:** branch `runwield/html-review-integration`.

- Fetch `upstream/main` and both PR heads from `origin`. Use the PR head commits reported by `gh pr view`, not the local
  worktree branches. The local `feat/host-html-restrictions` branch in its worktree is still at the old base and has an
  uncommitted `bun.lock` change; leave that worktree untouched.
- Create the branch from the fetched `upstream/main`. Merge #3907's head, then #4032's head, with real merge commits.
  Do not squash or rebase, so the PR commits stay identifiable.
- A merge-tree check on 2026-11-12 found one conflict: `HtmlViewer.tsx` destructures `resourcePolicy` on one side and
  `displayedContextAttributes` on the other. Keep both. Resolve any other conflict by keeping both features' behavior.
- **Append-only:** never force-push or rewrite this branch. A pinned RunWield commit must stay fetchable. When a PR head
  changes, merge the new head onto the branch as a new commit, and update the RunWield pin deliberately.

Verify in the fork before pushing. Use the commands from `docs/plans/plannotator-setup-handoff.md` in that clone:
upstream's pinned Bun (1.4.4 at setup), `bun install --frozen-lockfile`, `bun run typecheck`, and
`bun run test:sandbox` for the focused tests each PR added. Then run the combined browser flow: a page rendered with
`resourcePolicy="self-contained"` and a displayed-context mapping. Change the page state, add a text comment and an
element comment, and confirm the annotations carry the state at selection time while external resource loads stay
blocked. Neither PR's own tests cover this combination.

### RunWield pin

Update three references together: the gitlink, `.gitmodules` (`url` to `https://github.com/gandazgul/plannotator.git`,
`branch` to the integration branch), and `third_party/plannotator-revision.txt`. Today the gitlink is `7d06fcd8…` and the
marker names `762700fa…`; after this change all three agree.

Update `third_party/README.md`: the checkout temporarily comes from the owner's fork, which carries the two open PRs on
top of upstream `main`. State the rule to return to an upstream commit after both merge. Add a short amendment to
ADR-006, whose "pinned, reviewed checkout" decision names upstream as the source.

> [!WARNING]
> **This is a large upgrade**
>
> The current pin is 11,217 commits behind upstream `main`. Across `packages/ui`, `packages/core`, and `packages/shared`,
> 1,471 files changed. RunWield imports about 40 modules from those packages through `astro.config.ts` aliases. Expect
> renamed exports, changed props, new npm dependencies, and CSS changes.

**Owner preference: do not change Plannotator.** The integration branch contains upstream `main` plus the two PR merges
and nothing else. All compatibility work happens in RunWield code: aliases, imports, props, styles, and dependencies. Do
not edit files inside the submodule and do not add RunWield-specific commits to the integration branch. If an upstream
change makes a RunWield need impossible to meet without changing Plannotator, stop and report it to the owner.

New npm packages that Plannotator source imports go into RunWield's `package.json` and frozen `bun.lock` through the
locked install path. Keep `@plannotator/markdown-editor`, `@plannotator/atomic-editor`, `@plannotator/web-highlighter`,
and `@pierre/diffs` versions compatible with what the pinned source expects.

This Plan does not render prototypes or add any new review UI. It proves only that RunWield can import
`HtmlViewer`, `HtmlResourcePolicy`, and the displayed-context types from the pinned source and type-check that use.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `~/web/plannotator` branch `runwield/html-review-integration` — the combined, pushed commit RunWield pins.
- `.gitmodules`, `third_party/plannotator` gitlink, `third_party/plannotator-revision.txt` — one agreed commit and source.
- `third_party/README.md`, `docs/adr/006-local-first-workspace-plan-board.md` — current fork source and return rule.
- `src/ui/workspace/astro.config.ts` — aliases and package paths that changed upstream.
- `src/ui/workspace/react/` (`PlanReviewSurface.tsx`, `CodeReviewSurface.tsx`, `plannotator.css`,
  `plannotator-table-compat.ts`) and other `@plannotator/*` importers — adapt to changed exports and props.
- `package.json`, `bun.lock` — dependencies the newer Plannotator source needs.

No Plannotator source edits inside RunWield, no prototype storage, review UI, Product Planner, or PRD changes.

## Reuse Opportunities

- `scripts/check-submodule-fetchability.ts` (`bun run submodules:check:remote`) — proves the pinned commit is fetchable.
- `scripts/check-submodules.ts` — existing submodule status check.
- Existing `/dev/plan-review` and `/dev/code-review` fixtures and Workspace tests — regression evidence for the upgrade.
- `docs/plans/plannotator-setup-handoff.md` — Plannotator's own install and test commands.

## Implementation Steps

1. **The fork has a combined, verified, pushed commit.** `origin/runwield/html-review-integration` starts from fetched
   upstream `main` and contains merge commits for the PR #3907 and #4032 heads. The `HtmlViewer.tsx` conflict keeps both
   props. Plannotator typecheck and both PRs' focused tests pass in the fork with its own Bun version. The combined browser
   flow shows state captured at selection time with resource restrictions on. The branch was pushed without force.
2. **RunWield pins that exact commit.** The gitlink, `.gitmodules` url and branch, and `plannotator-revision.txt` all name
   the same fork commit. The fetchability check passes against the fork URL.
3. **RunWield builds and works on the new Plannotator.** `bun run workspace:build` succeeds. Changed aliases, imports,
   props, styles, and dependencies are adapted in RunWield code only. Plan Review (Markdown annotations, comments,
   feedback, direct edits, approval actions) and Code Review (diff display, annotations, Guided Review) still work.
4. **The new options are reachable.** A type-checked RunWield import of `HtmlViewer`, `HtmlResourcePolicy`,
   `HtmlDisplayedContext`, and `HtmlDisplayedContextAttribute` from the pinned source compiles. No prototype UI ships in this Plan.
5. **The dependency source is documented.** `third_party/README.md` and an ADR-006 amendment describe the temporary fork
   source, the two PRs it carries, the append-only branch rule, and the return to upstream after both merge.

## Approval Confirmation

No Work Records are proposed for supersession. The owner chose the fork integration pin over waiting for upstream. The
branch name is a reviewable assumption.

## Verification Plan

Use the Bun version in `.bun-version` through `./scripts/with-bun.sh`, and `./scripts/with-bun.sh run install:locked`
before checks. Never run `bun test` directly.

- **Fork:** `git -C ~/web/plannotator log --oneline --merges upstream/main..origin/runwield/html-review-integration` shows
  both PR merges. `git merge-base --is-ancestor <PR head> origin/runwield/html-review-integration` succeeds for
  `b18131870` and `1a89dcaec`, or for newer PR heads if they changed. Record the Plannotator test commands run and their
  results, plus the combined-flow evidence.
- **Pin agreement:** `git submodule status third_party/plannotator`, `cat third_party/plannotator-revision.txt`, and
  `git config -f .gitmodules --get-regexp 'submodule.third_party/plannotator.*'` agree on commit, fork URL, and branch.
  `bun run submodules:check:remote` passes. A pin to an unpushed or local-only commit fails this check.
- **Build and tests:** `bun run workspace:build`, then
  `bun run workspace:test` (`bun scripts/run-tests.ts --isolated src/ui/workspace src/cmd/plans/ui.test.ts`).
  Existing review tests are the regression protection; no existing behavior is retired. A test that no longer compiles
  is rewritten against the new Plannotator interface, not deleted.
- **Headed browser:** `bun run workspace:dev`, then `/dev/plan-review` and `/dev/code-review` in an
  assignment-specific `agent-browser --headed --session <name>` session. Add a text annotation and a comment, send
  feedback, and inspect a diff with annotations. Capture screenshots, console errors, and failed requests. Compare
  against screenshots taken on the old pin before the upgrade; report visible changes that come from upstream.
- **Full gate:** `bun run ci`.

## Edge Cases & Considerations

- **PRs change during review:** merge the new heads onto the integration branch; never rewrite it. Re-pin deliberately.
- **Upstream merges first:** if both PRs merge before this Plan runs, pin the upstream commit instead and keep `.gitmodules`
  on `backnotprop/plannotator`. That satisfies the objective with less to maintain.
- **Bun version mismatch:** Plannotator CI uses Bun 1.4.4; RunWield's `.bun-version` is older. If the new source needs a
  newer Bun to build inside RunWield, stop and ask the owner. Changing RunWield's toolchain is outside this Plan.
- **Visual changes from upstream:** the review surfaces follow Plannotator's design. Report notable visible changes with
  screenshots; restyle only where `docs/design-system.md` overrides already exist.
- **Fork maintenance:** RunWield temporarily depends on the owner's fork. The append-only rule keeps old pins fetchable.
