# RunWield Connect for Codex

RunWield Connect brings Plan review, isolated implementation, validation, and delivery into Codex. Codex owns the
conversation and every model call. RunWield Core owns the Plan, workflow gates, recovery, and delivery evidence.

The Codex adapter is available for **FEATURE Preview qualification** in this source version. It targets the Codex
desktop app and CLI. Neither surface has a qualified complete workflow yet; this is not a stable-support claim.
The [Claude Code guide](connect-claude-code.md) has its own tested scope.

## Scope and evidence

The native package provides one explicitly invoked skill, `$runwield:run`, for starting and resuming work. It uses the
same Core workflow as Claude Code, including browser review, fresh implementation and review workers, repair,
publication, and Work Records. Other request types, hooks, and enforced worker tool restrictions are outside this Preview.

| Surface                        | Evidence available                                 | Qualification limit                                                                                 |
| ------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Codex CLI `0.164.0-alpha.11.1` | Native marketplace/package and MCP protocol probes | A prerelease probe does not qualify a complete live skill journey or a stable version range.        |
| Codex desktop app              | The package targets the app's native plugin format | CLI and app-server results do not establish desktop installation or a completed desktop UI journey. |

Core has no tested Codex versions in its Compatibility Matrix yet. It allows a recognized Codex host with a visible
untested-version notice. The [Codex acceptance requirements](../prd/runwield-connect-prd.md#codex-acceptance) distinguish
protocol checks from live workflow qualification. A complete default-permissions walkthrough remains unproven.

## Install

You need compatible RunWield Core (`wld`) on `PATH`, Codex with its own model access, Git for isolated execution and
publication, and a browser for review. Start Codex in the local project you want to change. Your home directory must be
available for Core's saved workflow records.

Core needs **no model credentials, model preset, or RunWield account** for Connect. Install Core with the
[Quickstart](quickstart.md#install) or your package manager. Its model-login instructions apply to Core-owned Sessions.

Before publication, use a Core build and marketplace from the same source checkout. An installed release is compatible
only if it contains the Codex adapter. The GitHub commands below become usable after the package reaches that branch;
they do not make an unreleased adapter available in an older Core binary.

### Codex CLI

For a local checkout containing this adapter:

```bash
codex plugin marketplace add /absolute/path/to/runwield
codex plugin add runwield@runwield
```

After the adapter is published to the default branch, use this marketplace source instead:

```bash
codex plugin marketplace add RunWield/runwield
codex plugin add runwield@runwield
```

Start a new Codex session in your project. `/plugins` opens the native plugin browser; `/skills` lists available skills.
If your Codex build lacks these plugin commands, use a build with native plugin support. See OpenAI's
[plugin installation guidance](https://learn.chatgpt.com/docs/plugins).

### Codex desktop app

Register the local or published marketplace using the commands above with the Codex CLI associated with your desktop
installation. In the app, open **Plugins**, find **RunWield Connect** in the **RunWield** marketplace, and install or
enable it. Start a new chat in your local project so its bundled skill and tools load. The app and CLI must use the same
Codex configuration for this marketplace registration to be shared.

OpenAI documents local marketplaces and desktop installation in
[Package your plugin](https://developers.openai.com/plugins/build/plugins). These are setup instructions for the target
surface; a completed RunWield desktop walkthrough has not yet been recorded.

### What loads and what it can do

The installed plugin starts a local Core MCP process and exposes workflow tools. Loading it does not create a workflow,
read your conversation, or activate RunWield for ordinary prompts. The skill disables implicit invocation: explicitly
select it when you want RunWield to govern a request.

Codex's permissions and sandbox still apply. Codex may request access to Core's execution directory or permission to
run a tool. Use your normal permissions; the plugin installs no hooks or permission bypass. Worker roles are
instructions, not a sandbox.

Core can write Plans and recovery evidence, prepare an isolated checkout, run the project's validation command, serve
browser review, and publish approved work through its workflow gates. Codex supplies all model reasoning. Current Core
role instructions and project Skill overrides are fetched when needed; the package does not copy those roles.

## Start one FEATURE request

Explicitly choose the **RunWield** skill in Codex's skill picker or invoke it by name:

```text
$runwield:run Add an export button for the current report.
```

The general form is `$runwield:run <request>`. In the CLI, use `/skills` or type `$` to select the installed skill.
See OpenAI's [skill invocation guidance](https://learn.chatgpt.com/docs/build-skills).

RunWield applies to this request. It does not take over later ordinary prompts. Core checks host and adapter
compatibility, then Codex performs Triage and planning with the current Core instructions. An existing `.wld` directory,
`AGENTS.md`, or separate initialization command is not required.

1. Review the Plan in the browser. Use review chat for questions and change requests or submit structured Feedback.
   A revision opens a new review round on the same page.
2. **Approve & Run** starts implementation after readiness checks. **Approve for Later** saves the ready Plan; invoke
   the same RunWield skill when you want to continue.
3. Core prepares the execution checkout. Codex shows its directory and branch, then starts a fresh worker there.
   Non-Git execution requires explicit consent to edit current files without Git isolation or publication.
4. Core runs the configured checks. Fresh Codex workers review the diff and repair findings. Each independent reviewer
   must inspect the diff directly through RunWield tools. A reviewer without that access leaves a resumable capability
   blocker; the coordinating chat cannot supply the review for it.
5. If the validation command is missing, Codex shows Core's question. It may use a command explicitly supplied in your
   request or approved Plan after showing its source; otherwise it asks you.
6. Review the code when requested. Feedback starts repair and validation before a new diff decision. Review chat can
   request changes but cannot approve a Plan or code diff.
7. Core confirms delivery and reports the Work Record outcome. Implementation completion alone does not make a Plan
   Verified. A repairable publication conflict goes to a fresh worker; Core completes publication after the repair.

The landing follows your project's [Plan delivery settings](settings.md#plan-delivery). An onward pull request or merge
may remain your responsibility. Let Core own worktrees, commits, and publication for this workflow. Codex suggests manual
checks in the conversation rather than saving a Manual QA checklist.

## Resume or switch hosts

Use the same skill to resume:

```text
$runwield:run resume
```

Core selects the latest open workflow in this local repository. Codex shows its Plan name and current step before
continuing; if planning has not produced a Plan yet, it shows the request summary. You do not need to remember an
internal workflow ID. When a request could mean new work or continuation, the skill asks which you intend.

You can continue a Claude-started workflow in Codex, or a Codex-started workflow through Claude's
[resume commands](connect-claude-code.md#resume-after-interruption), in the same local repository. The host shows the
originating host before continuing. Core preserves the Plan, pending action, revision, accepted decisions, and execution
directory. Conversation history is not transferred.

An active Codex turn waits for browser decisions in bounded intervals. A saved decision survives the turn ending, but
does not start a new model turn automatically: invoke RunWield again to continue. Closing the browser or Codex does not
approve or abandon work. A new host process can reopen pending review; interrupted Core checks run again without
recording the stopped run as a failure. Accepted outcomes are not repeated.

### Long checks

The native package sets a one-hour MCP tool timeout and Core reports progress during active checks. A CLI protocol
probe lasting more than 60 seconds verified the timeout setting was applied; it does not prove a one-hour workflow.
If a call is interrupted, resume the saved workflow. Do not ask Codex to start a second copy of the validation command
while Core owns a running check.

## Update, disable, or remove

For a Git-backed marketplace, refresh its snapshot:

```bash
codex plugin marketplace upgrade runwield
```

For a local source, update that checkout instead. Reinstall the plugin to load the updated package:

```bash
codex plugin remove runwield@runwield
codex plugin add runwield@runwield
```

Start a new session or chat afterward. Update Core with the installer or package manager you originally used, and
update Codex through its installation's update mechanism. Keep the plugin and Core adapter contracts compatible;
follow Core's exact update guidance if it rejects an operation. Status remains available for recovery.

To disable the plugin, turn it off in the native plugin browser. In the CLI, open `/plugins` and press **Space** on the
installed entry. To uninstall, use the browser's uninstall action or `codex plugin remove runwield@runwield`. To stop
tracking the marketplace too, use `codex plugin marketplace remove runwield`.

Disabling, removing, or reinstalling the plugin does not delete Plans, Work Records, saved decisions, or execution
checkouts. It does not abandon delivery. Reinstall and invoke the RunWield skill to resume.

## Local artifacts and privacy

Plans remain ordinary files under `docs/plans/`, alongside the project's Work Records and workflow evidence. Core keeps
per-request recovery records under `~/.wld/attached/`, associated with the local repository. Browser review chat is
temporary workflow context. The [shared privacy contract](../prd/runwield-connect-prd.md#artifact-privacy-and-records)
defines what becomes durable project knowledge.

Core does not import or save the Codex conversation. Codex controls its own history and model credentials. Do not paste
host transcripts into Plans, worker reports, or Work Records. Cross-host continuation reads Core artifacts rather than
another host's chat.

Connect differs from [Core execution backends](providers.md), where RunWield owns the Session and dispatches model work,
and from [ACP](usage.md), where an external client drives a RunWield-owned Session. With Connect, you stay in Codex and
the browser throughout the workflow.
