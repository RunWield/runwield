---
planId: "ba18cb45-fed2-4878-8521-b4450ade354b"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - ".claude-plugin/marketplace.json"
    - "src/attached/claude/plugin/"
    - "src/attached/claude/mcp.ts"
    - "src/attached/claude/acceptance/"
    - "scripts/connect-claude-acceptance.ts"
    - "src/shared/attached/compatibility.ts"
    - "src/shared/attached/coordinator.ts"
    - "src/shared/attached/operations.ts"
    - "scripts/public-docs.ts"
    - "docs/user-documentation/connect-claude-code.md"
    - "docs/prd/runwield-connect-prd.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
    - "README.md"
planDeviations:
    - id: "call_3e68298d432c4303ae0a6e9b5abf2b9f|fc_022278afe10ed04e016adb707f175881938e90a9495309927a"
      supersededRequirement: "For `code_review`, show `review.url` and poll `status` every two seconds while the browser is open."
      replacementRequirement: "For `code_review`, show `review.url` and avoid repeated full-workflow `status` calls while the browser is open. Use a token-bounded way to detect the review decision, preserve timely feedback/approval detection and recovery, and fetch full workflow details only when they change or are needed."
      reason: "A live headed walkthrough reported about 10K tokens per status poll. The two-second full-response polling rule can repeatedly incur that cost."
      approvedAt: "2026-10-23T14:35:25.620Z"
    - id: "call_a85283e63be34fafb6406616263e427c|fc_022278afe10ed04e016adb715ea7d881938060f236d461133f"
      supersededRequirement: "For `code_review`, show `review.url` and avoid repeated full-workflow `status` calls while the browser is open. Use a token-bounded way to detect the review decision, preserve timely feedback/approval detection and recovery, and fetch full workflow details only when they change or are needed."
      replacementRequirement: "For Plan review and code review, keep the existing `status` operation but make polling responses a compact status summary containing only the workflow identity, state, revision, pending action kind and identity, and decision status needed to detect approval or feedback. Omit repeated role instructions, Plans, diffs, and other unchanged workflow payloads. Preserve timely decision detection and recovery; allow callers to fetch the full workflow when needed."
      reason: "The owner requests a simple status response rather than a large repeated payload; token measurements are not required."
      approvedAt: "2026-10-23T14:39:08.733Z"
    - id: "call_c1884418a5874117af38d4809116e9da|fc_022278afe10ed04e016adba44836f481939654bae151b401a1"
      supersededRequirement: "For Plan review and code review, keep the existing `status` operation but make polling responses a compact status summary containing only the workflow identity, state, revision, pending action kind and identity, and decision status needed to detect approval or feedback. Omit repeated role instructions, Plans, diffs, and other unchanged workflow payloads. Preserve timely decision detection and recovery; allow callers to fetch the full workflow when needed."
      replacementRequirement: "Make compact status the default for every status call. Return only workflow identity, state, revision, pending action identity, chat presence, and decision status. Keep full instructions available on explicit request. Do not embed Plans, diffs, or execution reports in status or reviewer/recorder action payloads; expose large artifacts through references and bounded reads. Let reviewer subagents fetch their own complete instructions by action ID, without requiring the coordinating agent to copy or condense them. Support waiting for browser decisions through a bounded long-poll status call that returns on a revision/action change or timeout, preserving restart recovery. For validation-command questions, use a command explicitly present in the user request or Plan; otherwise ask the user and show them the question rather than silently assuming an answer."
      reason: "The actual full status response was 56K characters and exceeded the host context. The current compact polling option still leaves full payloads as the default and does not solve instruction handoff, browser wait, or surfaced command decisions."
      approvedAt: "2026-10-23T18:16:08.826Z"
    - id: "call_fc4623e2f1a94367aaba3fae8d5e2787|fc_0cc29478207e5431016adcbbf8310481938bba77c6bccf1d04"
      supersededRequirement: "Verification Plan: **Live acceptance:** `bun run workspace:build`, then `bun scripts/connect-claude-acceptance.ts --keep` on the acceptance machine. Expected: exit 0, every row in `summary.json` passes with evidence, and the proposed entry matches what was committed to `compatibility.ts`. Repeat for any older floor version. **Headed pair run (default permissions):** install with `/plugin marketplace add` from a local clone of this branch, then `/plugin install runwield@runwield`, in an uninitialized trusted repo. Walk the journey in a real browser, exercise review chat, changes, Feedback, approval, interruption recovery, disable and uninstall, and record permission prompts. Implementation steps 9, 11, and 13 require the related live proof, observed permissions, and delivered Preview claims."
      replacementRequirement: "Close this Plan without another live acceptance run or headed/default-permissions walkthrough. Accept the automated checks already run and retain the existing historical acceptance evidence unchanged, with its recorded source identity, plugin version, and bypass-in-throwaway permission limit. Do not claim that the current changed source or default-permissions journey has live proof. Keep the guide, compatibility matrix, and PRD claims limited to the evidence actually available; do not invent observed permission prompts or declare broader Preview release qualification. RunWield's normal automated validation and delivery may proceed without further live Claude model runs."
      reason: "The user does not want another live acceptance run now and requests ending the work. This replaces the remaining live-proof requirements, not the evidence or automated validation requirements."
      approvedAt: "2026-10-24T14:09:06.593Z"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-07T03:22:49.110Z"
