# RunWield Product Strategy

## Purpose

RunWield product work starts from business goals, user outcomes, and an explicit strategy. A feature enters active work
when it supports a chosen customer, product outcome, or validated strategic bet.

Use this document as the durable source for product direction. Use Todoist to track decisions, research, PRD updates,
and the work that moves the strategy forward.

## The Bet

The next decade's leading developer tools will provide the infrastructure primitives that let code generation,
validation, and deployment operate seamlessly at machine scale.

RunWield's working thesis is that approved Plans and verified outcomes can become the durable control and learning layer
for AI-assisted software work.

## Target Customer Direction

RunWield is for software product teams that want to use LLMs as precise collaborators while sustaining the quality,
confidence, and maintainability they expect from human-led engineering. The initial buyer and narrowest market wedge
remain open for validation, while the product direction includes the whole team:

- Product Managers define outcomes, develop requirements, align contributors, and follow delivery.
- Designers turn product intent into concrete interactions and functional prototypes.
- Engineering Managers help teams coordinate work, make sound decisions, and use accumulated team intelligence.
- Engineers receive context around the work, PRDs, prototypes, draft plans, and other such documents so they can
  finalize or create plans to execute on the work.
- Other teams can discover, review, and contribute through the shared source of truth.

RunWield can expand to larger engineering organizations, but the initial product should prove this cross-functional
workflow with a small or midsize team before it attempts a complete enterprise platform.

## Highest-value Opportunity

Teams want the delivery speed and creative range of LLMs together with clear intent, thoughtful design, engineering
judgment, strong tests, mechanical proof, semantic review, and confidence in the result. This combination helps rapid
greenfield work mature into a maintainable brownfield system.

Each human-Agent collaboration can also make the next collaboration better by contributing useful work, decisions, and
lessons to the team's accumulated intelligence.

RunWield should guide people and Agents from an idea to an executable Plan and then through implementation and
verification with precision. Over time, Plans, outcomes, Work Records, and accepted team knowledge form an
engineering-organization brain that helps everyone make better decisions. It becomes a trusted guide built from the
team's work.

## Product Promise

RunWield helps teams wield LLMs as precision tools and creative partners. It augments the human team so it can deliver
more software with the quality, maintainability, and confidence it expected before AI-assisted development.

It gives product and design delightful new powers to express and test a concrete vision. It gives engineers high-quality
context, executable Plans, and reliable validation. It gives the whole organization a shared place to ideate with Agents
and people and a guide over accumulated team intelligence.

## Product Principles

- **Human-led augmentation.** Agents expand what the team can do while human judgment guides the work.
- **Precision before generation.** Clarify intent and make an executable Plan before asking an Agent to build an
  undefined outcome.
- **Confidence through evidence.** Shared artifacts and validation make software quality and delivery outcomes clear.
- **Sustainable quality.** Strong architecture, tests, and engineering judgment help greenfield software mature into a
  maintainable brownfield system.
- **Multiplayer by default.** Humans and Agents ideate, decide, plan, review, and learn together.
- **Accumulated intelligence should help everyone.** Team knowledge is a guide for managers, engineers, product, design,
  other teams, and future Agents.
- **Non-technical users should gain real creative power.** Product Managers and Designers should be able to build useful
  prototypes, one-off tools, and complete design systems with clear artifact purpose and readiness.

## Strategic Hierarchy

### Core Focus

1. Help humans wield LLMs as precise collaborators through clear outcomes, shared context, and executable Plans.
2. Preserve software quality, confidence, and maintainability as AI-assisted greenfield code becomes brownfield.
3. Enable Multiplayer AI: several humans and Agents ideate, decide, and create executable Plans together.
4. Build a useful guide over accumulated team intelligence so every person and Agent can make better decisions.

### Supporting Expansion Capabilities

- Enterprise workflow observability supports mature organizations and follows the initial product wedge.
- Delightful creation tools for Product Managers and Designers expand the product after the core collaboration model is
  proven.

These capabilities strengthen RunWield's core focus and extend its value to more people and larger organizations.

## Core Strategic Directions

### Multiplayer AI

Source: <https://www.ycombinator.com/rfs#multiplayer-ai>

RunWield puts several humans and Agents in one collaborative surface to ideate, resolve ambiguity, and produce
executable Plans. Product Managers, Designers, Engineering Managers, engineers, and other teams can contribute according
to their knowledge. The system should remain model-agnostic and job-role-agnostic.

### Company Brain

Source: <https://www.ycombinator.com/rfs#company-brain>

