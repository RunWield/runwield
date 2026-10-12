# Product Requirements Document: Forge Change Request Delivery

Last updated: 2026-08-12 10:29 EDT

## Objective

Add an explicitly selected **Change Request Delivery** path that publishes RunWield-validated work through GitHub pull
requests or GitLab merge requests, waits for the Forge merge, and then records truthful Plan and Work Record evidence.

The existing **Direct Delivery** path remains the default. For standalone Planned Changes,
`plans.autoMergeIntoTargetBranch` defaults to off: RunWield delivers the validated implementation and Plan outcome to a
Plan Branch, leaving the onward merge or pull request to the user. Setting On delivers to `targetBranch` directly.
`targetBranch` keeps the intended destination; an absent target defaults to the repository default branch. See the
[Core delivery requirement](runwield-core-prd.md#execution-validation-and-recovery). Change Request Delivery is a
conditional alternative, not a replacement for Direct Delivery.

The product promise is:

> Use RunWield's local planning, execution, validation, and recovery while letting GitHub or GitLab govern collaborative
> review, repository policy, CI, and the final remote merge.

## Product Posture

Change Request Delivery is a supported delivery and review mode, not RunWield's default direction. The default posture
is RunWield-native: intent, review, and memory are RunWield capabilities, and the Forge serves as the remote git host
and merge substrate. Today that default loop is Core's Local Human Code Review plus Direct Delivery. RunWield Workspace
later adds assignable human review and a Workspace merge component so teams can replace the pull-request loop entirely.

A repository, team, or instance can explicitly move the review gate to the Forge by selecting Change Request Delivery,
or run both gates through Dual Review. The choice is team policy, and the two gates never synchronize state.

The future Workspace default converges on this same machinery: a Workspace-merge flow still publishes a labeled Forge
Change Request as the CI-and-merge envelope — attributed to the correct humans and gated on green checks — while intent,
review, and memory live in RunWield. Change Request Delivery therefore builds the bridge and most of the destination.

## Problem Statement

Direct Delivery validates planned work and publishes it with its Plan outcome to the recorded landing branch. For a
standalone Planned Change, the default landing is its Plan Branch; `plans.autoMergeIntoTargetBranch: true` uses the
intended target directly. Direct Delivery does not manage the user's onward pull request or prove its merge.

That finalization model is incompatible with repositories where code must arrive through a pull request or merge
request:

- merging locally before opening a Forge Change Request bypasses the collaboration and policy gate;
- marking the Plan verified before the Forge merge makes an untrue lifecycle claim;
- publishing transient Plan/worktree metadata can leak RunWield artifacts into repositories that did not request them;
- review feedback or new commits can invalidate the revision RunWield previously validated;
- fork workflows separate the contributor's source repository from the maintainer's canonical repository;
- issue tracking and code delivery may share a provider without sharing lifecycle authority.

RunWield needs a separate delivery path that preserves its verification semantics without becoming an issue tracker,
reimplementing forge policy, automatically acting on untrusted review comments, or changing Direct Delivery.

## Target Users

- Collaborators who can publish topic branches to a shared GitHub or GitLab repository.
- External contributors who publish from a fork to an upstream repository.
- Maintainers who use RunWield to accept and record externally contributed work.
- Teams that explicitly opt into Forge-hosted review instead of RunWield's default native review loop.
- High-assurance teams that explicitly opt into both Local Human Code Review and Forge review (Dual Review).

## Resolved Assumptions

### Conditional Delivery Policy

- Direct Delivery remains the default for FEATURE and QUICK_FIX work.
- RunWield-native review is the default human review loop; Forge-hosted review and Dual Review are per-repository or
  per-team opt-ins, never the implied default.
- A Plan uses Change Request Delivery only when that delivery policy is explicitly selected.
- QUICK_FIX may also explicitly select Change Request Delivery even though it has no Plan.
- Selecting Change Request Delivery must not alter Direct Delivery behavior, evidence, recovery, or combined
  implementation-and-Plan merge semantics.

### Authority Boundaries

- RunWield owns planning, Plan Lifecycle, local validation, recovery evidence, and Work Records.
- The Forge owns branch publication, remote review state, repository policy, CI presentation, and the remote merge fact.
- A Forge merge does not by itself prove RunWield validation; RunWield must also prove that the delivered result
  corresponds to a revision covered by its validation.
- RunWield does not independently recreate approval counts, protected-branch rules, merge queues, or provider policy.
- User or existing Forge automation triggers the merge in V1. RunWield never merges implicitly.

### Tickets Remain Loose Provenance

- GitHub/GitLab issue URLs remain ordinary Ticket References on Plans and Work Records.
- Pasting an issue URL continues to work through normal Agent research capabilities; RunWield does not create a
  mechanical issue-import artifact.
- RunWield does not synchronize issue content or status.
- RunWield does not emit issue-closing instructions or model whether a Ticket was resolved.
- Whatever the Forge does to an issue after merge is outside RunWield's concern.

### Validation and Review

- Local tests and Semantic Code Review remain required for FEATURE Workflow Validation.
- When Change Request Delivery is selected, Forge-hosted review and repository policy replace Local Human Code Review
  unless Dual Review is configured; outside Change Request Delivery, RunWield's native review loop remains the review of
  record.
- **Dual Review** explicitly requires both Local Human Code Review and Forge review. The two gates run in their own
  surfaces with no state synchronization between them.
- RunWield local validation never replaces Forge or repository CI. Integrated teams keep a fast local validation tier
  and a fuller shared CI tier, mirroring this repository's own `deno task ci` versus `deno task release:check`
  separation.
- QUICK_FIX retains Mechanical Validation rather than gaining FEATURE-level planning or Semantic Code Review.
- Opening a Forge Change Request is not completion. Planned work remains visibly nonterminal while awaiting delivery.
- Any change to the published head invalidates prior local readiness evidence until RunWield explicitly resumes and
  validates the new revision.
- Review comments never automatically become Agent instructions. The user selects feedback and explicitly resumes repair
  or folds it into planning memory.

### Review Feedback as Planning Memory

Review feedback has two distinct, explicit user-chosen outcomes:

- **Resume repair:** selected feedback sends the workflow back through repair, revalidation, and republication, as
  described under Review and Repair Continuation.
- **Fold into planning memory:** selected feedback is recorded in the Work Record without requiring any code change.
  This path exists because the most valuable review comments are often forward-looking — how the change fits the system,
  or a doubt about the Plan's assumptions — and would otherwise be lost when no repair is needed.

Folding is strictly additive:

- folded feedback becomes prose in the Work Record, typically under Future Planning Notes;
- it never changes Plan Status, Work Record `status` or `completionMode`, or any lifecycle claim — the merge fact and
  Verified status remain mechanical;
- the Recorder authors the record; review content stays untrusted input and never becomes an Agent instruction or an
  authority over lifecycle state;
- feedback that invalidates a PRD or ADR assumption should route upstream to that artifact, because a Work Record cannot
  correct the source of the error;
- when later work corrects an earlier Work Record, users can confirm the replacement relationship. An approved Plan can
  declare it; otherwise the suggestion stays pending until explicitly accepted. Headless completion does not imply
  approval. Earlier records remain available with their original completion and confidence labels.

The same folding rule applies to feedback from any review source: Forge review today, and Workspace-hosted review later.

### Publication Candidate

- The Publication Candidate is the exact locally validated revision intended for the Forge Change Request.
- Change Request Delivery does not stage terminal Plan metadata into the published execution branch.
- Transient lifecycle fields, worktree identity, registry state, and premature verification evidence are excluded.
- If constructing the publishable candidate changes the validated tree, RunWield must validate the actual candidate
  rather than assuming that removing artifacts is harmless.
- Direct Delivery continues using the current staged verified-Plan path.

### Upstream Artifact Consent

- RunWield must not infer upstream participation from `docs/plans/`, `.wld/`, commit history, or local contributor
  settings.
- Contributed RunWield Plans require an explicit, upstream-authored, version-controlled **Repository Participation
  Declaration**.
- RunWield reads that declaration from the actual target repository and base revision, not solely from the contributor's
  fork.
- Absence of a declaration fails closed to a code-only Forge Change Request.
- An accepting upstream may receive an adoptable approved-Plan snapshot, but never transient worktree metadata or a
  contributor-authored premature `verified` state.
- The declaration's eventual file location and concrete configuration shape are implementation decisions, not product
  semantics.

### Shared Repositories and Forks

Both publication models are first-release requirements.

For a shared repository, RunWield publishes a topic branch to the repository and opens a Forge Change Request against
the selected target branch.

For a fork, RunWield publishes the source branch to the contributor's fork and opens a cross-repository Forge Change
Request against the upstream target. The contributor's fork does not need to receive terminal Plan or Work Record
updates after the maintainer merges.

RunWield participation can take three forms:

1. **Maintainer and contributor use RunWield:** a Plan may originate with either party. When upstream participation is
   declared, the maintainer can adopt or resume the stable Plan and record canonical verification after merge.
2. **Maintainer uses RunWield; contributor does not:** substantial acceptance or repair may use a maintainer-owned Plan;
   bounded work may use QUICK_FIX or an External Work Record path. RunWield does not fabricate contributor lifecycle.
3. **Contributor uses RunWield; maintainer does not:** the contributor publishes ordinary code. Their Plan remains
   local, may be discarded, and creates no required Work Record. They may later use `user_verified` and backfill a
   record if desired.

### Merge Reconciliation and Finalization

- RunWield refreshes Forge state while the relevant Session or Workspace is open.
- When the local app was offline, RunWield reconciles the next time the user opens or resumes the work.
- V1 requires neither an always-running local daemon nor a hosted webhook service.
- A proven merge enables **Change Request Finalization** in the canonical repository.
- Finalization records terminal Plan evidence and generates or reconciles the Work Record under existing policy.
- When RunWield accepts externally contributed work, finalization preserves multi-contributor provenance — the external
  author versus the reviewing and merging maintainer — as loose body references. Full person provenance waits for
  Workspace identity and is a Workspace responsibility.
- Change Request Finalization invokes the same Work Record auto-generation path as local delivery; the Recorder runs
  inside the maintainer's finalization action, never unattended and never from a Forge webhook.
- The normal product experience is one maintainer action, not one Git commit.
- Truthful ordering may produce one Forge implementation merge followed by one RunWield metadata commit.
- If repository policy blocks the metadata commit, finalization remains visibly pending and uses a narrowly authorized
  metadata path or a metadata-only Forge Change Request. RunWield must not claim canonical verification only in memory.

### Work Record Scope

The guarantee runs one direction: every verified Plan produces a Work Record carrying its delivery and merge evidence.
The inverse is false — no merge is required to have a Plan or a Work Record:

- QUICK_FIX, direct pushes, and merges performed outside RunWield produce commits and normally no Work Record. The git
  log is the audit trail at that level, and commit messages are expected to explain those changes.
- Externally contributed work accepted through maintainer review MAY receive an opt-in **External Work Record** when the
  maintainer judges it worth remembering. An External Work Record certifies provenance — the source change, the
  contributor, the reviewing and merging maintainer, and the validation that actually ran — and never claims RunWield
  Workflow Validation. It is created by explicit choice, never automatically: routine merges such as dependency updates
  and typo fixes stay record-free and are explained by their commits.
- Work Records are a layer of memory over planned work, not the authoritative history of the target branch.
- RunWield is responsible for the provenance of its own merges: clear commits that point back to their Plans. Each team
  owns its commit discipline for everything else; RunWield does not police it.
- Planning Agents do not rely on Work Records alone. For changes without records, they use code exploration and git
  history and fold what they find into future planning on a best-effort basis.

### Provider and Host Scope

- GitHub and GitLab are first-release providers with equivalent product semantics.
- GitHub.com and GitLab.com receive certified support.
- GitHub Enterprise Server and GitLab Self-Managed receive best-effort support when compatible with authenticated
  official CLIs.
- V1 uses the contributor’s existing local Forge authentication. Provider differences must not change the promised
  delivery and verification behavior.

## Delivery

The [Forge Change Request Delivery Epic](../plans/forge-change-request-delivery.md) owns implementation decomposition.
The first release covers GitHub and GitLab, shared repositories and forks, and planned work plus QUICK_FIX. Delivery can
proceed through a complete reference path, a second provider, then fork and recovery coverage. These milestones must not
silently remove either provider or publication model from the agreed release.

## Product Journey

The user-visible conceptual lifecycle is:

1. Plan approved and configured for Change Request Delivery, or QUICK_FIX explicitly selects it.
2. Work executes in isolation.
3. Local validation and applicable RunWield review pass.
4. RunWield seals and publishes the Publication Candidate.
5. The Forge Change Request enters an **In Review** phase.
6. User-selected feedback may resume repair, validation, and publication on the same source branch.
7. The maintainer or Forge automation merges according to repository policy.
8. RunWield proves delivery and performs Change Request Finalization.
9. FEATURE reaches Verified and receives its normal Work Record; QUICK_FIX completes under its existing no-Plan policy.

### Workspace and TUI Experience

Users should be able to:

- choose Direct Delivery or Change Request Delivery without changing unrelated execution settings;
- choose ordinary Forge review or Dual Review;
- see the source repository, target repository, target branch, Forge Change Request URL, published revision, and current
  delivery phase;
- see when local readiness became stale;
- refresh Forge state;
- resume selected feedback;
- distinguish merged-but-finalization-pending from fully Verified;
- recover from authentication, publication, review, merge, or metadata-finalization failure.

The interface should use presets rather than expose a large independent matrix of review and delivery toggles.

### Delivery Evidence and Failure

The delivered result must match what RunWield validated, including when a Forge uses squash, rebase, or merge queues.
Users can distinguish open, merged, closed without merge, inaccessible, and temporarily unavailable requests. A merged
change awaiting its Plan or Work Record update remains visibly pending and recoverable.

Publication, authentication, CI, conflicts, and metadata-update failures preserve the work. Any special permission to
finalize RunWield records must not become authority to bypass repository policy for unrelated changes.

### Privacy and Attribution

Review comments and issue content remain external evidence until the user selects an action. Only the upstream
repository can consent to receiving RunWield artifacts. V1 credentials remain local. Later Workspace integration must
attribute authorship, review, and merge to the correct people and respect their repository permissions; its token and
API design belongs in architecture documents.

## Success Criteria

- Existing Direct Delivery behavior and verification evidence remain unchanged when no Change Request Delivery policy is
  selected.
- FEATURE and QUICK_FIX work can publish through GitHub and GitLab in both shared-repository and fork models.
- No FEATURE reaches Verified before its intended Forge Change Request is proven merged.
- A changed published revision cannot inherit stale local validation evidence.
- Code-only publication is the default unless the authoritative upstream explicitly accepts contributed RunWield Plans.
- Contributor forks require no post-merge synchronization.
- Maintainers can merge and finalize canonical RunWield evidence through one understandable action, with recoverable
  handling when the metadata commit cannot publish.
- GitHub/GitLab issue state remains unaffected except for behavior independently configured by the Forge or repository.
- Reopening an In Review workflow after local downtime reconciles the correct Forge outcome without a daemon or webhook.
- Selected Forge review feedback can fold into the Work Record without resuming repair and without altering any
  lifecycle claim.
- A merge performed outside any Plan produces no Work Record and no lifecycle claim.

## Out of Scope

- Replacing GitHub Issues, GitLab Issues, Jira, or another demand-management system.
- Importing or continuously synchronizing issue content or status.
- Emitting or managing issue-closing directives.
- Automatically turning Forge comments into Agent work.
- Implicit RunWield merge or auto-merge in V1.
- Reimplementing Forge approval rules, CI systems, merge queues, or protected-branch policy.
- Requiring a hosted RunWield webhook service or always-running local watcher.
- Synchronizing terminal Plan state back to contributor forks.
- Automatically adding RunWield artifacts to upstream repositories without explicit upstream participation.
- Certifying every GitHub Enterprise Server or GitLab Self-Managed version in V1.
- Deployment, release, or production-rollout automation after merge.
- Choosing the concrete participation-declaration file, delivery-policy field, lifecycle event names, adapter API, or
  CLI command layout in this PRD.
- Synchronizing state between RunWield-native review and Forge review when both gates exist.
- Treating Work Records as the audit history of the target branch; the git log owns commit-level history.

## Proposed Domain Language

**Forge** (proposed redefinition): the current glossary defines the Forge as governing branch publication, code review,
repository policy, and remote merge outcomes. Under the default posture the Forge shrinks to the remote git host and
merge substrate; review and repository policy are RunWield capabilities that a team may explicitly delegate to the Forge
per repository. _Avoid_: system of record for intent, review, or memory; required review gate.

**Review Memory Fold**: the explicit user action that records selected review feedback into a Work Record as additive
planning memory, without resuming repair and without changing any lifecycle claim. _Avoid_: review sync, comment import,
automatic instructions.

These terms remain proposed until the capabilities that make them true are implemented. A Plan that implements them must
update `docs/domain-language.md` in the same change.

## Source Notes

Current provider facts were checked against official primary documentation on 2026-07-26:

- GitHub describes pull requests as its collaboration and pre-merge review surface, with draft requests blocked from
  merge:
  <https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests>
- GitHub issue-closing keywords are provider behavior tied to default-branch targeting, reinforcing that issue closure
  should remain outside RunWield lifecycle:
  <https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue>
- GitLab supports merge requests from shared branches, issues, and forks:
  <https://docs.gitlab.com/user/project/merge_requests/creating_merge_requests/>
- GitLab auto-merge and merge checks cover approvals, pipelines, conflicts, discussions, drafts, and external checks:
  <https://docs.gitlab.com/user/project/merge_requests/auto_merge/>
- GitLab exposes merge request identity, revisions, draft state, merge status, and merge outcomes through its API:
  <https://docs.gitlab.com/api/merge_requests/>
- GitHub CLI exposes structured pull-request revisions, review decisions, checks, merge state, and merge outcomes:
  <https://cli.github.com/manual/gh_pr_view> and <https://cli.github.com/manual/gh_pr_checks>
- GitLab CLI supports authenticated GitLab.com, Dedicated, and Self-Managed repositories:
  <https://docs.gitlab.com/editor_extensions/gitlab_cli/>
- GitHub Apps can authenticate on behalf of a user with a user access token, and those actions are attributed to the
  user alongside the app badge, checked 2026-08-12:
  <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user>

The lifecycle, authority, artifact-consent, and conditional-delivery requirements above are RunWield product decisions,
not claims made by those providers.