origin: "internal"
parentPlan: "attached-mode-claude-feature-preview"
order: 9
dependencies:
    - "07-answer-review-chat-from-the-claude-session"
userVerifiedAt: null
targetBranch: "epic/attached-mode-claude-feature-preview"
validatedCommit: "9783f680139f574ae5909efdb8027b9b1d578228"
status: "verified"
---

# Prove and document the supported Claude Preview

## Context

Children 01–07 deliver the runtime FEATURE journey with their own automated recovery tests and some one-off live runs.
Child 07 adds review chat on the Plan review and code review pages. This child adds the three things that are still
missing before RunWield Connect for Claude Code can be called a Preview:

- **An install path.** The plugin loads only through `claude --plugin-dir src/attached/claude/plugin`. The repository
  has no marketplace file.
- **A version preflight.** The MCP carrier (`src/attached/claude/mcp.ts`) records `hostVersion` and `adapterVersion`
  as evidence, but no code compares them. The only check is prose in `request.md` that asks Claude to compare role
  contract strings. No Compatibility Matrix exists.
- **Repeatable whole-journey evidence.** Live evidence for children 04–05 came from manual runs with logs in `/tmp`.
  Nothing in the repository drives real Claude Code through all 16 PRD steps.

The owning requirements are in the Connect PRD:

