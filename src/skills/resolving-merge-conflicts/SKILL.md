---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
license: MIT; complete terms in LICENSE
license_details:
    This complete `src/skills/resolving-merge-conflicts/` Skill package is licensed under MIT; see `LICENSE`. It is
    adapted from Matt Pocock's skills repository at `https://github.com/mattpocock/skills/`. This nested license
    covers only this Skill package and does not change the root RunWield license or any other repository path.
---

1. **List the conflicts.** Run `git status` and `git diff --name-only --diff-filter=U`. For each conflicted text file,
   list marker line numbers with `git grep -n -E '^(<{7,}|[|]{7,}|={7,}|>{7,})([[:space:]]|$)' -- <path>`. If the
   path has a custom `conflict-marker-size` attribute (`git check-attr conflict-marker-size -- <path>`), use that
   length. Read only the ranges you need. For a conflict
   without text markers, inspect the path's status and `git ls-files -u -- <path>`.

2. **Compare the base and both sides.** When starting a merge or rebase, use `git -c merge.conflictStyle=zdiff3` with
   that command. For a conflict already in progress, use `git show :1:<path>` for the base, `:2:<path>` for the
   current side, and `:3:<path>` for the incoming side. A stage can be absent. During a rebase, stage 2 is the branch
   you are rebasing onto plus any commits already replayed; stage 3 is the commit being replayed. Do not regenerate
   markers in a file that may contain manual edits. Use commit messages, PRs, and issues to check each side's intent
   when it is unclear.

3. **Resolve each hunk.** Edit one hunk at a time. Keep both intents when possible. If they conflict, pick the one
   that fits the goal and note what you left out. Do not use a script to rewrite markers across the file. Stage only
   the paths you resolved.

4. **Verify before continuing.** Repeat the marker search on each resolved text path with `git grep --cached` to
   check the staged content. For this search, exit status 1 means no matches; other errors do not confirm a clean
   result. Run `git diff --cached --check` and confirm `git diff --name-only --diff-filter=U` succeeds with no output.
   Find and run the project's relevant automated checks. Fix issues before continuing.

5. **Respect the operation owner.** If the workflow owns commits or continuation, leave the resolutions staged and
   hand back control. Otherwise, finish the merge or continue the rebase. Repeat these checks at each rebase stop.
   If you cannot resolve a conflict, report the path and why. Do not abort the operation.
