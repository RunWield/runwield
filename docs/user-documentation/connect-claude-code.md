# RunWield Connect for Claude Code

RunWield Connect brings Plan review, isolated implementation, validation, and delivery into Claude Code. Claude owns
this conversation and every model call. RunWield Core owns the Plan, workflow gates, recovery, and delivery evidence.
RunWield Workspace is the separate browser product for RunWield Sessions and collaboration.

This is a **FEATURE Preview**, not stable Claude Code support. Other hosts and request types are outside this Preview.

## Tested scope

Core's [Compatibility Matrix](../../src/shared/attached/compatibility.ts) lists these tested versions:

| Claude Code | Adapter contract | Live acceptance source                                                                             |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| 2.1.303     | 1                | [16-step acceptance result](../../src/attached/claude/acceptance/results/claude-code-2.1.303.json) |

The result identifies the tested Core commit, source digest, plugin version, and limits. It covers installation, Plan
and code review chat, repair, interruption recovery, publication, Work Records, disable/uninstall/reinstall, and
privacy checks. It records a dirty source snapshot and bypassed permissions **only in its throwaway repository**.
It is not evidence for every later source change or for a released binary.

### Permissions

Use Claude Code's normal permission settings for your work. Claude may ask for permission to run tools or access an
execution directory. Review those requests in Claude Code. Connect does not install permission restrictions or hooks.
Worker role boundaries are instructions, not a sandbox.

The saved acceptance run used bypassed permissions. It does not establish which permission prompts appear in a
complete default-permissions walkthrough. Do not use its launch settings to disable permissions in your own project.

## Install

You need:

- RunWield Core (`wld`) on `PATH`, with the Connect operations in this source version.
- Claude Code with its own model access and authentication.
- `HOME` set to your home directory. Attached records live there; without it, operations return `home_unavailable`
  and ask you to set `HOME`. Core does not put these records in your repository.
- Git for isolated execution and publication, and a browser for Plan and code review.

Core needs **no model credentials, model preset, or RunWield account** for Connect. The model setup in the
[Quickstart](quickstart.md) is for Core-owned Sessions, not this workflow.

