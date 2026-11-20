---
planId: "34978ff1-2070-481d-96bc-2aa16475d4ca"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/workflow/validation-local-ci.ts"
    - "src/shared/workflow/process-output.ts"
    - "src/shared/workflow/validation-log.ts"
    - "src/shared/project-runtime-layout.ts"
    - "src/shared/workflow/validation-mechanical.ts"
    - "src/shared/workflow/validation-local-ci.test.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-12"
origin: "internal"
status: "ready_for_work"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
---

# Keep Full Validation Logs for Repair

## Context

Mechanical Validation keeps only the tail of the Verification Command output. Repair Agents never see the complete
output.

Engineer feedback from a real repair:

> Keep the complete test output as a file, not only the truncated tail. This will expose the first errors and separate
> direct failures from failures caused by earlier timeouts.

Today `runValidationCommand` (`src/shared/workflow/validation-local-ci.ts`) reads stdout and stderr through
`captureProcessStreamTail` with a 1 MiB budget per stream. `formatCapturedProcessOutput` joins the stdout tail and the
stderr tail, so the two streams also lose their order. The result `output` string then travels everywhere:

```text
runValidationCommand → result.output
  ├─ TUI tool_end event (runLocalCI)
  ├─ Delivery Evidence "ci" entry (validation-mechanical.ts)
  ├─ failureReason → Plan lifecycle event + host checkpoint
  ├─ dispatchCiRepair prompt (managed + Connect host repair)
  └─ QUICK_FIX repair prompt (validation-helpers.ts)
```

Two problems follow:

- **The first error is lost.** On a long `bun run ci`, a timeout early in the run causes later failures. The tail shows
  only the later failures.
- **The tail is too large for a prompt.** Up to 2 MiB of output goes into the repair prompt, the Plan `failureReason`,
  and the checkpoint.

