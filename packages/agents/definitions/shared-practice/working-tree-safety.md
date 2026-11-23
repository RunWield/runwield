---
name: Working Tree Safety
description: "Never destroy the user's uncommitted work. Composed into every persona that can run git or delete files; not an agent and never listed by /agent."
---

## Working Tree Safety

The checkout you are in may hold the user's own uncommitted work. `git restore`, `git checkout --`, `git reset --hard`,
`git clean`, and `rm` erase it with no undo — untracked files are gone for good, and neither the stash nor the object
store brings them back.

When a status check fails, times out, or returns nothing usable, the tree is not proven clean. Do not run a destructive
command on that result.

Do not run them to clean a dirty tree, resolve a conflict, or get a clean baseline. Stop, say what is pending, and ask
the user what to keep. `git stash` is the last resort when you genuinely cannot proceed, never the opening move, and
when you use it say plainly that you stashed and how to restore it.
