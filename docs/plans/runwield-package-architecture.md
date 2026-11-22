---
classification: "PROJECT"
complexity: "HIGH"
affectedPaths:
    - "packages/"
    - "src/agent-definitions/"
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

The first review is the public Tools interface on top of the merged external Plan Store. Pause for interface review before extracting Agents. The remaining order is proposed. Each row is an independently shippable extraction. Create its directory and workspace
entry when its first real consumer moves. Export named types alongside the operations that own them.

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
[Core identity](../../src/shared/project-identity.ts), [owner registry](../../src/shared/owner-coordination/projects.ts), [Plan Store entry point](../../src/plan-store/index.ts), and [external Plan Store Epic](external-plan-store.md).

**Settings, credentials, and memory** also need explicit owners. Apps resolve project settings and credential
references at startup, then give each consumer the access it needs. Keep credential refresh with its designated
writer. Mnemoteca remains the owner of cross-run memory, reached through explicit memory tools. A shared memory
server, GitHub App authentication, hosted tenancy, and unattended prompt changes are follow-up features.

## Acceptance for each extraction

- Identify the domain's current entry points, consumers, saved formats, and relevant regression tests. Record the
  current behavior at the app boundary before moving implementation.
- Add one private workspace package and its public exports. Migrate active callers in the same change. Check
  imports for cycles and app internals. Include package code, tests, and assets in the existing build and CI inventory.
- Run the affected consumers through their normal entry points. Check CLI and wire output, tool results, prompt
  resolution, event order, on-disk compatibility, and process/pod recovery wherever the move touches those contracts.
  A behavior difference is a regression to fix before starting the next extraction.
- Qualify PostgreSQL, Pi Durable, new unattended loops, and app directory moves in their own changes. Define their delivery criteria with the relevant domain and factory work.
