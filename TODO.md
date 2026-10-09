| Priority | User journey                    | Current coverage                                                               | Missing proof                                                                                                                       |
| -------- | ------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 3        | Authentication onboarding       | `/login` only tests cancellation; `/logout` only tests having no credentials.  | Successful login → provider/model selection → first message, persisted credentials, real logout, and failed-auth recovery.          |
| 4        | Session resume                  | `/resume` only tests “no recent sessions.”                                     | Select a real session, restore history/Agent/model/Plan state, send another message, and survive corrupt or interrupted sessions.   |
| 5        | Real compaction                 | `/compact` only tests “Nothing to compact.”                                    | Compact a populated conversation, verify the summary/context, then continue successfully without losing Agent/model/workflow state. |
| 6        | Init recovery                   | Successful startup init and already-initialized behavior are covered.          | User declines, Init Agent fails, artifact is missing, retry succeeds, and partial initialization is recovered safely.               |
| 7        | Settings persistence            | `/settings` only selects “Done”; `/theme` changes the current selection.       | Actually edit each important setting, verify immediate behavior, restart the application, and verify persistence.                   |
| 8        | Agent/model restart persistence | The new scenarios prove precedence and subsequent messages within one process. | Restart/resume the session and prove the manual model and selected Agent remain effective.                                          |
| 9        | Slash-command happy paths       | `/share` only tests missing gh; `/copy` only tests no assistant message.       | Successful sharing and copying, plus their real failure/retry paths.                                                                |
| 10       | Validation branch precision     | Broad validation and repair coverage is extensive.                             | Independently prove human-review:none versus human-review:ask-skip; they currently share scenarios.                                 |

This and SSH: docs/plans/retry-transient-provider-failures.md

Suggested sequence

I would order the overlapping group like this:

1. Finish remove-return-to-router-user-owned-transitions.md It is already in_progress, and the Engineer split explicitly
   depends on it. - done

   1. finish-agent-prompt-architecture-cleanup - done

2. resume-validation-after-repair-completion.md Small ready bug fix. Stabilizes validation repair. - done

3. split-quick-fix-engineer-from-plan-engineer.md This should absorb/supersede
   generalize-pair-execution-to-engineer.md. - done

4. Reassess/archive mode-specific-engineer-context.md and generalize-pair-execution-to-engineer.md (this one is done).

   1. docs/plans/execution-agent-context-boundaries.md - done
   2. parallelize-independent-ci-stages.md - done

5. classify-validation-operational-errors.md - done

6. flag-test-seam-risks-during-init.md - done

7. Optional before foundation: guided-validation-repair.md - done

8. simplify-validation-and-lifecycle-messages.md Better after the error/repair model is stable. - done

9. plan-packages-and-independent-validation.md - in progress

10. plan-package-frontend-experience-planning.md

11. epic-branch-publication-workflow.md

Deferred: [Automated QA PRD](docs/prd/automated-qa-prd.md). Not a prerequisite for Plan packages.

## Core PRD gaps: recommended implementation order

Source: [Core PRD](docs/prd/runwield-core-prd.md). Read the
[detailed audit and planning handoff](docs/reports/core-prd-gap-audit.md) before drafting. It preserves source evidence,
failure examples, existing tests, coverage limits, related Plans, and scope boundaries for every group below. These
findings come from source and test inspection, not a completed runtime test pass. Work Record search also failed during
the audit. Existing entries above are unchanged.

**Quick win** means a narrow correction. **Needs Plan** means shared behavior, recovery, or compatibility needs
coordinated verification. These are proposed work groups, not created or approved Plans. Planner must check existing
Plans and current uncommitted work before creating new ones. Explicit future PRD scope is not included.

1. [ ] **Quick win — Restore Work Record search in this checkout.** Correct the missing Summary sections in
       [recovery repair](docs/work-records/2026-09-08-main-checkout-and-worktree-recovery-repair.md) and
       [Session continuation](docs/work-records/2026-09-08-workspace-session-continuation-and-steering.md). Preserve
       their evidence and confidence labels. This repairs the current documents, not the retrieval failure policy.

2. [ ] **Needs Plan — Respect browser Pair decisions.** Stop and revision feedback must never become permission to
       continue autonomously. Check the real Workspace checkpoint experience against TUI behavior. Evidence:
       [Pair checkpoint](src/tools/pair-checkpoint.ts),
       [browser interaction](src/ui/workspace/components/SessionTimeline.jsx).

