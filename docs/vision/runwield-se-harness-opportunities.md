# RunWield Software Engineering Harness Opportunities

Working draft. This document collects opportunities for expanding RunWield from a repo-centered coding harness into the
middle of a broader software engineering factory.

The goal is not to reinvent the software engineering toolchain. RunWield should remain a cognitive harness: it should
help the human and LLM perceive, reason about, plan, validate, and act across the existing tools teams already use.

Software engineering may be too broad to treat as one monolithic domain harness. RunWield is better understood as the
middle of the factory: the orchestration, planning, memory, review, and execution layer that can connect narrower domain
harnesses for code, frontend design, incidents, releases, documentation, infrastructure, product work, and customer
feedback. RunWield can be the glue without becoming every machine in the factory.

## Guiding Principle

RunWield should integrate with the software engineering environment rather than replace it.

External systems such as GitHub, GitLab, CI/CD platforms, observability tools, ticket trackers, documentation systems,
Figma, and incident platforms already solve large operational problems. RunWield's opportunity is to make those systems
part of the LLM-human cognitive loop:

```text
intent -> context -> representation -> reasoning -> tools -> evaluation -> action -> consolidation
```

That means RunWield should focus on:

- choosing the right context from external tools
- turning that context into useful working representations
- helping the LLM and human reason over it
- routing work into an opinionated RunWield flow
- preserving traceability across artifacts
- maintaining records, memories, docs, and plans as living inputs to future work
- keeping durable artifacts in markdown or other open, easy-to-export formats so the local harness remains useful
  independently and users can retain their project knowledge

## Reframed Gap

With the integration-first lens, most missing software engineering capabilities are not gaps RunWield should fill by
building native clones of external products.

Issue trackers, PR systems, CI, deployment platforms, observability tools, Figma, docs platforms, and incident tooling
should usually enter RunWield through skills, MCP servers, CLIs, APIs, browser access, or narrower purpose-built
harnesses.

The real RunWield gaps are the kernel primitives that let those integrations become part of the cognitive loop:

- integration registration
- domain-aware tool affordances
- external context intake
- Work Records and traceability
- context and record curation
- richer working representations
- opinionated workflow entry points
- permission tiers
- expert teaching and playbook extraction
- narrower domain harness boundaries

## Opportunity List

### 1. Integration Substrate

RunWield needs a practical way to make skills, MCP servers, CLIs, browser fetches, and future hosted integrations
legible to agents and workflows.

In practice, an integration should be able to tell RunWield:

- what domain it belongs to
- what domain objects it can read or write
- what questions it can answer
- what evidence it returns
- what artifacts it can create or update
- what permissions it needs
- whether it is read-only, local-write, external-write, or high-risk
- which RunWield roles should use it
- which workflows it can seed or enrich
- how its outputs should be cited, linked, or recorded

This can start lightweight. A skill can describe "I know how to use `gh` for PR and CI context" or "I know how to pull
Figma design context through MCP." Over time, RunWield may want a more structured capability manifest so the harness can
discover, rank, and explain integrations.

The important point: integration substrate is not just tool installation. It is making external tools usable as parts of
the domain cognition loop.

### 2. Domain-Aware Tool Affordance Model

Tools should not be framed only by what command they run. They should be framed by how they fit the domain model and
what cognitive role they play.

For example:

- `gh pr view` is not just a command. It observes a pull request object, retrieves review/CI state, and can provide
  validation evidence or collaboration context.
- A Figma MCP tool is not just a design fetcher. It observes design intent, UI structure, component relationships, and
  visual constraints.
- An observability CLI is not just log access. It observes runtime behavior and helps build debugging or incident
  timelines.
- A documentation search skill is not just search. It retrieves current product explanations, public promises, and
  migration constraints.

For each tool, RunWield should eventually know:

- **Domain objects:** ticket, PR, run, trace, deployment, design node, doc page, customer report, incident.
- **Cognitive role:** source of truth, evidence retrieval, comparison, validation, construction, action, or audit.
- **Input shape:** URL, identifier, query, file, time window, branch, environment, or artifact reference.
- **Output shape:** source text, structured JSON, timeline event, evidence link, diff, screenshot, metric, or artifact.
- **Trust level:** authoritative, useful-but-noisy, stale-prone, user-supplied, generated, or requires corroboration.
- **Risk level:** read-only, local write, external write, deploy/production/customer-visible.

