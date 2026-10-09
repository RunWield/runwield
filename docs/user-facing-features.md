# RunWield user-facing features

Updated against repository implementation and delivery records on **2026-10-06**.

This is the detailed inventory behind the public Features page. Organize public copy around what users can do and why it
helps. Keep internal test status and implementation notes in technical documentation. If a feature's current
availability is unclear, confirm it with the owner before presenting it as unavailable or future work.

- [Project learning](#project-learning)
- [Planning and collaboration](#planning-and-collaboration)
- [Execution and review](#execution-and-review)
- [Workspace and Sessions](#workspace-and-sessions)
- [Models and tools](#models-and-tools)
- [Local setup and customization](#local-setup-and-customization)

## Project learning

Carry what you learned into the next change. Work Records and searchable memory make prior decisions available to future
planning.

### Work Records

- Store canonical Work Records as Markdown under `docs/work-records/`.
- Automatically generate or link Work Records after supported completed plan outcomes.
- Generate parent Epic Work Records after supported child-feature completion outcomes.
- List current Work Records with `wld wr` or `wld wr list`.
- Include maintenance records with `wld wr list --all`.
- Search the Work Record index with `wld wr search <query>`.
- Search all maintenance states with `wld wr search <query> --all`.
- Open a Work Record read-only in the browser by stable ID with `wld wr read <recordId>`.
- Rebuild the derived Work Record index with `wld wr index rebuild`.
- Backfill missing Work Records with `wld wr backfill`.
- Preview Work Record backfill with `wld wr backfill --dry-run`.

### Project context, memory, and code intelligence

- Initialize project context with `wld init` or `/init`.
- Review and approve Init's settings, glossary, and managed ignore-file changes before the Agent starts. Declining or
  canceling stops initialization and explains how to retry with `/init`.
- Generate a project `docs/domain-language.md` during initialization.
- Store durable project memories during initialization.
- Carry uncommitted project settings and domain language into new Tutorial and Plan worktrees, together with RunWield's
  managed ignore block, without requiring an initial user commit or copying unrelated changes.
- Deliver Plans locally without unchanged Init output or managed ignore rules blocking the merge, preserving later user
  edits and restoring setup files and staging if publication fails before merging.
- Use Mnemoteca for project and global memory recall; Mnemoteca models download lazily on first semantic use.
- Use Cymbal for code search, symbol lookup, references, impact analysis, and tracing.
- Use Snip for compact command-output rewriting when available; Snip remains optional and fail-open.
- Use `code_batch` to read several Cymbal source or outline results in one tool call.
- Install RunWield-managed Deno Snip filters with `wld snip-filters install`.
- Check Snip filter status with `wld snip-filters status`.
- Remove RunWield-managed Snip filters with `wld snip-filters cleanup`.
- Run memory and context cleanup with `wld sleep` or `/sleep`.
- Back up session-scoped memory before sleep cleanup.

## Planning and collaboration

Turn a rough request into reviewed intent. Match the amount of planning to the risk and keep decisions close to the
work.

### Routing and agent workflow

- Start new work through Router by default.
- Get an explicit Triage Report for routed requests.
- Route direct questions and explanations as `INQUIRY` work.
- Route idea shaping, research, and PRD-style exploration as `IDEATION` work.
- Route direct non-code repository or environment tasks as `OPERATION` work.
- Route bounded no-plan code changes as `QUICK_FIX` work.
- Route non-trivial implementation as planned `FEATURE` work.
- Route large efforts as `PROJECT` Epics.
- Keep the specialist agent active after Router handoff for follow-up context.
- Return a running session to Router with `/agent router`.
- List available agents with `wld agent`.
- Start directly with a chosen agent using `wld agent <name>` or `wld agent <name> "<request>"`.
- Switch agents inside the TUI with `/agent <name>`.
- Use bundled specialist agents including Router, Guide, Ideator, Operator, Planner, Architect, Engineer, and Tester.
- Use workflow specialists such as Slicer and Reviewer during plan decomposition and validation flows.
- Let agents use bounded delegated agent sessions for parallel investigation or isolated implementation work.
- Let agents optionally use a verification-adversary delegated role to attack weak structural or high-risk Plans.

### Planning and execution

- Store plans as Markdown files under `docs/plans/`.
- Use YAML front matter to preserve plan metadata and workflow state.
- Review `FEATURE` plans before execution.
- Save approved plans for later execution.
- Load a plan by name or path with `wld load-plan <name-or-path>`.
- Continue draft or feedback plans.
- Re-open approved, implemented, or verified plans for review.
- Execute ready standalone `FEATURE` plans.
- Execute ready child `FEATURE` plans from an Epic.
- Target saved plan execution at a chosen git branch with `worktreeBaseBranch`.
- Run saved plan work in linked git worktrees when applicable.
- Merge verified worktree changes back to the target branch.
- Preserve plan lifecycle state through execution, validation, failures, holds, and recovery.
- Put plans on hold and later resume them.
- Close eligible work without verification when explicitly chosen.
- Recover failed execution, validation, and merge-back states through dedicated plan recovery actions.
- Inspect and repair plan/worktree registry mismatches with `wld plans doctor`.
- Reopen the most recently presented Plan review with `/plan-review` in TUI, Workspace, or supported ACP clients.
- Choose autonomous execution or conversational Pair checkpoints, including a final assent before validation.
- Confirm requirement changes as durable Plan Deviations during execution or repair, in either collaboration style.
- Preserve edits from the planning checkout when starting execution; do not replace newer planning content with stale
  copies.
- Mark work User Verified with an explicit note, visibly distinct from RunWield verification and confirmed publication.
- Review related work as a Sequence with an overview and child Plan tabs.

### Project Epics and slicing

- Represent large `PROJECT` work as Epic container plans.
- Review and approve Epic design plans before decomposition.
- Use the interactive Slicer to discuss child feature boundaries.
- Sequence child features and record sibling dependencies.
- Materialize child `FEATURE` plan drafts under the Epic folder.
- Store advisory per-child Manual QA sections in `docs/plans/<epic>/manual-qa.md`.
- Keep Epic Manual QA artifacts out of Plan lifecycle state and Plan listings.
- Finalize decomposition only after explicit confirmation.
- Load an Epic to resume decomposition or choose child feature work.
- Warn about unverified child feature dependencies.
- Mark an Epic done enough for now without pretending it produced a single implementation diff.
- Chat with Architect and revise saved or reopened Epics inside the review page, separately from approval and slicing.
- Allow child Plans to be integration-dependent slices when their boundaries are explicit.
- Assemble children on a dedicated Epic branch, defaulting to `epic/<epic-name>`.
- Run project checks, an integration AI review, and configured Code Review on the assembled Epic branch.
- Turn integration findings into a draft repair child and repeat the integration gate after its delivery.
- Keep the Epic branch for an explicit final merge decision; RunWield does not automatically merge the Epic into main.

## Execution and review

Implement approved work, inspect the evidence, and distinguish successful checks from delivered changes.

### Validation and review

- Run Mechanical Validation after direct `QUICK_FIX` work.
- Run workflow validation after saved executable plan work.
- Run AI review against the original plan after saved plan implementation, in narrowing rounds: two full plan reviews,
  then verification-only rounds that check the repairs rather than re-reviewing everything.
- Report code smells as non-blocking advisories instead of blocking findings.
- Use focused verification-only AI review rounds after the full-plan review budget is spent.
- Track review findings with stable identities across rounds so repairs and re-reviews refer to the same issue.
- Repair review findings with a dedicated agent in fresh context, which reports what it did for each finding.
- Offer another verification round or an immediate code review when automatic rounds run out, rather than stranding the
  work.
- Repair code review feedback with the same fresh-context agent, then rerun CI and reopen code review for as many
  feedback rounds as you give — the cycle ends only when you approve or quit.
- Send validation failures back through repair attempts.
- Preserve the original execution owner during validation repairs.
- Optionally use a Code Review gate during validation when configured.
- Generate post-verification Manual QA checklist handoffs for standalone plans and durable advisory Epic artifacts for
  Epic children.
- Record validation, review, and merge outcomes in plan lifecycle metadata.
- Review the common-ancestor-to-current-files change, including committed and uncommitted execution work.
- Use browser diff annotations and Guided Review to inspect the implementation and send actionable feedback.
- Keep validation, confirmed publication, User Verification, and deliberate abandonment distinct; failed attempts remain
  recoverable.

### Plans CLI

- List active saved plans with `wld plans`.
- Group child feature plans under their parent Epic in plan listings.
- Open active or archived plan details read-only in the browser with `wld plans read <name-or-id>`.
- Archive verified or closed plans with `wld plans archive <name-or-id>`.
- Force archive other safe statuses when explicitly requested.
- Bulk archive active plans by exact status with `wld plans archive --all --status <status>`.
- List archived plans with `wld plans archive`.
- Restore archived plans with `wld plans archive restore <name-or-id>`.
- Refuse unsafe archive and restore operations that would overwrite or lose recoverable state.

## Workspace and Sessions

Continue the same work in the terminal or browser, find what needs attention, and keep long-running work manageable.

### Local browser Workspace and plan review UI

- Launch the local Plans Workspace with `wld plans ui`.
- Start the Workspace without opening a browser with `wld plans ui --no-open`.
- Serve the Workspace from the current checkout.
- Bind the local Workspace to `127.0.0.1` by default.
- Use a random per-server token for Workspace pages and APIs.
- Warn before serving plaintext plan content on non-loopback hosts.
- View plan boards in the browser.
- View closed plans in the browser.
- View on-hold plans in the browser.
- View plan and Epic detail pages in the browser.
- View Session detail pages with model and Execution Backend disclosure.
- See the Claude CLI MVP caveat that Claude Code internal file/Bash/tool history is not replayed as native RunWield tool
  history.
- Use stable plan detail URLs based on `planId`.
- Review plans in the browser through the Workspace/Plannotator review surface.
- Approve, request changes, save, or cancel from the plan review flow.
- Read and comment on remote Shared Space plans in the browser.
- Resolve and reopen remote review comments in the browser.
- Switch remote review revisions in the browser.
- Start and continue Sessions in the browser, select a Project, choose an Agent/model/reasoning level, and attach
  images.
- Move between terminal and browser using the same saved Session history.
- Steer active work, queue follow-ups, answer questions, stop work, and continue from Workspace.
- Find attention items on the owner Dashboard: Needs You, Ready to Continue, In Progress, and Recently Finished.
- Navigate linked Plans and Sessions, including planning conversations named from their history.
- Search supported Project documents, Plans, Work Records, and Session entry points across registered Projects.
- Receive live browser notifications for supported workflow events.
- Archive Sessions without deleting transcripts, identity, Plan links, or workflow state; busy work stops and settles
  first.
- Unarchive from the Archived Sessions tab in Project settings. Direct and Plan links remain readable while archived.
- Use personal remote Workspace with device pairing and an owner connection to the machine running the work.
- Treat shared Plan review separately from simultaneous multi-user Session collaboration, which remains future scope.

### Interactive TUI and session management

- Use slash-command autocomplete by typing `/`.
- Use file-reference fuzzy search by typing `@`.
- Recall slash-command and shell-command input history.
- Open inline keyboard help for TUI shortcuts.
- Render Mermaid diagrams inline in Markdown responses.
- Run shell commands and send output to the model with `!command`.
- Run shell commands without adding output to model context with `!!command`.
- Paste images into the TUI when supported by the active model or configured fallback.
- Queue messages while an agent is working.
- Steer foreground work early without waiting for the active process to finish.
- Cancel active work and its process tree reliably with Escape.
- Use multiline input and external editor shortcuts inherited from Pi.
- Browse and resume recent sessions with `/resume`.
- Start a new root session with `/new`.
- Name a session with `/name <name>`.
- Show the current session name with `/name`.
- Inspect current session information and cumulative token totals with `/session`.
- Inspect active context-window usage with `/context`.
- Manually compact session context with `/compact`.
- Customize compaction instructions with `/compact "<instructions>"`.
- Configure compaction behavior through `/settings`.
- Receive a notification when manual compaction finishes.
- Automatically compact large mid-run tool results when configured.
- Reload settings, instructions, prompts, skills, models, themes, and memories with `/reload`.
- Copy the last assistant message to the clipboard with `/copy`.
- Exit with `/quit` or `/exit`.
- Persist session history under `~/.wld/sessions/`.
- Automatically name sessions and terminal titles from Router triage when no manual name exists.
- Send native terminal notifications, terminal activation requests, and terminal bell notices for supported events.
- Offer compaction before resuming large sessions when configured.
- Run Session-owned background shell work or read-only delegates, inspect logs, cancel tasks, and receive results
  automatically.
- Use background results in TUI, Workspace, and ACP; running tasks do not survive the owning process exiting.
- See Agent-specific busy indicators and chronological activity groups; expand only visible tool groups with Ctrl+O.
- Receive clear retry notices for transient provider failures.
- Hide the mascot in TUI and Workspace with the global or Project `mascot: false` setting.

### Collaborative planning

- Run a self-hosted encrypted Plan Server with Podman/OCI Compose and SQLite.
- Share a local plan to an encrypted remote Shared Space with `wld plans share <plan-name-or-id>`.
- Print reviewer and maintainer URLs for a shared plan.
- Configure a default Plan Server with `planServerUrl`.
- Override the Plan Server for a single share command with `--plan-server`.
- Pull remote feedback with `wld plans pull <maintainer-url-or-plan-name-or-id>`.
- Pull a shared plan into another checkout with `--to <plan-name>`.
- Push an accepted local revision with `wld plans push <plan-name-or-id>`.
- Delete a remote Shared Space and clear local collaboration metadata with `wld plans unshare <plan-name-or-id>`.
- Lock shared local plans against ordinary local mutation while the remote is canonical.
- Preserve local plan files as plaintext while remote payloads are encrypted.
- Support optional Shared Space inactivity retention on the Plan Server.
- Report expired, deleted, stale, and no-op remote collaboration states.

### Session export and sharing

- Export the current session to HTML with `/export`.
- Export the current session to JSONL with `/export output.jsonl`.
- Choose an explicit export path with `/export <path>`.
- Share the current session as a secret GitHub Gist with `/share`.

## Models and tools

Choose model access and give Agents the context and tools the work needs.

### Model access and provider setup

- Sign in to subscription model providers with `/login`.
- Save API-key provider credentials with `/login api-key <provider>`.
- Remove stored provider credentials with `/logout`.
- Inspect configured providers and available models with `/status`.
- Switch the active model with `/model` or `wld model <provider>/<model_id>`.
- Select Claude Code CLI execution models such as `claude-cli/sonnet`, `claude-cli/opus`, `claude-cli/haiku`, and
  `claude-cli/fable`.
- Use custom non-empty `claude-cli/<selector>` model references when Claude Code supports the selector.
- Choose Claude Code CLI from first-run model setup without storing API credentials in RunWield.
- Use Antigravity CLI as an execution backend.
- Configure providers and custom models through RunWield-owned config paths.
- Use per-agent model overrides in settings.
- Use named model presets in settings.
- Start with bundled Codex, Antigravity, OpenCode, Claude mixed, Claude Opus, or Codex–Claude model presets.
- Edit model presets from the interactive `/settings` flow.
- Configure model thinking levels per agent.
- Use a vision fallback model for pasted images when the active model is text-only.

### Image generation

- Configure `imageGeneration` globally, per Project, or in a model preset to expose `create_image`.
- Generate an image to a requested local output path, optionally referencing Project or current-Session images.
- Generate images with OpenRouter, OpenCode, Codex, or Antigravity CLI, from any conversation model including Claude
  CLI.
- Keep image generation separate from the conversation model and from vision fallback for understanding images.
- See [`imageGeneration`](user-documentation/settings.md#imagegeneration) for setup per provider.

## Local setup and customization

Run locally and adapt the harness to your Project.

### Installation and startup

- Install the standalone `wld` binary and missing runtime helpers on macOS or Linux with the release installer.
- Install required [Mnemoteca]/Cymbal/agent-browser and optional Snip into the shared `WLD_INSTALL_DIR` when they are
  not already present.
- Preserve existing helper binaries already found on `PATH` or in `WLD_INSTALL_DIR`.
- Choose a custom install directory with `WLD_INSTALL_DIR`.
- Run from source with Deno for contributor workflows.
- Compile a standalone binary from source.
- Print global command help with `wld help`.
- Print per-command help with `wld help <command>`.
- Print version and platform architecture with `wld version`.
- Check for newer stable releases and run the CLI update flow with `wld update`.
- See stable update notices during normal use when a newer release is available.
- Start an interactive terminal session with `wld`.
- Send a one-shot routed request with `wld "<request>"`.
- Explicitly route a request with `wld router "<request>"`.
- Take the optional guided first-change tutorial with `/onboard` or interactive `wld onboard`; skip future offers when
  desired.
- Follow release-aligned public documentation at <https://docs.runwield.dev>.

### Protocol and external-client support

- Drive RunWield from JetBrains AI Chat or the Air plugin through ACP.
- Use the OpenAB gateway for end-to-end workflows in Discord and its other supported chat platforms.
- Use other ACP-compatible clients; interoperability is expected through the shared protocol.
- Start the ACP stdio adapter with `wld acp` or `wld --mode acp`.
- Create, load, continue, cancel, and close Sessions through compatible clients, with history, progress, usage, and
  browser Plan review links.
- Select models and reasoning levels through native ACP configuration controls.
- Use advertised shared slash commands and structured questions, with conversational interview fallback for clients
  without native forms.
- Receive completed background-task results over the live ACP Session without another prompt.
- Treat ACP `session/delete` as reversible archive; Workspace can unarchive it. `session/list` remains unsupported.
- Keep RunWield planning, browser review, execution, validation, and project memory when working from an external
  client.

### Customization

- Configure global settings in `~/.wld/settings.json`.
- Configure project settings in `.wld/settings.json`.
- Use the published JSON Schema URL for settings autocomplete and validation.
- Layer project customization over home customization over bundled defaults.
- Override agent definitions with `.wld/agents/` or `~/.wld/agents/`.
- Add project or home prompt templates with `.wld/prompts/` or `~/.wld/prompts/`.
- Use prompt templates as slash commands when they do not collide with built-ins.
- Run bundled `/commit` to group pending changes into commits and push, `/release` for a repository-guided release,
  `/code-optimizer` for maintainability improvements, or `/test-seams` for an advisory audit of tests that replace
  product-owned behavior. The seam audit runs only when requested, independently of initialization.
- Load Skills from project `.wld`, project `.agents`, home `.wld`, home `.agents`, then bundled defaults.
- Protect bundled Skill names from external `.agents` conflicts, while allowing intentional `.wld` overrides.
- Disable both external Skill folders with `enableExternalSkills: false`.
- Let Agents select relevant Skills automatically, or invoke a Skill explicitly with `/skill:<name>`.
- Use bundled skills for documentation, web lookup, diagnosis, prototyping, research, test writing, skill writing,
  codebase design tasks, and terminal setup wizards.
- Read RunWield-specific global instructions from `~/.wld/RUNWIELD.md` or `~/.wld/AGENTS.md`.
- Optionally fall back to shared `~/.agents/AGENTS.md` instructions.
- Connect optional stdio MCP servers through `~/.wld/mcp.json` or Project `.wld/mcp.json`.
- Inspect server status with `/mcp` and reconnect with `/mcp reconnect <server>` without a model request.
- Use discovered tools and requested resources from root Agents, including supported external CLI bridges; delegates and
  isolated reviewers do not inherit MCP access.
- Configure restricted Bash allowlists for Guide and read-only delegates.
- Opt into Project-local workflow metrics for usage, cost, context, tool activity, retries, and latency. Recording is
  off by default; a dashboard and export are not delivered by this feature.

### Help configuring and understanding RunWield

- Ask RunWield to explain its features, commands, settings, and workflows.
- Describe your needs and ask RunWield to help configure or customize itself for your project.
- Get help choosing Agent models, creating Skills and prompt templates, and connecting MCP servers.

### Themes and visual customization

- Use the embedded `catppuccin-mocha` theme by default.
- Open an interactive theme picker with `/theme`.
- Preview themes live in the TUI before confirming.
- Persist the selected theme.
- List installed themes with `wld theme --list`.
- Switch themes from the CLI with `wld theme <name>`.
- Install theme packages from npm with `wld install npm:<package-spec>`.
- Install theme packages from git with `wld install git:<url>`.
- Install theme packages from a local path with `wld install local:<path>`.
- Remove installed theme packages with `wld remove <source>`.
- Reset to the built-in theme when the active external theme is removed.

## What is still ahead

- **RunWield Connect:** an attached workflow inside external hosts. The first planned preview targets Claude Code;
  durable host actions and fresh-process outcomes remain work in progress. Existing Claude CLI execution inside RunWield
  is a separate capability, not proof that Connect has shipped.
- **Reusable software-factory components:** a product direction, not an already delivered independent component suite.
- **Broader team Workspace:** shared Plan review exists; team governance and simultaneous multi-user Session work are
  not implied by personal Workspace support.
- **Remote Session-save redesign:** the October laptop-owned SSH save proof supports design review only, not production
  adoption.
- **Plan Store redesign and metrics dashboard/export:** proposals, not replacements for the current Markdown artifacts
  or the opt-in local metrics recorder.

## Maintenance sources

- [Core capabilities and maturity](prd/runwield-core-prd.md)
- [Workspace capabilities](prd/runwield-workspace-prd.md)
- [ACP compatibility](prd/runwield-acp-protocol-prd.md)
- [Connect target scope](prd/runwield-connect-prd.md)
- [Session workflows](user-documentation/sessions.md), [MCP](user-documentation/mcp.md),
  [settings](user-documentation/settings.md), and [Plan lifecycle](plan-lifecycle.md)
- [Delivery records](work-records/)

[Mnemoteca]: https://github.com/gandazgul/mnemoteca