RunWield should become a guide over the team's accumulated intelligence. Plans, verified outcomes, Work Records, design
decisions, and accepted lessons should help managers, engineers, product, design, other teams, and future Agents make
better decisions. Shared intelligence must remain reviewable, attributable, and safe to activate.

### Forge as Git Upstream

RunWield's default posture is to replace the workflow layers above git — intent, review, and memory — rather than build
on a software forge's pull-request model. A forge like GitHub remains valuable as the remote git host, merge substrate,
and identity provider, and integrating with GitHub for identity and permissions is high on the Workspace roadmap. But
Plans, human review, and Work Records are RunWield capabilities by default: Workspace hosts the review loop (assignable
to teammates, assisted by Agents), holds review process state outside the repository the same way it holds Sessions, and
commits only the resulting artifacts. Teams that want forge-hosted review can opt into it per repository or team,
including dual review, with no state synchronization between gates.

## Supporting Product Directions

### Enterprise Workflow Observability

An enterprise RunWield product should make shared workflow state and evidence understandable across teams. Product and
Engineering Managers should be able to answer:

- What outcome and Plan were approved?
- Which work is active, blocked, waiting for attention, or complete?
- Does the result match the product intent and relevant prototype?
- What mechanical validation and semantic review occurred?
- What changed during delivery?
- What should the organization remember for future work?

This capability presents shared work, decisions, risks, evidence, and organizational knowledge clearly. It becomes
increasingly valuable as RunWield grows into an enterprise tool and follows the initial product wedge.

### Functional Prototypes and Non-technical Creation

RunWield should be delightful for non-technical people and expand their creative power. Product Managers and Designers
should be able to create Lovable-style functional prototypes, easy one-off tools, and fully developed design systems,
potentially by importing or collaborating through Figma. Each prototype is an alignment and specification artifact with
a clear purpose and readiness level.

The prototype should connect to product requirements and the approved Plan. Engineers should be able to inspect the
working behavior, understand which parts are illustrative or production-ready, and trace implementation decisions back
to the agreed vision. Validation should prove the delivered software against the Plan and relevant prototype outcomes,
while engineers deliberately select which prototype code and ideas belong in production.

This capability expands who can create with RunWield, improves alignment, and supports the core human-Agent
collaboration model with a distinct RunWield experience.

## Positioning

HumanLayer is the closest product to RunWield. It is excellent at operating multiple coding-agent sessions and managing
the artifacts and context around them. RunWield starts from a different source of truth: the approved Plan and its
verified outcome. RunWield treats approval, execution ownership, worktree state, validation, recovery, and the final
Work Record as one durable transaction.

HumanLayer helps software engineers operate multiple coding-Agent sessions. RunWield extends human-Agent collaboration
across the whole product and engineering team. It helps people and Agents think together, turn intent into executable
Plans, build with precision, preserve quality as the codebase matures, and reuse the team's accumulated intelligence.

## Open Product Questions

### How does RunWield help small local models?

multi_file_edit and code_batch means less tool calls which small models struggle with. We have mid-session nudges
reminding agents of their persona and goal for short attention windows.

The verification loop actually helps smaller models because they can catch things they forgot while executing.

### Which small or midsize product organizations place the highest value on precise AI collaboration, engineering quality, and long-term maintainability?

Any startup to mid-size company with a dev team.

### Which persona is the best initial buyer or champion: Engineering Manager, Head of Engineering, Product leader, or a combined product-and-engineering founder?

Combined product-and-engineering founder, and someone in engineering management. Developers can be great advocates,
though, if they find it useful in their personal projects, which is why core must stay free.

### What is the smallest cross-functional workflow that proves value for Product Managers, Designers, Engineering Managers, and engineers?

Product Manager uses Ideator to plan a new feature within the context of the project, even make a high-fidelity
prototype. Designer uses the prototype to refine the UX and aesthetics and update the design system as needed. Engineers
take the PRD, Prototype, and other context and make one or more plans for implementation and execute them. Engineering
managers can steer the team through the plans’ feedback loop and get metrics on the team and the outcomes.

### What is the smallest RunWield prototype capability that materially improves alignment and expresses RunWield's distinct approach?

We need to be able to produce the prototypes and attach them to a plan on a URL that can be shared with the team and
linked to from the PRDs and plans.

### What are the different layers of memory, and which product outcomes does each layer support?

RunWield does not have one memory layer. It uses short-lived context, durable artifacts, local and shared Mnemoteca
Memories, code intelligence, and Workspace surfaces for different outcomes.

