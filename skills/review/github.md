# GitHub commands

For a pull request on GitHub. Requires the `gh` CLI, authenticated. Replace `<n>` with the pull request number.

Inside the target repository, `{owner}` and `{repo}` come from that repository. Outside it, set the repository once so
both `gh pr` and `gh api` use the same target:

```bash
export GH_REPO=<owner>/<repo> # or <host>/<owner>/<repo>
```

A pull request URL works with `gh pr` commands. Get its number before using an API path:

```bash
gh pr view <pull-request-url> --json number --jq '.number'
```

## Read the change

```bash
# Title, body, state, the head and base commits, and the files the diff touches.
gh pr view <n> --json number,title,body,state,url,headRefOid,baseRefOid,files,commits

# The discussion, including earlier reviews.
gh pr view <n> --comments

# Earlier line comments, with the file and line each one sits on.
gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate \
  --jq '.[] | {path, line, user: .user.login, body}'

# The diff itself, and the file list alone.
gh pr diff <n> --patch
gh pr diff <n> --name-only
```

Keep `headRefOid`. It is the commit the review is anchored to.

## Post the review, batched

`gh pr review` cannot attach line comments — it has only `--approve`, `--request-changes`, `--comment`, and a body. Line
comments need one call to the reviews endpoint carrying every comment at once.

Write the review to a file:

```json
{
    "commit_id": "<headRefOid>",
    "event": "REQUEST_CHANGES",
    "body": "## Standards\n\n…\n\n## Spec\n\n…\n\n## Tests\n\n…",
    "comments": [
        { "path": "src/session.ts", "line": 42, "side": "RIGHT", "body": "…" },
        { "path": "src/session.ts", "start_line": 60, "start_side": "RIGHT", "line": 64, "side": "RIGHT", "body": "…" }
    ]
}
```

Then submit it once:

```bash
gh api --method POST repos/{owner}/{repo}/pulls/<n>/reviews --input review.json
```

Field by field:

- `commit_id` — the head commit you read. Optional, but it pins the review to the code you actually reviewed.
- `event` — `REQUEST_CHANGES` when a blocking issue is open, `COMMENT` otherwise. Never `APPROVE`.
- `body` — the summary. Everything that is not anchored to a changed line.
- `comments[]` — one object per line comment. `path` is repository-relative. For `side: "RIGHT"`, `line` is the line
  number in the file after the change. For `side: "LEFT"`, `line` is the line number in the file before the change. For
  a range, add `start_line` and `start_side`, using the same before-or-after rule for the first line.

Omitting `event` leaves the review pending and unpublished, which looks posted to you and is invisible to everyone else.
Always set it.

## Post a summary with no line comments

Use the verdict that matches the summary:

```bash
# At least one blocking issue.
gh pr review <n> --request-changes --body-file review-body.md

# No blocking issues.
gh pr review <n> --comment --body-file review-body.md
```

Use these only when nothing anchors to a line. Each is one call; the reviews endpoint above is the same operation with
`comments[]` attached. Never use `--comment` when a blocking issue is open.

## When a comment is rejected

A comment anchored to a line the diff does not touch fails the whole call with `422 Unprocessable Entity` and a message
naming `pull_request_review_thread.line`. Nothing is posted — the batch is atomic.

Move that finding into `body`, naming the file and line in the text, and submit again. Do not retry the same payload,
and do not split the batch to get the rest through: a run of partial reviews is worse than one complete one.
