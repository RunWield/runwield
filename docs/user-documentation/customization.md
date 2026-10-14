# Customization

You can change RunWield's Agents, prompt templates, and Skills for one project or for all your projects. For settings,
see the [Settings reference](settings.md); for themes, see [Themes](themes.md).

For the underlying concepts, see [Pi Skills](https://pi.dev/docs/latest/skills) and
[Pi Prompt Templates](https://pi.dev/docs/latest/prompt-templates).

## Where customizations live

RunWield looks in three places, and the first match wins:

1. The project: `.wld/`
2. Your home folder: `~/.wld/`
3. The defaults bundled with RunWield

So a project file overrides your personal one, and your personal one overrides the bundled default.

Run `/reload` after editing anything here so the current Session picks it up.

## Agents

An Agent is a Markdown file with YAML front matter. The front matter sets its name, tools, and behavior; the body is its
prompt. Put a file in `.wld/agents/` or `~/.wld/agents/` to change a bundled Agent or to add a new one.

The file name is the Agent's ID: `.wld/agents/reviewer.md` defines the `reviewer` Agent, which you start with
`/agent reviewer` or `wld agent reviewer`. IDs use lowercase letters, numbers, and hyphens. A file with the same name as a
bundled Agent, such as `engineer.md`, customizes that Agent instead of creating a new one.

The bundled Agents are `guide`, `ideator`, `planner`, `architect`, `engineer`, `operator`, `tester`, `router`,
`plan-engineer`, `frontend-engineer`, and `recorder`. Run `wld agent` to see the ones you can pick by hand.

### How layers merge

Agent files don't replace each other the way other customizations do. RunWield reads every layer that has the file, from
the bundled default up to your project, and merges them:

| Part                  | How it merges                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| Prompt (the body)     | Each layer's body is **added after** the one below it. Set `promptOverride: true` to discard lower ones. |
| Most front matter     | A field set in a higher layer replaces it; a field you leave out comes from the layer below.             |
| `tools`, `toolSets`   | Together they replace the whole list from the layer below. Protected tools can't be removed (see below). |
| `sharedPractice`      | Replaces the whole list from the layer below.                                                            |
| `bashAllowedCommands` | A non-empty list adds to the list below. See [Limiting shell commands](#limiting-shell-commands).        |

So a file that contains only a body adds instructions to the bundled Agent and keeps everything else. Front matter is
still required, even if it's empty (`---` on two lines).

`promptOverride` applies only to the layers below the file that sets it. If `~/.wld/agents/guide.md` sets it and
`.wld/agents/guide.md` doesn't, the project body is added after your personal one, and the bundled body is dropped.

Some tools are **protected**: if the bundled Agent has one, a narrower tool list in an override gets it back anyway.
They cover memory, code exploration (`code_*`), web access (`web_*`), and workflow tools such as `task_completed`,
`plan_written`, and `user_interview`, which RunWield needs to move work forward.

Model, thinking level, and temperature in an Agent file are defaults. [`agents`](settings.md#agents) and
`defaultModel` in settings win over them, so use settings to pick models.

### Front matter fields

| Field                 | Use                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `name`                | The name shown in the UI, such as `Code Reviewer`. Required for new Agents.                 |
| `description`         | One line shown in `wld agent` and the `/agent` picker.                                      |
| `toolSets`            | Groups of tools to include. See [Tool sets](#tool-sets).                                    |
| `tools`               | Individual tools, added after any `toolSets`. Leave both out for a conversation-only Agent. |
| `bashAllowedCommands` | Limit the shell to specific commands.                                                       |
| `sharedPractice`      | Shared prompt fragments to add after the body. See [Shared practices](#shared-practices).   |
| `promptOverride`      | `true` discards the prompt from lower layers.                                               |
| `model`               | A fallback `provider/model`, used only when settings don't choose one.                      |
| `thinkingLevel`       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.                               |
| `temperature`         | A sampling temperature, such as `0.4`.                                                      |
| `busyLines`           | Status messages shown while the Agent works.                                                |
| `workflowOnly`        | `true` hides the Agent from `/agent`; RunWield can still activate it in a workflow.         |

### Tool sets

`toolSets` gives an Agent a group of related tools without listing each one:

| Set     | Tools                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | `read`, `grep`, `find`, `ls`, the code exploration tools (`code_search`, ...), `memory`, `user_interview`, Work Record search, read-only delegation |
| `write` | `edit`, `write`, `multi_file_edit`, write delegation                                                                                                |
| `docs`  | `write_docs`, `edit_docs`: create and edit Markdown files only                                                                                      |
| `shell` | `bash`, `background_task`                                                                                                                           |
| `web`   | `web_search`, `web_fetch`, `web_code_search`, `web_docs_search`                                                                                     |

Use `tools` alongside it for anything else, such as image generation:

```yaml
toolSets: [read, docs]
tools: [create_image]
```

If a file sets either `toolSets` or `tools`, the two together make that layer's whole list, and it replaces the one
below. An unknown set name is an error, so a typo can't quietly leave an Agent without tools.

#### Limiting delegation

`delegate_agent` lets an Agent hand a bounded task to a separate helper session, either to investigate (read) or to make
changes (write). You choose which kinds an Agent may start:

| In `tools`             | The Agent can delegate                 |
| ---------------------- | -------------------------------------- |
| `delegate_agent_read`  | Investigation only                     |
| `delegate_agent_write` | Changes only                           |
| `delegate_agent`       | Both, which is what bundled Agents use |

The `read` set includes `delegate_agent_read` and the `write` set includes `delegate_agent_write`, so `[read]` gets
investigation and `[read, write]` gets both. The Agent only sees the kinds it's allowed, and RunWield refuses any other.
A helper never gets more tools than the Agent that started it.

For the full list of tools, open any bundled Agent in
[`src/agent-definitions/`](https://github.com/gandazgul/runwield/tree/main/src/agent-definitions) and look at its
`tools` list.

### Examples

**Add project rules to a bundled Agent.** This keeps Engineer's prompt and tools and adds your rules after them:

```markdown
---
---

## Project rules

- Run `bun run test` before calling the task done.
- Never edit files under `vendor/`.
- New modules are TypeScript.
```

Save it as `.wld/agents/engineer.md` for one project, or `~/.wld/agents/engineer.md` for all of them.

**Rename an Agent and change how it talks.** Front matter fields replace only themselves:

```markdown
---
name: Sherpa
busyLines:
    - "Checking the map..."
temperature: 0.3
---

Answer in short paragraphs. Lead with the file path when the answer is about code.
```

Saved as `~/.wld/agents/guide.md`, this changes Guide's name, status lines, and temperature, and adds a style rule.

**Let Guide run one more command.** Because `bashAllowedCommands` adds to the bundled list, this keeps Guide's commands
and adds `td`:

```markdown
---
bashAllowedCommands:
    - td
---
```

**Make Operator read-only.** A tool list replaces the bundled one, so you list only what you want to keep:

```markdown
---
description: "Read-only operations helper for this repo."
toolSets: [read, shell]
bashAllowedCommands:
    - git status
    - git log
    - git diff
---

Don't change files. Explain the commands the user should run instead.
```

Operator's protected workflow tools, such as `task_completed`, stay available.

**Replace an Agent's prompt entirely.** Use `promptOverride` when you want to write the prompt from scratch:

```markdown
---
promptOverride: true
---

You are a careful test writer. Read the code under test, then add focused tests next to it...
```

RunWield's core system prompt and the Agent's shared practices are still included.

**Add a new Agent.** Use a name no bundled Agent has, and give it a `name`, `description`, and tools:

```markdown
---
name: Docs Writer
description: "Writes and updates user-facing docs in docs/."
temperature: 0.5
sharedPractice:
    - user-authority
    - plain-language-dialogue
toolSets: [read, docs]
---

You write documentation for the people who use this project, not for its developers.

- Read the code before describing behavior. Don't document what you haven't verified.
- Keep each page focused on one task. Link to related pages instead of repeating them.
- Ask before deleting or moving a page.
```

Save it as `.wld/agents/docs-writer.md` and start it with `/agent docs-writer`. The Router doesn't send requests to
your own Agents; switch to them yourself.

**Add a conversation-only Agent.** Leave out `toolSets` and `tools`, and the Agent can only talk. That's useful for
brainstorming or rubber-ducking without it touching your files:

```markdown
---
name: Sounding Board
description: "Talks ideas through. Doesn't read or change files."
temperature: 0.8
---

Ask one question at a time. Point out the weakest part of an idea before its strengths.
```

**Share a team Agent and keep personal tweaks.** Commit `.wld/agents/reviewer.md` to the repository so everyone gets
it. A teammate's `~/.wld/agents/reviewer.md` still merges underneath it: their body comes first, then the project's.

### Shared practices

A shared practice is a prompt fragment several Agents reuse. `sharedPractice` names fragments to add after the Agent's
prompt, so the prompt reads Agent, then practices. The bundled ones are in
[`src/agent-definitions/shared-practice/`](https://github.com/gandazgul/runwield/tree/main/src/agent-definitions/shared-practice),
for example `user-authority`, `working-tree-safety`, and `plain-language-dialogue`.

To add your own, create `.wld/agents/shared-practice/<name>.md` or `~/.wld/agents/shared-practice/<name>.md` with front
matter and a non-empty body:

```markdown
---
name: Ticket Hygiene
description: "Reference the ticket in every commit and PR."
---

Every commit message and pull request title starts with the ticket ID, such as `WLD-123:`.
```

Then list it in any Agent's `sharedPractice`. Unlike Agent files, shared practices don't merge: a project fragment with
the same name as a personal or bundled one replaces it. Remember that `sharedPractice` replaces the inherited list, so
include the bundled entries you want to keep.

### Limiting shell commands

`bashAllowedCommands` limits which shell commands an Agent may run:

```yaml
bashAllowedCommands:
    - git status
    - git diff
    - ls
```

- Each entry is a command prefix, matched word by word. `git status` allows `git status --short` but not
  `git status-other`.
- The Agent can run one command at a time with ordinary arguments. Pipes, `&&`, redirects, and variable expansion are
  refused.
- `[]` allows no shell commands. `null` removes a list inherited from a lower layer.
- A non-empty list adds commands to the list from a lower layer. Duplicate entries appear only once. For example,
  `bashAllowedCommands: [td]` in `~/.wld/agents/guide.md` keeps Guide's built-in commands and adds `td`.
- The list only limits the shell. It doesn't give an Agent shell access it doesn't already have.

This is a convenience filter, **not a sandbox**: an allowed command can still have side effects. Claude CLI and
Antigravity CLI use their own shell permissions, which this list doesn't change.

## Prompt templates

A prompt template is a Markdown file that becomes a slash command. `.wld/prompts/commit.md` becomes `/commit`, and
`/commit staged changes` sends the template with "staged changes" as its argument.

RunWield looks for templates in `.wld/prompts/`, `~/.wld/prompts/`, the bundled templates, then installed packages. A
template can't replace a built-in command such as `/help`; RunWield warns you at startup if one tries.

### Bundled prompts

Run these in a Session as slash commands, or start one from your terminal with `wld /<name>`.

| Prompt            | What it does                                                                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/commit`         | Inspects all pending changes, groups unrelated work into separate commits, writes commit messages, stages, commits, and pushes upstream. Its scope includes pending changes unrelated to the current conversation.                                                                       |
| `/release`        | Runs with Engineer, asks whether to create a Candidate, promote a Candidate, or create Stable directly, then follows the repository's release policy and automation. Prepares release notes, confirms before publishing or other network-visible side effects, and monitors the release. |
| `/code-optimizer` | Walks the codebase from its entry points and improves clarity, maintainability, types, and documentation. Offers a planned refactor when a change needs broader work.                                                                                                                    |
| `/test-seams`     | Runs with Engineer and inspects representative code and tests for fakes that replace product-owned behavior. Reports evidence, uncertainty, and fixture-based alternatives; asks how to handle findings before persisting them.                                                          |

`/test-seams` is an optional advisory audit. Initialization does not run it. It distinguishes internal machinery from
legitimate external boundaries such as networks, clocks, and hosted services. It does not change code, add CI rules, or
claim the project is clean when no candidates are found. Use it when you want to examine whether tests exercise real
project behavior.

### Template settings

Front matter can set:

```yaml
description: "Explain the current diff"
argument-hint: "<focus>"
agent: operator
model: anthropic/claude-sonnet-4-5
thinkingLevel: low
```

`agent`, `model`, and `thinkingLevel` switch the Session to those settings and keep them for follow-up messages. Fields
you leave out keep the Session's current settings. In a brand-new Session, templates run with Operator by default, so
`wld /commit` works without front matter.

If a template asks for a different Agent while a workflow, such as a Plan, is still running, RunWield offers to open it
in a new Session instead, so the workflow isn't interrupted.

## Skills

A Skill is a folder with a `SKILL.md` file that teaches an Agent how to do a specific task. Agents see each Skill's name
and description and load the full instructions when they need them. You can also run one directly with `/skill:<name>`;
it runs in the current Agent's turn.

RunWield looks for Skills here, and the first match wins:

1. `.wld/skills/` in the project
2. `.agents/skills/` in the project
3. `~/.wld/skills/`
4. `~/.agents/skills/`
5. The bundled Skills

Skills in an `.agents/skills/` folder can't use a bundled Skill's name. To replace a bundled Skill, put yours in a
`.wld/skills/` folder. To ignore both `.agents/skills/` folders, set
[`enableExternalSkills`](settings.md#runwield-custom-keys) to `false`.

Bundled Skills:

| Skill                           | Use                                                    |
| ------------------------------- | ------------------------------------------------------ |
| `agent-browser-use`             | Open a real browser to check UI work.                  |
| `codebase-design`               | Design module interfaces.                              |
| `diagnose`                      | Track down a bug methodically.                         |
| `documentation`                 | Write or update project docs.                          |
| `front-end-framework-use`       | Frontend work that follows the project's framework.    |
| `improve-codebase-architecture` | Find architecture improvements, with a visual report.  |
| `prompt-writing`                | Write or tighten prompts for AI systems.               |
| `prototype`                     | Build a throwaway prototype to test an idea.           |
| `research`                      | Research a question and write a cited note.            |
| `resolving-merge-conflicts`     | Resolve a Git merge or rebase conflict.                |
| `review`                        | Review a pull request, branch, or uncommitted changes. |
| `runwield`                      | Answer questions about using RunWield.                 |
| `show-me`                       | Explain a topic visually.                              |
| `tdd`                           | Build with a red-green-refactor loop.                  |
| `wizard`                        | Walk you through setup steps an Agent can't do.        |
| `write-a-skill`                 | Write or edit a Skill.                                 |
| `write-tests`                   | Add or repair automated tests.                         |

RunWield doesn't load Skills from Pi settings or Pi packages. To install a Skill from a package, use
`npx skills add <source>`.
