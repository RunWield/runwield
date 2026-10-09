---
planId: "eca2ba1e-32ca-4e5a-bed5-dc579b81e0a2"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "HIGH"
affectedPaths:
    - "deno.json"
    - "deno.lock"
    - "src/shared/session/session.js"
    - "src/shared/session/named-invocation.ts"
    - "src/shared/settings.js"
    - "src/shared/workflow/workflow-results.js"
    - "src/shared/session/session-runtime.test.js"
    - "src/shared/session/session-temperature.test.js"
    - "scripts/compile.js"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-22"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "441519de997038c5227aeb9842cfc3e060a93d2d"
workRecord:
    status: "generated"
    recordId: "eadeaf2f-0c2e-409f-8233-724d929d8e04"
    path: "docs/work-records/2026-09-24-pi-0-87-compatibility-upgrade.md"
    lastAttemptAt: "2026-09-24T17:08:32.253Z"
archivedAt: "2026-09-27T16:37:28.736Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/upgrade-pi-087-api-compatibility.md"
---

# Upgrade Pi to 0.87 with API compatibility

## Context

Upgrade the four direct `@earendil-works/pi-*` packages from 0.85.1 to 0.87.0, the latest published release checked
during planning. The earlier version-only attempt exposed 28 type errors. Upstream release notes also identify runtime
changes that type checking alone will not catch. The checkout returned to 0.85.1 before planning; do not assume that the
earlier attempt left either the manifest, installed packages, or lockfile upgraded.

The owner chose to keep prompt-cache warming **off**. Exposing warming as a user setting is deferred; the owner will
track that TODO. Do not add the setting or its UI in this change.

Owning Core requirements and preserved scenarios:

