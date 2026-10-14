---
name: prototype
description: Use this skill when the user wants to prototype an idea, sanity-check a data model or state machine, mock up a UI, explore design options, or try several approaches before committing — even if they just say "let me play with it" or "try a few designs". Creates a runnable throwable that lets the user interact with the design before implementation.
license: MIT; complete terms in LICENSE
license_details: This complete `src/skills/prototype/` Skill package is licensed under MIT; see `LICENSE`. It is
    adapted from Matt Pocock's skills repository at `https://github.com/mattpocock/skills/`. This nested license
    covers only this Skill package and does not change the root RunWield license or any other repository path.
---

# Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

## Pick a branch

Identify which question is being answered — from the user's prompt, the surrounding code, or by asking if the user is
around:

- **"Does this logic / state model feel right?"** → [LOGIC.md](LOGIC.md). Build a tiny interactive terminal app that
  pushes the state machine through cases that are hard to reason about on paper.
- **"What should this look like?"** → [UI.md](UI.md). Generate several radically different UI variations in an ignored
  fixture host, switchable via a URL search param and a floating bottom bar.

The two branches produce very different artifacts — getting this wrong wastes the whole prototype. If the question is
genuinely ambiguous and the user isn't reachable, default to whichever branch better matches the surrounding code (a
backend module → logic; a page or component → UI) and state the assumption at the top of the prototype.

## Mandatory location and launch contract

1. **Write prototypes only under the ignored root:** `prototypes/<kebab-case-slug>/`.
   - Slugs use lowercase letters/numbers separated by single dashes, e.g. `plan-review-toolbar`.
   - Before writing executable files, run `git check-ignore prototypes/<slug>/` and stop if it is not ignored.
   - Never add prototype imports, routes, switchers, CSS, or marker comments under `src/` or another tracked production
     directory.
2. **Use one local folder shape:**
   - `README.md` — question, assumptions, run command, and eventual answer.
   - project-native local task config — `package.json` in RunWield and npm projects, `Makefile`/`justfile`
     where that is the existing convention.
   - source files for the UI or logic branch.
3. **Launch with one command.** In RunWield, create a local `package.json` with a `scripts.dev` command and run:

   ```bash
   bun run prototype <slug>
   ```

   In other projects, use the equivalent committed generic launcher or document the project-native command in the
   prototype README; do not add a new production-root task per prototype.

## Rules that apply to both

1. **Throwaway from day one, and clearly marked as such.** The prototype root is ignored and local. Keep context in its
   README, not by placing code next to production modules.
2. **One command to run.** The user must be able to start it without remembering internal file paths.
3. **No persistence by default.** State lives in memory. Persistence is the thing the prototype is _checking_, not
   something it should depend on. If the question explicitly involves a database, hit a scratch DB or a local file with
   a clear "PROTOTYPE — wipe me" name under the ignored prototype root.
4. **Skip the polish.** No tests, no error handling beyond what makes the prototype _runnable_, no abstractions. The
   point is to learn something fast and then delete it.
5. **Surface the state.** After every action (logic) or on every variant switch (UI), print or render the full relevant
   state so the user can see what changed.
6. **Delete or absorb when done.** When the prototype has answered its question, either delete it or fold the validated
   decision into the real code — don't leave it rotting in the repo.

## When done

The _answer_ is the only thing worth keeping from a prototype. Capture it somewhere durable (Plan/PRD/ADR, issue, commit
message, or `README.md`/`NOTES.md` under the ignored prototype until the user confirms the verdict). Then delete or
ignore the executable prototype artifacts. Do not force-add prototype code to share it.