Install Core with the [Quickstart](quickstart.md#install), Homebrew, or winget. Before the Preview is published,
use a Core build and local marketplace from the same checkout; the published default branch and release must contain
this Preview before the GitHub form below can install it.

In Claude Code, after publication:

```text
/plugin marketplace add gandazgul/runwield
/plugin install runwield@runwield
```

For a local checkout that contains the Preview, replace the first command with:

```text
/plugin marketplace add /absolute/path/to/runwield
```

The second command stays the same. Restart Claude Code if it requests a restart to load the plugin.

Start Claude Code from your project root with a timeout long enough for local checks:

```bash
MCP_TOOL_TIMEOUT=600000 claude
```

The value is milliseconds. Increase it if your validation command needs more than ten minutes. Core sends progress
notifications during active checks. It does not ask Claude to run a second copy of the full command.

### What loads before activation

Claude starts the plugin's `wld attached mcp` process and lists its tools when the plugin loads. That process and tool
list are present even before a RunWield request. Loading the plugin alone does not inspect your prompt or repository,
inject role instructions, restrict tools, or create workflow state. Ordinary Claude use stays ordinary.

## Start one FEATURE request

In Claude Code:

```text
/runwield:request Add an export button for the current report.
```

This activates RunWield for that request, not the whole conversation. Core checks the adapter contract and Claude
version first. The host performs Triage and planning with current Core instructions. A project does not need an
existing `.wld` directory or `AGENTS.md`. `/runwield:init` is not provided.

1. Review the Plan in the browser. Ask questions in review chat, request a change in chat, or send structured Feedback.
2. A changed Plan opens a new review round on the same page. Approve the exact Plan before implementation starts.
   **Approve & Run** continues immediately. **Approve for Later** leaves it Ready For Work and starts nothing; use
   `/runwield:implement` when you want to start it.
3. Core prepares the execution checkout. Claude discloses its directory and branch and starts a fresh worker there.
   Non-Git execution needs explicit consent; it edits current files without Git isolation or publication.
4. Core runs the configured validation command. Fresh Claude workers review the diff and repair findings. Core checks
   inspection coverage and candidate freshness; the coordinating conversation cannot waive those checks.
5. If a validation command is missing, Claude shows Core's exact question. If your request or approved Plan supplies
   the command, it shows that source and the answer. Otherwise, it asks you. It must not guess a command silently.
6. Review the code when Core requests it. Feedback starts repair and validation, then opens the changed diff for a new
   decision. Chat alone cannot approve or reject a Plan or diff.
7. Core confirms delivery and reports the Work Record outcome. Implementation completion alone is not Verified.
   If publication has a repairable conflict, Core asks a fresh Claude worker to resolve and stage files in the
   publication directory. Core then completes publication without repeating passed checks or recording.

Core owns publication. Do not ask a worker to create another worktree, commit, merge, or push around Core's gates.
The recorded landing follows the project's [Plan delivery settings](settings.md#plan-delivery); an onward PR or merge
can remain the owner's responsibility. Claude suggests manual checks in the conversation rather than saving a Manual
QA checklist. Work Record supersession proposals use `wld wr supersede` separately.

## Review chat and waiting

Use the chat on the Plan review or code review page for questions and change requests. The active Claude turn reads
pending chat through Core, replies to the exact queued turn, and handles requests in order. Change requests do not
reuse an earlier approval.

Status responses are compact. A bounded wait returns when the workflow changes or after at most 30 seconds; the active
turn can wait again. Instructions and chat are fetched explicitly. Prompts and reports have bounded UTF-8 reads; diff
reads also record inspection coverage. Large artifacts are not repeated in every status response.

A browser decision is durable even if Claude stops waiting. If its turn has ended, resume with the command below;
Connect does not push a new model turn into an idle Claude session. Closing the page is not approval or abandonment.

## Resume after interruption

Use these commands in the same project, including from a new Claude Code conversation:

| Command                 | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `/runwield:plan-review` | Reopen the pending Plan review or retrieve its saved outcome.         |
| `/runwield:implement`   | Start a saved ready Plan or restore its implementation handoff.       |
| `/runwield:validate`    | Continue or restore validation, code review, recording, and delivery. |

Do not start another `/runwield:request` to resume the same work. Core loads its saved action and revision. A review
page hosted by the old Claude process stops when that process closes; the resume command hosts the pending review
again. Work already accepted by Core remains recorded. A stale action, changed diff, or process interruption cannot
supply a new approval or duplicate an accepted outcome.

## Update and version messages

Update the marketplace and plugin from Claude Code:

```text
/plugin marketplace update runwield
/plugin update runwield@runwield
```

Update Core with the installer or package manager you used. For example, rerun the Quickstart installer, or use
`brew upgrade gandazgul/tap/wld` or `winget upgrade --id Gandazgul.RunWield --exact`. Use `claude update` for Claude Code.

Core checks every evidence-carrying operation, not just activation:

- **Compatible:** the host version and adapter contract are in the matrix.
- **Newer, not yet tested:** continue with a visible notice; this does not add a tested version.
- **Version not reported:** continue with a notice; the version floor cannot be checked.
- **Older than the tested floor:** update Claude Code before continuing.
- **Incompatible adapter:** follow Core's exact plugin or Core update guidance. The rejected operation changes no
  workflow, Plan, or execution checkout. Status remains available for recovery.

## Disable or uninstall

In Claude Code:

```text
/plugin disable runwield@runwield
/plugin uninstall runwield@runwield
```

Use either command as needed. This removes access to the plugin; it does not delete Plans, Work Records, pending
reviews, execution checkouts, or Core's recovery evidence. Ordinary Claude use works without RunWield activation.
Reinstall the plugin, then use a resume command to continue saved work. Disable or uninstall is not abandonment.

## Local artifacts and privacy

Core keeps:

- Ordinary Plan files under `docs/plans/`, plus the project's Work Records and workflow evidence.
- A per-request Attached Workflow Record under `~/.wld/attached/`, keyed by the primary checkout.
- Core-owned execution, validation, review, and publication evidence needed for recovery.

The record references the Plan rather than replacing its lifecycle. Current role instructions are loaded from project,
home, and bundled definitions when requested; they are not stored as a transcript. Review chat is temporary workflow
context, not a permanent conversation archive.

Core does not import or save the Claude conversation. Claude Code controls its own history and model credentials.
Do not paste a transcript into a Plan, worker report, or Work Record. Core stores explicit workflow outcomes, not a
copy of your host conversation.

## Connect, Core's Claude backend, and ACP

- **Connect:** Claude Code owns the conversation and every worker/model call. Core governs durable workflow truth.
- **Core's Claude CLI execution backend:** RunWield owns the Session and dispatches work through Claude CLI. This is
  not Connect. See [Providers and models](providers.md).
- **ACP:** an external client connects to a RunWield-owned Session. Core still runs the Agent turns. See
  [Using RunWield](usage.md).

This Preview covers one FEATURE journey in Claude Code. It does not claim stable support, other External Agent Hosts,
other Routing Intents, `/runwield:init`, hooks, or enforced host role restrictions.
