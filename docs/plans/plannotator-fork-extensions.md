---
classification: "PROJECT"
complexity: "HIGH"
affectedPaths:
    - "packages/ui/components/html-viewer/"
    - "packages/ui/types.ts"
    - "packages/core/html-anchor.ts"
    - "packages/ui/utils/parser.ts"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-11-12"
status: "draft"
planId: "8e080bdc-ed35-4023-8ef3-d6ddf828ff8a"
---

# Plannotator Host Restrictions and Displayed Context

## Context

The owner requests two focused Plannotator PRs, developed in a fork cloned under `~/web/`, with changes made in worktrees.
They add host-controlled HTML restrictions and optional displayed context on annotations. RunWield integration is not
part of either PR. [Fork and worktree setup](plannotator-fork-setup.md) is the first executable Plan. The feature Plans
are independent contributions to be loaded from the new Plannotator project, not an automatically executed cross-project
Sequence. This proposal records their shared decisions and checks.

**Source evidence, checked 2026-11-12:**

- RunWield's actual submodule and gitlink are `7d06fcd8cd1913e03b5cbacbe40877001a5c8a42`.
- `third_party/plannotator-revision.txt` names the older `762700fa031b0793884f8182fd791d822e766160`. It is not the source inspected.
- Upstream `backnotprop/plannotator` main was `104f6b9ef9a800e2391dd3848eb2f5b59ee25caf`. GitHub reports 6,597 commits ahead of the actual checkout.
- Direct reads of upstream `HtmlViewer.tsx`, `srcdoc.ts`, `bridge-script.ts`, `useHtmlAnnotation.ts`, and `types.ts` still show both gaps.
- Upstream adds `sandbox`, `frameUrl`, and an early sandbox shim. These do not supply the requested resource policy or displayed context.
- GitHub reports no `gandazgul/plannotator` repository. The authenticated user's fork inventory also contains no Plannotator fork.