- [Explicit per-request activation](../../prd/runwield-connect-prd.md#explicit-per-request-activation) — install
  flow and activation step 2 (host and Core preflight) are still target scope; disable and uninstall scenarios.
- [Compatibility and honest availability](../../prd/runwield-connect-prd.md#compatibility-and-honest-availability) —
  tested versions, Preview label, host guide contents, README positioning.
- [First-class Connect use](../../prd/runwield-connect-prd.md#first-class-connect-use) — the whole journey stays in
  Claude Code and the browser.
- [End-to-End Preview Acceptance Journey](../../prd/runwield-connect-prd.md#end-to-end-preview-acceptance-journey) and
  [Preview Acceptance](../../prd/runwield-connect-prd.md#preview-acceptance) — the 16 steps and success criteria.
- The Core PRD's Attached delivery maturity note (`docs/prd/runwield-core-prd.md`, near "Preview release and live
  integrated support remain **TARGET** until child 08").

Deferred and unchanged: stable Claude support, other hosts, Routing Intents beyond FEATURE, `/runwield:init`, a
persistent daemon, and submission to Anthropic's plugin directory.

### Decisions from planning

- **Install:** a Claude Code marketplace file at the root of `gandazgul/runwield`. Users run
  `/plugin marketplace add gandazgul/runwield`, then `/plugin install runwield@runwield`. Core installs through the
  existing `install.sh`, Homebrew, or winget. No model credentials and no RunWield account are needed.
- **Version policy:** activation blocks a Claude Code version older than the oldest tested version. A newer, untested
  version is allowed with a visible "not yet tested" notice.
- **Evidence:** an opt-in live acceptance script drives real Claude Code through the whole journey and acts as the user
  through the review page endpoints. It is run by hand, not in CI. One headed pair run checks the real browser pages.
- **Matrix and contract (accepted assumptions):** the Compatibility Matrix is versioned data in Core. The plugin
  declares an adapter contract number. Core checks it on every evidence-carrying operation and rejects a plugin it does
  not speak to with exact update guidance. This replaces the prose contract check in `request.md`.

## Objective

A user installs RunWield Connect for Claude Code through one documented flow. Activation checks the plugin contract and
Claude Code version against a Compatibility Matrix before any state is created. One repeatable script proves the full
16-step journey, including update, disable, uninstall, and reinstall, against each Claude Code version the matrix
claims. The README and host guide claim only what that evidence shows.

## Approach

### Install and version check

The marketplace file lists the existing plugin directory. Claude Code fetches it; the plugin's `.mcp.json` starts
`wld attached mcp` from the user's PATH, as today.

```text
gandazgul/runwield
├── .claude-plugin/marketplace.json     # new: name "runwield", plugin source ./src/attached/claude/plugin
└── src/attached/claude/plugin/
    ├── .claude-plugin/plugin.json      # description names "RunWield Connect for Claude Code"
    ├── runwield-adapter.json           # new: { "adapterContract": 1 }
    ├── .mcp.json                       # unchanged: command "wld"
    └── commands/*.md                   # contract prose replaced by "show Core's guidance"
```

The plugin comes from the default branch, and `wld` comes from a release, so the two can drift apart. The contract
number is the one fact that decides whether they can work together. Core owns the decision:

```diff
 runAttachedOperation(name, projectRoot, inputText)
   parse input
+  if the operation carries evidence
+    assessCompatibility(evidence)        # src/shared/attached/compatibility.ts
+      contract not supported   -> reject "incompatible_adapter" + update guidance, no state change
+      host older than floor    -> reject "unsupported_host_version" + update guidance, no state change
+      host newer than tested,
+      or version not reported  -> accept, attach compatibility notice
   dispatch to activate / triage_report / ... (unchanged)
   withRoleInstructions
```

The MCP carrier only reads `runwield-adapter.json` next to the manifest it already reads and adds `adapterContract` to
the evidence. It decides nothing. `activate` stores the assessment in the Attached Workflow Record's evidence, which is
the capability snapshot the Epic calls for. `status` carries no evidence and is not checked, so a stale plugin can still
read state. Its next mutating call returns the guidance.

> [!NOTE]
> **The MCP server starts with every Claude Code session**
>
> Claude launches plugin MCP servers at session start, so `wld attached mcp` runs and its tool names are visible to
> the model even without `/runwield:request`. The server reads no prompts and writes no state until a tool is called.
> The PRD promise is "no inspection, injection, restriction, or state", and the acceptance script proves it. The guide
> must disclose that the server process and tool list are present.

### The acceptance script

`bun scripts/connect-claude-acceptance.ts` is a thin entry over `src/attached/claude/acceptance/`. It builds an
isolated world, then drives real Claude Code and acts as the user. It decides "pass" only from Core's durable state and
Git, never from Claude's chat text.

```text
evidence dir (default: new temp dir)
├── fixture/            # throwaway Git repo: README, check.sh, one commit; no .wld, no AGENTS.md
├── runwield-home/      # HOME for wld only: settings + reviewer override, no credentials, no model presets
├── bin/wld             # shim: logs its argv, sets HOME=runwield-home, PATH=sentinels:$PATH, HTTP(S)_PROXY=sink,
│                       #   then exec bun <checkout>/src/cli.ts "$@"
├── sentinels/claude,pi # log the call and exit 1; catches any Core-started model process
├── proxy-sink.log      # hosts Core tried to reach; the sink refuses every connection
├── logs/*.jsonl        # Claude stream-json per run (kept locally, never committed)
├── snapshots/          # Attached records, Plans, registry, git status/HEAD before and after each phase
└── summary.json        # privacy-safe: versions, per-step pass/fail + evidence pointers, proposed matrix entry
```

The committed proof is `summary.json`. It is copied to
`src/attached/claude/acceptance/results/claude-code-<version>.json`, and the matrix entry points to that file. A
reviewer can then see which run backs each claimed version, and a unit test keeps the two in step.

How the world forces each hard step to happen:

- **Uninitialized repo (step 2):** the fixture has no `.wld` and no `AGENTS.md`. Settings live only in the temporary
  RunWield home: `verification_command` runs `sh ./check.sh`, `codereview` is `always`, and `workflowMetrics` is on so
  the privacy check covers metrics.
- **CI that can be interrupted (steps 10, 15):** `check.sh` appends to `$ACCEPTANCE_MARKER_DIR/ci-runs`, sleeps about
  20 seconds, then checks the requested feature. The shim exports `ACCEPTANCE_MARKER_DIR`.
- **A blocking review finding (step 11):** the run writes a home-scope `reviewer` override. It is the bundled reviewer
  definition, copied at run time, plus one rule: in the first review round, report a blocking finding when `NOTES.md`
  lacks the line `acceptance: reviewed`. The request never mentions `NOTES.md`, so the first round blocks, a repair
  worker adds the line, and a fresh reviewer re-verifies it. This also proves that a layered override reaches the host
  without regeneration.
- **No Core model call:** the RunWield home has no credentials or presets. The sentinels fail any `claude` or `pi`
  process that Core starts. The proxy sink logs and refuses any in-process provider request, and a request to a model
  provider host fails the run. Mnemoteca setup runs before the journey, outside the sink. Claude itself runs from an
  absolute path, without the sink.
- **No transcript import:** the script sends a unique sentinel phrase in an ordinary message inside the Attached
  conversation and in the ordinary prompts. At the end it byte-searches every file in the RunWield home, including the
  binary Mnemoteca database and the metrics. It also searches the fixture's working tree and every commit's content.
- **Claude, not the script, made every call:** the script reads Core state only through `wld attached status` and file
  reads. It acts on reviews only through the review page HTTP endpoints. The shim's argv log must contain only
  `attached mcp` and `attached status`. Every accepted `operationId` in the Attached records must match a RunWield MCP
  `tool_use` in Claude's stream-json logs. Every recorded `evidence.hostVersion` must equal `claude --version`.

The driver loop reads `nextAction` from Core between Claude turns:

```text
start claude -p --input-format stream-json --output-format stream-json (MCP_TOOL_TIMEOUT=600000)
loop
  read the Attached Workflow Record (via `wld attached status` through the shim)
  review pending      -> act through the review page endpoints the browser uses (chat, Feedback, approve)
  decision pending    -> answer it as a user would, in the conversation
  Claude turn ended   -> send the next user message (the command or "continue") for the current state
  scripted interrupt  -> SIGKILL the Claude process group, verify, start a fresh session with the restore command
until delivered, a failed assertion, or the overall timeout
```

The journey order, with where each PRD step is proven:

| Phase               | What the script does                                                                                                                                                                                                                                                                                             | Proves                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Stale adapter       | Installs a temporary marketplace copy whose `adapterContract` is one lower, then runs `/runwield:request`.                                                                                                                                                                                                       | Rejection with update guidance; no record created.     |
| Update and install  | Replaces it with a marketplace from the checkout (same `marketplace.json`), then runs `claude plugin install`.                                                                                                                                                                                                   | Step 1.                                                |
| Ordinary use before | Runs an ordinary prompt with the sentinel.                                                                                                                                                                                                                                                                       | Inactive no-op.                                        |
| Request and plan    | Runs `/runwield:request <fixture feature>`.                                                                                                                                                                                                                                                                      | Steps 2–5.                                             |
| Plan review         | Asks a chat question and waits for the reply. Requests a Plan change by chat and waits for the new round. Sends structured Feedback and waits for the next round. Kills Claude, checks that the old URL refuses connections and the Plan is not approved, starts a fresh `/runwield:plan-review`, then approves. | Steps 6–7 and the planning/review interruption.        |
| Implementation      | Waits for Core's implementation checkpoint.                                                                                                                                                                                                                                                                      | Steps 8–9.                                             |
| Disable during work | Disables the plugin, runs an ordinary prompt, uninstalls, compares snapshots, reinstalls, and resumes with `/runwield:validate`.                                                                                                                                                                                 | Disable, uninstall, and reinstall preserve work.       |
| Validation          | Kills Claude after the first new `ci-runs` line, then resumes with `/runwield:validate`. Waits for the forced finding, the repair, and the re-review.                                                                                                                                                            | Steps 10–11 and the execution/validation interruption. |
| Code review         | Asks a chat question, requests a code change by chat, waits for the re-verified diff, then approves.                                                                                                                                                                                                             | Step 12.                                               |
| Delivery            | Waits for `delivered`.                                                                                                                                                                                                                                                                                           | Steps 13–14.                                           |
| Ordinary use after  | Runs an ordinary prompt with the sentinel, then the sentinel search.                                                                                                                                                                                                                                             | Step 16 and privacy.                                   |

> [!TIP]
> **Why a script and not a checklist**
>
> Claude Code releases often. With a script, adding a version to the matrix is one command. The Preview criteria also
> ask for the interruptions to be proven "in black-box tests". A manual checklist would have made the script
> stable-release work.

Installs use Claude Code's `local` scope in the fixture repo or a temporary Claude config directory, so the run does
not change the user's own plugin settings. Snapshot comparisons ignore Claude's own local settings file, which Claude
owns. Claude runs with permission prompts bypassed inside the throwaway repo, and `summary.json` records that fact. The
headed pair run uses normal permissions and records which permission prompts appear, for the guide.

### Documentation follows the evidence

`docs/user-documentation/connect-claude-code.md` is the host guide. The README gains a short Connect section that
positions Connect, Core, and Workspace together and links the guide. The Connect PRD records what is now delivered and
answers its two Open Questions from the evidence. A unit test keeps the guide's version table in step with the matrix.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `.claude-plugin/marketplace.json` — new marketplace file at the repository root.
- `src/attached/claude/plugin/` — `runwield-adapter.json`, manifest description and version, and command prose that
  shows Core's compatibility notice and guidance instead of comparing contracts itself.
- `src/attached/claude/mcp.ts` — reads `adapterContract` from the plugin root and adds it to the evidence. No policy.
- `src/shared/attached/compatibility.ts` (new) — the Compatibility Matrix data and `assessCompatibility`.
- `src/shared/attached/operations.ts` and `coordinator.ts` — the evidence field, the two rejection codes, the
  compatibility notice on results, and the check in `runAttachedOperation`.
- `src/attached/claude/acceptance/` and `scripts/connect-claude-acceptance.ts` — the live acceptance script and unit
  tests for its pure parts.
- `scripts/bun-test-files.json` — new test files, if the explicit inventory requires them.
- `docs/user-documentation/connect-claude-code.md`, `docs/user-documentation/index.md`, `scripts/public-docs.ts` — the
  guide and its publication.
- `README.md` — the Connect section.
- `docs/prd/runwield-connect-prd.md`, `docs/prd/runwield-core-prd.md` — maturity and scope reconciliation.
- `docs/domain-language.md` — the Compatibility Matrix term.
- `docs/releasing.md` — one rule: bump the plugin `version` when plugin files change (Claude caches by version), and
  bump `adapterContract` only when Core and plugin stop being able to work together.

Deliberately unchanged: Plan Lifecycle, validation engine, worktree registry, and delivery policy. Integration defects
the journey exposes are fixed in their owning module, not worked around in the script or the plugin.

## Reuse Opportunities

- `src/shared/attached/review-chat-test-fixture.ts` and `delivery-test-fixture.ts` — the HTTP calls the review pages
  use for chat, Feedback, and decisions. The script uses the same endpoints a browser uses, not Core shortcuts.
- `src/cmd/attached/` — `wld attached status` for the script's read-only view of the record.
- `src/shared/attached/record-store.ts` (`locateAttachedWorkflows`) — where records live, for snapshots.
- `src/shared/session/agents.js` (`loadAgentDef`) — the bundled reviewer text the override copies.
- `scripts/check-doc-links.js`, `scripts/public-docs.ts`, `scripts/check-public-docs.ts` — guide publication checks.
- The Epic's Integration Notes from children 01, 02, and 05a — places the integrated journey should exercise.

## Implementation Steps

1. `.claude-plugin/marketplace.json` exists at the repository root with marketplace name `runwield`, an owner, and one
   plugin entry named `runwield` whose `source` is `./src/attached/claude/plugin`. `claude plugin validate .` and
   `claude plugin validate src/attached/claude/plugin` both pass. The plugin manifest's `name` stays `runwield`, so
   commands stay `/runwield:request` and so on. Its description names "RunWield Connect for Claude Code" and the
   supported FEATURE journey.
2. `src/attached/claude/plugin/runwield-adapter.json` declares `adapterContract: 1`. `runAttachedMcpServer` reads it
   from `RUNWIELD_ATTACHED_PLUGIN_ROOT`, or from the bundled copy when that variable is unset, and adds
   `adapterContract` to `evidence` on every non-`status` call. The evidence parser in `operations.ts` requires the field
   and its schema lists it. The carrier contains no comparison.
3. `src/shared/attached/compatibility.ts` exports the Compatibility Matrix for `claude-code`: a matrix version, the
   supported adapter contract numbers, the oldest tested Claude Code version (the floor), and one entry per tested
   version. Each entry holds the version, the test date, the Core version, the adapter contract, the evidence source (the
   acceptance script and its `summary.json` outcome), the capabilities exercised, and the disclosed limits. It also
   exports `assessCompatibility(evidence)`, which returns `compatible`, `untested_newer`, `version_not_reported`,
   `incompatible_adapter`, or `unsupported_host_version`, with a user-facing message. Version comparison is numeric per
   dotted segment. Each entry's evidence source is the repository path of its committed result file (step 9).
4. `runAttachedOperation` runs `assessCompatibility` for every operation that carries evidence, before dispatch.
   `incompatible_adapter` and `unsupported_host_version` reject with that code and a message naming the found and
   required versions and the exact update action (update the plugin, or update Core with the installer or package
   manager). A rejected `activate` creates no record file. A rejected continuation changes no record, Plan, or worktree.
   `untested_newer` and `version_not_reported` proceed. Their `activate` result carries a `compatibility` notice, and
   the record evidence keeps the assessment.
5. The command prose in `request.md`, `plan-review.md`, `implement.md`, and `validate.md` tells Claude to show a
   `compatibility` notice to the user before continuing, and on either rejection code to show Core's message and stop.
   The old "plugin and Core contract versions do not match" comparison and the sentence "Installation and full preflight
   are separate capabilities" are gone. The role-contract string checks on returned actions may stay.
6. `src/shared/attached/compatibility.test.ts` drives `runAttachedOperation` against a real project and record store.
   It shows that a wrong contract and a below-floor version each reject `activate` with no record created, a newer
   version activates with the notice saved in record evidence, and `"not-reported"` activates with the notice. It loops
   over every entry in `ATTACHED_OPERATIONS` that carries evidence. For each one, a stale contract on an existing
   workflow rejects with `incompatible_adapter`, and the Attached record, the Plan file, and the worktree registry stay
   byte-identical. A new evidence-carrying operation is therefore covered automatically. `mcp.test.ts` shows that the
   carrier sends the `adapterContract` read from a temporary plugin root.
7. `bun scripts/connect-claude-acceptance.ts [--claude <path>] [--out <dir>] [--keep]` builds the isolated world
   described in Approach and runs every phase in the journey table in order. For each of the 16 PRD steps and each extra
   check (stale adapter, inactive before and after, disable, uninstall, reinstall, no Core model process, sentinel
   absence), `summary.json` records pass or fail and the Core evidence that decided it: the Plan status and events,
   review-round and chat state, the registry entry, CI marker counts and delivery evidence receipts, review-ledger
   finding IDs, the publication result, the Work Record path, and the Git state of the invoking branch. It also records
   the identity checks: every accepted `operationId` matched to a RunWield MCP `tool_use` in the stream-json logs, the
   shim argv log, each recorded `hostVersion` against `claude --version`, and the stored activation assessment, which
   must be `compatible` or `untested_newer` and never `version_not_reported`. It records the review requests the script
   sent over HTTP, one or more per review action, the sentinel-binary log, and the proxy-sink hosts. The script exits
   non-zero when any check fails or lacks evidence. `summary.json` holds no prompts, transcripts, source content,
   sentinel text, or absolute home paths. It includes the Core commit, the adapter contract, the activation assessment,
   and the proposed matrix entry.
8. The acceptance code is split into a collector, which reads files, Git, logs, and records from an evidence directory,
   and a pure evaluator. Both live in `src/attached/claude/acceptance/` and have unit tests that never start Claude.
   The tests cover:
    - **Evaluator:** the tests feed complete evidence with one item removed or changed at a time, and the matching check
      fails. Cases: no Work Record; Plan not `verified`; a duplicate CI run after resume; a record created by the
      stale-adapter attempt; an ordinary prompt that called a RunWield tool; a changed invoking branch; a review URL that
      still answers after the kill; an accepted `operationId` with no matching `tool_use`; a `hostVersion` that differs
      from `claude --version`; and a `version_not_reported` assessment.
    - **Collector:** the tests use planted data in a temporary world. The collector must report each planted item: the
      sentinel inside a real SQLite database file, in a metrics JSONL file, in a Work Record, and only in an earlier
      commit's content; a sentinel-binary log line; a proxy-sink entry for a model provider host; and a shim argv log
      entry for a mutating `wld attached` operation.
    - **Import boundary:** no acceptance module imports the coordinator, operations, record-store write functions, Plan
      Lifecycle, or worktree registry modules.
9. The script passes on the current Claude Code release on the acceptance machine. If the user wants an older floor, it
   also passes on that older version. Each passing run's `summary.json` is committed as
   `src/attached/claude/acceptance/results/claude-code-<version>.json`. `compatibility.ts` holds exactly those versions,
   and the floor is the oldest. A unit test fails in any of these cases: a matrix entry has no result file; a result
   file has no entry; a result row is not `pass`; or a result's Claude version, Core commit, or adapter contract differs
   from its entry. Every limit the runs found is in the entry's limits, for example the `MCP_TOOL_TIMEOUT` launch
   setting, FEATURE-only routing, no `/runwield:init`, no hooks, and role boundaries that are instructions and not
   enforcement.
10. Integration defects the runs expose are fixed in their owning module, each with a focused regression test there.
    No such fix weakens a Core guard, and the script contains no special case for one.
11. `docs/user-documentation/connect-claude-code.md` exists and is published through `scripts/public-docs.ts` and
    `index.md`. It covers: Preview label and tested versions (a table that matches the matrix); prerequisites (Core
    install, no model credentials, no RunWield account); marketplace install; `MCP_TOOL_TIMEOUT`; `/runwield:request`
    and the other commands; the MCP server presence disclosure; permission prompts seen in the headed run; Plan review,
    review chat, and code review; local artifacts and what is never stored (the Claude transcript); recovery after
    closing Claude; update and the version messages; disable, uninstall, and what remains; unsupported actions; and who
    owns the conversation and model calls compared with Core's Claude CLI backend and ACP. A unit test fails when a
    matrix version is missing from the guide's table or the table lists a version the matrix does not.
12. `README.md` has a short section that names Connect, Core, and Workspace together, states the Claude Code Preview
    with install commands, and links the guide. It claims no other host and no stable support.
13. The Connect PRD's maturity lines for Explicit per-request activation, Compatibility and honest availability, and the
    End-to-End Preview Acceptance Journey describe the delivered Preview for the matrix versions. Preview Acceptance
    links the evidence source. The two Open Questions are answered from the evidence, or reduced to what is still open.
    Stable and later-host scope stays labeled target. The Core PRD's "TARGET until child 08" note states the delivered
    Preview and links Connect instead of restating it.
14. `docs/domain-language.md` defines **Compatibility Matrix**: Core-owned, versioned data of tested External Agent Host
    versions, adapter contracts, capabilities, and limits for a Connect adapter. Activation checks it, and only the
    acceptance evidence adds entries. Avoided aliases are "support list" and "capability manifest". The relationships
    section states that an Attached Workflow Record keeps the activation assessment as evidence, not authority.
15. `docs/releasing.md` states the plugin `version` and `adapterContract` bump rules from Expected Change Surface.

## Verification Plan

- **Automated, focused:**
  `bun scripts/run-tests.js src/shared/attached/compatibility.test.ts src/attached/claude/ src/shared/attached/ src/cmd/attached/`
  plus the new guide-sync, result-file, collector, evaluator, and import-boundary tests. The compatibility tests fail if
  `assessCompatibility` is a pass-through or runs for only some operations, because every evidence-carrying operation
  expects a byte-identical rejection. The evaluator tests fail if the evaluator always passes. The collector tests fail
  if the sentinel search skips binary files or history. The result-file test fails for a hand-written matrix entry with
  no committed run behind it.
- **Plugin packaging:** `claude plugin validate .` and `claude plugin validate src/attached/claude/plugin` pass.
- **Docs:** `bun run doc-links:check` and `bun run docs:check` pass. Format changed files with
  `bun run fmt --write <files>`.
- **Live acceptance:** `bun run workspace:build`, then `bun scripts/connect-claude-acceptance.ts --keep` on the
  acceptance machine. Expected: exit 0, every row in `summary.json` passes with evidence, and the proposed entry
  matches what was committed to `compatibility.ts`. Repeat for any older floor version.
- **Headed pair run (default permissions):** install with `/plugin marketplace add` from a local clone of this branch,
  then `/plugin install runwield@runwield`, in an uninitialized trusted repo. Walk the journey in a real browser. On the
  Plan review page and on the code review page, ask a chat question, request a change by chat, see the new round on the
  same page, and approve. Send structured Feedback once. Close Claude while a review is open and confirm the page stops
  answering; reopen with `/runwield:plan-review` or `/runwield:validate` and confirm the review returns. Record the
  Claude version, the permission prompts shown, and any wording to fix in the guide. Then disable and uninstall the
  plugin and confirm ordinary Claude use, with Plans and Work Records still present.
- **Protected behavior:** all existing Attached tests in `src/shared/attached/` and `src/attached/claude/` keep their
  meaning. Only their envelopes gain `adapterContract`. Core Session, ACP, and Claude CLI backend behavior is
  unchanged. No existing behavior is expected to stop, except the prose contract comparison in `request.md`.
- **PRD and glossary:** the Connect PRD claims match `summary.json` and the matrix. No stable, other-host, or
  `/runwield:init` claim appears. The glossary defines only the Compatibility Matrix as delivered.
- **Full gate:** `bun run ci` runs after implementation, including `seams:check`. The script's Claude subprocess is a
  genuine external boundary in a script, not a Core seam.

## Edge Cases & Considerations

- **Quota and run time.** One run costs about one full feature cycle of the user's Claude quota and 30–60 minutes. The
  script is never part of `bun run ci`. `--keep` preserves the world for diagnosis.
- **Model variation.** A run may fail because Claude did something unexpected. The script reports which check failed and
  with what evidence. A retry is acceptable. A repeated failure is a defect to fix (step 10), not a check to relax.
- **Human prerequisites.** Claude authentication, workspace trust, and installing an older Claude version may need a
  person. Record a blocked prerequisite as blocked in `summary.json`; never mark it passed.
- **Plugin and Core drift.** The marketplace serves the default branch, so the plugin can be newer than an installed
  `wld`. The contract check turns that into a clear message, not a confusing failure. Bump `adapterContract` only for a
  real break.
- **Host version not reported.** If Claude stops sending its version in MCP client info, activation proceeds with a
  notice instead of blocking everyone.
- **Assumption: Claude Code reports its version in MCP `clientInfo`.** The carrier already sends that value as
  `hostVersion`. The live run checks it against `claude --version`. If the two differ, or no version is reported, the
  floor cannot protect users. Stop and report this as a decision before claiming the version policy is delivered.
- **Repository clone size.** Adding the marketplace clones the whole repository. If that is slow, document
  `claude plugin marketplace add --sparse .claude-plugin src/attached/claude/plugin gandazgul/runwield` as the
  shell alternative. A separate plugin repository is a later option and not part of this change.
- **Epic branch before merge.** Until the Epic reaches `main`, the GitHub marketplace command finds no marketplace. The
  script and the headed run install from a local marketplace of this branch. The guide documents the GitHub form, which
  works once the Epic merges.
- **Forced finding override.** The reviewer override is fixture-only and lives in the temporary RunWield home. It never
  ships and never touches the user's agents.
- **Reviewable assumption:** the first matrix holds only the version or versions that pass here (at least the current
  release on the acceptance machine). Ask the user during the pair run whether an older floor is worth the extra quota.
