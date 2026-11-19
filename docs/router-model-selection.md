# Router Model Selection

This document records the June 2026 Router model evaluation findings. The short version: outside frontier-class models,
Gemma4 31B is the only model we have seen behave like a reliable Router.

Router is a constrained dispatch role. It is not supposed to solve the user's task. It should do only enough discovery
to remove routing ambiguity, call `triage_report` exactly once, and stop.

That makes Router model quality different from general coding quality. A good Router needs:

- strong system-prompt adherence;
- reliable structured tool calling;
- enough judgement to distinguish `INQUIRY`, `IDEATION`, `OPERATION`, `QUICK_FIX`, `FEATURE`, and `PROJECT`;
- restraint after discovery;
- consistent termination with `triage_report`.

Small models can often classify the request intellectually, but they fail the role contract. They keep investigating,
try to run or fix the task, call non-router tools, answer directly, or simply never emit `triage_report`.

## Current Recommendation

Use Gemma4 31B for Router.

Gemma4 31B is not chosen because Router needs creativity. It is chosen because Router needs disciplined, boring
execution:

- it follows the Router system prompt more consistently;
- it is less eager to become the implementation agent;
- it handles strict structured output well;
- it makes bounded decisions after limited discovery;
- it is willing to call the final routing tool and stop.

Other agents can use different model personalities. Ideator, Planner, and Architect benefit from broader synthesis and
higher-temperature reasoning. Router should stay low-temperature and mechanical.

## Observed Model Runs

These runs used the real Router path against `router-judgements.csv`. Agreement is measured only on rows where the model
actually produced a canonical `routerDecision`; unscored rows are labelled prompts where Router did not produce a usable
`triage_report`.

| Model                           |        Scored agreement |           Unscored rows | Notes                                                                                                       |
| ------------------------------- | ----------------------: | ----------------------: | ----------------------------------------------------------------------------------------------------------- |
| `ollama-cloud/gemma4:31b-cloud` | Current Router baseline | Low enough to be usable | Best observed combination of routing judgement, structured output, and termination discipline.              |
| `ollama/Qwen3.5-9B-MLX-8bit`    |      `22/32` (`68.75%`) |                    `70` | Fast locally, but often over-discovers until timeout or fails to call `triage_report`.                      |
| `crofai/qwen3.5-9b`             |       `14/25` (`56.0%`) |                    `77` | Can call tools, but sometimes emits fake tool calls in reasoning text or starts solving instead of routing. |
| `crofai/minimax-m2.5`           |       `20/30` (`66.7%`) |                    `72` | Tool calling works, but it wanders through repository discovery and is very slow to terminate.              |
| `crofai/glm-4.7-flash`          |              Not usable |              Not usable | Did not reliably call even the required tool in this setup.                                                 |
| `greg-1-mini`                   |                 Dropped |                 Dropped | Too eager to perform the task and weak at following the Router contract.                                    |

The local Qwen run is the clearest example. It scored decently when it produced a decision, but `70/102` rows were
unscored:

- `55` timed out after 120 seconds;
- `15` ended without `triage_report`;
- most failures were over-discovery rather than inability to use tools.

The unscored rows were not concentrated in one intent:

| Human judgement | Unscored rows |
| --------------- | ------------: |
| `QUICK_FIX`     |          `29` |
| `FEATURE`       |          `17` |
| `INQUIRY`       |          `11` |
| `PROJECT`       |           `7` |
| `IDEATION`      |           `6` |

That distribution matters. The failure is not just ambiguous classification. It is role discipline.

## Failure Patterns In Smaller Models

### Over-Discovery

The dominant failure mode is continued discovery until timeout. The model uses valid tools such as `read`, `grep`,
`find`, `code_search`, `code_show`, and memory lookup, often on relevant files. Then it keeps going instead of calling
`triage_report`.

This is especially common on prompts that look implementation-shaped:

- "fix this";
- "run CI";
- "add support for...";
- "the app loses state...";
- "make this command work...".

The model starts acting like Operator, Engineer, or Planner.

### Direct Answering Or Empty Completion

