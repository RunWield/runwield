---
status: accepted
---

# Initial Technology Stack

## Context

RunWield is designed to be an opinionated, plan-by-default coding harness that
operates directly in the developer's terminal. To ensure high maintainability,
extreme execution speed, and an iteration cycle that feels instantaneous, the
foundational technology stack must be chosen carefully.

We need an environment that allows for rapid scripting without the overhead of
heavy compilation pipelines, while still maintaining strict type safety and
leveraging modern, robust foundations for agentic AI interactions.

## Decision

We have selected the following foundational stack for RunWield:

1. **Release runtime: Bun 1.4.3, with Deno retained for compatibility checks**
    - **Why:** The Bun migration provides standalone executables with embedded
      Workspace and agent assets. Release builds use the pinned `.bun-version`
      and frozen root and docs dependency graphs, and verify the executing
      runtime as well as the release version and build identity. The five
      published platforms retain their canonical archive names and metadata. Bun
      source and Golden gates run alongside native Windows ZIP and Homebrew
      checks; the Candidate channel must pass these gates before publication. See
      [Releasing](../releasing.md).

2. **Language: runtime-native TypeScript**
    - **Why:** Source and tests use TypeScript (`.ts`/`.tsx`) executed directly
      by Bun with real source extensions in imports. TypeScript compiler
      validation runs in no-emit mode through `bun run check`. Workspace
      TypeScript and TSX are checked through Astro via `bun run workspace:check`.
      Normal source execution uses Bun's TypeScript support.

3. **Agent Foundation: `pi.dev` Ecosystem**
    - **Why:** Instead of building an LLM orchestration layer from scratch,
      RunWield will heavily leverage `@mariozechner/pi-coding-agent`, `pi-tui`,
      and related packages from the `pi.dev` ecosystem. These packages provide
      the core state machines, tool-calling wrappers, and terminal UI components
      needed to build a sophisticated agent workflow, allowing RunWield to focus
      strictly on the opinionated DAG execution and architectural routing.

## Consequences

### Positive

- **Standalone Distribution:** Users run compiled Bun executables without
  installing a JavaScript runtime. Development source runs directly under the
  pinned Bun runtime.
- **Repeatable Tooling:** Bun builds and checks use the pinned runtime and
  frozen dependencies. Source and Golden validation use the repository's
  isolated Bun runners; legacy Deno lock interoperability is qualified
  separately.
- **Agent Synergy:** Using `pi-mono` allows RunWield to inherit battle-tested
  LLM abstractions and focus purely on the "Gatekeeper" and planning logic.
- **Type Safety without Friction:** TypeScript no-emit checking provides a
  safety net while development source runs directly under Bun.

### Negative

- **Legacy Compatibility:** Released Deno executables still require lock
  interoperability checks. Their dependency graph must stay separate from Bun
  developer checkouts. Remote containers and legacy documentation publication
  remain transition work; they must not install Deno dependencies into the Bun
  checkout.

## Runtime process boundaries

### Owned command cancellation

Foreground commands own a separate process group on POSIX systems. On macOS, cancellation stops the group and checks
that its members are stopped before sending SIGKILL. A single group kill can miss a child that is still being created,
leaving output pipes open after the shell exits. The check is bounded; probe failure still forces termination so a
command cannot remain suspended. Explicit cancellation also terminates lingering descendants after their shell exits.
Windows keeps its process-tree termination through `taskkill /T`.

### CLI runtime supervision

The CLI entrypoint starts a small supervisor before command imports and initialization. The working Bun runtime runs
in a child process with inherited stdin and stdout. The supervisor forwards stderr, retains bounded diagnostics,
forwards termination signals, and restores terminal modes after failure. This boundary applies to private entries and
protocol commands as well as interactive commands. Source-run and compiled invocations use the same boundary.

The supervisor observes runtime exit rather than closure of a shared stderr pipe. It allows a short drain window for
final diagnostics. A blocked output destination does not consume that window. Detached services can retain stderr
without holding the CLI open; the supervisor does not terminate those services.

This process boundary is required because native runtime aborts, including image-worker event-loop creation under
file-descriptor exhaustion, bypass runtime exception handlers. A shared error classifier gives interactive handlers
and the supervisor consistent OS-resource guidance. Supervision does not retry a command because its external effects
may be uncertain. It does not replace Session or workflow recovery and does not mark a workflow complete or abandoned.
