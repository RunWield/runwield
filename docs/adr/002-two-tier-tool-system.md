---
status: accepted
---

# ADR-003: Two-Tier Tool System (Core vs Agent Tools)

## Context

RunWield uses a layered agent definition system where users can override bundled agent configurations via local
(`.wld/agents/`) or home (`~/.wld/agents/`) markdown files. The `tools:` frontmatter list determines which tools an
agent can use.

As RunWield adds infrastructure tools (`codebase_search`, `memory_recall`, `return_to_router`, `triage_report`,
`plan_written`), a tension emerges: these tools are foundational to how the SDLC works — removing them breaks the
system's ability to route, plan, and recall context. But the override system allows users to replace the entire tool
list, potentially crippling agents unintentionally.

The design question: how to provide a curated, "it just works" experience while still allowing customization for
developers who code differently?

## Decision

Introduce a **two-tier tool classification**:

### Core Tools

Tools that are infrastructure for the RunWield SDLC. They cannot be removed by user overrides:

- `codebase_search` — semantic code retrieval
- `memory_recall`, `memory_recall_global` — memory search
- `memory_store`, `memory_store_global` — memory creation
- `memory_delete` — memory removal
- `return_to_router` — hand-off back to Router for fresh triage
- `triage_report` — Triage Report output that drives post-triage workflow dispatch
- `plan_written` — planner/architect plan declaration

### Agent Tools

Tools that define what an agent _can do_ — customizable via frontmatter overrides:

- `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, `user_interview`, etc.

### Implementation

Core tools remain in the bundled agent frontmatter `tools:` lists — this is the source of truth for which agent gets
which core tools by default. Not every core tool goes to every bundled agent, but adding a workflow tool to another
Agent should preserve the same runtime semantics.

On `loadAgentDef`, after the layered merge (bundled → home → local), the system ensures core tools from the **bundled**
layer are always present in the final tool set. User overrides cannot remove them, only add. The merged list is
deduplicated.

Concretely:

- Bundled `router.md` lists `triage_report`, `codebase_search`, `memory_recall`, etc.
- A user override at `.wld/agents/router.md` with `tools: [read, bash]` won't strip the core tools — they're re-injected
  from the bundled layer.
- Users CAN add core tools to agents that don't have them by default (e.g., adding `triage_report` to a custom Agent or
  adding `memory_list` to a custom Agent).

### Bash command policy within Agent tools

`bash` remains an Agent tool: a `bashAllowedCommands` front matter field limits its use but never adds it to a toolset.
Bundled Guide and read-delegate definitions list permitted inspection commands; write delegates have no default list.
For layered Agent definitions, omission inherits, a list replaces, `[]` denies all, and `null` resets the definition's
inherited list to unrestricted. An absent list means unrestricted bash. Delegated Sessions intersect the effective
parent's list with the child's definition list after role authority is resolved. A child's omission or `null` cannot
remove a parent restriction; without parent bash, the child does not gain bash. These limits apply to RunWield-managed
foreground Pi bash and background shell starts, not to external CLI Execution Backends' native shells.

The command check permits single commands with approved literal token prefixes and ordinary arguments, while rejecting
shell composition, expansion, wrappers, and known write or execution options. Denial explains the effective commands and
asks the Agent to report a blocker if they are insufficient. It is best-effort convenience filtering, **not a sandbox**:
shell startup, Git configuration, executable lookup, and incomplete option coverage can still have effects. Restricted
Pi Sessions omit Snip because its rewrites require compounds and temporary files. Guide's explicitly requested docs-only
Markdown writing remains separate from the shell limit. See
[customization](../user-documentation/customization.md#agents) for syntax and
[Core customization](../prd/runwield-core-prd.md#agent-and-skill-customization) for the user contract.

### Escape Hatch

If a user truly wants to replace a core tool's behavior (e.g., with a custom search extension), extensions that register
a tool with the same name would override the built-in implementation. The tool still exists in the agent's toolset —
just with different behavior. This preserves the system contract while allowing power-user customization.

## Consequences

### Positive

- **Curated experience** — the SDLC pipeline (route → plan → execute → recall) always works out of the box.
- **Safe customization** — users can add/remove agent-capability tools without accidentally breaking infrastructure.
- **Clear mental model** — "core tools are the system; agent tools are the capabilities."
- **Simpler agent definitions** — as core tools are guaranteed, prompts and documentation can assume their presence.

### Negative

- **Slight complexity in `loadAgentDef`** — the merge logic needs to identify and protect bundled core tools.
- **Less flexibility for radical customization** — users who want a completely different SDLC would need to fork rather
  than override. This is intentional — RunWield is opinionated, and those users should use Pi directly.
