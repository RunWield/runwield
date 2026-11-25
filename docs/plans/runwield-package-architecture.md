---
classification: "PROJECT"
complexity: "HIGH"
affectedPaths:
    - "packages/"
    - "packages/agents/definitions/"
    - "src/tools/"
    - "src/shared/owner-coordination/"
    - "src/plan-store.ts"
    - "src/shared/workflow/"
    - "src/shared/session/"
    - "src/acp/"
    - "src/ui/"
    - "factory/"
targetBranch: "epic/code-reorg"
createdAt: "2026-11-21"
status: "draft"
---

# Extract RunWield one domain at a time

Move one domain into a private package under the repository root's `packages/`, switch its existing consumers to
the public exports, and verify their behavior before starting the next domain. Each extraction should be a no-op
for users, integration clients, and existing data. The apps can consume a package from their current locations.
Moving an entry point to `apps/` is a separate mechanical change when useful.

## Packages and extraction order

Tools, Agents, Projects, and the [Plan document and lifecycle package](https://github.com/RunWield/runwield/pull/645) have merged. The next interface review covers the project-bound store. Workflow extraction follows review of the complete Plans domain. [Tools PR](https://github.com/RunWield/runwield/pull/641) · [Agents PR](https://github.com/RunWield/runwield/pull/643) · [Projects PR](https://github.com/RunWield/runwield/pull/644)

| Order and package | Public interface and responsibilities | Evidence that the move preserved behavior |
| --- | --- | --- |
| 1. `packages/tools` | Own built-in tool names, descriptions, parameter schemas, and computation over tool input. Expose typed results alongside the operation that produces them. Keep execution against live resources in their existing owners. Every tool can be used independently of agent definitions. Tools that operate on Plans or workflow state call the owning domain operation. The triage function takes fields and returns a JSON value. The calling adapter owns tool registration and dispatch. | Compare tool inventory, exposure, validation errors, result envelopes, and completion behavior for each existing caller. Exercise triage directly with no Session or model. |
| 2. `packages/agents` | Load the bundled role definitions, resolve project/user overrides, and assemble the effective prompts and declared tool names. Export the effective role, instructions, model preferences, and allowed names. The runtime binds those names to available implementations. | Compare effective prompts, override precedence, and tool lists in source and compiled `wld`. Keep prompt tuning as a separately reviewed behavior change. |
| 3. `packages/projects` | Own the stable `ProjectId`, project registration and lookup, and checkout bindings. Expose the existing register, list, get-by-ID, and relink operations. | Open an existing registration through Workspace and factory setup. Both must return the original ID, including for a project with zero Plans. Relink a moved checkout and confirm it still resolves to that ID. |
| 4. `packages/plans` | Open the Plan store with the resolved `ProjectId`. Own `PlanId`, the store, and Plan lifecycle. Expose create, read, edit, list, apply lifecycle event, archive, and restore. Own Work Record persistence, Plan history, artifact content and references, and publication copies. Keep lifecycle rules, Work Records, artifact APIs, and storage drivers as modules inside this package. The workflow asks Plans to apply an event to a particular Plan revision. | Load and edit existing Plans, approve and restore through current entry points, and read their Work Records and artifact links. Preserve IDs, layout, conflict handling, and delivered files. |
| 5. `packages/workflow` | Own the state of a workflow attempt. Expose starting/resuming an attempt, accepting a completion report, answering an interaction, and reading progress and outstanding work. Apply the existing routing, validation, repair, review, and publication rules. Return the recorded next action or result to the caller. | Replay existing workflow events and receipts. Check that repeated completion and interrupted publication resume the same attempt and that the same evidence is required to finish. |
| 6. `packages/pi-ai` | Wrap the existing model registry, provider/model resolution, execution settings, and mapping between RunWield inputs/results and Pi turns/tools. Keep Pi-specific types and provider errors behind these exports. Provide the existing coding-agent and MCP bindings as integration modules. | Compare selected model, tool arguments/results, cancellation, streaming events, and credential lookup for the same configuration. Keep the current Pi dependency versions during extraction. |
| 7. `packages/session-runtime` | Keep SessionHost and SessionRuntime together. Expose create/load, prompt, steer, cancel, observe, snapshot, answer, and dispose. Own live session identity, writer lifetime, queues, transcript access, and interactions. Compose agents, tools, model execution, and the workflow owner. | Resume an existing session through the TUI and ACP. Verify event order, selected agent, active-turn ownership, cancellation, and disconnection behavior. |
| 8. `packages/acp` | Export the reusable ACP client/server bindings, capability negotiation, wire schemas, extension codecs, and mapping between ACP requests and RunWield operations. The caller supplies the runtime and transport. Keep stdio startup and process lifetime in the ACP app. | Run the existing client/server protocol checks against the normal executable. Compare advertised capabilities, structured factory results, request errors, and session updates. |

While extracting a domain, move its real implementation and update the binding at the call site. Keep an existing
domain at its current public module until its own turn. A temporary forwarding import can preserve compatibility for
old callers. Give it one implementation and remove the forwarder when the last caller moves. For tools currently
wired directly to HostedSession, bind contextual operations at the host edge. Keep that binding outside the portable
tool implementation so importing Tools never loads Agents or starts a Session.

## Tools registry

`@runwield/tools` exports one runtime value, `toolRegistry`. It exports `ToolRegistry`, `ToolName`, `ToolEntry<Name>`, and `ToolParameters<Name>` for typed consumers. The package also exports the results its operations produce, such as `TriageOutcome` and `PreparedInterview`. Adapters own the results of live execution, including delegate session details and Pi result envelopes. The registry owns membership of the RunWield tool set and the ordered list of bundled extension tools used for session prompts. Agent permissions, Pi-provided tools, and tools discovered through an MCP connection stay with their respective hosts. [Package entry point](../../packages/tools/index.ts) · [Registry interface](../../packages/tools/registry.ts)

| Operation | Caller gets |
| --- | --- |
| `toolRegistry.list()` | Names of all registered tools, including tools whose schemas depend on session context. |
| `toolRegistry.list("extension")` | Bundled extension names in prompt order. |
| `toolRegistry.has(name)` | A membership check that narrows an external string to `ToolName`. |
| `toolRegistry.get(name)` | The typed entry for that name. A fixed tool exposes its model-facing schema and metadata under `definition`. Completion and delegation entries expose `define(...)`, taking the report variant or the host's authorized modes and roles. |

Tool operations live on the entry that owns them. For example, the interview entry validates questions with `prepare`, and the triage entry returns a JSON report that a worker can save or an interactive session can route. Adapters bind tool definitions to live resources. The Plan Store still checks revisions before writing a Plan. Repository lint enforces imports through declared package entry points.

```ts
import { toolRegistry, type TriageOutcome } from "@runwield/tools";

const report: TriageOutcome = toolRegistry.get("triage_report").report({
    routingIntent: "INQUIRY",
    complexity: "LOW",
    summary: "Explain how a worker resumes.",
});
```

For the same report, check all three boundaries:

1. Calling the function twice with the same fields yields the same JSON. No agent lookup, IO, metric, event, or
   transition occurs inside the function. Reject `FEATURE` as a routing intent or classification. Accept it as a work kind for `PLANNED_CHANGE`. Preserve access to historical saved Plans in the Plan reader.
2. An interactive TUI, desktop session, or ACP session can pass the report to the existing workflow routing
   operation. Its session binding updates context, records the metric, emits the status/event, and switches agents
   exactly as the current mode requires. The Pi binding preserves its tool envelope and turn termination behavior.
   Desktop may request this through ACP. One shared workflow owner implements the routing policy.
3. The target factory worker returns the same JSON inside its ACP operation result. The factory prototype lives outside this main-based extraction. A recipe requesting a GitHub comment
   feeds the saved result to the existing publisher and returns its receipt. A retry reuses that receipt. Agent
   switching and comment publication are consumer decisions. Current Connect callers also retain the same
   normalization for reports supplied by external hosts.

## Agents registry

`createAgentRegistry()` takes no arguments in local, packaged, and managed sessions. Agents locates its bundled
definitions and prompt template, resolves the personal override directory against the active RunWield profile,
and derives project overrides from the checkout selected for the lookup. The registry also owns the Markdown,
override rules, role identifiers and declared tool policy. [Registry contract](../../packages/agents/registry.ts)

| Consumer operation | Result |
| --- | --- |
| `list(projectRoot?)` and `list(projectRoot, "all")` | Effective, sorted roles for manual selection or for workflow discovery, respectively. `listNames` discovers filenames without assembling prompts. |
| `get(name, projectRoot?)` | A loaded definition with role instructions, composed system prompt, display metadata, model preferences, tool names, delegation modes and Bash selectors. Connect can return the role instructions alone. |
| `normalizeName`, `displayName`, `busyLines`, `isWorkflowOnly` | Validate an external role ID, render existing session state, or explain why a role is unavailable for manual selection. |
| `selectTools(...)` | Apply the role's existing tool-selection policy. The session binds the resulting names to implementations. |
| `getBundledDefinitionsPath()` | Give Session, Connect and project initialization a filesystem path for bundled reference documents. The registry owns cache materialization and recovery. |
| `ids.primary` and `ids.isolated` | Stable runtime and isolated definition identifiers. Some isolated definitions share a runtime name. |
| `delegation.listRoles()` and `delegation.resolve(authority, role?)` | Discover supported roles or resolve a requested delegation into an effective authority and matching isolated definition ID. |
| `isolated.load(id, options?)`, `isolated.toolCeiling(id)` and `isolated.displayNameFallback(id)` | Load the chosen worker's instructions and obtain the applicable tool ceiling or display fallback. The caller owns execution, parent permissions and background-work policy. |

```ts
import { createAgentRegistry } from "@runwield/agents";

const agents = createAgentRegistry();
const router = await agents.get(agents.ids.primary.ROUTER, projectRoot);
// An interactive session uses router.systemPrompt. Connect can present router.rolePrompt.
```

Primary definitions load in bundled, personal, then project order. Prompt text appends unless a layer declares
`promptOverride: true`. Shared practices resolve through the same layers. A role's protected tools and the universal
session naming tool keep their existing behavior. A local override can supply a custom role. The optional
`projectRoot` identifies the checkout for a particular session or run. Omitting it uses the bundled and personal
layers. In a managed session, the connection activates its verified personal mount once. The registry observes
that same scope for subsequent lookups.

Isolated workers keep their existing definitions. Most use a bare workflow prompt with a fixed tool ceiling.
The feedback engineer uses a full agent definition. Reviewer discovery and verification use distinct prompts.
Filtering what a child can actually execute still belongs to the host. Changing which worker prompts users may
override or tuning them for unattended work would change the product and needs a separate decision.

The private `@runwield/parsing` workspace holds the Markdown front-matter and shell-selector parsers that the
registry shares with existing Plan and Bash code. The private `@runwield/bundled-assets` workspace holds file
materialization and repair used by Agents and bundled skills. Agents chooses the local cache
`~/.wld/bundled-agent-definitions` when a consumer requests a readable copy. `@runwield/resources` owns the
shared home lookup and the active personal mount's access checks.

## Projects registry

Workspace and a factory worker can import `projects` from `@runwield/projects`. A checkout path selects the
directory to inspect or admit. The package locates the active account, Git metadata, Core identity record and
Workspace database. Opening registrations takes no arguments. Close the registry when the caller finishes.
[Public exports](../../packages/projects/index.ts) · [Registry](../../packages/projects/registry.ts)

| Consumer operation | Contract |
| --- | --- |
| `projects.checkout.inspect(path)` | Read existing identity, report a fresh checkout, return candidates that require a clone decision, or explain invalid evidence. Inspection leaves the checkout and account home untouched. |
| `await projects.checkout.admit(path, options?)` | Establish or recover Core identity. An existing result includes the stable project, repository and checkout IDs. A clone can require an explicit choice before admission completes. |
| `projects.registrations.open()` | Open the current owner's existing SQLite registration database. The registry exposes `register`, `list`, `get`, `relink`, `getHealth`, `setStatus`, `requireActiveRoot`, `listRootEvidence`, `remove` and `close`. |
| `projects.home` and `projects.launch` | Resolve an owner from project and repository IDs, open an existing project without a local checkout, and scope operations to the verified execution account or remote owner. |
| `projects.storage` and `projects.directory` | Resolve established Session storage and checkout history, guard against reusing another project's root, and apply existing directory confirmation rules. |

### Project identity and status

Projects owns one opaque `ProjectId` for each logical project. Workspace URLs, Plans, Sessions, Usage and
default Memory collections reference it. Future factory runs will use it too. Projects assigns a cryptographically
random UUIDv4 on admission. Repository and checkout IDs distinguish clones and worktrees within a project.
The current Workspace is personal. A hosted deployment will need tenant membership and permission checks.

An explicit registration resolves an existing project or admits a new one and returns its non-null
`projectId`, including for a project with zero Plans. Inspection and listing stay read-only. A clone with
ambiguous ownership requires the existing link-or-create decision. Relinking verifies the destination's
identity and retains the ID across a move. Removing a Workspace registration removes that registration;
reopening the same admitted project recovers its original ID.

New registrations start with `status: "active"`. The registry accepts `setStatus(projectId, "active" | "inactive")`.
Deactivation pauses Workspace access to project content and leaves the underlying project, Plans and Sessions intact.
Directory health is independent: an active project can have a missing checkout, and its settings remain available.

The personal Workspace uses canonical IDs in new links. Old registration URLs can expire. Its SQLite driver
retains historical row keys for foreign keys and reconciles existing registrations with admitted identities.
File-backed Sessions resolve old storage locators internally and expose the canonical project ID. Memory uses
that ID for its default collection. An explicit personal Memory binding can still select a shared collection.
Earlier Mnemoteca collections remain accessible by their original names. To adopt one explicitly, export it
with `mnemoteca export --name <old-name> -o memories.jsonl` and import it once with
`mnemoteca import memories.jsonl --name <project-id>`.

Workspace also uses pairing and device state in the owner database. Its coordination service binds the registry
to the same connection through `@runwield/projects/owner-coordination`. Independent consumers use the default
opener. The owner database migrates existing registrations in place. Git and non-Git checkouts keep their existing identity formats. A multi-host
identity service and tenant authorization remain separate work.

The private `@runwield/session-files` package contains the Session-owned reader used to discover existing
writer locks during checkout admission. The Session store uses the same file evidence for recovery.
This shared reader lets a worker open Projects without loading the Session runtime. The existing Session store
continues to own manifests, restoration, writes and writer lifetime.

## Plans document and lifecycle contract

A consumer imports `plans` from `@runwield/plans`. These operations run on the supplied document in memory.
The store uses the document codec during authoring and the lifecycle rules when it commits an event. Workspace uses them to present the actions available
for the current status. [Package entry point](../../packages/plans/index.ts)

| Operation | Result |
| --- | --- |
| `plans.documents.parse(markdown)` | Reads the front matter and body using the existing saved-Plan rules, including historical classifications. |
| `plans.documents.create(body, fields)` | Builds Markdown with normalized front matter. |
| `plans.documents.revision(markdown)` | Returns the existing content revision used by the store for optimistic concurrency. |
| `plans.identity.parse(value)` and `isValid(value)` | Normalize a stored Plan ID or check whether a string is already canonical. IDs remain scoped to the Project. Historical non-UUID Plan IDs remain readable. |
| `plans.lifecycle.actionsFor(status, fields)` | Returns available manual actions and reasons for blocked actions. |
| `plans.lifecycle.changesFor(event, status, details)` | Validates a lifecycle event and returns its metadata changes. The store checks the observed revision and persists the result. |

## Project-bound Plan Store under review

Open the store with the canonical `ProjectId` from Projects. Each handle addresses one project.
The personal Workspace uses its active registration. A CLI or worker with an admitted checkout can use the identity returned by Projects.
The managed runtime uses its configured owner connection. The store checks the binding before each operation.
[Store contract](../../packages/plans/store.ts) · [Runtime opener](../../src/plan-store/project-plans.ts)

| Operation | Caller supplies | Result |
| --- | --- | --- |
| `list` | No arguments | Catalog entries and document diagnostics, including the existing passive display of legacy Plans. |
| `create` | A Plan name, Markdown prose, and optional typed definition and validation instructions | A saved draft with an assigned Plan ID and revision. |
| `read`, `readArchived` | The Plan ID | The saved Plan in the requested collection. |
| `edit` | Plan ID, new body, observed revision | Updated prose and revision. |
| `revise` | Plan ID, observed revision, authored prose, validation instructions, and definition fields | An authored revision of the same Plan. The store checks identity, revision, and review locks. |
| `applyEvent` | Plan ID, named lifecycle event, observed revision, and any required event evidence | The persisted lifecycle result. |
| `archive`, `restore` | Plan ID and observed revision | An archived or restored Plan with its original ID. |

The runtime adapter calls the existing store for locking, conflict checks, recovery, and local or managed writes.
The filesystem driver in Plans captures and verifies the immutable input documents used by workflow attempts.
Existing history, Work Record persistence, and publication copies still run through the current store.
PostgreSQL remains a future driver. [Store operations](../../src/plan-store/index.ts)

### Consumer coverage

| Consumer | Entry and responsibility |
| --- | --- |
| TUI `/load-plan` and completion | List Plans in the session checkout without registering it. The picker carries the Project and Plan IDs across the selection prompt. Execution continues through the existing directory, review, and recovery checks. |
| Workspace Board, sidebar, attention dashboard, and search | Read each registered Project through its active Projects registration. Each surface owns its presentation and joins with Session or Git state. |
| Workspace Plan review, progress, usage, documents, and edits | Open the requested Project for the entire operation, including lookups that take only a Plan ID or resource name. Two Projects may have the same imported Plan ID. |
| Hosted and attached `plan_written` | Bind the Session or attached request to its Project, then create or revise by Plan ID. Sequence child decisions use the captured child IDs. Retained execution continues through its admitted source. |
| Core CLI, Session, and workflow operations | Use the project-bound host document reader for Markdown, file locations, and workflow evidence. Named commands own transaction locks, attempt recovery, archive-by-name compatibility, and publication evidence. |

The Tools registry owns schemas and pure results. The Agent registry owns role IDs and definitions. The host constructs the registry using the bundled assets. Projects owns checkout identity and registration. Plan types, document formats, and lifecycle rules come directly from Plans. The package import check also rejects application re-exports of those domains.

The factory router prototype lives outside this branch. Its old Agent loader and triage normalizer imports must move to the Agent registry and the registered `triage_report` tool when it is integrated. Factory admission must bind the canonical Project ID before handing work to the worker. The worker's scratch directory is an execution location.

## MCP and app boundaries

Keep built-in tools usable through direct calls. For MCP today, the Session owns authorized connections and Pi owns
discovery, invocation, result conversion, reconnect, and shutdown. Retain that arrangement as a Pi integration module.
If RunWield later exposes built-in tools *as an MCP server*, that adapter can import Tools and expose the selected
catalog. Introducing that server is a separate feature. [Existing MCP ownership decision](../adr/018-pi-owned-mcp-integration.md).

| App or entry point | How it consumes packages |
| --- | --- |
| TUI | Uses Session Runtime in process. Renders events and supplies interactive routing and input. |
| Desktop & Workspace | The desktop direction uses the ACP client to reach its runtime. Preserve the current Workspace adapter during its extraction. |
| SaaS | Target hosted workspace service binds an authenticated Project to the runtime. Browser clients talk to the service. |
| Factory and Worker | Factory remains the Go controller and Kubernetes API client. It starts the worker and invokes its ACP contract. The TypeScript worker composes the packages and selects output behavior. |
| ACP | The runnable server behind `wld --mode acp` wires stdio, configuration, Session Runtime, and the ACP server binding. Client apps can import the ACP package independently. |

Two existing consumers also need compatibility coverage. **The CLI** includes noninteractive commands for Plans and
other project operations. **Connect** invokes RunWield from an external agent host and already consumes normalized
triage and workflow operations. Give both callers a place in the extraction tests even if neither changes directory.
[Connect architecture](../adr/013-attached-workflow-coordination-boundary.md).

## Storage and other shared concerns

Drivers are implementation modules of the domain that owns the data. Extract the shipping driver and its readers
first. Track new drivers in follow-up implementation work so each package move can be verified against existing data.

| Owner | Existing behavior to preserve during extraction | Driver direction after extraction |
| --- | --- | --- |
| Projects | Preserve Core project identity admission, checkout bindings and the existing Workspace registry. | Keep the Projects API independent of the Plan storage driver. Hosted identity persistence can evolve behind that API. |
| Plans | Personal Markdown Plans, existing metadata and revision rules, Work Records, related artifacts, and repository delivery copies. Preserve the merged external store, including managed-remote owner selection, canonical revisions and checkout identity. | Local Markdown/filesystem driver and hosted PostgreSQL driver expose the same Plan, lifecycle, Work Record, and artifact operations. |
| Workflow | Existing checkpoints, accepted event history, pending actions, and publication receipts. | Keep the personal file-backed driver. SQLite is an option for transactional worker checkpoints. A hosted PostgreSQL driver records event acceptance, next state, and pending effects together. Workflow remains the sole transition owner across drivers. |
| Session Runtime and Pi integration | Existing Session bundles, transcripts, restore behavior, and the factory's current operation receipts. | Session Runtime owns session identity and history. A later Pi Durable worker can reopen its execution journal on its PVC. Pin the harness version and reconcile external writes using the existing effect receipts. |

**Project identity and storage binding.** Extract Core identity admission and the existing owner registry operations into
`packages/projects`, preserving registered IDs and checkout history. Plans, Sessions, factory setup, and cross-run
memory can use the same identity. At project open, the owning app resolves the ID through Projects, selects its
configured store, and passes the binding to Plans. A signed-in desktop can select a local or hosted project.
At factory admission, record the resolved ID and store binding so a replacement worker reopens the same project.
Qualify new driver bindings separately from the registry extraction.
[Projects contract](../../packages/projects/registry.ts), [registration operations](../../packages/projects/registration.ts), [Plan Store entry point](../../src/plan-store/index.ts), and [external Plan Store Epic](external-plan-store.md).

**Settings, credentials, and memory** also need explicit owners. Apps resolve project settings and credential
references at startup, then give each consumer the access it needs. Keep credential refresh with its designated
writer. Mnemoteca remains the owner of cross-run memory, reached through explicit memory tools. A shared memory
server, GitHub App authentication, hosted tenancy, and unattended prompt changes are follow-up features.

## Acceptance for each extraction

- Identify the domain's current entry points, consumers, saved formats, and relevant regression tests. Record the
  current behavior at the app boundary before moving implementation.
- Add the domain as a private workspace package and its public exports. Migrate active callers in the same change. Check
  imports for cycles and app internals. Include package code, tests, and assets in the existing build and CI inventory.
- Run the affected consumers through their normal entry points. Check CLI and wire output, tool results, prompt
  resolution, event order, on-disk compatibility, and process/pod recovery wherever the move touches those contracts.
  A behavior difference is a regression to fix before starting the next extraction.
- Qualify PostgreSQL, Pi Durable, new unattended loops, and app directory moves in their own changes. Define their delivery criteria with the relevant domain and factory work.
