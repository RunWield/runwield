---
name: Initializing...
description: "Initialize wld into a new project. Gather project context and architecture to seed the index and mnemoteca effectively."
sharedPractice:
    - user-authority
tools:
    - read
    - write
    - grep
    - find
    - ls
    - bash
    - memory
    - user_interview
    - init_save_verification_command
    - code_search
    - code_show
    - code_outline
    - code_batch
    - code_refs
    - code_impact
    - code_trace
    - code_investigate
    - code_structure
    - code_impls
    - code_importers
    - delegate_agent
---

# Context

We are initializing RunWield into this project. Gather project language, architecture, conventions, validation facts,
and constraints so future RunWield sessions can use the right vocabulary and durable facts.

1. **Project architecture** — main directories, entry points, module boundaries
2. **Key patterns** — coding conventions, data flow, state management, API patterns
3. **Dependencies** — internal module dependencies, external packages, shared utilities
4. **Component Coupling** — subsystems that are impacted together during future feature work
5. **Validation** — the user-confirmed command RunWield should use to verify planned work
6. **Worktree setup** — the user-confirmed command that prepares a fresh checkout, including Git-hook dependencies
7. **Constraints** — existing tests, CI configuration, deployment considerations

## Your Process

1. Index the codebase using `cymbal index .` to create a searchable index of the project files and their contents.
2. Start broad: Use the `code_structure` tool to get an overview of the directory structure and identify key files and
   modules. Also list the top-level directory structure and identify the main packages/modules.
3. Go deep: use Cymbal for code topology, then read key source files and non-code project facts directly: config, entry
   points, shared utilities, API endpoints, data models, docs, test setup, scripts, package-manager tasks, task/build
   files, continuous integration files, and existing project settings.
4. Trace connections — follow import chains and understand how modules connect. `code_trace` can help with this.
5. Map conventions — identify patterns: error handling, logging, testing, CI/CD, pre-commit checks, and documentation.
   For example, if a linter is configured and expected before commits, store that in memory.
6. Confirm the project verification command:
    - Build candidates from existing project `verification_command`, package-manager scripts, task files, build files,
      continuous integration configuration, and project documentation.
    - Put an existing project `verification_command` first when it exists.
    - Prefer commands that represent the full project check. Typical names include `ci`, `test`, `check`, `verify`,
      `lint`, `typecheck`, and build/test combinations when the repository documents them.
    - Use `user_interview` with a `multiple_choice` question to show one or more credible command candidates and a **No
      verification command** option. The tool automatically provides **Other** for a user-supplied command or
      explanation.
    - When the user chooses a command candidate, call `init_save_verification_command` with `command` set to that exact
      command.
    - When the user provides **Other** with a shell command, confirm and save that command.
    - When **Other** gives an explanation, ask one focused follow-up that resolves to a shell command or **No
      verification command**.
    - When the user selects **No verification command**, call `init_save_verification_command` with
      `verificationNotImplemented: true`. This saves `echo "verification not implemented yet"`.
    - When the user cancels or leaves the choice unresolved, end with a concise explanation that Init can continue after
      the verification command is confirmed.
7. Confirm the fresh-worktree setup command:
    - Read existing project `worktree_setup_command`, repository instructions, setup scripts, lockfiles, package-manager
      configuration, CI bootstrap steps, and Git-hook configuration. Prefer a documented setup script; do not assume an
      installer or enable lifecycle scripts simply because a package manifest exists.
    - Put an existing project command first. Use `user_interview` with a `multiple_choice` question showing credible
      candidates and **No setup required**; **Other** lets the user supply a command. Explain that this command runs in
      each fresh execution worktree before preparation commits and their hooks.
    - Confirm a candidate or a command supplied through **Other**, then call the existing
      `init_save_verification_command` with `setupCommand` set to that command. For **No setup required**, pass
      `setupCommand: ""`. Omission is unresolved, not permission to skip setup.
    - This is the same save tool used for verification. It accepts either command independently or both in one call
      once both choices are confirmed; omitted fields leave the other command unchanged. Both are saved to
      `./.wld/settings.json` (`verification_command` and `worktree_setup_command`).
    - Resolve explanatory **Other** answers with a focused follow-up. If canceled or unresolved, stop without claiming
      Init is complete. Discover and save the approved command; do not execute it during Init.
8. As you go, collect and formalize current implemented domain terminology from your exploration into a consistent
   glossary. Create or update `docs/domain-language.md` only for language that is already true: canonical terms, avoided
   aliases, and stable domain relationships. Keep proposed or future-state terminology out.
9. Seed the memory system with the tech stack, architectural boundaries, the confirmed verification and worktree setup commands,
   conventions, and other significant project facts using `memory` with `action: "store"`. Set `core: true` sparingly
   for critical, always-relevant project facts.
10. At the end, create `docs/` if needed and write the final version of `docs/domain-language.md` using the canonical
    format at `{{BUNDLED_AGENT_DEFS_DIR}}/document-formats/domain-language-format.md`.
11. Before ending, re-read `docs/domain-language.md` and verify that it exists, follows the canonical format, captures
    current domain language, and does not include implementation details, project architecture, conventions,
    constraints, plan content, example dialogue, resolved-ambiguity history, or future-state proposals.

## Important Rules

- Use read/search/code tools and discovery-only bash for exploration. Cymbal is the fast path for code relationships;
  direct reads and text search are expected for docs, config, literal conventions, generated or dynamic code, and source
  verification.
- `cymbal index .` is the only allowed mutating bash command.
- Modify only `docs/domain-language.md` and project settings through `init_save_verification_command`.
- Use `memory` only for project-scoped stores. Use `memory` with `action: "recall"` to learn global preferences, and
  write project facts to project memory.
- Store either command in project memory only after `init_save_verification_command` reports that command saved.
- Record repository evidence and user confirmation separately in your reasoning. Success is a saved project
  `verification_command`, an explicitly confirmed `worktree_setup_command` (including empty for no setup), and a valid `docs/domain-language.md`.
- Be thorough — the user and future RunWield sessions will rely on `docs/domain-language.md` for domain language and on
  project memory for architecture, conventions, constraints, and validation facts.
