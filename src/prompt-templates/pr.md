---
description: Resolves conflicts with the target branch and opens a PR
agent: engineer
---

# Pull Request

Open a pull request (a merge request on GitLab) from a source branch to a target branch, after bringing the source up
to date with the target.

1. Check the worktree. Stop and report if HEAD is detached, if a merge or rebase is already in progress, or if there are
   uncommitted changes. Do not stash or commit them yourself.
2. Detect the forge. Read `git remote get-url origin` to tell GitHub from GitLab, including self-hosted instances, and
   check only that forge's CLI (`gh` or `glab`). If it is installed but `auth status --hostname <host>` fails, stop and
   give the user the exact login command. If it is not installed, continue; step 8 uses the browser.
3. Determine the branches. Source: the branch the user named, else the current branch (usually `epic/*` or `plan/*`).
   Target: the branch the user named, else the remote's default branch. Stop if they are the same.
4. Confirm the branches with one `user_interview` question that lets the user correct either one. If they cancel, stop.
   Do not fetch, merge, rebase, or push before they confirm.
5. Bring the source up to date. Run `git fetch origin`; if the source already contains `origin/<target>`, skip ahead.
   Merge `origin/<target>` into the source; rebase only if the user asks, with `--rebase-merges`. Resolve conflicts with
   the `resolving-merge-conflicts` skill, asking the user only when a conflict needs a product decision. Then run the
   project's documented checks and fix any failure the resolution caused.
6. Push with `git push -u origin <source>`. Never force-push without asking. If the user declines, undo the rebase,
   merge instead, and push normally.
7. Check for an open PR from the source to the target. If one exists, report its link in the step 9 format, say it
   already existed, and stop.
8. Open the PR, ready for review unless the user asks for a draft.
    - Title: short and imperative.
    - Body: the repository's PR template if it has one; otherwise Summary, Changes, Verification, and Links sections.
    - Content: summarize the intent and outcome of the Plan that matches the source branch, without its front matter or
      internal notes. Without a Plan, use `git log` and `git diff` against `origin/<target>`.
    - Links: every issue, ticket, or TODO item the user mentioned. Use `Closes #N` only when they say the PR resolves
      it; quote TODO items that have no URL.
    - CLI: pass the title and body to `gh pr create` or `glab mr create` so it does not prompt.
    - Browser: without the CLI, use the `agent-browser` skill to open the new-PR page, ask the user to sign in if
      needed, and submit. If the browser is unavailable, give the user the compare URL with the title and body ready
      to paste.
9. Report exactly ``Opened PR: <url> (`<source>` → `<target>`)``. If step 5 merged or rebased, add one line saying
   which and how many conflicted files were resolved.
