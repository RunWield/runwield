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
planId: "9551469a-5924-4adb-a6ae-3383632b2f33"
---

# Extract RunWield one domain at a time

Retire the root `src/` directory in three passes. Preserve behavior for users, integration clients, and existing data at every step.

1. **Publish the interfaces.** Work through the domains below in order. Review one typed public interface at a time and migrate all callers of that capability. Apps continue running from their current locations. Move implementation that belongs to the interface as it is extracted, and record which operations still rely on a runtime implementation in `src/`.
2. **Make the packages independent.** Start again with Tools and follow the same order. Move each domain's remaining implementation, storage drivers, and tests to its owner. For example, finish the project-bound Plan store opener and its local and managed storage operations. Add a CI check that rejects package imports or re-exports from root `src/`, imports of another package's internals, and cycles between packages, including type-only dependencies. Verify each package through its public entry points.
3. **Construct the apps and retire `src/`.** Compose the packages in `apps/`. Move command handling, presentation, and process startup to the app that owns each entry point. Relocate the remaining tests and assets with their owners, update build and release paths, and exercise the shipped entry points. This pass is complete when root `src/` is gone and the apps build, test, and package from the new layout.

## Packages and extraction order

Tools, Agents, Projects, and the [Plan document and lifecycle package](https://github.com/RunWield/runwield/pull/645) have merged. The [Project-bound store](https://github.com/RunWield/runwield/pull/646), [caller migration](https://github.com/RunWield/runwield/pull/647), [Work Record reads](https://github.com/RunWield/runwield/pull/648), and [store-assigned Work Record creation](https://github.com/RunWield/runwield/pull/649) have also merged. [Plan milestone history](https://github.com/RunWield/runwield/pull/650) has merged. [Plan artifacts and publication copies](https://github.com/RunWield/runwield/pull/651) have merged. [Workflow](https://github.com/RunWield/runwield/pull/652) has merged. [Pi-AI](https://github.com/RunWield/runwield/pull/653) has merged. [Session Runtime](https://github.com/RunWield/runwield/pull/654) and [ACP](https://github.com/RunWield/runwield/pull/655) complete the interface pass. [Tools independence](https://github.com/RunWield/runwield/pull/656) has merged. [Agents independence](https://github.com/RunWield/runwield/pull/657) forms the base for Projects. Plans follows Projects in this pass. [Tools PR](https://github.com/RunWield/runwield/pull/641) · [Agents PR](https://github.com/RunWield/runwield/pull/643) · [Projects PR](https://github.com/RunWield/runwield/pull/644)

| Order and package             | Public interface and responsibilities                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence that the move preserved behavior                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `packages/tools`           | Own built-in tool names, descriptions, parameter schemas, and computation over tool input. Expose typed results alongside the operation that produces them. Keep execution against live resources in their existing owners. Every tool can be used independently of agent definitions. Tools that operate on Plans or workflow state call the owning domain operation. The triage function takes fields and returns a JSON value. The calling adapter owns tool registration and dispatch. | Compare tool inventory, exposure, validation errors, result envelopes, and completion behavior for each existing caller. Exercise triage directly with no Session or model.                                     |
| 2. `packages/agents`          | Load the bundled role definitions, resolve project/user overrides, and assemble the effective prompts and declared tool names. Export the effective role, instructions, model preferences, and allowed names. The runtime binds those names to available implementations.                                                                                                                                                                                                                  | Compare effective prompts, override precedence, and tool lists in source and compiled `wld`. Keep prompt tuning as a separately reviewed behavior change.                                                       |
| 3. `packages/projects`        | Own the stable `ProjectId`, project registration and lookup, and checkout bindings. Expose the existing register, list, get-by-ID, and relink operations.                                                                                                                                                                                                                                                                                                                                  | Open an existing registration through Workspace and factory setup. Both must return the original ID, including for a project with zero Plans. Relink a moved checkout and confirm it still resolves to that ID. |
| 4. `packages/plans`           | Open the Plan store with the resolved `ProjectId`. Own `PlanId`, the store, and Plan lifecycle. Expose create, read, edit, list, apply lifecycle event, archive, and restore. Own Work Record persistence, Plan history, artifact content and references, and publication copies. Keep lifecycle rules, Work Records, artifact APIs, and storage drivers as modules inside this package. The workflow asks Plans to apply an event to a particular Plan revision.                          | Load and edit existing Plans, approve and restore through current entry points, and read their Work Records and artifact links. Preserve IDs, layout, conflict handling, and delivered files.                   |
| 5. `packages/workflow`        | Own the state of a workflow attempt. Expose starting/resuming an attempt, accepting a completion report, answering an interaction, and reading progress and outstanding work. Apply the existing routing, validation, repair, review, and publication rules. Return the recorded next action or result to the caller.                                                                                                                                                                      | Replay existing workflow events and receipts. Check that repeated completion and interrupted publication resume the same attempt and that the same evidence is required to finish.                              |
| 6. `packages/pi-ai`           | Wrap the existing model registry, provider/model resolution, execution settings, and mapping between RunWield inputs/results and Pi turns/tools. Keep Pi-specific types and provider errors behind these exports. Provide the existing coding-agent and MCP bindings as integration modules.                                                                                                                                                                                               | Compare selected model, tool arguments/results, cancellation, streaming events, and credential lookup for the same configuration. Keep the current Pi dependency versions during extraction.                    |
| 7. `packages/session-runtime` | Keep SessionHost and SessionRuntime together. Expose create/load, prompt, steer, cancel, observe, snapshot, answer, and dispose. Own live session identity, writer lifetime, queues, transcript access, and interactions. Compose agents, tools, model execution, and the workflow owner.                                                                                                                                                                                                  | Resume an existing session through the TUI and ACP. Verify event order, selected agent, active-turn ownership, cancellation, and disconnection behavior.                                                        |
| 8. `packages/acp`             | Export the reusable ACP client/server bindings, capability negotiation, wire schemas, extension codecs, and mapping between ACP requests and RunWield operations. The caller supplies the runtime and transport. Keep stdio startup and process lifetime in the ACP app.                                                                                                                                                                                                                   | Run the existing client/server protocol checks against the normal executable. Compare advertised capabilities, structured factory results, request errors, and session updates.                                 |

While extracting a domain, move its real implementation and update the binding at the call site. Keep an existing
domain at its current public module until its own turn. A temporary forwarding import can preserve compatibility for
old callers. Give it one implementation and remove the forwarder when the last caller moves. For tools currently
wired directly to HostedSession, bind contextual operations at the host edge. Keep that binding outside the portable
tool implementation so importing Tools never loads Agents or starts a Session.

## Tools registry

`@runwield/tools` exports one runtime value, `toolRegistry`. It exports `ToolRegistry`, `ToolName`, `ToolEntry<Name>`, and `ToolParameters<Name>` for typed consumers. The package also exports the results its operations produce, such as `TriageOutcome` and `PreparedInterview`. Adapters own the results of live execution, including delegate session details and Pi result envelopes. The registry owns membership of the RunWield tool set and the ordered list of bundled extension tools used for session prompts. Agent permissions, Pi-provided tools, and tools discovered through an MCP connection stay with their respective hosts. [Package entry point](../../packages/tools/index.ts) · [Registry interface](../../packages/tools/registry.ts)

| Operation                        | Caller gets                                                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolRegistry.list()`            | Names of all registered tools, including tools whose schemas depend on session context.                                                                                                                                                  |
| `toolRegistry.list("extension")` | Bundled extension names in prompt order.                                                                                                                                                                                                 |
| `toolRegistry.has(name)`         | A membership check that narrows an external string to `ToolName`.                                                                                                                                                                        |
| `toolRegistry.get(name)`         | The typed entry for that name. A fixed tool exposes its model-facing schema and metadata under `definition`. Completion and delegation entries expose `define(...)`, taking the report variant or the host's authorized modes and roles. |

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

### Tools independence

A consumer can import the registry and use a tool's input checks and result preparation without opening a Session. For example, a caller can validate a `code_batch` request, run the reads using its own adapter, and ask the same registry entry to assemble the ordered report. The `memory` entry prepares scoped requests. Its adapter resolves the project collection and contacts the memory service.

The host still authorizes delegation, opens files, runs commands, and persists workflow decisions. Workflow checks review findings against its ledger. TUI and Workspace share the list of tool calls to expand in Session history. That presentation list includes the historical `slicer_finalize` name so older transcripts keep their appearance.

The package boundary check starts with Tools. It follows imports, re-exports and type references across workspace packages and reports the path when a dependency reaches root `src/` or forms a package cycle. Each later independence change adds its package to the same check. [Boundary check](../../scripts/check-package-boundaries.ts) · [Registry](../../packages/tools/registry.ts) · [Session history presentation](../../src/ui/workflow-tool-presentation.ts)

## Agents registry

`createAgentRegistry()` takes no arguments in local, packaged, and managed sessions. Agents locates its bundled
definitions and prompt template, resolves the personal override directory against the active RunWield profile,
and derives project overrides from the checkout selected for the lookup. The registry also owns the Markdown,
override rules, role identifiers and declared tool policy. [Registry contract](../../packages/agents/registry.ts)

| Consumer operation                                                                               | Result                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list(projectRoot?)` and `list(projectRoot, "all")`                                              | Effective, sorted roles for manual selection or for workflow discovery, respectively. `listNames` discovers filenames without assembling prompts.                                                         |
| `get(name, projectRoot?)`                                                                        | A loaded definition with role instructions, composed system prompt, display metadata, model preferences, tool names, delegation modes and Bash selectors. Connect can return the role instructions alone. |
| `normalizeName`, `displayName`, `busyLines`, `isWorkflowOnly`                                    | Validate an external role ID, render existing session state, or explain why a role is unavailable for manual selection.                                                                                   |
| `selectTools(...)`                                                                               | Apply the role's existing tool-selection policy. The session binds the resulting names to implementations.                                                                                                |
| `getBundledDefinitionsPath()`                                                                    | Give Session, Connect and project initialization a filesystem path for bundled reference documents. The registry owns cache materialization and recovery.                                                 |
| `ids.primary` and `ids.isolated`                                                                 | Stable runtime and isolated definition identifiers. Some isolated definitions share a runtime name.                                                                                                       |
| `delegation.listRoles()` and `delegation.resolve(authority, role?)`                              | Discover supported roles or resolve a requested delegation into an effective authority and matching isolated definition ID.                                                                               |
| `isolated.load(id, options?)`, `isolated.toolCeiling(id)` and `isolated.displayNameFallback(id)` | Load the chosen worker's instructions and obtain the applicable tool ceiling or display fallback. The caller owns execution, parent permissions and background-work policy.                               |

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

### Agents independence

The registry loads bundled definitions, personal and project overrides, prompt templates, and isolated roles through its package entry point. The Session host shares one registry instance so prompt lookups and display metadata use the same cache. CI follows the Agents package's imports and type references and checks its dependencies for cycles. The packaged CLI qualification reads the bundled Router and applies both personal and project overrides after the executable has been moved. [Public entry point](../../packages/agents/index.ts) · [Package qualification](../../scripts/check-bun-package.ts)

## Projects registry

Workspace and a factory worker can import `projects` from `@runwield/projects`. A checkout path selects the
directory to inspect or admit. The package locates the active account, Git metadata, Core identity record and
Workspace database. Opening registrations takes no arguments. Close the registry when the caller finishes.
[Public exports](../../packages/projects/index.ts) · [Registry](../../packages/projects/registry.ts)

| Consumer operation                              | Contract                                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `projects.checkout.inspect(path)`               | Read existing identity, report a fresh checkout, return candidates that require a clone decision, or explain invalid evidence. Inspection leaves the checkout and account home untouched.                          |
| `await projects.checkout.admit(path, options?)` | Establish or recover Core identity. An existing result includes the stable project, repository and checkout IDs. A clone can require an explicit choice before admission completes.                                |
| `projects.registrations.open()`                 | Open the current owner's existing SQLite registration database. The registry exposes `register`, `list`, `get`, `relink`, `getHealth`, `setStatus`, `requireActiveRoot`, `listRootEvidence`, `remove` and `close`. |
| `projects.home` and `projects.launch`           | Resolve an owner from project and repository IDs, open an existing project without a local checkout, and scope operations to the verified execution account or remote owner.                                       |
| `projects.storage` and `projects.directory`     | Resolve established Session storage and checkout history, guard against reusing another project's root, and apply existing directory confirmation rules.                                                           |

### Projects independence

The standalone registry opens the personal SQLite database. When Workspace already holds an owner coordination connection, its `store.projects` binds the same registration operations to that connection. Both entry points use the Projects package for identity, registration, status, and relinking. Resources owns the shared database migrations. Runtime entry owns the authorization to repair relocated Git submodules. [Registry contract](../../packages/projects/registration.ts) · [SQLite registration tests](../../packages/projects/registration.test.ts)

The package boundary check covers Projects and its tests. Tests in the package exercise the real identity files and SQLite store. The remaining Session and Workspace integration tests exercise their own behavior through that registry.

### Project runtime entry

`@runwield/project-runtime` exposes `enter(checkout: ProjectIdentity): Promise<ProjectRuntimeLayout>` to code that needs to prepare an admitted checkout for a write. Projects supplies the identity. Runtime verifies it, recovers interrupted storage migrations and returns the locations for the primary and selected checkouts. A managed Plan write uses the selected checkout's journal to retain its operation ID across a lost response. Plans owns that operation and its retry.

Commands that start with a directory resolve identity through Projects before entering. Passive reads inspect storage without entering. A factory worker uses the same project-bound Plan store contract as Workspace.

Runtime uses Workflow's private publication format to validate saved attempts during registry inspection and storage recovery. The format contains the saved schema, phases, and evidence checks. It uses Plans' private storage format for Plan IDs, frozen publication references, and copy policy. These dependencies give Runtime the validators without loading either domain's operations. Workflow owns phase transitions and publication decisions. Consumers still use the existing Plans and Workflow entry points. [Publication state machine](../adr/015-proof-bearing-publication-state-machine.md)

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

| Operation                                            | Result                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans.documents.parse(markdown)`                    | Reads the front matter and body using the existing saved-Plan rules, including historical classifications.                                                 |
| `plans.documents.create(body, fields)`               | Builds Markdown with normalized front matter.                                                                                                              |
| `plans.documents.revision(markdown)`                 | Returns the existing content revision used by the store for optimistic concurrency.                                                                        |
| `plans.identity.parse(value)` and `isValid(value)`   | Normalize a stored Plan ID or check whether a string is already canonical. IDs remain scoped to the Project. Historical non-UUID Plan IDs remain readable. |
| `plans.lifecycle.actionsFor(status, fields)`         | Returns available manual actions and reasons for blocked actions.                                                                                          |
| `plans.lifecycle.changesFor(event, status, details)` | Validates a lifecycle event and returns its metadata changes. The store checks the observed revision and persists the result.                              |

## Project-bound Plan Store

The application's Plan operations, including `openProjectPlanStore(projectId, options?)`, are exposed through `src/plan-store/index.ts`. Each handle addresses one canonical `ProjectId` from Projects.
The personal Workspace uses its active registration. A CLI or worker with an admitted checkout can use the identity returned by Projects.
The managed runtime uses its configured owner connection. The store checks the binding before each operation.
[Application Plan operations](../../src/plan-store/index.ts) · [Runtime opener](../../src/plan-store/project-plans.ts)

Import the `ProjectPlanStore` contract, `StalePlanWriteError`, and the retained data types `PackageAttemptContinuation`, `PackageWorkflowInput`, `PackagePublicationManifest`, and `PreparedPlanImport` directly from `@runwield/plans/store`. The application and its managed worker share these definitions across the existing owner connection. [Store contract](../../packages/plans/store.ts)

| Operation              | Caller supplies                                                                            | Result                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `list`                 | No arguments                                                                               | Catalog entries and document diagnostics, including the existing passive display of legacy Plans. |
| `create`               | A Plan name, Markdown prose, and optional typed definition and validation instructions     | A saved draft with an assigned Plan ID and revision.                                              |
| `read`, `readArchived` | The Plan ID                                                                                | The saved Plan in the requested collection.                                                       |
| `editBody`             | Plan ID, new body, observed revision                                                       | Updated prose and revision.                                                                       |
| `revise`               | Plan ID, observed revision, authored prose, validation instructions, and definition fields | An authored revision of the same Plan. The store checks identity, revision, and review locks.     |
| `applyEvent`           | Plan ID, named lifecycle event, observed revision, and any required event evidence         | The persisted lifecycle result.                                                                   |
| `archive`, `restore`   | Plan ID and observed revision                                                              | An archived or restored Plan with its original ID.                                                |

Plans owns the opener options, Project and personal-owner checks, and the retained checkout scope for explicit import and original execution. The Plans filesystem driver owns canonical package reads and writes, catalog and Plan locks, revision checks, immutable workflow inputs and controller evidence, and recovery of package writes and operation receipts. The application still opens the configured local or managed store and coordinates its workflow operations. For explicit import, the application observes and revalidates the checkout or SSH source while the Plans driver holds the existing locks and commits the resulting import evidence.

Desktop, TUI, ACP and worker callers read a Plan by its stable ID with `store.read(planId)`. For a Plan imported
during an active local run, the private Plans reader verifies the original attempt, repository, branch and checkout
before returning its current document and controller state. If the checkout is missing, it can read a verified local
Git snapshot. After settlement, reads use the canonical Plan. [Retained checkout reader](../../packages/plans/retained-execution.ts)

For a canonical Plan, the filesystem driver assembles the document, revision, family references and controller state.
When the execution checkout lives on an SSH host, the laptop can serve the saved document without querying the host.
During recovery the host supplies an observation of the requested attempt. Plans verifies it against the saved Plan
and binds it to that operation. For Recreate, the host journal links the old and new attempt IDs and Plans owns
the switch between them. Desktop, TUI, ACP and worker callers continue to use `store.read(planId)`.

The same driver lists active Plans and looks up archived Plans by ID. The public catalog returns logical Plan
references and diagnostics. The CLI computes checkout-relative paths when it displays archived resources.

The SSH adapter sends distinct create and revise commands. A create carries the content and operation ID. The
Plan store reserves its Plan ID with that operation. A revise carries the existing Plan ID and expected revision.
An older saved authoring request replays with its original identity and payload. The public store and
`plan_written` continue to use the same create and revise methods.

Plans owns the canonical operation receipt files and validates the retained operation identity before completion. The application owns typed command result files, including `sequence-review-results/<operationId>.json`. It reads the retained Sequence decision and passes its operation identity, digest, Plan ID, and revision to Plans to settle the canonical receipt.
The host coordinates milestone capture with the lifecycle event that makes the version visible.
PostgreSQL remains a future driver. [Store operations](../../src/plan-store/index.ts)

### Work Records

Opening the Plan Store binds its `workRecords` collection to the same Project ID and personal owner. Each operation rechecks the binding. Callers supply no checkout path.

| Operation | Result |
| --- | --- |
| `workRecords.create(input)` | Returns the persisted document with its store-assigned record ID. The store owns the ID and the filename. |
| `workRecords.list()` | All stored documents, including drafts, archived records and superseded records. A passive read of an empty store returns an empty list. |
| `workRecords.read(recordId)` | One document by case-insensitive record ID, or `null` if missing. Multiple documents with that ID cause an ambiguity error. |

A document includes its typed front matter, title, summary, sections, body, original Markdown, and a relative document path. Absolute owner locations stay in the filesystem driver. Workspace applies its own visibility rules when displaying and indexing records. The agent memory tools retain their current-only policy and Mnemoteca search behavior.

`@runwield/plans/work-records` owns the Markdown format, projects each record into its public document shape, and looks up records by ID. Both the filesystem driver and the managed host adapter use those document operations. `@runwield/plans/work-record-files` supplies the Project-bound filesystem collection and owns its creation receipts and durable files. The host admits the Project, routes managed reads and writes to its owner, and coordinates publication and secondary indexing. A future PostgreSQL driver can expose the same Project-bound collection.

### Plan milestone history

A caller opens the Project Plan Store once, then uses its `history` collection with the stable Plan ID. The CLI resolves its existing name-or-ID argument at the command boundary.

| Operation | Result |
| --- | --- |
| `history.list(planId)` | The Plan ID, its current revision, and the recorded versions in order. Renamed and archived Plans retain their history. |
| `history.read(planId, version)` | The Markdown documents frozen for that version, including any optional documents present at capture. The store verifies the frozen content against its saved digest. |
| `history.restore(planId, version, expectedRevision)` | Restores the version’s document set and returns the new revision. A stale revision leaves current content intact. |

Lifecycle operations trigger capture on approval, delivery, closure, and archive. The store assigns the version. Restore keeps the current Plan identity and delivery evidence and reopens review when changed content requires it. Managed callers use the personal owner’s store and its existing restore receipts. [Core milestone requirements](../prd/runwield-core-prd.md#plan-lifecycle)

Plans owns local catalog selection, milestone reads, and atomic document restoration. The host settles interrupted
Sequence approvals before returning history. Restore still uses the host’s collaboration guard and review reopening
because they read live controller and execution evidence.

### Plan artifacts and publication copies

An Epic can own a Manual QA checklist and an integration report. Use `store.artifacts` with the stable Plan ID and artifact name to read or save either document. A read of an absent optional document returns `null`. A successful read returns the Markdown, its logical reference, and the revision used for editing. The QA operations take the Epic and child IDs so a retried append can recognize the child's existing section. The Plans filesystem driver checks active Epic ownership, reads artifacts with their package revision, and revalidates saves under the Plan family locks. The workflow retains the child's attempt and frozen input evidence for generated QA. [Store contract](../../packages/plans/store.ts)

Sessions that register a Plan document keep its stable Plan ID and resource so the TUI and Workspace can reopen it after a rename or archive. Older references that contain only a name still resolve that name through the admitted store. If a different Plan later takes that name, the old reference alone cannot identify the original. Workspace document editing and Attached document reads use the same package content and revision while retaining their existing permissions and response formats.

Use `store.publicationCopies.read(reference)` with the retained reference from a publication attempt. It returns the repository destinations and exact Markdown frozen for delivery. An attempt with both copy settings disabled can return an empty list. Later Plan edits and changes to repository settings leave the sealed payload intact. Plans owns the local manifest lookup, copy format, destination validation, and filesystem writes. The runtime routes managed requests and checks Git evidence for earlier deliveries. Workflow decides when to create the copies commit, advance the target, or retry publication. [Publication copy contract](../../packages/plans/publication-copies.ts)

### Consumer coverage

| Consumer                                                     | Entry and responsibility                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI `/load-plan` and completion                              | List Plans in the session checkout without registering it. The picker carries the Project and Plan IDs across the selection prompt. Execution continues through the existing directory, review, and recovery checks. |
| Workspace Board, sidebar, attention dashboard, and search    | Read each registered Project through its active Projects registration. Each surface owns its presentation and joins with Session or Git state.                                                                       |
| Workspace Plan review, progress, usage, documents, and edits | Open the requested Project for the entire operation, including lookups that take only a Plan ID or resource name. Two Projects may have the same imported Plan ID.                                                   |
| Hosted and attached `plan_written`                           | Bind the Session or attached request to its Project, then create or revise by Plan ID. Sequence child decisions use the captured child IDs. Retained execution continues through its admitted source.                |
| Core CLI, Session, and workflow operations                   | Use the project-bound host document reader for Markdown, file locations, and workflow evidence. Named commands own transaction locks, attempt recovery, archive-by-name compatibility, and publication evidence.     |

The Tools registry owns schemas and pure results. The Agent registry owns role IDs and definitions. The host constructs the registry using the bundled assets. Projects owns checkout identity and registration. Plan types, document formats, and lifecycle rules come directly from Plans. The package import check also rejects application re-exports of those domains.

The factory router prototype lives outside this branch. Its old Agent loader and triage normalizer imports must move to the Agent registry and the registered `triage_report` tool when it is integrated. Factory admission must bind the canonical Project ID before handing work to the worker. The worker's scratch directory is an execution location.

## Workflow

A client opens a Workflow for the selected Plan in its Project. Starting or resuming execution binds an attempt to the existing worktree or in-place execution. The client can inspect its state and report implementation completion. Workflow checks the attempt and the Plan before recording the checkpoint. Reading progress combines the current attempt, its compatible validation checkpoint, and saved publication evidence. Workspace uses those facts for Plan details and reads active attempts in one batch for the attention dashboard. [Workflow contract](../../packages/workflow/index.ts)

| Caller | Responsibility |
| --- | --- |
| Interactive Session, TUI and ACP | The Session presents agent handoffs and prompts. Workflow interprets accepted triage, planning and implementation outcomes. The Tools registry still returns a structured triage report independently. |
| Attached coordinator | The host executes agent turns. Workflow advances validation, accepts the host’s review or repair report, and checks an interaction answer against its saved request. |
| Tool adapters and Session runners | Publish, claim, wait for and settle typed reports through a Session-bound queue. An accepted root report stays in the existing Session outbox until settled. Isolated agent reports keep their invocation scope. |
| Publication and recovery | Open the publication attempt in its Project to prepare copies, advance with evidence, reconcile or finish cleanup. Plans supplies the frozen documents. Workflow owns the transition and its receipt. |

The interface pass retains the existing file-backed Plan checkpoints, Session outbox and publication receipts. New worktree completion receipts can also record the implementation commit. A retry of an older completed worktree with no recorded commit leaves later edits alone and returns no commit ID. Worktree and Git operations, Plan Store binding, the validation engine and Session execution still use runtime code under `src/`. The next pass moves those implementations to their owners. [Workflow events](../../packages/workflow/events.ts) · [Routing](../../packages/workflow/routing.ts) · [Publication](../../packages/workflow/publication-runtime.ts)

## Pi-AI contract

Applications use the model registry to list models, resolve a selection, and manage provider login. The registry locates the personal configuration and credential store. Its public model descriptors contain the fields used for display and selection. The coding-agent binding resolves the native model for execution. [Model registry interface](../../packages/pi-ai/model-catalog.ts) · [Native model binding](../../packages/pi-ai/models.ts)

The Session chooses the Agent, prompt, allowed tools, and collaboration policy. The coding-agent binding submits prompts and steering messages, applies provider settings, and converts direct completions into text, usage, and an outcome. An abort signal follows the request to the provider. Session identity, transcripts, and workflow transitions stay with their current owners. [Coding-agent binding](../../packages/pi-ai/coding-agent.ts) · [Turn inputs and results](../../packages/pi-ai/turn.ts)

The host admits MCP servers and chooses which connections travel through the laptop. Pi-AI starts discovery, binds tools to a root session, handles MCP commands, and closes connections. The remote model binding carries the catalog and provider stream across the existing connection. [MCP interface](../../packages/pi-ai/mcp.ts) · [Remote model binding](../../packages/pi-ai/remote-models.ts)

## Session Runtime and the Factory worker

The interactive Session Runtime owns the live session, its writer, queued messages, subscriptions, and pending interactions. TUI, ACP, and Workspace use the same implementation. Clients call `createSession` to open a new Session, optionally selecting its initial agent. For a local project, `resumeSession` accepts either the stable RunWield Session ID or the Pi transcript ID and returns the reopened Session with its replay events. Omitting the ID selects the most recent unarchived Session. If none is available, the call returns `null`, so the TUI can start a new Session. [Session contract](../../packages/session-runtime/contract.ts)

The root factory opens the personal session store by default. Interactive hosts use the services entry when they need to compose storage or run host-specific operations. Browser clients can load the event and interaction contracts independently. The transcript entry exposes the existing history readers. The file store, Pi session construction, and some workflow integrations still live in `src/` until the dependency pass. [Interactive services](../../packages/session-runtime/services.ts) · [Events](../../packages/session-runtime/events.ts) · [Interactions](../../packages/session-runtime/interactions.ts) · [Transcripts](../../packages/session-runtime/transcript.ts)

A Factory worker can use pi-durable to execute or resume a turn while reusing the RunWield model registry, effective Agent prompts, tool definitions, and Workflow rules. For the Router recipe, the worker accepts the admitted input through ACP and returns the accepted `triage_report`. That operation needs neither an interactive session host nor a UI subscription. The pi-durable execution adapter and pod-recovery qualification are future Factory work.

## ACP connections

The ACP package connects clients and servers over caller-supplied byte streams. Client apps import `@runwield/acp/client` to register their ACP handlers and send typed SDK requests. The protocol entry exposes wire validation and RunWield extension codecs. [Client binding](../../packages/acp/client.ts) · [Protocol](../../packages/acp/protocol.ts)

The server binding translates requests and Session Runtime events and owns the ACP IDs and outstanding prompts for each connection. The CLI wires in the interactive runtime and its local services, opens stdin and stdout, handles signals, and releases the resources it opened. [Server binding](../../packages/acp/server.ts) · [CLI entry](../../src/cmd/acp/index.ts)

## MCP and app boundaries

Keep built-in tools usable through direct calls. For MCP today, the Session owns authorized connections and Pi owns
discovery, invocation, result conversion, reconnect, and shutdown. Retain that arrangement as a Pi integration module.
If RunWield later exposes built-in tools _as an MCP server_, that adapter can import Tools and expose the selected
catalog. Introducing that server is a separate feature. [Existing MCP ownership decision](../adr/018-pi-owned-mcp-integration.md).

| App or entry point  | How it consumes packages                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI                 | Uses Session Runtime in process. Renders events and supplies interactive routing and input.                                                                                              |
| Desktop & Workspace | The desktop direction uses the ACP client to reach its runtime. Preserve the current Workspace adapter during its extraction.                                                            |
| SaaS                | Target hosted workspace service binds an authenticated Project to the runtime. Browser clients talk to the service.                                                                      |
| Factory and Worker  | Factory remains the Go controller and Kubernetes API client. It starts the worker and invokes its ACP contract. The TypeScript worker composes the packages and selects output behavior. |
| ACP                 | The runnable server behind `wld --mode acp` wires stdio, configuration, Session Runtime, and the ACP server binding. Client apps can import the ACP package independently.               |

Two existing consumers also need compatibility coverage. **The CLI** includes noninteractive commands for Plans and
other project operations. **Connect** invokes RunWield from an external agent host and already consumes normalized
triage and workflow operations. Give both callers a place in the extraction tests even if neither changes directory.
[Connect architecture](../adr/013-attached-workflow-coordination-boundary.md).

## Storage and other shared concerns

Drivers are implementation modules of the domain that owns the data. Extract the shipping driver and its readers
first. Track new drivers in follow-up implementation work so each package move can be verified against existing data.

| Owner                              | Existing behavior to preserve during extraction                                                                                                                                                                                                          | Driver direction after extraction                                                                                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects                           | Preserve Core project identity admission, checkout bindings and the existing Workspace registry.                                                                                                                                                         | Keep the Projects API independent of the Plan storage driver. Hosted identity persistence can evolve behind that API.                                                                                                                                     |
| Plans                              | Personal Markdown Plans, existing metadata and revision rules, Work Records, related artifacts, and repository delivery copies. Preserve the merged external store, including managed-remote owner selection, canonical revisions and checkout identity. | Local Markdown/filesystem driver and hosted PostgreSQL driver expose the same Plan, lifecycle, Work Record, and artifact operations.                                                                                                                      |
| Workflow                           | Existing checkpoints, accepted event history, pending actions, and publication receipts.                                                                                                                                                                 | Keep the personal file-backed driver. SQLite is an option for transactional worker checkpoints. A hosted PostgreSQL driver records event acceptance, next state, and pending effects together. Workflow remains the sole transition owner across drivers. |
| Session Runtime and Pi integration | Existing Session bundles, transcripts, restore behavior, and the factory's current operation receipts.                                                                                                                                                   | Session Runtime owns session identity and history. A later Pi Durable worker can reopen its execution journal on its PVC. Pin the harness version and reconcile external writes using the existing effect receipts.                                       |

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