- [Models and providers](../../prd/runwield-core-prd.md#models-and-providers): **Change models without losing Session or
  workflow context.** Preserve selection, authentication, custom providers, and Agent-specific options.
- [Agent and skill customization](../../prd/runwield-core-prd.md#agent-and-skill-customization): **Respect user
  customization while retaining workflow capabilities.** Skill instructions must reach the model; required tools and
  precedence stay intact.
- [Session continuity](../../prd/runwield-core-prd.md#session-continuity): **Continue the same saved work across
  clients.** Preserve saved history, Agent/model choices, and continuation without replaying earlier actions.
- [Compaction and image context](../../prd/runwield-core-prd.md#compaction-and-image-context): **Retain useful
  conversation and attachment context.** Preserve instructions and images through compaction and resume, including
  compiled releases.
- [Execution, validation, and recovery](../../prd/runwield-core-prd.md#execution-validation-and-recovery): preserve
  accepted workflow decisions and recovery behavior. Transcript output remains evidence, not transition authority.

Proposed product addition: under Models and providers, state that automatic prompt-cache warming is disabled in Core;
this upgrade must not add warming requests or charges. No existing requirement is removed. Other changes implement
compatibility, not new user workflows. Preserve the current meanings of Session, Session Transcript, Named Invocation,
Prompt Template, Skill, and Workflow Tool Event in [domain language](../../domain-language.md).

Evidence: upstream
[coding-agent changelog](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/CHANGELOG.md),
[AI changelog](https://github.com/earendil-works/pi/blob/v0.87.0/packages/ai/CHANGELOG.md), and
[Agent changelog](https://github.com/earendil-works/pi/blob/v0.87.0/packages/agent/CHANGELOG.md). These are references,
not external Tickets. Planning compared tagged source with local 0.85.1; the proposed 0.87 runtime fixes have not been
run.

## Objective

RunWield uses Pi 0.87.0 with matching dependency resolution and preserves its current Session, tool, workflow, and
release behavior. Tests must observe actual provider requests and persisted context, not only public type names or Agent
state. Cache warming stays off without changing the user's stored settings.

## Approach

### Request context

Pi still accepts `Context` at public request methods such as `ModelRuntime` requests and `/compat` `completeSimple`.
Provider callbacks and `Agent.streamFunction` now receive branded `TranscriptContext` instead:

```text
Before: provider receives { systemPrompt, tools, messages }
After:  provider receives { messages } with system/tool changes in transcript order
        getCurrentSystemPrompt(messages)
        getCurrentTools(messages)
```

Use `normalizeContext` when tests call the streaming boundary directly. Keep public request callers, including
`src/tools/see-image.ts`, on the appropriate public input type. Update explicit callback annotations as well as inferred
ones: a callback annotated with the old `Context` can still compile while reading absent optional properties.

`applySessionTemperature` must forward the full transcript unchanged on the first attempt and any supported retry.
Retain model exclusions, configured-temperature precedence, option forwarding, and remembered capability failures. Do
not rebuild a shorthand Context and duplicate system messages. Keep the existing ModelRuntime and credential owner.

### Named Invocation context

Pi 0.87 rebuilds provider and compaction context from SessionManager. The current
`applyNamedInvocationExpansionToPiSession` changes only `agent.state.messages`; that no longer supplies future requests.
Use Pi's append-only context edits within the existing Named Invocation write path:

```text
withNamedInvocationDisplayMessage intercepts the user append
  append existing runwield.named_invocation metadata
  append compact user message -> userEntryId
  appendContextEdit(userEntryId, { content: originalExpandedContent })
  return userEntryId
Pi builds provider and compaction context from the saved entries
```

Capture the original incoming content, including Pi-normalized images and image hints. Append the edit before returning
from the intercepted append, not after the turn or in `message_end` (which precedes Pi persistence). Keep raw history
and existing cross-surface display behavior unchanged. In particular, do not change how Prompt Template display differs
from Skill display today.

For old Sessions, replace Agent-state-only restoration with an idempotent compatibility helper at writable activation,
before `createAgentSession`, or followed by public `refreshContext` if an AgentSession already exists. Match metadata to
the user entry by branch order/entry relationship, not matching slash-command text. Read metadata from the full active
branch, but edit only user targets retained in current context. Metadata can precede the compaction kept boundary.
Respect existing applicable edits, including omissions and later replacements. Do not restore summarized-away messages
or borrow edits from sibling branches. Reopening the same Session must not append duplicates. Do not mutate Sessions
while listing or rendering history.

This follows [ADR-015](../../adr/015-file-authoritative-session-bundles.md): Pi files remain authoritative, and all
writes use the existing Session Writer Lock. A request-only rewrite was set aside because compaction also needs the
exact saved expansion; maintaining two restoration paths would risk divergence.

### Result types and warming policy

Narrow JSON-compatible tool-result details before reading fields. Preserve the compatibility readers' existing search,
default, metadata, image, and outcome behavior. Accepted Workflow Tool Events remain the sole transition authority; do
not route workflows from these readers as part of this fix.

Pi 0.87's `getCacheWarmingMode()` reads global settings directly and defaults to `streaming`.
`applyOverrides({ cacheWarming: "off" })` does not affect that getter, and the warming setter writes to disk. Apply one
fixed runtime policy when RunWield creates each SettingsManager: make its public `getCacheWarmingMode` return `off`
before any AgentSession is created. Document this narrow version-specific override. It must survive reload and must not
alter stored configuration. Do not add private-field access, a configurable test hook, or a new settings framework.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `deno.json`, `deno.lock` — upgrade the four Pi mappings together and resolve their required transitive dependencies.
- `src/shared/session/session.js`, `named-invocation.ts` and their tests — preserve normalized streaming input and use
  canonical context edits instead of Agent-state mutation for saved expansions.
- `src/shared/settings.js`, `settings.test.js` — disable cache warming at runtime without persisted settings changes.
- `src/shared/workflow/workflow-results.js`, `workflow-results.test.ts`, `workflow.test.js`, and
  `validation-loop-delivery.test.js` — narrow JSON details and use complete, correctly typed message fixtures.
- Provider-facing tests in `src/shared/session/`, `src/cmd/load-plan/`, and `src/shared/workflow/` — update prompt/tool
  observations. Includes `session-runtime.test.js`, `skill-catalog.test.ts`, `orchestrator.test.ts`, and
  `plan-execution-runtime-boundaries.integration.test.ts`.
- `src/acp/server.test.js`, `src/cmd/guided-review/index.test.ts` — adapt exact Faux usage estimates to
  transcript-ordered system messages and tool additions/removals; do not weaken exact usage checks.
- `src/shared/session/session-context-resilience.test.js`, compaction and re-anchor tests — characterize the new
  boundary hooks truthfully while retaining current behavior coverage.
- `scripts/compile.js`, `scripts/compile.test.js`, existing compiled-image checks — verify packaging after Pi's native
  clipboard change, adding reachable assets only where needed. Preserve the image worker and Photon WASM packaging.
- `docs/prd/runwield-core-prd.md` — add the warming requirement/scenario and clarify preserved upgrade acceptance.
  `docs/adr/015-file-authoritative-session-bundles.md` — clarify append-only context edits versus unchanged raw history.
  Update affected references only. No new domain term or glossary redefinition is required.

No browser redesign, backend replacement, Pi fork, broad dependency refresh, new cache-warming UI, or new long-run
recovery design is in scope. Inspect model/catalog changes for compatibility; do not invent replacement model-selection
policy or retain removed catalog entries artificially.

## Reuse Opportunities

- `withNamedInvocationDisplayMessage`, existing metadata payload/readers, and Pi `appendContextEdit` — retain exact
  expansion evidence without a second storage format.
- `src/cmd/testing/runtime-command-fixture.ts` and Pi Faux providers — observe requests through real AgentSession and
  ModelRuntime without paid network calls.
- `src/testing/process-global-lock.ts` and existing Session fixtures — isolate HOME/cwd and use real persisted managers.
- `src/shared/workflow/workflow-tool-events.ts` — retain accepted event ownership and consume-once decisions.
- Release workflows already use `deno cache scripts/compile.js src/cli.ts` — refresh the selected dependency graph
  rather than resolving every frontend import with `deno install`.

## Implementation Steps

1. **Dependency resolution is consistent.** All four direct Pi imports use `^0.87.0`; the lockfile and installed graph
   resolve 0.87.0, including the compatible Pi telemetry dependency. Use the existing cache entry points and check the
   lockfile diff for unrelated upgrades. Do not hand-edit integrity hashes or bypass lock verification. If a newer Pi
   release appears, report it rather than silently expanding this approved API target.
2. **Provider boundaries use the correct context contract.** Production streaming wrappers and Faux callbacks consume
   TranscriptContext where required. Tests inspect effective prompts/tools through Pi helpers, including a later system
   update. Public Context callers remain supported. Temperature retry preserves context and unrelated request options.
   JSON result readers safely handle missing/scalar/array details; complete fixtures replace incomplete message casts.
   Do not add broad casts, `any`/`unknown`/`object` TypeScript declarations, or suppression comments to hide errors. Use
   named JSDoc typedefs for changed JavaScript shapes.
3. **Named Invocations survive Pi's canonical context rebuild.** New invocations persist compact raw input plus the
   exact expanded-content edit targeting its user entry. Existing saved invocations acquire missing edits during
   writable activation only. First requests, follow-ups, resume, branch isolation, retained compaction entries, repeated
   commands, and images all use the correct expansion. Existing edits take precedence and repeated activation adds no
   duplicate edits. Remove the obsolete Agent-state-only restoration path. Other Execution Backends keep their existing
   behavior.
4. **Warming is disabled for every RunWield-owned Pi AgentSession.** Root and auxiliary/isolated Sessions use managers
   with the fixed off policy, including after reload. Existing global/project warming values are not rewritten. A
   controlled eligible long-tool scenario makes no warming provider request or warming usage entry.
5. **Integration and release behavior remain compatible.** Exact usage estimators match Pi's new transcript serializer.
   Existing compaction, re-anchor, Agent-switch, completion, cancellation, and tool-authority tests retain their
   assertions. Replace obsolete hook-name expectations with truthful 0.87 capability characterization, not a new
   recovery implementation. Verify reachable native clipboard helpers under the compiled layout; include required assets
   by compile target where needed. Image resize worker/WASM behavior stays intact.
6. **Product and architecture documents match the result.** Core's Models and providers capability states warming is off
   and includes a no-warming-request scenario; the user setting stays explicitly deferred. Relevant customization,
   continuity, and compaction scenarios cover saved expansions and active prompts/tools. ADR-015 explains canonical
   context edits without changing raw transcript or lock authority. No unrelated PRD rewrite or claim that all deferred
   Session resilience work shipped is permitted.

## Approval Confirmation

No Work Record supersession is proposed. Approval covers the 0.87.0 compatibility changes and the owner's explicit
warming-off decision, not a new user setting or a redesign of Session recovery.

## Verification Plan

### Automated checks

Run tests only through the sandboxed repository runner. Use `getHomeDir`/`getCwd`; tests that mutate process state must
use `withProcessGlobalTestLock`. Do not add injection points for RunWield-owned persistence or transitions.

```sh
deno cache scripts/compile.js src/cli.ts
deno task check
deno run -A scripts/run-tests.js --isolated src/shared/session/session-temperature.test.js src/shared/settings.test.js src/shared/session/named-invocation.test.ts src/shared/session/named-invocation-active-segment.integration.test.ts src/ui/named-invocation-cross-surface.integration.test.ts
deno run -A scripts/run-tests.js --isolated src/shared/session/session-runtime.test.js src/shared/session/skill-catalog.test.ts src/shared/session/session-context-resilience.test.js src/extensions/re-anchor/index.test.ts src/cmd/load-plan/index.integration.test.ts src/shared/workflow/plan-execution-runtime-boundaries.integration.test.ts src/shared/workflow/orchestrator.test.ts
deno run -A scripts/run-tests.js --isolated src/shared/workflow/workflow-results.test.ts src/shared/workflow/workflow.test.js src/shared/workflow/workflow-tool-events.test.ts src/shared/workflow/validation-loop-delivery.test.js src/acp/server.test.js src/cmd/guided-review/index.test.ts scripts/compile.test.js
```

Include any new focused test file in these runs. Run the existing model/auth and image suites when their boundary is
changed. RunWield performs full CI after implementation; these commands are the focused evidence, not a substitute.

### Required distinguishing evidence

- **Provider payload:** a real AgentSession/Faux request after an Agent or tool change contains the current nonempty
  system prompt, required tools, and no obsolete tools. Exercise a later system message, not only the first one. A
  pass-through old Context reader must fail this check.
- **Temperature:** a normalized transcript with prompt changes, tool declarations, and messages reaches first and retry
  calls unchanged; temperature alone changes on an exact capability rejection. Preserve option/signal forwarding,
  single-start behavior, exclusions, and cached rejection knowledge. Verify error/cancellation does not become success
  or cause an extra retry after content. Report unrelated pre-existing retry defects separately rather than folding in a
  retry-system redesign.
- **Named Invocation:** through actual request dispatch, assert exact expanded text and image blocks in the first model
  request and a subsequent follow-up. Close and reopen a file-backed Session, send again, and assert the expansion is
  unchanged and old actions are not executed. Raw user history remains compact, saved payload unchanged, and existing
  Skill/Prompt Template display assertions still pass. Repeating the same command targets distinct user entry IDs.
- **Legacy and compaction:** construct 0.85-style metadata/user entries with no edits; include a retained user entry
  whose metadata is outside the kept range. Assert both real provider input and Pi compaction preparation see the
  expansion. Verify latest existing replacement/omission wins, sibling edits do not leak, summarized-away messages stay
  absent, and a second activation adds no edits. Agent-state-only restoration must fail these checks.
- **Warming:** test absent settings and global values `streaming` and `idle` with real SettingsManager storage. Getter
  and AgentSession report off after reload; flush/unrelated writes do not replace the stored value. Run an eligible
  warming scenario using Pi's real warmer and controlled clock/provider boundary: let a valuable cache approach expiry
  during a held tool call, then settle. Assert zero warming requests and usage entries. Demonstrate the same fixture
  triggers a warming request without RunWield's fixed-off policy, so an ineligible model cannot create a false pass.
- **JSON results:** valid review/plan/completion reports remain equivalent. Null, scalar, array, and empty details do
  not throw or become approvals/completions. Preserve backward search, `fromIndex` behavior, defaults, plan
  metadata/images, and legacy truthy plan outcomes rather than adding a new allowlist. Fake or rejected transcript
  reports still cannot replace an accepted Workflow Tool Event or advance a workflow.
- **Usage and runtime boundaries:** retain exact ACP/guided-review usage expectations using the new Faux serialization.
  Keep tests that prove Agent switching, tool restrictions, compaction re-anchor, and accepted completion behavior. Only
  old provider-field access and obsolete hook-presence expectations stop existing; their behavioral coverage survives.

### Compiled and manual checks

Build the host release with `deno task compile`. Run it outside the checkout, using a disposable HOME and project.
Confirm start/resume, one Skill/Prompt Template invocation, clipboard actions reachable from RunWield, and image resize.
Check for missing native helpers, worker/WASM load errors, stray terminal output, or loss of input. A `--version` smoke
test alone is insufficient. Exercise a native-dependent path when testing native assets, not merely a command fallback.
For other release targets, inspect target-specific package assets and compile arguments; report platforms not exercised
rather than claiming cross-platform runtime proof.

Review the dependency diff and the updated Core/ADR references. Record any unrelated baseline failure with its evidence;
do not attribute earlier transient skills-sync failures to Pi or fix unrelated concurrent work.

## Edge Cases & Considerations

- The earlier `deno install` failed on Plannotator's extensionless `./code-file` import. Use the established cache entry
  points; do not change vendor code or globally enable sloppy imports to make this upgrade pass.
- `Context` remains a valid public type, so a clean type check cannot establish correct streaming behavior.
- Context edits are durable and branch-specific. Apply legacy repairs only while writable authority is held. Do not
  rewrite raw history or create a whole-store migration. Unexpected invalid metadata must not erase user messages.
- Pi's warming override API is ineffective for this field in 0.87.0. The fixed public getter override is intentionally
  narrow and temporary; the future user-setting work can replace it after verifying upstream behavior.
- Pi's native clipboard implementation changed, but RunWield also owns clipboard code. Trace reachable calls before
  adding assets; do not replace RunWield clipboard behavior merely because Pi offers a new helper.
- The image worker location is unchanged in inspected upstream code. Preserve existing includes unless runtime evidence
  requires a change.
- Current dirty files may belong to concurrent work. Recheck status before execution and preserve unrelated edits.