This is the difference between "the agent can call a tool" and "the harness understands how the tool participates in
software engineering cognition."

### 3. External Context Intake

RunWield needs richer ways to start from external artifacts.

Today, a user should be able to point RunWield at a ticket URL, design link, PR, doc, incident page, or support report
and say: use this as context, help me understand it, or turn it into a plan.

Near-term shape:

- accept external URLs and identifiers as first-class context seeds
- fetch accessible content through browser/web/document tools
- preserve the source link in plans and Work Records
- route the resulting work through inquiry, ideation, planning, execution, or review
- let the user decide whether the external source is durable context or session-only context

Collaborative planning is an important part of this. As planning becomes richer and more collaborative, RunWield should
also support richer ways to attach external context to a plan: ticket links, design artifacts, customer examples,
existing docs, prior incidents, PRs, CI runs, and decision records.

This does not require native integrations for every platform at first. A URL plus a good context-ingestion path can
already be valuable. Tighter integrations can come later, as their user value becomes clear.

### 4. Work Records as the Traceability Backbone

Work Records should close the loop.

They should not be dead summaries written after the fact. They should be actively maintained records that connect
intent, planning, execution, validation, external evidence, and future learning.

Possible Work Record links:

- original ticket or request
- plan or epic
- external context sources
- changed files and diff summary
- test and validation evidence
- reviewer feedback
- PR or MR
- CI run
- release
- deployment
- incident
- follow-up work
- durable lessons for future planning

Work Records should also become inputs to future planning. Planning should be able to ask:

- Have we changed this area before?
- What broke last time?
- What tests or reviews mattered?
- What assumptions were wrong?
- What incidents or customer reports are related?
- What unresolved follow-ups exist?

This makes Work Records a maintained memory layer, not just an audit log.

### 5. Context and Record Curation

RunWield's context sources will include memories, repo files, docs, plans, Work Records, external links, tool outputs,
and user-provided notes. These need active maintenance and stale checks.

Open questions:

- How does RunWield tell the user what context is active without overwhelming them?
- Should stale context warnings appear in plans?
- Should Work Records have review dates or freshness checks?
- Should planning include a "context considered" section?
- Should memory and Work Record maintenance be a separate workflow?
- How should contradictions between docs, code, memory, and Work Records surface?

A full UI for this is hard to envision immediately. A plausible first step is artifact-based curation:

- plans list important context sources
- Work Records record evidence and links
- stale or contradicted context becomes an explicit planning note
- `/memory` and future Work Record commands expose review/prune flows
- Workspace later adds a context panel for active sources, trust, freshness, and persistence

The goal is not to make the user manage a context database manually. The goal is to make the harness honest about what
it is relying on.

### 6. Richer Working Representations

Plans are strong, but the middle of the factory needs more shared thinking surfaces.

Useful representations:

- **Debugging timeline:** symptoms, observations, logs, traces, hypotheses, checks, and conclusions over time.
- **Incident timeline:** detection, impact, mitigations, decisions, deployments, recovery, and follow-up items.
- **Release risk summary:** changes included, risky areas, validation evidence, rollback plan, open concerns, and owner.
- **Design comparison table:** design intent versus implemented UI, with screenshots, Figma references, deviations, and
  review notes.
- **Dependency map:** modules, packages, services, commands, data flows, ownership, and change impact.
- **Test matrix:** requirements or user flows mapped to automated tests, manual checks, browser evidence, and gaps.

Claim ledgers are probably less central in an AI-partnered harness than they would be in a pre-LLM process. Many bug and
tech-debt investigations can compress into an opinionated flow: diagnose the issue, gather evidence, either produce a
triage report or hand the evidence to Engineer, then fix and validate. A claim ledger may still be useful for unusually
audited, ambiguous, or high-stakes work, but it should not become a default artifact.

These do not all need bespoke interactive UIs at first. They can start as generated Markdown tables, Mermaid diagrams,
JSON artifacts, or Workspace panels attached to plans and Work Records.

For example, a RunWield dependency map could start as a generated artifact that combines:

