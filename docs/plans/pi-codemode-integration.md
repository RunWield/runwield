---
planId: "c4eb1eb7-e3b6-46f4-8cd2-28d6815ff711"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "package.json"
    - "bun.lock"
    - "src/shared/session/session.js"
    - "src/shared/mcp/integration.ts"
    - "src/tools/registry.ts"
    - "scripts/compile-bun.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-02"
origin: "internal"
status: "ready_for_work"
userVerifiedAt: null
---

# Integrate Pi codemode into RunWield

## Context

The request is to implement Pi 1.0's codemode in `wld`. Codemode lets an Agent use JavaScript to combine tool calls,
process their results, and return only useful output to the model. RunWield already pins Pi 1.0.4; it does not load
the public codemode extension. The earlier MCP migration deliberately left this feature for separate work.

The owning capability is [Core: Agent and skill customization](../prd/runwield-core-prd.md#agent-and-skill-customization).
This Plan proposes a named codemode requirement and acceptance scenarios there. Preserve Trusted MCP tools, layered
Agent definitions, delegated/validation tool ceilings, and [Session continuity](../prd/runwield-core-prd.md#session-continuity)
where applicable. Codemode is proposed behavior until implemented and verified.

Repository evidence:

- `src/shared/session/session.js` builds the real Pi AgentSession, installs extension factories, resolves allowed tools,
  binds extensions, and selects active tools. Its MCP-root exclusion list currently includes `codemode`.
- `src/shared/mcp/integration.ts` keeps MCP connections in a separate Session-owned SDK host. It forces direct exposure
  and disables automatic codemode activation. `bindRoot()` forwards definitions and enforces the root Agent's policy.
- `src/shared/session/bridged-tools/mcp-bridge.ts` gives external CLI tools a context that rejects nested execution.
  Simply advertising codemode through that bridge would produce a broken tool.
- `scripts/compile-bun.ts` embeds existing workers and WASM assets, but has no codemode worker entrypoint. Pi resolves
  its own worker path and QuickJS WASM lazily, so source success alone does not prove the shipped executable works.

### Verified upstream research

Online research succeeded on 2026-11-02. The installed version remains **1.0.4**; upstream released **1.5.0** on
2026-11-02. The following evidence uses release tags, not upstream HEAD:

- [Pi 1.3.0](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md) fixes Bun codemode
  cancellation waiting for non-interruptible work and limits surviving workers across Sessions.
- [Pi 1.4.0](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md) queues scripts when
  workers are occupied instead of failing immediately.
- [Pi 1.5.0](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md) improves codemode
  discovery and declaration size, fixes failed Session writes corrupting subsequent history, and changes tool argument
  validation to `pi-schema`.
- The [1.5.0 SDK guide](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sdk.md#codemode-mcp)
  still requires SDK hosts to register and activate `createCodemodeExtension()` explicitly. The
  [1.5.0 codemode reference](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/codemode.md)
  documents branch-local successful-script stores, presentation settings, and worker limits.

These sources establish the recommended API and behavior; they do not prove compatibility with RunWield's packaged
runtime. No dependencies have been changed during planning.

## Objective

Agents executing through Pi can run real codemode scripts against their existing authorized tools, including root MCP
tools, with Pi's output, cancellation, discovery, and branch-aware store behavior. The feature works in source execution
and packaged Bun builds. It does not grant extra filesystem, shell, MCP, or workflow authority.

## Approach

Load Pi's public `createCodemodeExtension()` in each actual executing Pi AgentSession. Keep the Session-owned MCP host
responsible only for MCP connection lifetime. Registering codemode there would give scripts the wrong tool inventory,
transcript, and Agent identity.

```text
RunWield Agent policy
  → executing Pi AgentSession + codemode extension
    → Pi executeTool pipeline
      → allowed RunWield tools and authorized root MCP definitions
```

Use the upstream extension and runtime rather than building another JavaScript interpreter, tool dispatcher, discovery
catalog, or store. Preserve RunWield's policy resolution, tool events, transcript ownership, and model/auth runtime.

### Pi version choice

**Accepted decision:** upgrade the coordinated Pi package set to exact **1.5.0** as the first implementation step,
including schema/SDK compatibility work and regression checks. Its Bun cancellation and worker admission fixes directly
support this feature's verification requirements. Staying on 1.0.4 would leave those known defects in the runtime being
integrated.

Upgrade the direct `pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-mcp`, and `pi-tui` pins and matching
overrides in `package.json`; align transitive `pi-codemode` and `pi-telemetry` and regenerate the root `bun.lock`.
Inspect the resulting graph for obsolete overrides such as `chord`, rather than inventing matching package versions.
The [1.5.0 coding-agent manifest](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/package.json)
pins its Pi dependencies exactly. Preserve the separate docs lock and do not install the legacy Deno graph.

Compatibility work is required:

- **Schema validation and typing:** the [1.5.0 pi-ai migration](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/CHANGELOG.md)
  removes TypeBox re-exports from its main entry, changes `StringEnum()` typing, and applies JSON Schema coercion to
  plain schemas too, including MCP. TypeBox-only refinements/codecs no longer run; validation messages also change.
  Inventory RunWield tool schemas and imports, retain compatible TypeBox schemas, and explicitly preserve any required
  validation that is outside JSON Schema. Do not assume Pi's extension-loader compatibility mapping covers ordinary
  RunWield SDK imports, or convert every schema without need.
- **SDK boundaries:** [1.5.0 AgentTool typing](https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/CHANGELOG.md)
  changes parameter inference for some TypeBox kinds. Verify custom tools, registered extensions, model streams,
  model/auth/usage adapters, and Session resume/fork under the aligned graph. Keep named project types and existing
  authority checks; passing compilation alone is not compatibility proof.
- **Worker lifecycle and delivery:** [codemode's 1.3.0 change](https://github.com/earendil-works/pi/blob/v1.3.0/packages/codemode/CHANGELOG.md)
  separates settled script results from actual worker exit. Reuse upstream admission control; a cancelled Bun worker
  can occupy capacity until it exits. The [1.5.0 worker export](https://github.com/earendil-works/pi/blob/v1.5.0/packages/codemode/package.json)
  is public, but the extension exposes no worker-path option. Qualify actual worker/WASM resolution in the compiled
  artifact before claiming the upgrade solves packaging.

### Activation and presentation

**Accepted decision:** make codemode available alongside existing tools for Pi-backed root Agents. Keep delegated and
isolated Agents' explicit tool ceilings; they may receive codemode only when their effective definition grants it, and it can
never recover an excluded tool. Keep workflow advancement tools directly available. Honor Pi's `codemode.mode` and
`codemode.inlineBudget` through RunWield's settings layer, with documented precedence and no separate `.pi` state.

MCP tools remain directly exposed as today and are also callable from codemode. Migrating MCP configuration to deferred
exposure or adding `tool_search` is separate work; neither is required to compose and filter existing MCP calls.

### Execution backend coverage

**Accepted decision:** cover Pi-backed execution first across TUI, Workspace, and ACP. External CLI backends retain their
existing direct tool bridges. They do not receive a nonfunctional codemode declaration. RunWield Connect leaves the
external host's tool loop under that host's control.

Keep Pi's native script globals, including discovery, `store`/`load`, output helpers, and non-chat model capabilities.
Classifier/image calls must use the configured RunWield model/auth runtime and preserve usage accounting. Existing
`create_image` remains available under its normal policy. No new image UI or classifier product workflow is proposed.

### Runtime delivery

Use the upstream worker and QuickJS runtime. Inspect the actual public exports and bundling behavior before choosing
asset wiring; do not rely on private deep imports being supported. If the installed public surface cannot support
RunWield's packaged runtime, report that concrete limitation and revise the Plan instead of silently copying a runtime
or patching installed dependencies. Package qualification must execute a script with no development checkout nearby.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/session.js` and focused session support modules — extension registration, activation, authorized
  callable inventory, prompt projection, and persistence through ordinary Session continuation.
- `package.json`, root `bun.lock`, and affected Pi SDK/schema consumers — align Pi 1.5.0 dependencies and repair
  demonstrated compatibility differences without broad schema or UI rewrites.
- `src/tools/registry.ts`, effective Agent policy resolution, and relevant Agent guidance — availability and the
  distinction between composable capability calls and workflow decisions.
- `src/shared/mcp/integration.ts` — ensure root binding and tool updates preserve codemode availability and ceilings;
  retain one connection host and direct MCP exposure.
- Existing settings readers and user configuration documentation — expose the accepted activation policy and Pi's
  presentation settings without a second configuration authority.
- Session tool events, transcript and usage integration — only changes needed for truthful nested-call presentation,
  existing workflow events, and codemode model usage; preserve existing surface patterns.
- `scripts/compile-bun.ts`, runtime asset initialization, and package qualification — worker/WASM shipping and runtime
  resolution independent of `node_modules` in a developer checkout.
- Focused tests near session policy, MCP integration, persistence, and packaging — execute the real extension and sandbox.
- `docs/prd/runwield-core-prd.md`, `docs/user-documentation/mcp.md`, relevant customization documentation,
  `docs/domain-language.md`, and `docs/adr/0019-pi-owned-mcp-integration.md` — align behavior, terminology, and ownership.

## Reuse Opportunities

- Pi `createCodemodeExtension()` and its normal `ctx.executeTool()` pipeline supply script execution, tool discovery,
  error/output semantics, and transcript-backed `codemode-store` entries.
- `buildAgentSession()` and `resolveEffectiveSessionToolNames()` already establish per-Agent authority.
- `McpIntegration.bindRoot()` already forwards live MCP definitions across replaceable root Agents.
- Existing SessionManager branches and Session bundles own durable history; no parallel codemode database is needed.
- Existing fixture MCP servers, process-global test lock, isolated runner, and packaged runtime qualification provide
  real boundaries without new seams for RunWield-owned machinery.

## Implementation Steps

1. The Pi dependency graph resolves consistently to exact 1.5.0 and RunWield's SDK imports,
   schema validation, tool parameter types, model/auth adapters, and existing Session behavior pass focused compatibility
   checks. Any plain-schema coercion difference is documented and tested; invalid lifecycle inputs still cannot advance
   a workflow. Pi 1.5.0 and its verified runtime limits are reflected in the final user documentation.
2. The accepted activation policy resolves once through existing Agent/session policy. Real Pi sessions register and
   activate the public codemode extension when authorized, with or without MCP servers. Settings precedence and custom
   Agent opt-in/disable behavior are explicit and tested. External backends expose only supported capabilities.
3. Scripts discover and execute exactly their current callable tools. Read-only Agents cannot invoke writes or shell
   commands excluded by policy; isolated/delegated Agents do not inherit root MCP connections. Late MCP discovery,
   withdrawal, reconnect, and root Agent replacement preserve both availability and restrictions.
4. Authorized nested tool calls travel through Pi's tool pipeline and RunWield's existing guards and event ownership.
   Workflow advancement tools use Pi's public `model-only` exposure: they remain direct calls and cannot be batched
   inside scripts, including in `only` mode. This preserves the existing one-decision/turn boundary rather than adding
   workflow concurrency. Cancellation and errors cannot create duplicate lifecycle transitions or claims that
   previously completed external effects were rolled back.
5. The real upstream sandbox supports parallel awaited calls, filtered output, discovery, errors with partial output,
   timeout/cancellation, and successful-script store persistence. Resume/fork sees only entries on its branch. Failed
   scripts do not commit pending store writes. Results preserve text, structured content, and images.
6. Non-chat model globals use configured credentials and runtime capabilities. Their returned usage remains visible in
   Session cost/usage accounting without double-counting nested ordinary tool usage. Unsupported model capabilities
   return honest errors; scripts cannot run chat-model turns or recursively start codemode.
7. Source execution and shipped Bun artifacts resolve the actual upstream worker and QuickJS WASM. Package tests run
   from a disposable directory and HOME without relying on repository files, developer `node_modules`, or `.pi` state.
8. Focused behavioral regression tests execute scripts and real tool calls, including a real local MCP fixture. New
   tests enter the explicit runner inventory where required; no RunWield-owned injection seam is introduced.
9. The owning Core capability and acceptance scenarios describe the delivered activation and backend coverage.
   Documentation includes a small working script, settings, output/error behavior, and tool authority. The glossary
   defines Codemode consistently. ADR-0019 preserves MCP lifetime ownership and replaces its blanket codemode deferral
   with the accepted integration boundary; unrelated HTTP/OAuth and manager UI remain deferred.

## Approval Confirmation

No Work Record supersession is proposed. No unanswered Plan questions remain: the owner accepted the Pi 1.5.0 upgrade
with schema/SDK compatibility work and regression checks, alongside-tools activation, and Pi-backed-only execution
coverage. This Plan does not authorize commits, pushes, or publication: the owner's standing instruction requires an
explicit request for those.

## Verification Plan

- Use Bun 1.4.3 and run `bun run install:locked` before checks. Do not install the legacy Deno dependency graph.
- Run focused cases with `bun scripts/run-tests.js <changed-test-paths>`. Include existing
  `src/shared/session/__tests__/session-tools-policy.test.js`, `src/shared/session/agent-switching.test.js`, relevant MCP
  integration tests, new codemode behavioral tests, and `scripts/compile-bun.test.ts` when packaging changes.
- Run `bun run seams:check` and `bun run fmt:check <changed-files>` with explicit paths. Core owns the full CI gate.
- **Upgrade compatibility:** inspect the resolved Pi graph for aligned 1.5.0 pins, then exercise real
  RunWield custom-tool and MCP schemas with missing fields, invalid types, numeric strings, scalar-to-array inputs,
  and any non-JSON-Schema constraints found in the inventory. Assert the arguments the handler receives and absence of
  effects for rejected calls, through both direct and nested paths. Cover model stream/auth/usage adapters, extension
  loading, MCP reconnect, and pre-upgrade Session resume/fork with disposable fixtures. Preserve existing behavior
  assertions while updating only deliberately changed validation text/coercion expectations.
- **Positive proof:** one script awaits two real allowed tool calls, filters their results, and emits a computed answer.
  Assert each tool's observed side effect/call record and the final filtered output. A stub codemode implementation or
  an extension that is registered but never callable must fail this case.
- **Policy proof:** execute a forbidden write/shell call from a restricted Agent and verify no filesystem/process
  effect. Compare discovery to callable permissions. Verify no MCP tools appear or execute in an isolated Agent.
- **MCP proof:** call a fixture server from codemode; preserve structured results and error flags, then exercise tool
  removal/addition and root replacement without duplicate connection processes or restored forbidden tools.
- **Lifecycle proof:** scripts cannot discover or invoke model-only workflow advancement tools; direct calls still
  obey existing acceptance/consume-once guards in both presentation modes. Cancellation cannot repeat an accepted
  workflow event. Ordinary nested capability calls retain canonical tool-call identity.
- **Persistence proof:** store a value, resume the real SessionManager branch, and read it; fork before the store and
  verify absence. A failing script's new value must remain absent. Use disposable Session files.
- **Failure/output proof:** cover partial output before failure, deadline/abort cleanup, a subsequent successful script,
  structured content, and image output. Validate the upstream output limits without duplicating its whole test suite.
- **Worker capacity proof on 1.5.0:** concurrent scripts beyond the default two-worker capacity wait and then execute
  when a slot opens. Aborting or timing out a queued script must not run its tools. Repeated cancellation must retain
  capacity accounting until actual worker exit; a settled result alone is not evidence that its worker exited.
- **Model proof:** use the existing external-model test boundary to assert configured runtime/auth dispatch and truthful
  usage for one classifier or image call; no live paid model call is required for the automated suite.
- **Packaged proof:** extend `scripts/check-bun-package.ts` or the existing equivalent qualification path with a
  deterministic codemode script that invokes an allowed local tool. Run the compiled artifact outside the checkout.
  Merely building the binary or running `--help` is insufficient.
- **Manual:** in a Pi-backed Session, ask for a parallel read-and-summarize operation, inspect nested tool activity and
  filtered output, cancel a long script, then run another. Repeat Session continuation. For retained external CLI
  backends, confirm ordinary bridged tools still work and no unusable codemode tool is advertised.
- Preserve existing MCP trust, minimal stdio environment, remote transport ownership, shell limits, Agent restrictions,
  workflow transitions, and Session continuation coverage. The intentional change is codemode's accepted availability;
  no previous tool-authority restriction is retired.
- Confirm owning PRD scenarios, ADR, user docs, and glossary describe tested behavior together; leave unimplemented
  backend coverage explicitly deferred rather than claiming parity.

## Edge Cases & Considerations

- A script can complete external effects before failing. Preserve Pi's honest partial-output and no-rollback semantics.
- `codemode.mode: only` changes declarations, not authority. Workflow tools must remain reachable according to their
  declared exposure and accepted workflow constraints; do not hide required guidance accidentally.
- RunWield's custom prompt projection must match the effective loadout rather than advertising tools scripts cannot use.
- The separate MCP host never owns codemode store entries; executing Session transcripts do.
- Packaged worker/WASM availability is a delivery requirement, not optional follow-up work.
- Source/type style follows AGENTS.md: new production code is TypeScript, with named shapes and no new `any`, `unknown`,
  or `object` annotations. Existing unrelated JS need not be converted.
- The Pi 1.5.0 upgrade includes the required compatibility work and regression checks. No frontend redesign, new MCP
  transport, unrelated dependency upgrade, or host-owned Connect tool-loop replacement is proposed.
