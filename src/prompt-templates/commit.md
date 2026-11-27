---
description: Generates a concise commit message, stages changes, and pushes to the remote.
---

# Commit

Generate a concise, informative commit message and commit the current pending changes in the repo staged or not, even
unrelated to your current context. If the changes seem very different and unrelated, then make several commits instead
of one. Always group together docs or plans or other Markdown files with a headline and a list of all the docs changed.

**Execution Steps:**

1. Run `git status` and `git diff` to analyze the pending changes. If a merge or rebase is already in progress, stop
   and report it. Do not take over an operation you did not start for this request.
2. Generate a detailed, imperative-mood commit message (e.g., "Add feature", not "Added feature").
3. Keep the subject line under 50 characters. If there are multiple distinct changes, add a blank line and list them as
   bullet points in the commit body. Also include in the body any clarifying details about the changes.
4. Stage the files for each commit. Run `git diff --cached --check`, fix any reported issues, then commit.
5. Run `git push` to sync the changes upstream. If Git rejects the push with `non-fast-forward` or `fetch first`,
   confirm the push target is the configured upstream and the working tree is clean. Fetch from that remote. If the
   fetch succeeds, run `git -c merge.conflictStyle=zdiff3 rebase --no-autostash '@{upstream}'`. If Git reports
   conflicts, load and follow the `resolving-merge-conflicts` skill. After a successful rebase, retry the push and
   use the final commit hashes in your report. If you cannot continue, report what stopped you. Do not force-push.
6. After a successful push, finish in ordinary assistant text. Use exactly this report format, with no extra prose,
   no verification details, and no missing list:

    ```markdown
    Committed and pushed:

    - `short-hash` - Full commit subject
    - `another-short-hash` - Full commit subject
    ```

    Include one bullet for each commit you made. Use the short commit hash in backticks, followed by a space, a hyphen,
    and a space, followed by the complete commit subject line (the same subject you used for that commit, up to the
    50-character limit).