| Layer                                              | What it stores                                                                                            | Product outcome                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Active model context                               | The current Agent turn context, bounded briefs, selected files, and tool results.                         | Better immediate reasoning without loading the whole project into the prompt.                            |
| Session Transcript and Session Transcript Segments | Private raw conversation and event history for one Session, split at workflow boundaries.                 | Resume, recovery, and user-visible continuity. Execution gets clean context instead of planning chatter. |
| PRDs, prototypes, and design docs                  | Product intent, UX intent, and desired outcomes.                                                          | Alignment between product, design, engineering, and Agents.                                              |
| ADRs and domain language                           | Accepted architecture rules and canonical vocabulary.                                                     | Stable team reasoning, fewer repeated debates, and more maintainable decisions.                          |
| Plans and Plan Lifecycle                           | Executable strategy, Plan Status, validation state, recovery metadata, and delivery evidence.             | Controlled execution, attention state, blocker visibility, recovery, and delivery truth.                 |
| Validation evidence and workflow state             | Mechanical validation, Semantic Code Review, worktree state, and delivery results.                        | Confidence that the result matches the approved Plan.                                                    |
| Work Records                                       | Retrospective planning memory: what changed, deviations, deferred work, and future planning notes.        | Future Plans become smarter because Agents can retrieve verified lessons.                                |
| Mnemoteca Local Memory                             | Concise local project facts, decisions, and preferences.                                                  | Personal continuity across Sessions and less rediscovery for one user.                                   |
| Mnemoteca Global Memory                            | Cross-project preferences and stable user working style.                                                  | Consistent Agent behavior across repositories.                                                           |
| Core Memory                                        | Any Local or Team Memory marked for injection into every Agent Session.                                   | Always-on critical context for safety and consistency. This layer must stay sparse.                      |
| Team Memory                                        | Reviewable repository-versioned Memory text, reconciled into local Mnemoteca copies after trusted review. | Shared Company Brain without committing Mnemoteca databases or unreviewed prompt injection.              |
| Code intelligence                                  | Current source structure, symbols, references, and impact data.                                           | Accurate answers, better Plans, and safer changes grounded in current implementation.                    |
| Workspace and Project Knowledge Search             | Search and presentation across Projects, Sessions, Plans, PRDs, ADRs, Work Records, and code.             | Multiplayer AI and leadership visibility into work, blockers, decisions, evidence, and lessons.          |

### How is RunWield different from Cursor, Lovable, HumanLayer, and Warp?

### Which parts of the Multiplayer AI and Company Brain directions are near-term product bets, and which are later vision?

### Which enterprise workflow insights create the most value for teams and leaders?

## Products to Study

### Multiplayer AI

- Cohesive

### Specification to Build

- HumanLayer
- Cursor
- Warp
- Lovable

## Strategy-to-Work Rule

Before a new feature enters Ready or In Progress, identify:

1. The business or user outcome it supports.
2. The product assumption it tests or the established strategy it executes.
3. Why it is more important now than other candidate work.
4. The evidence that will show whether it helped.

Items with clear answers move into Ready or In Progress. Other items remain in strategy or discovery while the team
builds the evidence needed for a sound decision.

## FAQ

### Isn't a work-record the same as a PR?

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

Under RunWield's default posture there is no PR at all: review happens in RunWield and RunWield merges. When a team opts
into forge-hosted review, a proven forge merge is an input that lets RunWield seal the Work Record — delivery evidence
for the memory, never a replacement for it. Either way, selected review feedback folds back into the Work Record
additively, because the comment that changes no code is often the one the next Plan most needs.

### Isn't a Plan just a ticket?

Usually issue trackers as the storage for intent are weak — they hold a wish, not a validated plan, and they drift from
the code immediately. You could expand typical tickets with a well-formed execution plan and lots of details, but some
tickets will require more than one execution to complete; typical ticket systems solve this with subtasks. So you could
use a ticket system to hold execution plans, but they are different intents, especially with Agile where tickets might
map to user stories rather than to technical execution.

Keep the Plan and Work Record upstream of the forge, and a forge swap costs you nothing. A Forge like GitHub can handle
identity, permissions, branch protection, immutable merge history, CI triggers, and the social and legal record of who
accepted a change into a shared artifact. RunWield's default posture replaces the layers above git — intent, review, and
memory — and relegates the forge to the git upstream. Teams that want forge-hosted review can opt into it per repository
or team, and integrating with GitHub for identity and permissions is high on the Workspace roadmap. With RunWield, your
knowledge does not live inside a vendor.

[Mnemoteca]: https://github.com/gandazgul/mnemoteca