- import graph information
- command/task definitions
- package dependencies
- code search symbols
- plan/work-record references
- manually annotated ownership or boundaries

Later, Workspace could render that artifact interactively. The key is to materialize the representation so the human and
LLM can reason over the same thing.

### 7. Opinionated Workflow Spine

RunWield should not become a generic workflow builder.

Generic workflow composition tools are useful, but they are not the product thesis here. RunWield should be opinionated
about the flows that work well with an AI partner. If users commit to those flows, RunWield can make stronger promises
about planning quality, validation, traceability, and recovery.

The opportunity is not "let users compose arbitrary workflows." The opportunity is:

- define a small number of high-quality RunWield flows
- let external context and integrations enter those flows cleanly
- let skills enrich flows without turning flow design into the user's job
- keep the harness focused on doing the work, not maintaining a custom automation graph

Examples of opinionated flows:

- ticket or idea -> collaborative plan -> implementation -> validation -> Work Record
- bug report -> reproduction/evidence -> fix plan -> implementation -> validation -> Work Record
- incident -> triage -> mitigation/fix plan -> postmortem -> follow-up Work Records
- design artifact -> frontend plan -> implementation -> browser/design review -> Work Record
- release candidate -> risk review -> release notes -> release Work Record

These are product-level flows, not arbitrary user-built graphs.

### 8. Permission and Action Tiers

Permissions are necessary, but they are probably not the next most interesting product surface.

As integrations gain write access, RunWield will need clearer action tiers:

- local read-only inspection
- local file edits
- local validation commands
- branch or PR creation
- issue or ticket updates
- CI reruns
- release preparation
- deployment actions
- production or customer-visible actions

Each tier should have appropriate permissions, audit trails, and human approval gates.

This can come later, but the architecture should not paint RunWield into a corner.

### 9. Expert Teaching and Playbook Extraction

RunWield needs a clearer loop for turning expert corrections into reusable harness behavior.

Examples:

- "remember this pattern" with scoped preview
- "this was wrong" contradiction handling
- "never do this in this project"
- "extract this as a playbook"
- "make this a review rubric"
- "this tool is the source of truth for this question"
- "when planning frontend work, always check the design artifact and browser evidence"
- "when planning release work, always include rollback and customer communication"

This should produce maintainable artifacts:

- memories
- skills
- project playbooks
- review rubrics
- tool affordance notes
- domain-specific planning checklists
- Work Record follow-up lessons

The expert teaching loop should be inspectable and reversible. The point is not to save everything; it is to decide what
should shape future cognition.

### 10. Narrower Domain Harnesses

Some capabilities should become their own domain-specific harnesses rather than bloating RunWield Core.

Examples:

- incident/on-call/production debugging harness
- release planning and deployment traceability harness
- frontend/design implementation harness
- DevOps and infrastructure harness
- documentation and developer education harness
- customer feedback and support-intake harness

RunWield's job is to provide the shared kernel and glue:

- session runtime
- routing
- planning
- memory
- Work Records
- traceability
- tools and permissions
- Workspace surfaces
- validation and review hooks

The narrower harness supplies its own ontology, skills, tools, external representations, rubrics, and domain workflows.

This is how RunWield can stay coherent while still becoming the middle of the factory.

## External Systems as Integrations

### Issue Trackers

RunWield should be able to start from a ticket as context for planning or execution.

Near-term shape:

- accept a ticket URL when accessible
- use web/document tools to pull the ticket content
- treat the ticket as the seed for an inquiry, plan, or execution workflow
- preserve the ticket link in the plan or Work Record

Later shape:

- tighter GitHub Issues, Linear, Jira, or GitLab issue integrations
- authenticated ticket updates
- status synchronization

### Pull Requests and CI History

GitHub and GitLab already expose PR/MR and CI data through `gh`, `glab`, APIs, and platform-specific tooling. RunWield
should use skills and integrations rather than duplicate those clients.

Opportunities:

- teach agents how to use `gh` and `glab` through skills
- record PR/MR links in Work Records
- record CI run links and outcomes as validation evidence
- inspect CI history when debugging failures
- support PR-centered workflows in addition to direct merge-back

