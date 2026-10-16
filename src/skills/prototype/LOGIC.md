# Logic Prototype

A tiny interactive terminal app that lets the user drive a state model by hand. Use this when the question is about
**business logic, state transitions, or data shape** — the kind of thing that looks reasonable on paper but only feels
wrong once you push it through real cases.

## When this is the right shape

- "I'm not sure if this state machine handles the edge case where X then Y."
- "Does this data model actually let me represent the case where..."
- "I want to feel out what the API should look like before writing it."
- Anything where the user wants to **press buttons and watch state change**.

If the question is "what should this look like" — wrong branch. Use [UI.md](UI.md).

## Process

### 1. State the question

Create `prototypes/<slug>/README.md` with the state model and question. Confirm the folder is ignored before writing
executable files:

```bash
git check-ignore prototypes/<slug>/
```

### 2. Pick the language and local task

Use whatever the host project uses. Match the existing toolchain; don't add a new package manager or runtime just for
the prototype.

In RunWield, put a local `package.json` under `prototypes/<slug>/` with a `scripts.dev` command and run:

```bash
bun run prototype <slug>
```

In other projects, use the equivalent project-native local task config and document the one command in the prototype
README. Do not add a new production-root task per prototype.

### 3. Isolate the logic in a portable module

Put the actual logic — the bit that's answering the question — behind a small, pure interface inside the ignored
prototype folder. The TUI around it is throwaway; the logic module should be portable enough to rewrite into production
later.

The right shape depends on the question:

- **A pure reducer** — `(state, action) => state`.
- **A state machine** — explicit states and transitions.
- **A small set of pure functions** over a plain data type.
- **A class or module with a clear method surface** when the logic genuinely owns ongoing internal state.

Keep it pure: no I/O, no terminal code, no `console.log` for control flow. The TUI imports it and calls into it; nothing
flows the other direction.

### 4. Build the smallest TUI that exposes the state

Build it as a **lightweight TUI** — on every tick, clear the screen (`console.clear()` / `print("\033[2J\033[H")` /
equivalent) and re-render the whole frame. The user should always see one stable view, not an ever-growing scrollback.

Each frame has two parts, in this order:

1. **Current state**, pretty-printed and diff-friendly.
2. **Keyboard shortcuts**, listed at the bottom: `[a] add user  [d] delete user  [t] tick clock  [q] quit`.

Behaviour:

1. Initialise state in memory.
2. Read one keystroke or line at a time.
3. Dispatch to a handler that mutates state.
4. Re-render the full frame after every action.
5. Loop until quit.

The whole frame should fit on one screen.

### 5. Hand it over

Give the user the run command. They'll drive it themselves; the interesting moments are when they say "wait, that
shouldn't be possible" or "huh, I assumed X would be different" — those are the bugs in the _idea_.

### 6. Capture the answer

When the prototype has done its job, the answer to the question is the only thing worth keeping. Capture that answer in
the Plan/PRD/ADR, issue, commit message, or prototype `NOTES.md` while it remains local. Then delete or leave ignored
local artifacts out of the production diff.

## Anti-patterns

- **Don't add tests.** A prototype that needs tests is no longer a prototype.
- **Don't wire it to the real database.** Use an in-memory store unless the question is specifically about persistence.
- **Don't generalise.** No "what if we wanted to support X later."
- **Don't blur the logic and the TUI together.** Keep the TUI as a thin shell over a pure module.
- **Don't put the shell under `src/` or add a named root task.** Everything executable stays in `prototypes/<slug>/`.