Related RunWield requirements are [interactive prototype review](../prd/product-planner-prd.md#interactive-prototype-review),
particularly **Preserve a simple, contained review experience** and **Keep feedback tied to what was reviewed**. The lasting
owner is [Workspace browser review](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow). These remain integration
targets: upstream library support alone does not deliver the RunWield journey. Revision identity, persistence, Agents,
approval, Artifact Server work, and updating RunWield's dependency pin remain outside these PRs.

No dedicated Plannotator PRD or domain glossary was found in the inspected checkout. Its package README and HANDOFF own
host integration guidance. Each PR updates that guidance with its delivered contract and limitations.

## Objective

Produce two separately reviewable upstream contributions:

1. [Host-controlled HTML restrictions](plannotator-host-html-restrictions.md).
2. [Displayed context on HTML annotations](plannotator-annotation-context.md).

Implement restrictions first, then context, but keep the PR branches and diffs independent. Context capture must also
work without the restriction option. Use `frontend-engineer` and autonomous execution for both. Submit the setup Plan
from RunWield first; submit each feature Plan from its Plannotator worktree after setup. Do not dispatch these feature
Plans from the RunWield project or treat this proposal as a cross-project execution controller.

**Owner decision for PR 2:** prototype HTML declares and updates generic labels; the host chooses which labels Plannotator
reads. Target annotations capture labels at selection. Global comments capture them when their composer opens. Both
retain that snapshot through submission.

**Owner decision for PR 1:** reuse the existing iframe sandbox. Add only the missing early host resource policy and
non-live bridge enforcement, with tests and documentation. Restricted mode uses a self-contained profile and the inline
bridge; separately served bridge support in that mode is out of scope. Existing unconfigured callers stay unchanged.

### Repository and contribution base

**Owner decision:** the first step is to fork `backnotprop/plannotator` as `gandazgul/plannotator`, clone it at
`~/web/plannotator`, and create the two PR worktrees there. Start from checked current upstream main. Keep RunWield's
checkout and pin unchanged; any downstream backport or pin update remains a separate integration change.

### Repository setup — first execution step

The executable [setup Plan](plannotator-fork-setup.md) owns this prerequisite. Before either feature changes source, the
Engineer establishes and verifies this layout:

```text
~/web/plannotator/                         fork clone; origin = gandazgul/plannotator
  .worktrees/
    host-html-restrictions/                feat/host-html-restrictions
    annotation-context/                   feat/html-annotation-context
```

Worktree directory and branch names are low-risk implementation assumptions. Both branches start from the same freshly
fetched `upstream/main` commit, where `upstream` is `backnotprop/plannotator`. They are not stacked on each other.

1. **The fork and clone exist.** Use `gh repo fork backnotprop/plannotator --clone=false`, then
   `git clone https://github.com/gandazgul/plannotator.git ~/web/plannotator`. If either already exists, verify its identity
   and reuse it; never overwrite it or force-reset existing work.
2. **Both PR worktrees exist at the agreed upstream base.** Configure and fetch the upstream remote. Exclude `.worktrees/`
   through the clone's local Git exclude file, not a product change. Use `git worktree add -b` to create each branch and
   worktree from the recorded upstream commit. Existing branches/worktrees must be inspected before reuse.
3. **Execution is attached to Plannotator.** Load the feature Plans in that project, with each PR assigned to its own
   worktree. Recheck its `AGENTS.md`, package guidance, current source, and CI commands before implementation. Preserve
   RunWield requirement links as external planning context; do not copy its PRDs or policies into Plannotator's product.

> [!WARNING]
> **Execution belongs in the Plannotator project**
>
> These draft Plans are prepared in the current RunWield session. Their source paths are relative to Plannotator, not
> RunWield. No fork, clone, or worktree has been created. Before execution, an Engineer must perform the agreed repository
> setup and load these Plans in that project. Do not execute them against RunWield or patch its submodule in place.

## Vertical Slice Findings

```text
HtmlViewer host props
  srcdoc assembly -> host policy before author content
    annotation bridge -> selection plus displayed-context snapshot
      useHtmlAnnotation -> Annotation / HostDraft
        existing feedback and pure host serialization helpers
```

The current injection removes author CSP and appends the bridge at the end of the head. Author head scripts can set
`window.__plannotatorLiveConfig` before the bridge reads it. An after-ready configuration message is too late for restrictions.

Existing element context describes a target, not the displayed application state. The bridge already captures element
context before the comment is submitted. Extend that same capture boundary for generic displayed labels, including text
selections, rather than read the page's latest state when the user submits a comment.

## Expected Change Surface

The boundaries this Epic is expected to touch. This list is guidance, not an allowlist: each child Plan verifies the
real footprint during implementation and changes whatever its Implementation Steps need. Discovery that changes approved
intent — another subsystem joins the Epic, public behavior or architecture shifts, migration risk grows — comes back to
the user, not to the file list.

- `packages/ui/components/html-viewer/` — host props, policy assembly, bridge capture, validation, and tests.
- `packages/ui/types.ts`, relevant `packages/core/` HTML types/helpers — optional displayed-context data and bounded parsing.
- `packages/ui/utils/parser.ts` — preserve context in exported annotation feedback.
- Browser fixtures and Playwright configuration — prove actual CSP enforcement and usable annotations together.
- `packages/ui/README.md`, `HANDOFF.md` — public host contracts, limits, compatibility, and examples.

No RunWield source, storage, workflows, PRDs, or submodule pin changes ship in these two PRs.

## Reuse Opportunities

- Existing `HtmlViewer`, bridge, annotation composers, host drafts, and pure HTML anchor helpers.
- Existing early-injection logic in current upstream, subject to browser proof rather than string ordering alone.
- Existing Bun component tests and Playwright dependency; no new browser framework or Artifact Server.

## Verification Plan

**Setup evidence:** inspect `gh api repos/gandazgul/plannotator` for `fork: true` and parent
`backnotprop/plannotator`. Check `git -C ~/web/plannotator remote -v` and
`git -C ~/web/plannotator worktree list --porcelain`. Verify both worktree HEADs initially equal the recorded upstream
base, with separate feature branches and no product edits in the primary clone. A directory alone does not prove setup.

Each child defines focused commands. Select Plannotator's full verification command from its checked-out CI after setup.
Do not apply RunWield's `bun run ci` to a different repository.

### Outcome Evidence

- **Restrictions:** controlled resource endpoints receive requests without the option and receive none for the covered
  resource classes with it. In the restricted case, inline interaction, text comments, and pinpoint comments still work.
- **Non-live bridge:** author code sets/replaces live config before and after bridge initialization; the restricted
  bridge retains non-live messaging and annotation behavior. Genuine unrestricted live callers retain their tests.
- **Context:** capture state A, change to state B before submit, and receive A on the resulting target annotation. A new
  annotation receives B. Global comments capture displayed page context when their comment box opens, without requiring
  a target selection, and retain it through submission even if the page changes. Invalid or absent context does not
  prevent ordinary annotations.
- **Combined:** the same state-change/annotation flow works with restrictions enabled, without adding revision storage.
- **Compatibility:** omitted options retain existing rendering, live mode, asset bridge loading, and context-free annotations.

## Edge Cases & Considerations

- CSP is not a universal navigation firewall. Neither PR may claim that every iframe navigation or network channel is blocked.
- Prototype code and the bridge share a JavaScript realm. Displayed labels are untrusted descriptions, not authenticated state.
- Current upstream changes quickly. Recheck the five source files and project guidance at the selected contribution base.
- Fork creation and local repository setup are approved in scope. Do not claim they happened until their verification passes.
- Do not claim RunWield integration is delivered or reconcile its marker in these PRs.
