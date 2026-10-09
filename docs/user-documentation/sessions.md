# Sessions

A Session is one conversation with RunWield. Sessions are saved automatically, so you can resume them later in the
terminal or in [Workspace](workspace.md).

RunWield's Sessions work like Pi's. For the Session tree, forking, cloning, export, and compaction, see
[Pi Sessions](https://pi.dev/docs/latest/sessions) and [Pi Compaction](https://pi.dev/docs/latest/compaction).

## Starting and resuming

Run `wld` to start a Session. Inside it:

```text
/resume          # browse and resume recent Sessions
/new             # start a fresh Session
/name <name>     # name the current Session
/name            # show the current name
/session         # show Session information and token totals
/context         # show how much of the model's context window is in use
/compact         # compact the conversation to free context
/export          # export to HTML or JSONL
/share           # upload as a secret GitHub Gist
```

RunWield saves Sessions under `~/.wld/sessions/`.

When you resume a large Session, RunWield can offer to compact it first. Set the threshold with
[`compactOnResumeThresholdPercent`](settings.md#runwield-custom-keys).

## Session names

A new Session's terminal title is `wld - <folder>`. Once the Router has sorted your first request, it names the Session,
and the title becomes `wld - <name>`. A name you set with `/name` always wins; the Router never replaces it.

## Which Agent answers

Every new Session starts with the Router. After it hands your request to an Agent, that Agent keeps answering your
follow-up messages. Use `/agent <name>` to switch Agents, `/agent router` to route your next message again, or `/new` to
start over. See [How requests are routed](workflows.md#how-requests-are-routed).

## Continuing in Workspace

The same Session can continue in Workspace on another screen, including your phone. See
[Workspace](workspace.md#try-moving-between-screens).

## Background tasks

Agents can run long commands, such as a test suite, in the background and keep working while they run. They can also ask
a read-only helper Agent to investigate something in the background.

- Up to five background tasks can run at once in a Session.
- The Agent gets each result when it finishes, during its current turn or a later one. Long output is saved to a log
  file that the result points to.
- Closing a browser tab or finishing a turn doesn't stop background tasks. Pressing Stop, or quitting RunWield, cancels
  them.
- Background tasks belong to the RunWield process that started them. If that process exits, they can't be resumed.
- When an Agent tries to finish while tasks are still running, RunWield warns it first. If it finishes anyway, the
  remaining tasks are cancelled. A cancelled test run is not a passing test run.