Owning PRD capability: [Core PRD — Validation](../prd/runwield-core-prd.md#validation). These requirements stay true:
"Fresh, focused repair verification" (timeout versus assertion guidance) and "Repair the latest observed CI failure"
(follow-up uses the latest run). This Plan adds one requirement: keep the complete validation output.

## Objective

Every Verification Command run writes its complete, interleaved output to a log file. The `output` that RunWield
delivers to repair Agents, evidence, and the TUI is a short tail plus the absolute path of that log. The repair prompt
tells the Agent to read the log from the start when the tail does not show the first failure.

## Approach

Write the log while the process runs. Keep one combined tail in memory at the same time. Do not re-read the file.

```text
runValidationCommand
  openValidationLog(cwd)              # new: prunes old logs, opens <dir>/<time>-<id>.log
  spawnForegroundShell
  captureProcessOutput(stdout, stderr, { tailBytes, sink: log })   # chunks in arrival order
  log.close()
  output = formatValidationOutput(tail, log)   # tail + "[RunWield] Full output … saved to <path>"
```

The output footer has this shape:

```text
<last 200 lines of combined output, at most 16 KB>
[RunWield] Output truncated; showing the last 200 lines (12034 of 3480122 bytes).
[RunWield] Full validation output saved to /abs/.wld/internal/validation-logs/20261112T153000Z-ab12cd.log.
Read it from the start to find the first failure.
```

The path goes into `output` itself. All consumers in the call path above then carry it with no change to their code.

> [!TIP]
> **One string, one owner**
>
> The path and the tail live in the `output` string. The repair prompt, Delivery Evidence, `failureReason`, and Connect
> host packets need no new fields, and the two duplicate result types (`LocalCIResult`, `ValidationLocalCIResult`) stay
> as they are.

**Log location.** Each log goes in the execution checkout: `<checkout>/.wld/internal/validation-logs/`. The repair Agent
works in that checkout, so Core Agents and Connect host Agents can read the file without access outside their working
directory. `.wld/internal/` is already ignored and excluded from publication. `resolveProjectRuntimeLayout` owns the
path as `selected.validationLogsDir`.

**Retention.** Before each run, keep the newest 19 logs and delete older ones, so the new run makes 20. When RunWield
removes an execution worktree, its logs go with it.

Decision (review): keep logs in the execution checkout.

**Tail size.** The delivered tail is the last 200 lines of combined output, capped at 16 KB (16,384 bytes), whichever
is smaller. Decision (review): the owner asked for a short tail; 1 MiB and 50 KB are too large. The full log carries
everything else, so the tail only needs the failure summary at the end of the run.

**Failure to write the log is not a validation failure.** When the directory or file cannot be written, the command
still runs. `output` then carries the in-memory tail and the line
`[RunWield] Full validation output could not be saved: <reason>.` The result kind and exit code do not change.

Set aside: re-reading the tail from the log file after the run. It gives the same text, but adds a second read path
and fails when the write failed.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved intent
— the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk grows,
or the Verification Plan no longer proves the objective.

- `src/shared/workflow/process-output.ts` — add a combined-stream capture that keeps one tail in arrival order and
  passes each chunk to an optional sink. The tail is bounded by bytes during capture and trimmed to whole lines at the end.
- `src/shared/workflow/validation-log.ts` (new) — owns log naming, retention, open/append/close, and the output footer.
- `src/shared/project-runtime-layout.ts` — adds `selected.validationLogsDir`.
- `src/shared/workflow/validation-local-ci.ts` — `runValidationCommand` uses the log and the combined capture. Update
  its module comment, which describes the tail-only design.
- `src/shared/workflow/validation-mechanical.ts` — the `dispatchCiRepair` instruction tells the Agent how to use the
  log.
- `src/shared/workflow/validation-helpers.ts` — the QUICK_FIX repair instruction gets the same sentence.
- `src/shared/workflow/validation-local-ci.test.ts`, a new `validation-log.test.ts`, and the repair prompt tests —
  behavior coverage.
- `docs/prd/runwield-core-prd.md#validation` — new requirement and scenario.

Deliberately out of scope: worktree setup output (`execution-setup.ts`) and Epic integration output
(`epic-integration.ts`). They also use `captureProcessStreamTail` and keep today's behavior.

## Reuse Opportunities

- `captureProcessStreamTail` in `src/shared/workflow/process-output.ts` — the byte-tail logic to extend for the
  combined capture.
- `resolveProjectRuntimeLayout` in `src/shared/project-runtime-layout.ts` — the only owner of `.wld/internal` paths.
- `spawnForegroundShell` — unchanged; cancellation still settles both pipes before the log closes.

## Implementation Steps

- `src/shared/project-runtime-layout.ts`: `SelectedProjectRuntimeLayout` has `validationLogsDir`, equal to
  `<selected internalRoot>/validation-logs`.
- `src/shared/workflow/process-output.ts` exports a capture function that reads stdout and stderr concurrently, passes
  every chunk to an optional sink in arrival order, and returns one combined tail of at most the given byte count plus
  the total byte count and a truncated flag. A helper trims that tail to its last N complete lines. Existing `captureProcessStreamTail` callers keep their behavior.
- `src/shared/workflow/validation-log.ts` exports the validation log owner:
    - Opening a log creates `validationLogsDir` for the given checkout, deletes all but the newest 19 `*.log` files, and
      creates a new file named `<UTC timestamp>-<random id>.log`.
    - Appends are serialized, so the file holds every byte in arrival order.
    - A failure to create, prune, or write records the reason and stops further writes. It never throws to the caller.
    - A formatter returns the tail, a truncation notice when truncated, and either the "Full validation output saved to
      <absolute path>. Read it from the start to find the first failure." line or the "could not be saved: <reason>" line.
- `runValidationCommand` in `src/shared/workflow/validation-local-ci.ts` writes each run's complete output to a new log
  and returns `output` from the formatter with a tail of at most 200 lines and 16,384 bytes. Completed, canceled, and timed-out runs all include the
  log path. Spawn failures and `command_missing` results keep their current messages and create no log.
- `dispatchCiRepair` in `src/shared/workflow/validation-mechanical.ts` and the QUICK_FIX repair request in
  `src/shared/workflow/validation-helpers.ts` tell the Agent that the output below is a tail, that the full log path is
  at its end, and to read the log from the start when the tail shows timeouts, interrupted checks, or failures that
  could be caused by an earlier error.
- `docs/prd/runwield-core-prd.md#validation` has a requirement "Keep the complete validation output" and an acceptance
  scenario for it. The requirement says: each Verification Command run saves complete output in the execution checkout;
  repair Agents, Delivery Evidence, and progress receive a bounded tail plus the log path; a failed log write does not
  change the validation result.

## Verification Plan

Automated (`bun scripts/run-tests.ts <paths>`):

- `src/shared/workflow/validation-local-ci.test.ts`:
    - A command prints `FIRST-ERROR` on stderr, then 2,000 numbered lines on stdout, then `LAST-LINE`. `result.output` contains
      `LAST-LINE`, does not contain `FIRST-ERROR`, holds at most 200 output lines and 16,384 output bytes before the
      notices, and ends with the log path. The file at that path contains
      `FIRST-ERROR` and `LAST-LINE`, and its byte size equals the total the notice reports. This test fails if the log is
      a stub or holds only the tail.
    - A command alternates stdout and stderr writes with short sleeps. The log holds the lines in emitted order.
    - A short successful command returns its full text, no truncation notice, and the log path.
    - A command printing one 40 KB line with no newline returns at most 16,384 output bytes and a truncation notice.
    - A canceled run (adapt the existing `sleep 30` test) returns a log path, and the file exists.
    - With `validationLogsDir` blocked by a regular file, the command still completes with its real exit code, and
      `output` contains the tail and the "could not be saved" line.
    - Update the existing `[RunWield] stdout truncated;` assertion to the new combined truncation notice. The protected
      behavior is unchanged: a truncated tail is never shown as complete output.
- `src/shared/workflow/validation-log.test.ts`: with 25 existing logs, opening a new log leaves exactly 20 `*.log` files,
  the newest 19 plus the new one. Non-log files in the directory remain.
- Repair prompt coverage (`validation-completion-gating.test.ts` or the existing `dispatchCiRepair` test fixture): a
  failing CI run produces a repair request that contains the log path and the instruction to read the log from the
  start.

Behavior that must still be protected:

- Large output does not crash the run or buffer without limit in memory (keep the existing large-output test).
- Cancellation terminates the process tree and settles both pipes before the result returns.
- The latest run's output, not an older `failureReason`, reaches Engineer follow-up.

Manual:

- Run a Plan whose Verification Command fails with more than 200 lines of output. The repair Agent's prompt shows the tail
  and the path. The Agent can read the file from the execution worktree. The TUI CI tool result shows the same tail and
  path.

PRD check: the Core PRD Validation section has the new requirement and scenario, and the existing timeout and
latest-failure requirements are unchanged.

## Edge Cases & Considerations

- **Disk use.** A noisy suite can write tens of megabytes per run. The 20-log limit per checkout bounds it, and worktree
  removal deletes the logs.
- **In-place (non-worktree) runs** write to the primary checkout's `.wld/internal/validation-logs/`. The same 20-log
  limit applies.
- **Stale paths.** Delivery Evidence and Plan `failureReason` keep the path after the worktree is gone. The short tail stays
  readable inline. This is acceptable for historical evidence.
- **Secrets in output.** The log holds what the command printed, in the same ignored, unpublished `.wld/internal/` tree
  as other runtime state. No new exposure beyond what the TUI already shows.
- **Remote SSH projects.** The log is written on the machine that runs the command, beside the checkout the repair Agent
  uses.
- **Assumption:** "full validation output" is plain wording. It is not a new domain term, so `docs/domain-language.md`
  does not change.