Today, RunWield's saved-plan workflow tends to finish by merging validated work back into the primary checkout. A fuller
team-oriented harness may need PRs to become a more centered workflow: plan -> branch/worktree -> implementation ->
validation -> PR -> review -> merge -> Work Record.

### Deploys and Releases

Deployment automation is already a mature tooling ecosystem. RunWield should not try to replace CD systems.

The cognitive opportunity is around release traceability and decision support:

- link Work Records to releases
- identify which plans and PRs went into a release
- summarize release risk
- check rollout and rollback readiness
- capture deployment notes
- preserve production feedback after release
- connect incidents back to the release or work item that caused them

Deploys are less about "RunWield clicks deploy" and more about "RunWield helps understand what is being deployed, why,
with what risk, and what happened afterward."

### Logs, Metrics, and Traces

Observability tools are critical context for bugs and incidents.

RunWield should access them through skills, MCP servers, CLIs, and vendor APIs where available.

Opportunities:

- provide skills for common observability tools
- guide agents to retrieve the right logs, metrics, and traces
- build debugging timelines from evidence
- connect runtime symptoms to code changes, deploys, and incidents
- preserve useful findings in Work Records or incident records

The harness should help the LLM get the right information, not invent an observability platform.

### Documentation

Docs are already part of RunWield's work surface: plans and work items can be about writing or updating docs, and skills
can provide documentation workflows.

Potential additions:

- docs impact checks for code changes
- source-to-doc traceability
- docs freshness review
- stronger documentation skills for API docs, tutorials, migrations, and release notes

### Customer Reports

Customer reports are an important but less defined input.

Possible sources:

- support tickets
- emails
- chat transcripts
- sales or success notes
- app feedback
- issue reports
- community posts

Possible harness role:

- cluster related reports
- extract symptoms, affected users, reproduction hints, and severity
- connect reports to existing issues, incidents, or plans
- preserve source links and privacy boundaries
- turn validated patterns into planning context

This area likely needs careful scoping because customer data can be noisy, sensitive, and domain-specific.

### Design Artifacts

Frontend and product design need a stronger first-class workflow.

RunWield should lean on skills and MCP integrations rather than inventing design-tool replacements. Figma MCP is a
natural example.

Opportunities:

- ingest design artifacts as planning context
- compare implementation against design intent
- capture visual evidence with browser verification
- support FE-specific review rubrics
- track design decisions and deviations
- link plans, screenshots, Figma nodes, and UX review notes
- support human-in-the-loop frontend Work Records where design comparison evidence, screenshots, deviations, and review
  decisions are preserved as part of the completed work

This is a major part of making RunWield a stronger factory middle, because frontend work is not just code correctness.
RunWield still has a lot of room to grow here: design intake, implementation guidance, browser evidence, visual review,
accessibility checks, responsive behavior, and human design judgment all need better support.

### Production Incidents

Production incidents may deserve their own narrower harness for on-call, production debugging, deployment traces,
mitigation, and postmortems.

RunWield could still provide the shared planning, memory, traceability, and follow-up machinery.

Possible loop:

```text
incident -> gather symptoms -> retrieve telemetry -> build timeline -> identify hypotheses -> test hypotheses ->
mitigate -> write postmortem -> consolidate learnings
```

Opportunities:

- incident triage skill
- postmortem drafting skill
- runbook execution with permission gates
- incident-to-plan conversion for follow-up fixes
- incident record that can surface during future planning
- release and incident traceability

This is a strong example of extended cognition: the harness can help connect runtime evidence, code history, human
judgment, and future planning.

## Possible Sequencing

One practical sequence:

1. Define Work Records as the traceability backbone.
2. Build external context intake around collaborative planning.
3. Add context and record curation to planning and Work Record flows.
4. Define lightweight integration capability metadata for skills/MCP/CLIs.
5. Materialize a few high-value representations: dependency map, test matrix, debugging timeline, release risk summary.
6. Add PR-centered workflow support alongside direct merge-back.
7. Improve frontend/design workflow with browser evidence and Figma-oriented skills.
8. Add observability and incident skills as optional integrations or a narrower incident harness.
9. Add customer-report intake only after privacy and source-boundary questions are clearer.

This sequence keeps RunWield focused on cognition, traceability, and opinionated flow while relying on existing external
tools for the specialized systems they already handle well.
