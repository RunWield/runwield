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

Agents are Markdown files with YAML front matter. Put a file in `.wld/agents/` or `~/.wld/agents/` to change a bundled
Agent's prompt, role, or tools, or to add a new Agent. Use the same name as a bundled Agent to override it.

An override can leave fields out; missing fields come from the next layer down.

To change an Agent's model, use [`agents`](settings.md#agents) in settings instead.

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
- A list replaces the list from a lower layer; the two aren't combined.
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
