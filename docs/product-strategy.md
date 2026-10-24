# RunWield Core Product Strategy

RunWield helps a developer turn intent into a reviewed Plan, execute it with independent validation, and preserve useful
Work Records for future planning. The CLI, TUI, personal browser Workspace, and ACP server remain free forever.
Core is open source under MIT from v0.14.0.

## Principles

- Human judgment owns intent, approval, and execution choices.
- Material changes start with reviewed Plans; bounded work receives proportionate verification.
- Mechanical checks and independent semantic review support honest completion claims.
- Repository Markdown owns durable project knowledge; private Session history supports continuity.
- Personal workflows stay useful across the terminal, browser, and compatible external clients.
- Model choice, local customization, and portable artifacts preserve user control.

## Scope and maturity

The five [living PRDs](prd/runwield.md#capability-ownership) own current requirements and distinguish delivered behavior
from proposals. Cross-project personal knowledge search and self-hosted encrypted Plan review remain Core capabilities.
Work Records preserve outcomes, Plan Deviations, out-of-scope facts, and durable lessons; they are not raw transcripts.

## Strategy-to-work rule

Before starting a feature, name the user outcome, the assumption it tests, why it matters now, and the evidence that will
show whether it helped. Keep unvalidated ideas in discovery and implementation steps in Plans.

## Work Records and pull requests

First, let’s start by saying that Work Records are different from a commit message. Many commit messages go into 1 PR
the same way as many go into one plan in RunWield and eventually a Work Record, much more pronounced with an Epic.
Commit messages are diff-anchored and there are many per Plan. A PR is roughly one per Plan. So on granularity alone, a
PR body and a Work Record Summary overlap a lot.

The overlap stops there. Look at any work record produced by RunWield: only the first paragraph is "what changed". The
rest is Deviations from Plan, Out of Scope, and Future Planning Notes — things that did not happen, and rules the next
planner must keep. A PR body cannot hold that well for four structural reasons:

- Direction of time. A commit and a PR describe a change that happened. A Work Record describes what future planning
  must remember. The most valuable lines in a Work Record describe no diff at all.
- Consumer. A PR is written for a human at merge time and is read once. A Work Record is written for an Agent at
  planning time and is retrieved repeatedly through work_record_search over an embedding index, with visibility filters
  that hide draft, superseded, and skipped-verification records.
- Correctability. Work Records carry status, completionMode, and provenance.sourcePlans. A record can be marked
  superseded when later work proves it wrong. A merged PR is immutable history; nobody edits a two-year-old PR body when
  its conclusion stops being true. Planning memory must be correctable. Delivery history must not be.
- Locality. Work Records are Markdown in the repo. They are readable offline, inside a worktree, by any Agent, with no
  API token and no vendor. Move them into PR bodies, and your planning memory now needs network and auth to think.

The guarantee also runs one direction only: every validated Plan produces a Work Record with evidence of its merge, but
not every commit on main has a Work Record. Quick fixes and merges made outside RunWield produce commits, and the git
log is the audit trail at that level. Work Records are a layer of memory over planned work, not the authoritative
history of the target branch, and RunWield does not police a team's commit discipline — it is responsible for the
provenance of its own merges, with commits that point back to their Plans.
