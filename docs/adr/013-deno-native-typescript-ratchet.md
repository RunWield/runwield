---
status: accepted
---

# 013 - Runtime-Native TypeScript Ratchet

## Context

ADR-000 selected vanilla JavaScript with JSDoc to avoid a TypeScript transpilation or bundling pipeline. That decision
kept early RunWield iteration fast, but the codebase now has enough type-heavy runtime, workflow, and UI boundaries that
native TypeScript syntax is useful for new code.

RunWield still needs Bun-native execution: source files should run directly, imports should use real file extensions,
and CI should type-check with TypeScript no-emit validation, without generated runtime `dist/` output or a CLI bundling step.

## Decision

RunWield will use a mixed JavaScript/TypeScript codebase with a ratchet policy:

- Existing JavaScript and JSX production files remain valid and continue to use JSDoc for typing.
- New production source under `src/` must be TypeScript (`.ts` or `.tsx`) unless it is intentionally added to the
  language-policy baseline.
- TypeScript is executed directly by Bun and checked with the TypeScript compiler in no-emit mode. We will not introduce a `tsc` emit pipeline, runtime `dist/`
  directory, or CLI bundler for normal source execution.
- Imports must use real source file extensions, including `.ts` when importing TypeScript modules from JavaScript.
- Workspace TypeScript and TSX remain checked through Astro/Vite via `bun run workspace:check`; non-Workspace
  TypeScript and TSX are checked by `bun run check`.
- `scripts/language-policy-baseline.json` records current production JavaScript/JSX under `src/`. Migrations remove
  paths from that baseline in the same change that converts them to TypeScript.

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
file-descriptor exhaustion, bypass JavaScript exception handlers. A shared error classifier gives interactive handlers
and the supervisor consistent OS-resource guidance. Supervision does not retry a command because its external effects
may be uncertain. It does not replace Session or workflow recovery and does not mark a workflow complete or abandoned.

## Consequences

### Positive

- New production code can use native TypeScript where it improves clarity and type safety.
- Existing JavaScript remains stable; the ratchet avoids a risky big-bang migration.
- CI prevents accidental growth of production JavaScript while still allowing deliberate exceptions.
- Runtime behavior remains Bun-native and source-directed.

### Negative

- The repository remains mixed-language for some time.
- Import extensions must be maintained carefully during migrations.
- Baseline updates are required whenever production JavaScript is intentionally migrated, deleted, or added as an
  exception.
