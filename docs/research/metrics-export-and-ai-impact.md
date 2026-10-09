# RunWield Metrics Export and AI Impact

Research date: 2026-09-16 (America/New_York).

## Question

What metrics does RunWield collect, what is missing for AI-impact reporting, can a WLD extension export them to
Jellyfish, and which alternatives merit evaluation?

This is a source-based feasibility review, not an accepted product specification or an implementation claim. Local
findings describe the working checkout. No live vendor ingestion was tested. Vendor documentation describes supported
features; marketing claims are not independent proof of impact.

## Findings

### Current RunWield data

Workflow metrics are opt-in and disabled by default. They append to project-scoped local JSONL under
`~/.wld/workflow-metrics/<encoded-project-root>/metrics.jsonl`. Linked execution worktrees use the primary project's
file. Writes are best-effort: a write failure does not stop work and can be silent. There is no reporting UI, CLI
summary, or analytics sync. Sources: [metrics writer](../../src/shared/workflow/metrics.js),
[settings](../user-documentation/settings.md#workflowmetrics).

A local configuration check found global `workflowMetrics: true`, no project override, and 30 metrics files including
this project's file. Event contents and counts were not audited. This updates the older July finding that metrics were
not enabled locally; it does not establish complete recording.

| Area                   | Recorded now                                                       | Source                                                                                                         |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Routing                | Triage and dispatch choices                                        | `src/tools/triage-report.ts:132–143`; `src/shared/workflow/orchestrator.ts:358–368`                            |
| Planning               | Readiness and Plan review outcomes                                 | `src/tools/plan-written.ts:950–1006`                                                                           |
| Execution              | Start, result, implementation checkpoint failures, task completion | `src/shared/workflow/plan-executor.ts:386–470`; `src/tools/task-completed.ts:393–404`                          |
| Validation             | CI attempts, semantic-review rounds and finding counts             | `src/shared/workflow/validation-mechanical.ts:168–179`; `src/shared/workflow/validation-semantic.ts:243–289`   |
| Recovery               | Recovery choices/results and committed Plan transitions            | `src/cmd/load-plan/plan-recovery-flow.ts:158–170,240–252`; `src/shared/workflow/state-transition.ts:1025–1030` |
| Model selection        | Candidate, resolution, failure, and Session configuration events   | `src/shared/session/session.js:1241–1411,2337–2359,2672–2692`                                                  |
| Tools                  | Pi tool starts, finishes, errors, categories, and elapsed time     | `src/shared/session/session.js:3223–3231,3293–3301`; `src/shared/workflow/metrics.js:390–425`                  |
| Frontend collaboration | Runtime style, pair checkpoints, and completion details            | `src/shared/workflow/plan-executor.ts:373–383`; `src/tools/task-completed.ts:237–419`                          |

There is more useful data outside the metrics file:

- **Model usage:** Session messages and runtime events contain input, output, cache usage, and cost where supplied.
  Sources: `src/shared/session/session-transcript-projection.js:356–363,940–986`;
  `src/shared/session/session-runtime-events.js:692–699`.
- **Identity:** Session records have durable identity; Plan associations contain `planId` and segment links. Sources:
  `src/shared/session/file-session-store-types.ts:51–96`; `src/shared/session/plan-association.ts:8–22`.
- **Publication:** Publication attempts link Plan and attempt IDs to validated, integration, and published commits.
  These operational records can be pruned after cleanup, so they are not a permanent analytics ledger. Sources:
  `src/shared/workflow/publication-attempt.ts:31–56`; `src/shared/workflow/publication-machine.ts:182–235,341–349`.

Important limits:

- Tool metrics use Pi subscribers. Claude and Antigravity branches skip these subscribers. Their MCP bridge records
  RunWield tool activity in transcripts/runtime events, but does not call the workflow tool-metrics helpers. Native
  backend activity is a further coverage limit. Sources: `src/shared/session/session.js:3772–3779,4124–4131`;
  `src/shared/session/bridged-tools/mcp-bridge.ts:269–341`.
- Antigravity records input/output usage but sets cache and cost values to zero. Claude's parser reads cost from
  `usage.cost`; it does not read a top-level `total_cost_usd`. Do not treat all zero values as measured zero cost.
  Sources: `src/shared/session/backends/agy-cli/execution-session.ts:645–663`;
  `src/shared/session/backends/claude-cli/stream-parser.ts:71–80,133–143`.
- Tool-call IDs are used for in-memory timing but are not written. Tool metrics omit Session identity. The record
  contract has no standard event ID, Plan ID, attempt ID, commit, or PR link. `cwdHash` identifies a checkout path, not
  the same repository across developer machines. Source: `src/shared/workflow/metrics.js:17–30,104–113,390–425`.
- The sanitizer redacts keys containing `token`, `output`, and `request`, among others. Simply adding token counters or
  request IDs to ordinary `details` would redact them. A reviewed safe numeric/identity contract is needed, not weaker
  general redaction. Source: `src/shared/workflow/metrics.js:44–47,149–176`.
- Some frontend metrics deliberately omit Session/Plan/Agent identity. Existing privacy choices must not be silently
  reversed for analytics. Source: `src/shared/workflow/metrics.js:285–306`.
- [Complete Tool-Call Metrics](../plans/archived/complete-tool-call-metrics.md) is a **draft**, not evidence that
  cross-backend coverage, exposure counts, correlation, or aggregation shipped.

### Jellyfish: target supported, custom import unconfirmed

[Jellyfish AI Impact](https://jellyfish.co/platform/jellyfish-ai-impact/) advertises AI adoption, token usage, spend,
quality, delivery impact, and comparisons across tools. Its integration list includes engineering systems and major AI
coding products. This is a broader data set than RunWield's local workflow events.

The public sources reviewed did **not** establish a supported API for registering RunWield as a custom AI tool and
importing its usage or workflow outcomes. This does not prove such an API is unavailable.

Two related public interfaces do not resolve that question:

- The official [Jellyfish MCP server](https://github.com/Jellyfish-AI/jellyfish-mcp) retrieves and analyzes existing
  Jellyfish data. Its listed AI Impact tools query adoption and impact. It is not evidence of an ingestion API.
- The official [JF Agent example configuration](https://github.com/Jellyfish-AI/jf_agent/blob/master/example.yml)
  documents Git and Jira collection. It does not define a RunWield/custom AI event contract.

Further public-source inspection gives a more specific boundary:

- The official [MCP API client](https://github.com/Jellyfish-AI/jellyfish-mcp/blob/main/server/api.js) reads
  `/endpoints/export/v0/schema` using `Authorization: Token ...`. Its generic requests are GET requests. The schema
  exposed through this client is an export schema, not proof of a general ingestion interface.
- The official [AI Impact tool definitions](https://github.com/Jellyfish-AI/jellyfish-mcp/blob/main/server/tools.js)
  describe per-tool usage dates, adoption groups, usage percentage, median issue cycle time, median PR cycle time, and
  PR throughput. These identify concrete reporting targets, not the input schema used to calculate them.
- The [help center](https://help.jellyfish.co) presents a login page. Jellyfish's
  [documentation-aware MCP announcement](https://jellyfish.co/blog/jellyfish-mcp-documentation-aware) says documentation
  search/read is available through the authenticated MCP. No customer credentials were requested or used.
- The [Augment partnership announcement](https://jellyfish.co/blog/ai-impact-augment-code) explicitly describes
  telemetry supplied by the Augment Code API. This establishes a vendor-data-source integration precedent; it does not
  establish a customer-accessible push endpoint. The
  [Codex announcement](https://jellyfish.co/blog/jellyfish-and-codex-team-up-to-bring-clarity-to-ai-assisted-engineering)
  also describes a partner integration.

The integration might require Jellyfish to read a RunWield data source, rather than a plugin posting events. Do not
choose between these approaches without evidence. No supported generic custom-tool push API or CSV import was verified.

Before promising delivery, resolve custom AI-tool ingestion support, required identities, supported metrics, where
imported data appears, authentication, retry/deduplication rules, historical import limits, and account or partnership
requirements. Confirm that custom validation/repair outcomes are accepted, not only daily usage. These remain research
dependencies, not tasks the prospective customer must solve before receiving a proposal.

### Is a plugin viable?

**Yes as optional export packaging; no as a complete extension-only integration today.**

RunWield loads enabled WLD-compatible Pi package extensions. The package must declare compatibility, extension API 1,
and `code-extension` kind. Pi extensions can observe message/tool lifecycle events and read Session state. Sources:
[src/shared/extensions/wld-extension-manifest.js](../../src/shared/extensions/wld-extension-manifest.js),
`src/shared/session/session.js:2236–2279`.

However, the inspected CLI-backend construction does not load these package extensions. There is also no dedicated
workflow-metric export hook. The writer appends JSONL; it does not publish a package-extension event. Source:
`src/shared/session/session.js:2594–2671`; `src/shared/workflow/metrics.js:277–319`.

A file-reading exporter could reuse existing data, including shared workflow events from other backends. It cannot
recover dropped events, missing identity, or unrecorded tool calls. Depending only on a Pi Session to run it would also
miss export opportunities when the user runs only CLI backends.

Here, “plugin” means an optional WLD export extension. It is not **RunWield Connect**, which brings RunWield workflows
into external agent hosts. Connect host-owned model usage needs separate permission and support; it must not be obtained
by importing raw host transcripts. Sources: [domain language](../domain-language.md),
`docs/prd/runwield-connect-prd.md:169–175,266–273`.

### Metrics gap

The table describes data needed for credible reporting, not a verified Jellyfish payload schema.

| Reporting question                | Gap to close                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Who uses RunWield, and how often? | Explicit user/org mapping, active-use definition, and enabled-user population. Events alone cannot measure inactive seats.  |
| Which projects use it?            | Portable repository identity, not a hash of each developer's local path.                                                    |
| What did each workflow cost?      | Safe cross-backend usage totals; measured versus estimated versus unavailable cost; separation from subscription invoices.  |
| What did that usage produce?      | Links from usage and attempts to Plans and confirmed published commits; PR links where applicable.                          |
| Did validation improve results?   | Joined validation attempts, findings, repairs, and final outcomes. A finding is not proof of a prevented production defect. |
| Did delivery improve?             | Git/PR, issue, deployment, incident, and rework data from external systems; a baseline and comparable groups.               |
| Can reports be trusted?           | Stable event identity, duplicate handling, offline/retry behavior, visible coverage gaps, and incomplete-call handling.     |
| Can data leave the device?        | Separate export consent and allowed fields. Local recording consent is not remote-export consent.                           |

Raw prompts, code, tool arguments/results, transcript text, Plan titles, or feedback are not required for a first
usage/outcome export. Do not upload the current JSONL wholesale merely because it is sanitized.

### Alternatives worth evaluating

| Product      | Reason to evaluate                                                                   | Verified integration position                                                                                            |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Swarmia**  | Clearest documented first custom-tool integration                                    | Custom AI-tool API accepts daily per-user usage. Best first feasibility candidate.                                       |
| **DX**       | AI impact plus developer feedback and before/after comparisons                       | Custom SQL tables can join imported data with Git/issue data. This does not automatically populate standard AI reports.  |
| **LinearB**  | AI-assisted PR analysis, delivery flow, and usage-cost reporting                     | Documented supported-provider integrations; arbitrary RunWield ingestion was not established.                            |
| **Faros**    | Session/model spend linked to shipped work; relevant to RunWield's workflow evidence | Current product page emphasizes agent outcomes, model routing, and policy. Custom RunWield ingestion needs confirmation. |
| **GitClear** | Code durability and rework as a counterweight to raw activity counts                 | Current product page emphasizes model attribution and quality scorecards. Custom RunWield ingestion needs confirmation.  |

Specific evidence and cautions:

- **Swarmia:**
  [Custom AI integrations](https://help.swarmia.com/settings/integrations/ai-coding-tool-integrations/custom-ai-tool-integrations)
  and [API reference](https://help.swarmia.com/settings/integrations/swarmia-apis/additional-ai-integrations) document
  `POST /api/v1/ingest/ai-usage`. It uses an AI Usage-scoped token and upserts by tool, user email, and date. Records
  include enabled/active state, with optional usage, spend, and model breakdowns. Historical import is supported.
  **Limit:** custom spend/detail is stored but not yet shown in the app. Daily usage gives low-confidence PR attribution
  based on use within 24 hours, not a proven link to a particular change. Linked bot contributors offer another path,
  but must not be confused with the human using RunWield. Swarmia's API does not establish support for arbitrary
  validation and repair events.
- **DX:** [AI Impact](https://docs.getdx.com/reports/ai-impact/) includes group comparisons, before/after results,
  adoption, lifecycle views, and survey-derived time savings. Its docs explicitly warn that correlation is not
  causation. [Custom tables](https://docs.getdx.com/custom-tables/) permit imports and joins in Data Studio.
  [Claude OTel](https://docs.getdx.com/connectors/claude-code-otel/) is a documented push connector, but it is
  Claude-specific, not permission to send arbitrary RunWield records as Claude activity.
- **LinearB:** [AI Analytics](https://linearb.helpdocs.io/article/q8veszh4nr-ai-analytics-adoption-workflow-and-impact)
  is documented as Beta and focuses on PR-level activity, team/repository filters, and coding/review touchpoints.
  [AI consumption](https://linearb.helpdocs.io/article/w1yl8ejm8p-ai-cost-and-token-consumption) covers supported
  Claude, Cursor, and Copilot inputs. Its cost figures are estimates of consumed resources, not provider invoice totals.
- **Faros:** [Current platform description](https://faros.ai/platform) links tasks, sessions, commits, PRs, and CI to
  spend. It also promotes model routing and governance, so there is possible product overlap as well as export value.
  This review did not validate an ingestion contract. An older custom-metrics search result returned 404 and was not
  used as evidence.
- **GitClear:** [AI ROI scorecard](https://www.gitclear.com/ai_roi_scorecard) promotes line/model attribution, durable
  output, rework, defects, and review time. Its example data is explicitly synthetic; do not cite it as measured
  performance. Evaluate its privacy requirements and support for an additional agent tool.

## Inference

RunWield's strongest contribution is not another token counter. It can connect **planning, validation, repair, and
confirmed publication**. Usage data plus those outcomes could explain whether AI work needed extensive correction before
it was accepted. That is useful alongside the Git and issue data these vendors already collect.

Do not infer developer productivity from tool-call counts, generated lines, or elapsed Session time. Waiting time is not
human labor. Successful publication is not deployment. Baseline differences, task mix, and overlapping AI tools can
explain apparent gains. RunWield invoking Claude Code is one activity with two labels, not two independent costs.

## Customer Context

The prospective team already uses Jellyfish. It will consider a RunWield trial if it can compare RunWield with its
current tools there. The owner wants RunWield to gather the evidence and present a proposal without first requiring the
team to arrange a Jellyfish introduction. This makes Jellyfish the target; competitors are references, not a substitute
destination for this opportunity.

## Recommendation

Prepare a conditional pilot proposal now, with a clear separation between RunWield-owned collection work and the
unverified Jellyfish connection. Do not require a customer introduction to develop the proposal, and do not claim that
an exporter alone guarantees appearance in AI Impact.

Keep the pilot small: usage attribution and delivery comparisons first. Cost and RunWield-specific validation/repair
analysis are secondary. Let Jellyfish's existing Git and issue connections supply delivery measures. Defer other vendor
exporters and a general RunWield analytics dashboard.

### Proposed customer offer

> Evaluate RunWield against your current development tools using your existing Jellyfish reports. RunWield will supply
> permitted usage data and links to the changes it helps deliver. We will validate that the data appears under
> RunWield's name before the measured trial starts. No prompts, source code, or conversation text will be included in
> RunWield's telemetry export.

This is proposed scope, not a statement of current integration support.

| Measure             | RunWield would supply                                                                           | Jellyfish would supply or calculate                                       |
| ------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Adoption            | Approved developer identity and actual active-use dates; enrolled-user list supplied separately | Existing person/team mapping, adoption groups, and usage percentage       |
| Delivery comparison | Repository and confirmed commit links; PR association where available                           | Existing PR throughput, median PR cycle time, and median issue cycle time |
| Usage context       | Backend/model and overlapping-tool attribution                                                  | Supported tool filters; exact custom-tool support remains unverified      |
| Cost, if supported  | Measured token totals and clearly labeled estimates; missing values stay missing                | Supported cost comparisons, subject to accepted inputs                    |

Do not equate ordinary lines changed with Jellyfish's AI-adoption-line measure. Its required attribution method has not
been verified. Do not use an existing tool's name to make RunWield activity fit an unsupported integration.

### Proposed trial conditions

- Agree the participating developers, repositories, existing tools, and baseline period before measurement. Use
  comparable work and keep tool overlap visible. A small trial is directional evidence, not causal proof.
- Start the measured period only after real RunWield activity appears in the intended Jellyfish reports and maps to the
  correct people. Repeated imports must not inflate counts. A local sample file is not integration acceptance.
- Compare delivery alongside available quality/rework signals. Do not declare success from increased PR count alone.
- Validation findings, repair attempts, and confirmed publication are useful RunWield-specific evidence. Keep them
  secondary until Jellyfish confirms where they can be displayed.
- A proposal may use clearly labeled illustrative records. Actual evidence must come from authorized real usage;
  historical gaps must remain visible. No live data was uploaded during this research.

The largest unknown is whether Jellyfish accepts a new tool through a supported customer import or requires a vendor
integration. Public evidence supports the latter as a possible route, not as a confirmed requirement. The proposal can
state this dependency without asking the customer to solve it. If no supported route exists, a separate dashboard would
not meet this customer's stated condition.

## Open Questions

- Will Jellyfish register RunWield as its own tool through customer configuration, or is vendor onboarding needed?
- Does Jellyfish accept pushed usage, read a vendor API, or support another documented import method?
- Which inputs produce native AI Impact comparisons rather than a separate custom report?
- Which current tools and execution backends will the pilot cover?
- What identity sharing and organization-level controls will the customer permit?
- How will overlapping provider telemetry be linked without double-counting spend or claiming exclusive contribution?