Some small models fail on the easiest rows. Greetings, simple repository questions, and ideation prompts may produce no
logged tool calls and no `triage_report`. They likely answer directly, emit an invalid/fake tool call, or complete
without the structured final action.

For Router, a direct answer is still a failure unless it is represented as an `INQUIRY` routing decision.

### Invalid Tool Instincts

Some prompts mention another workflow explicitly, for example `diagnose`, `grill me`, or research. Smaller models may
try to call that tool directly instead of routing to the proper agent through `triage_report`.

Router should decide the handoff. It should not become the handoff.

### Bash Fixation

Read-only shell commands like `git status` and `git diff` are valid Router discovery in the real app, but the benchmark
does not execute bash. The golden-set runner now provides a benchmark-only bash shim that explains this and nudges the
model to use non-bash tools or call `triage_report`.

Even with that shim, smaller models can repeat bash calls or treat the missing shell output as a reason to keep working.

## Why Gemma4 31B Wins

Gemma4 31B appears to have the best balance for Router:

- enough model capacity to understand the five-way routing taxonomy;
- enough instruction following to respect "do not solve";
- enough tool discipline to use `triage_report` instead of freeform text;
- enough restraint to stop after a bounded amount of discovery.

This is the exact shape Router needs. The task is clerical, but it is clerical in a high-friction agent environment:
many tempting tools, many plausible files to inspect, and user prompts that often look like implementation requests.

Smaller models tend to be "helpful" in the wrong direction. Gemma4 31B is more willing to be a dispatcher.

## Benchmark Notes

Use `scripts/run-router-golden-set.ts` to run the real Router against the golden CSV. You can override the model,
thinking level, and sampling temperature for that run:

```sh
deno run -A scripts/run-router-golden-set.ts --model <provider/model> \
  --thinking-level medium --temperature 0.1 --rerun --out <results.csv>
```

`--thinking-level` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `--temperature` accepts a
finite number from 0 to 2, including zero. Omit either option to keep the configured Router default. The overrides do
not change saved settings. Provider support varies; the existing temperature fallback omits temperature when the model
does not support it. Use separate output files and `--rerun` to compare settings without reusing completed decisions.

### Pin repository context per row

Add an optional `contextCommit` column to the golden CSV. Use the full Git commit hash for the repository state that
applied when the user made the request. Leave the cell empty for cases that can use the current checkout.

The runner creates one temporary detached worktree from the repository selected by `--cwd`, when it reaches the first
valid pinned row. Before each later pinned row, it checks out that row's commit in the same worktree. Router filesystem
and code discovery use that worktree. Generated files are not cleared between rows. The runner removes the worktree when
the run ends, including after row failures or timeouts. It does not switch branches, reset files, or copy uncommitted
changes from your source checkout.

Use a full 40- or 64-character commit hash, not a branch name or abbreviated hash. The commit must already exist in the
local repository; the runner does not fetch it. An invalid or missing commit produces a row error, without falling back
to the current checkout. Input pins remain in result CSVs and checkpoints. Resume discards a prior result when its pin
changes; use `--rerun` after changing request text or model settings.

The runner and model remain current. A commit pin fixes tracked repository files, not missing conversation history,
uncommitted Session state, global settings, memory, external resources, or sibling repositories. Check that the chosen
commit reflects the original discovery context before using its result as historical evidence. Pins are not inferred
from Session dates.

The current golden-set benchmark is useful, but it is not perfect.

- Historical prompts contain real project context, so models can spend a lot of time doing genuine discovery.
- The benchmark CSV is currently visible from repository tools, which can leak fixture context.
- Bash is represented by a non-executing shim, not a true read-only shell.
- Agreement alone is not enough; unscored rows are critical because a Router that does not report cannot hand off.
- The real Router may need a discovery budget, such as "after N tool calls, call `triage_report`."

Future model evaluations should track at least:

- agreement on scored rows;
- unscored row count;
- timeout count;
- non-router tool attempts;
- repeated bash-shim calls;
- average tool calls before `triage_report`.

Until another mid-sized model beats Gemma4 31B on both agreement and completion discipline, Gemma4 31B should remain the
Router default.