3. [ ] **Needs Plan — Require consent before enabling package extensions.** Interrupted or failed theme-package
       installation must not leave executable extensions enabled without consent. Evidence:
       [package installation](src/cmd/install/index.ts).

4. [ ] **Needs Plan — Keep unpublished workflows recoverable.** Automatically repair internal records and recover from
       unexpected Reviewer failures. User verification must preserve delivery continuation. Hold must remain available
       for unpublished validated work. End only after proven publication or deliberate abandonment; preserve unmerged
       work. Evidence: [recovery actions](src/cmd/load-plan/plan-recovery-actions.ts),
       [validation recovery](src/shared/workflow/validation-recovery.ts),
       [lifecycle](src/shared/workflow/plan-lifecycle.js).

5. [ ] **Needs Plan — Recover malformed Plan metadata without blocking other Plans.** Preserve the latest user body and
       existing decisions. One damaged Plan must not disable the entire listing or require users to edit internal
       fields. Evidence: [Plan store](src/plan-store.js), [Plan loading](src/cmd/load-plan/index.ts).

6. [ ] **Quick win — Preserve annotation locations.** Matching free-text feedback must not remove an annotation's file
       and line reference. Keep this separate from the larger review work below. Evidence:
       [human review feedback](src/shared/workflow/validation-human-review.ts).

7. [ ] **Needs Plan — Make review match its promised checks.** Require the second whole-change review, distinguish
       reading changed code from listing filenames, and retain useful human-review conversation through repair and
       checks. Evidence: [semantic review](src/shared/workflow/validation-semantic.ts),
       [diff inspection](src/shared/workflow/review-diff-tool.js),
       [human review](src/shared/workflow/validation-human-review.ts).

8. [ ] **Needs Plan — Retain image access across Session handoffs.** Planning attachments must remain available after
       execution, repair, and resume without exposing another Session's images. Evidence:
       [image attachments](src/shared/session/image-attachments.ts),
       [segment rollover](src/shared/session/segment-rollover.ts).

9. [ ] **Needs Plan — Preserve compaction across model backends.** Claude CLI and Antigravity must support useful
       long-session continuation and respect existing compaction when selected. Do not silently resend the entire old
       conversation. Evidence: [CLI conversation](src/shared/session/external-cli-conversation.ts),
       [Session runtime](src/shared/session/session-runtime.ts).

10. [ ] **Needs Plan — Keep optional vision settings local to the correct Project.** Broken fallback setup must not
        block text-only conversation. Workspace must use the Session Project's settings, not the server's working
        directory. Evidence: [vision settings](src/shared/settings.js), [Agent setup](src/shared/session/session.js).

11. [ ] **Needs Plan — Isolate malformed Work Records.** Listing, reading, search, backfill, and index rebuild must
        remain useful when an unrelated record is malformed. Report the affected record without treating it as approved
        guidance or discarding a usable index before replacement succeeds. Evidence:
        [record store](src/shared/work-records/store.js), [index rebuild](src/shared/work-records/index-adapter.ts).

12. [ ] **Needs Plan — Keep same-named Projects' knowledge separate.** Independent repositories named `app`, for
        example, must not share project memories or overwrite each other's Work Record index. Preserve access to
        existing knowledge. Evidence: [memory collection](src/extensions/mnemoteca/tools.ts),
        [record index](src/shared/work-records/index-adapter.ts).

13. [ ] **Quick win — Back up the correct memories during Sleep.** In a linked worktree, use the same project collection
        as normal memory operations. Coordinate with the Project separation work above if it changes first. Evidence:
        [Sleep](src/cmd/sleep/index.ts), [memory collection](src/extensions/mnemoteca/tools.ts).

14. [ ] **Quick win — Restore the visible theme when preview is cancelled.** If the saved theme is missing, cancelling a
        preview must return to the previous usable theme, not leave the preview active. Keep the saved choice unchanged.
        Evidence: [theme selection](src/cmd/theme/index.ts), [theme registry](src/ui/theme/theme-registry.ts).

Order favors restoring today's broken retrieval, honoring user control, and protecting workflow completion before
context and polish. Quick wins can ship independently; the order is a priority recommendation, not a dependency chain.
Code fixes need focused regression coverage. Expand a Quick Fix into a Plan if investigation reveals broader behavior
changes.
