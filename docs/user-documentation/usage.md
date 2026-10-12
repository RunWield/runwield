# Using RunWield

This page covers day-to-day commands and where RunWield keeps its data. For how RunWield handles a request, see
[Plans and workflows](workflows.md).

Editor features, terminal shortcuts, image paste, and message queueing work as in Pi. See
[Pi Usage](https://pi.dev/docs/latest/usage) and [Pi Keybindings](https://pi.dev/docs/latest/keybindings).

## Starting RunWield

```bash
wld                         # start an interactive Session
wld "fix the parser bug"    # send one request; the Router decides how to handle it
wld agent                   # list Agents
wld agent engineer "…"      # send a request straight to one Agent, skipping the Router
```

## Signing in

```bash
wld login
```

Choose a subscription or API-key provider, then a default model. The command succeeds only when both are ready; if you
cancel, your existing credentials are kept. Inside a Session, `/login` does the same and switches the Session to the
model you chose. See [Providers and models](providers.md).

ACP clients that support terminal sign-in can open this same flow for you.

## Agents

| Agent     | Role                                                        |
| --------- | ----------------------------------------------------------- |
| Router    | Sorts new requests and hands them to the right Agent.       |
| Guide     | Answers questions about your code and RunWield.             |
| Ideator   | Explores and sharpens ideas; can write PRDs.                |
| Operator  | Handles Git, releases, dependencies, and other maintenance. |
| Planner   | Writes Plans for planned changes.                           |
| Architect | Designs large projects as Epics.                            |
| Engineer  | Makes quick fixes.                                          |
| Tester    | Tests behavior and UI, and hunts for bugs.                  |

Plans are built by Engineer, or by Frontend Engineer for browser UI work; you choose during Plan review. Agents you add
in `.wld/agents/` or `~/.wld/agents/` also appear in `wld agent`.

Switch Agents with `/agent <name>`. To change an Agent's prompt, tools, or model, see [Customization](customization.md)
and [Settings](settings.md#agent-model-overrides).

Agents working on browser UI can open a real browser to check their work, using the bundled `agent-browser-use` Skill.

## Slash commands

Type `/` for completion.

| Command          | Description                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `/login`         | Sign in to a provider.                                                        |
| `/logout`        | Remove stored credentials.                                                    |
| `/status`        | Show configured providers and available models.                               |
| `/model`         | Switch model.                                                                 |
| `/agent`         | Switch Agent.                                                                 |
| `/init`          | Initialize the current project.                                               |
| `/onboard`       | Start the [Tutorial](quickstart.md#try-the-tutorial).                         |
| `/load-plan`     | Continue a saved Plan.                                                        |
| `/resume`        | Resume a recent Session.                                                      |
| `/new`           | Start a new Session.                                                          |
| `/name`          | Set or show the Session name.                                                 |
| `/session`       | Show Session information and token totals.                                    |
| `/context`       | Show context-window usage.                                                    |
| `/sleep`         | Clean up memory and context.                                                  |
| `/compact`       | Compact the conversation.                                                     |
| `/theme`         | Pick a theme.                                                                 |
| `/reload`        | Reload settings, instructions, prompts, Skills, models, themes, and memories. |
| `/mcp`           | Show MCP server status. See [MCP](mcp.md).                                    |
| `/export`        | Export the Session to HTML or JSONL.                                          |
| `/share`         | Upload the Session as a secret GitHub Gist.                                   |
| `/quit`, `/exit` | Exit.                                                                         |

Prompt templates and Skills also appear as slash commands. See [Customization](customization.md).

Not every command is available everywhere:

- **Workspace** hides `/theme`, `/quit`, `/exit`, and `/onboard`.
- **ACP clients** don't get `/copy`, `/theme`, `/quit`, `/exit`, `/new`, `/resume`, `/login`, or `/onboard`.

## CLI commands

```bash
wld help [command]               # help
wld version                      # version and platform
wld login                        # sign in and choose a default model
wld model <provider>/<model_id>  # switch model
wld agent [name] [request]       # list or use Agents
wld init                         # initialize project context
wld onboard                      # start the Tutorial
wld sleep                        # memory and context cleanup
wld plans …                      # list and manage Plans; see Plans and workflows
wld load-plan <name-or-path>     # continue a Plan
wld wr …                         # Work Records; see below
wld workspace serve              # start Workspace; see Workspace
wld theme <name> | --list        # set or list themes
wld install <source>             # install a package (themes, prompt templates)
wld remove <source>              # remove a package
```

Plan commands are covered in [Plans and workflows](workflows.md#working-with-plans), and sharing commands in
[Self-hosted collaboration](collaboration.md).

## Files and shell commands

- Type `@` to search for a project file and attach it.
- `!command` runs a shell command and sends its output to the model.
- `!!command` runs a shell command without sending its output.

## Document links in Agent messages

In terminals that support hyperlinks, an Agent's mention of an existing Project-relative `.md` file is clickable.
Examples include `(docs/guide.md)`, `README.md`, an exact backticked path, and a labeled Markdown link. The visible text
stays the same. Click the link to open the read-only Workspace reader in your browser.

Each tab reads the current file. Reload after an edit to see the change. Close affects only that tab; other links stay
available while the TUI is open. Links are limited to the active Session's Project, including checks that block symlinks
to outside files. Replacing the Session revokes its old links. Exiting the TUI stops the local reader host.

User messages, tool output, code fences, images, external URLs, and non-Markdown paths do not gain these links. A
mention is navigation only: it does not register a Session Artifact. Terminals without hyperlink support keep the
original readable paths and do not show local reader URLs or tokens.

## Math and diagrams

Completed LaTeX math in messages renders as Unicode text in the terminal: inline `$…$` or `\(…\)`, and display `$$…$$`
or `\[…\]`. Formulas that are still streaming or that RunWield can't render stay as source text. Mermaid diagrams in a
closed code fence render as diagrams.

## Images

If your model can see images, paste them into the message. If it can't, set
[`visionFallback`](settings.md#visionfallback) so another model can describe them. To have Agents generate images, set
[`imageGeneration`](settings.md#imagegeneration).

## Work Records

When a Plan finishes, RunWield writes a Work Record to `docs/work-records/`: a Markdown summary of what was done, kept
for future planning. Plans that are part of an Epic don't get their own record; the Epic gets one when it finishes.

```bash
wld wr                         # list Work Records
wld wr list --all              # include older and maintenance records
wld wr search <query>          # search Work Records
wld wr read <recordId>         # open one in a read-only browser view
wld wr backfill                # create missing records for finished Plans
wld wr index rebuild           # rebuild the search index
```

If writing a Work Record fails, the Plan stays finished. Run `wld wr backfill` to try again. To stop automatic Work
Records, set [`workRecords.autoGenerateOnPlanCompletion`](settings.md#workrecordsautogenerateonplancompletion) to
`false`.

## Where RunWield keeps data

| Data                         | Location                                   |
| ---------------------------- | ------------------------------------------ |
| Global settings              | `~/.wld/settings.json`                     |
| Credentials                  | `~/.wld/auth.json`                         |
| Custom models                | `~/.wld/models.json`                       |
| Sessions                     | `~/.wld/sessions/`                         |
| Global instructions          | `~/.wld/RUNWIELD.md` or `~/.wld/AGENTS.md` |
| Your Agents and prompts      | `~/.wld/agents/`, `~/.wld/prompts/`        |
| Project settings             | `.wld/settings.json`                       |
| Project Agents and prompts   | `.wld/agents/`, `.wld/prompts/`            |
| Plans                        | `docs/plans/`                              |
| Work Records                 | `docs/work-records/`                       |
| RunWield's own project state | `.wld/internal/`                           |

The first time RunWield runs, it copies some Pi configuration files into `~/.wld/` if RunWield's copies don't exist yet.
