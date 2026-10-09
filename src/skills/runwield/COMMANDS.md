# RunWield commands

Use this file for command orientation. Keep each answer brief; link to https://docs.runwield.dev/usage/ for full usage.

## CLI commands

- `wld router`: triage a request through Router; default when no command is given.
- `wld acp` or `wld --mode acp`: start the Agent Client Protocol stdio server for external clients.
- `wld agent`: list Agents, or start a request with a selected Agent.
- `wld login`: configure provider credentials and choose a usable default model, then exit.
- `wld model`: set the default model from a `provider/model_id` value.
- `wld load-plan`: load a saved Plan by name or path and continue its lifecycle.
- `wld plans`: list active Plans and open Plan management subcommands.
- `wld workspace`: start the paired-device owner Workspace with `serve`, or approve a browser with `pair <code>`.
- `wld wr`: list, search, read, backfill, or repair the Work Record index.
- `wld sleep`: back up and consolidate Memory, then keep Engineer active for follow-up.
- `wld help`: show global or command help.
- `wld version`: print RunWield version and platform architecture.
- `wld update`: install the latest Stable release with the public installer.
- `wld init`: explore a project, write project context, and store durable project Memory.
- `wld theme`: switch or list TUI themes.
- `wld install`: install package themes, prompt templates, or compatible extensions.
- `wld remove`: uninstall an installed package source.
- `wld snip-filters`: install, inspect, or remove RunWield-managed Deno Snip filters.

Global flags:

- `--continue`: resume the most recent interactive session instead of starting fresh.
- `--help`: show global help or command help.
- `--version`: print version and architecture information.
- `--mode acp`: run ACP stdio mode instead of the TUI.

## `wld plans` subcommands

- `wld plans`: list active saved Plans.
- `wld plans read <plan>`: open active or archived Plan Markdown read-only in a browser.
- `wld plans doctor`: fix all safe Plan and worktree problems.
- `wld plans doctor --repair`: same repair behavior, kept for compatibility.
- `wld plans doctor --check`: report problems without changing files.
- `wld plans share <plan>`: publish an encrypted Shared Space and print secret URLs once.
- `wld plans pull <url-or-plan>`: fetch remote revisions/comments and update or create a locked local Plan.
- `wld plans push <plan>`: publish the local shared Plan as the next encrypted remote revision.
- `wld plans unshare <plan>`: destructively delete the remote Shared Space and clear local sharing metadata.
- `wld plans archive`: list archived Plans or move terminal Plans under `docs/plans/archived/`.
- `wld plans archive restore <plan>`: restore an archived Plan to active Plan storage.
- `wld plans ui`: open the local read-only Plan Board for the current checkout.

## `wld wr` subcommands

- `wld wr list`: list current usable Work Records; add `--all` for maintenance states.
- `wld wr search <query>`: search the derived Work Record index; add `--all` for maintenance states.
- `wld wr read <recordId>`: open one canonical Work Record read-only in a browser.
- `wld wr backfill`: generate or link missing Work Records for completed Plans and Epics.
- `wld wr index rebuild`: rebuild the derived Work Record search index from Markdown.

## Slash commands

- `/login`: configure subscription or API-key credentials and switch the live Session model.
- `/logout`: remove stored credentials.
- `/status`: show configured providers and available models.
- `/model`: switch the active model for the current Session.
- `/agent`: switch the active Agent.
- `/init`: initialize the current project.
- `/load-plan`: open a Plan selector or continue a saved Plan.
- `/plan-review`: in an existing Session, show the live Plan review link or reopen that Session's most recent review of
  the current saved Plan without a planning turn. Takes no arguments. A past review does not restore a pending answer;
  busy Sessions and missing or no longer reviewable Plans receive an explanation. Available in TUI, ACP, and the
  Workspace Session composer.
- `/resume`: browse and resume a recent Session.
- `/new`: start a new root Session.
- `/name`: set or show the current Session name.
- `/session`: show current Session information and cumulative token totals.
- `/context`: show active Agent Session context-window usage and resident context estimates.
- `/sleep`: run safe Memory backup and cleanup.
- `/compact`: compact Session context.
- `/settings`: open compaction and model preset settings.
- `/theme`: pick a theme.
- `/reload`: reload settings, instructions, prompts, skills, models, themes, and memories.
- `/export`: export the current Session to HTML or JSONL.
- `/share`: export and upload the Session as a secret GitHub Gist.
- `/copy`: copy the last assistant message to the clipboard.
- `/help`: show command help.
- `/version`: show version and architecture information.
- `/quit` and `/exit`: exit the TUI.

Prompt templates and skills can also appear as slash commands when they do not collide with built-ins.

## TUI input mechanics

- Type `@` to search and attach project file references.
- Use `!command` to run a shell command and send output to the model.
- Use `!!command` to run a shell command without adding output to model context.
- Press Escape to cancel a running turn.
- Type while the Agent is busy to queue the next message.
- Paste images when the model supports images or `visionFallback` is configured.

## Session management

- Use `wld login` for setup before a Session starts. ACP Terminal Auth appends `login` to `wld acp` and runs the same
  setup flow.
- Use `/new`, `/resume`, `/session`, `/context`, `/compact`, `/export`, and `/share` to manage Sessions in the TUI.
- Use `--continue` to resume the most recent Session from the CLI.
- RunWield stores Sessions under `~/.wld/sessions/`, separate from Pi's `~/.pi/agent/sessions/`.
