# Settings Reference

RunWield reads settings from JSONC files, so comments and trailing commas are allowed.

- Global settings: `~/.wld/settings.json`
- Project settings: `<project>/.wld/settings.json`

## JSON Schema

Add the release schema URL to either settings file for editor autocomplete and validation:

```jsonc
{
    "$schema": "https://github.com/gandazgul/runwield/releases/latest/download/config.schema.json"
}
```

Settings files are JSONC, but the published `config.schema.json` asset is strict JSON for broad editor compatibility.
The schema intentionally allows unknown keys so future RunWield settings, inherited Pi settings, and extension-owned
settings do not become false errors. Known RunWield keys and currently inherited Pi-backed keys are still described for
completion and basic validation.

Project settings override global settings. For ordinary Pi-backed settings, nested objects are shallow-merged and arrays
replace the global value. For RunWield custom object keys such as `agents` and `modelPresets`, RunWield merges the
top-level object keys only, so a project `agents.router` object replaces the global `agents.router` object.

If `~/.wld/settings.json` does not exist, RunWield imports `~/.pi/agent/settings.json` once. After that, RunWield only
reads and writes `~/.wld/settings.json`.

Run `/reload` in an active TUI session after editing settings by hand. `/reload` refreshes settings, the active theme,
the root agent model, the root agent thinking level, prompt templates, skills, and memories. Prompt Template and Skill
catalogs are replaced only after reload succeeds, so removed names stop autocompleting and new or changed bodies are
used by later invocations.

## Example

```jsonc
{
    "$schema": "https://github.com/gandazgul/runwield/releases/latest/download/config.schema.json",

    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-5",
    "defaultThinkingLevel": "medium",
    "theme": "catppuccin-mocha",

    "visionFallback": {
        "model": "lmstudio/google/gemma-4-12B-it"
    },

    "agents": {
        "router": {
            "model": "openai/gpt-5-mini",
            "thinkingLevel": "minimal",
            "temperature": 0.1
        },
        "engineer": {
            "model": "anthropic/claude-sonnet-4-5",
            "thinkingLevel": "high",
            "temperature": 0.4
        }
    },

    "activeModelPreset": "fast",
    "modelPresets": {
        "fast": {
            "agents": {
                "router": {
                    "model": "openai/gpt-5-mini",
                    "thinkingLevel": "minimal",
                    "temperature": 0.1
                },
                "engineer": {
                    "model": "anthropic/claude-haiku-4-5",
                    "thinkingLevel": "low",
                    "temperature": 0.3
                }
            }
        },
        "quality": {
            "agents": {
                "router": {
                    "model": "anthropic/claude-sonnet-4-5",
                    "thinkingLevel": "medium",
                    "temperature": 0.1
                },
                "engineer": {
                    "model": "anthropic/claude-opus-4-5",
                    "thinkingLevel": "xhigh",
                    "temperature": 0.4
                }
            }
        }
    },

    "compaction": {
        "enabled": true,
        "reserveTokens": 16384,
        "keepRecentTokens": 20000
    },

    "compactOnResumeThresholdPercent": 50,
    "verification_command": "deno task ci",
    "codereview": "ask",
    "cleanupMergedWorktrees": true,
    "workRecords": { "autoGenerateOnPlanCompletion": true },
    "workflowMetrics": { "enabled": true }
}
```

## Agent Model Overrides

Bundled agent names are `architect`, `engineer`, `guide`, `ideator`, `operator`, `planner`, `router`, and `tester`.
Custom agent names can also be used if they match the agent definition name.

### `agents`

Type: object.

Maps agent names to base per-agent overrides:

```jsonc
{
    "agents": {
        "router": {
            "model": "openai/gpt-5-mini",
            "thinkingLevel": "minimal",
            "temperature": 0.1
        }
    }
}
```

Agent object values:

- `model`: string in `provider/model_id` format. The provider and model id must exist in the model registry and have
  configured auth.
- `thinkingLevel`: one of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `temperature`: number from `0` to `2`. Lower values are better for mechanical classification and operational work;
  higher values are useful for exploratory agents such as Ideator, Planner, and Architect.

### `activeModelPreset`

Type: string.

Names a bundled or user-defined entry in `modelPresets`. If it is unset or names a preset that doesn't exist, RunWield
uses the base `agents` overrides.

A model you pick with `/model` overrides the preset for the current Agent. It stays in effect for follow-up messages and
when you resume that Agent's Session. Switching Agents, with `/agent` or through a workflow handoff, uses the new
Agent's configured model. Switching back doesn't restore your earlier `/model` choice.

### `modelPresets`

Type: object.

Defines named groups of agent overrides. RunWield includes these presets without requiring a `modelPresets` setting:

| Preset         | Model assignments                                                                                              | Required access                |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `codex`        | GPT-6 Luna for Router/Operator; GPT-6.1 Sol for execution; GPT-6 Astra for planning/review                     | Codex account                  |
| `agy`          | Gemini 3.8 Flash for execution; Gemini 3.1 Pro for Router, Slicer, planning/review                             | Antigravity CLI sign-in        |
| `opencode`     | GPT-6 Luna for Router/Operator; GPT-6.1 Sol for execution; GLM 5.3 for Slicer/planning; GPT-6 Astra for review | OpenCode Zen API key           |
| `claude-mixed` | Sonnet for Router/execution; Opus for planning/review                                                          | Claude Code sign-in            |
| `claude-opus`  | Opus for every Agent, including Router                                                                         | Claude Code sign-in            |
| `codex-claude` | Codex Luna/Sol for Router/execution; Claude Opus for planning/review                                           | Codex and Claude Code accounts |

Planning means Ideator, Planner, and Architect; review means Reviewer. Execution includes Guide, Engineer, Frontend
Engineer, and Init. Slicer uses Sol in the Codex presets and Sonnet in `claude-mixed`. Operator uses Flash in `agy`,
Sonnet in `claude-mixed`, and Opus in `claude-opus`. Validation Repair Engineer inherits Engineer's model and thinking
level unless separately configured.

Select a preset in `/settings` → **Model Presets**, or set `activeModelPreset` to its name. Nothing is activated
automatically. Configure the listed provider access before using its models; selecting a preset does not sign you in.
These are starting configurations, not a claim that every model has passed RunWield's Router benchmark.

Definitions ship in `src/model-presets/` and are unpacked to `~/.wld/bundled-model-presets/` on first preset access or
`/init`. The unpacked files are a readable cache refreshed by each RunWield process; edit settings to customize a
preset. Bundled definitions remain usable if the cache cannot be written.

Presets resolve by name: project `modelPresets` override personal `modelPresets`, which override bundled presets. A
same-name definition replaces the entire lower-priority preset, preserving existing settings behavior. To adjust one
bundled assignment while keeping the others, copy its JSON into `modelPresets.<name>` in your settings and edit the
desired Agent. Use a different name to keep both choices. RunWield updates its bundled copies without rewriting personal
or project settings.

You can also define your own preset:

```jsonc
{
    "activeModelPreset": "fast",
    "agents": {},
    "modelPresets": {
        "fast": {
            "agents": {
                "router": { "model": "openai/gpt-5-mini" }
            }
        }
    }
}
```

Each preset has the same `agents.<agentName>.model`, `agents.<agentName>.thinkingLevel`, and
`agents.<agentName>.temperature` shape as the base `agents` key. Presets are partial: if the active preset does not
define a value for an agent, RunWield falls back to that agent's base `agents` entry.

### Resolution order

Model resolution for an agent invocation:

1. Manual `/model` user override for the current active agent.
2. Invocation-specific model, such as a prompt-template `model` frontmatter value.
3. Active preset `modelPresets.<activeModelPreset>.agents.<agent>.model`.
4. Base `agents.<agent>.model`.
5. For non-Engineer Agents with no earlier model, Engineer's configured model.
6. `defaultProvider` plus `defaultModel`.
7. Layered agent definition frontmatter `model` (`./.wld` > `~/.wld` > bundled).

If none of these resolve to a registered, authenticated model, RunWield reports an error instead of falling through to
the underlying agent library's built-in fallback.

Thinking level resolution:

1. Active preset `modelPresets.<activeModelPreset>.agents.<agent>.thinkingLevel`.
2. Base `agents.<agent>.thinkingLevel`.
3. For Validation Repair Engineer with no earlier thinking level, Engineer's configured thinking level.
4. `defaultThinkingLevel`.
5. Layered agent definition frontmatter `thinkingLevel` (`./.wld` > `~/.wld` > bundled).

Temperature resolution:

1. Active preset `modelPresets.<activeModelPreset>.agents.<agent>.temperature`.
2. Base `agents.<agent>.temperature`.
3. Layered agent definition frontmatter `temperature` (`./.wld` > `~/.wld` > bundled).
4. Unset, letting the provider/model default apply.

RunWield omits the resolved temperature for the ChatGPT Codex Responses endpoint, which does not support that parameter.
If another provider or model reports that temperature is unsupported before returning assistant content, RunWield
retries that request once without temperature.

### `visionFallback`

Type: object with `model` string in `provider/model_id` format.

`visionFallback` configures a vision-capable fallback model for image inspection when the active agent model is
text-only. Vision-capable active models keep receiving images directly and do not get the `see_image` tool.

Resolution order:

1. Active preset `modelPresets.<activeModelPreset>.visionFallback.model`.
2. Top-level `visionFallback.model`.
3. Disabled when unset.

Example with LM Studio and Gemma 4 12B:

```jsonc
{
    "visionFallback": {
        "model": "lmstudio/google/gemma-4-12B-it"
    },

    "activeModelPreset": "local",
    "modelPresets": {
        "local": {
            "visionFallback": {
                "model": "lmstudio/google/gemma-4-12B-it"
            },
            "agents": {
                "engineer": {
                    "model": "lmstudio/some-text-only-code-model"
                }
            }
        }
    }
}
```

Gemma 4 12B is a recommended local image-description fallback when available in LM Studio. Configure the LM Studio
provider/model in RunWield's model registry with image input support and auth/base URL as usual, then set
`visionFallback.model` to that `provider/model_id`.

Behavior:

- **The active model supports images:** images go to it directly, and the fallback isn't used.
- **The active model is text-only and a fallback is set:** you can attach images. RunWield tells you the fallback model
  will describe them, and the Agent uses the `see_image` tool to inspect attachments or image files in your project.
- **The active model is text-only and no fallback is set:** RunWield blocks the attachment and keeps what you typed:

```text
Cannot attach image: current model does not support vision and no visionFallback.model is configured.
See https://docs.runwield.dev/settings/#visionfallback to configure an image fallback model.
```

RunWield checks the fallback model and its credentials when you send or inspect an image, not when a Session starts.

#### Declaring vision support for discovered models

OpenAI-compatible `/models` endpoints (used to auto-discover models for providers configured with only `baseUrl` +
`apiKey` in `~/.wld/models.json`) do not report per-model input modalities. RunWield therefore registers discovered
models as **text-only** by default — sending raw image bytes to a text-only model can fail silently on some providers.

To mark specific discovered models as vision-capable, add an `imageInputModels` array to the provider entry in
`models.json`:

```json
{
    "providers": {
        "crofai": {
            "baseUrl": "https://crof.ai/v1",
            "api": "openai-completions",
            "apiKey": "...",
            "imageInputModels": ["some-vision-model"]
        }
    }
}
```

Models not listed remain text-only and rely on `visionFallback.model`. A model named in `visionFallback.model` is always
treated as vision-capable, so it does not need to appear in `imageInputModels`. To fully control a model's metadata
(context window, cost, etc.), define it explicitly under `providers.<p>.models[]` with `input: ["text", "image"]`
instead of relying on discovery.

### `imageGeneration`

Type: object with `model` (required), `thinkingLevel`, `temperature`, and `enabled`.

`imageGeneration` turns on the `create_image` tool, which lets an Agent generate a new image or edit an existing one and
save it in your project. The image model is separate from your conversation model, so any conversation model can use it,
including Claude CLI.

Supported providers:

| Provider        | `model` format             | Sign-in                                       |
| --------------- | -------------------------- | --------------------------------------------- |
| OpenRouter      | `openrouter/<image model>` | OpenRouter credentials through `/login`       |
| OpenCode        | `opencode/<model>`         | OpenCode credentials through `/login`         |
| Codex           | `codex-cli/<model>`        | Codex CLI signed in with your ChatGPT account |
| Antigravity CLI | `agy-cli/<model>`          | `agy` installed and signed in to Antigravity  |

See [Login commands](providers.md#login-commands) for `/login`.

#### OpenRouter

```jsonc
{
    "imageGeneration": {
        "model": "openrouter/google/gemini-3.1-flash-image",
        "thinkingLevel": "high",
        "temperature": 1
    }
}
```

Choose an image-output model. A chat model that only accepts images as input cannot generate them.

- `google/gemini-3.1-flash-image`: `thinkingLevel` `minimal` or `high`; `temperature` 0–2.
- `google/gemini-2.5-flash-image`: `temperature` 0–2; no `thinkingLevel`.
- Other OpenRouter image models: omit both.

#### OpenCode

```jsonc
{
    "imageGeneration": {
        "model": "opencode/<model>"
    }
}
```

Choose an OpenCode model that uses the Responses API. Your OpenCode account must have access to that model and to image
generation. To edit reference images, the model must also accept image input.

- Reasoning models accept `thinkingLevel` and no `temperature`.
- Other models accept `temperature` 0–2 and no `thinkingLevel`.

#### Codex

```jsonc
{
    "imageGeneration": {
        "model": "codex-cli/gpt-5.6-sol",
        "thinkingLevel": "low"
    }
}
```

Install the Codex CLI and sign in with your ChatGPT account. Image generation uses your ChatGPT subscription, not API
billing. RunWield looks for `codex` on your `PATH`. On macOS it also finds the copy bundled with the ChatGPT desktop app
in `~/Applications` or `/Applications`.

The model must appear in your Codex model list. `thinkingLevel` accepts the reasoning efforts Codex offers for that
model; `off` means none. `temperature` is not supported. Codex picks the image model itself. `openai-codex/<model>` is
an accepted alias for `codex-cli/<model>`.

#### Antigravity CLI

```jsonc
{
    "imageGeneration": {
        "model": "agy-cli/gemini-3.8-flash",
        "thinkingLevel": "medium"
    }
}
```

Install `agy` and sign in to Antigravity. Supported models are `agy-cli/gemini-3.8-flash` and `agy-cli/gemini-3.1-pro`.
`thinkingLevel` maps to Antigravity effort as in the [Antigravity CLI](providers.md#antigravity-cli) table.
`temperature` is not supported. Antigravity picks the image model itself.

#### Where to set it

Set `imageGeneration` in global settings, project settings, or a model preset (`modelPresets.<name>.imageGeneration`).
Project settings override global settings, and the active preset overrides both. When a more specific scope changes
`model`, it doesn't inherit `thinkingLevel` or `temperature` from the broader scope.

To turn image generation off in one scope without deleting the configuration, set `"enabled": false`.

After enabling it for the first time, start a new Session so Agents pick up the tool. Agents that can write files get
`create_image`, and so does Guide. Read-only Agents don't. Image generation isn't available in remote Sessions yet.

#### Using it

Ask the Agent for an image and say where to save it. The Agent can also edit images you name, from your project or
attached to the Session.

- The output must be a new `.png`, `.jpg`, `.jpeg`, or `.webp` file inside the project. Existing files are never
  overwritten.
- Up to 14 reference images can be used for an edit, subject to the provider's own limits.
- Each request makes one image. Requests time out after five minutes and are not retried, so a failure never charges you
  for a second image.
- The Agent cannot change the model or provider; only your settings can.

## Work Records

### `workRecords.autoGenerateOnPlanCompletion`

Type: boolean, inside the `workRecords` object. Default: `true`.

RunWield writes a [Work Record](usage.md#work-records) whenever a Plan finishes. Set this to `false` to stop that:

```jsonc
{
    "workRecords": {
        "autoGenerateOnPlanCompletion": false
    }
}
```

Only `false` turns it off. The `wld wr` commands, including `wld wr backfill`, keep working either way.

## Collaboration settings

### `planServerUrl`

Type: string URL.

`planServerUrl` configures the default remote Workspace Plan Server used by `wld plans share`. It is a non-secret base
URL only:

```jsonc
{
    "planServerUrl": "https://plans.example.com"
}
```

RunWield normalizes trailing slashes and rejects full share URLs, query strings, and fragments. Do not store reviewer or
maintainer URLs here; those contain secret `#key=...` and capability material. For one-off local testing, pass
`--plan-server http://127.0.0.1:8080` instead of editing settings. Pull, push, and unshare use the Plan's stored
`collaborationServerUrl` and reject overrides that point at a different Plan Server.

See [Self-hosted collaborative planning](collaboration.md) for Podman/OCI setup and the collaboration privacy model.

## RunWield Custom Keys

These keys are read by RunWield outside the upstream Pi `SettingsManager` schema.

| Key                                        | Type              | Values / default                                | Scope            | Description                                                                                                                                                                                                                                           |
| ------------------------------------------ | ----------------- | ----------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                                   | object            | agent-name map                                  | global + project | Base per-agent `model`, `thinkingLevel`, and `temperature` overrides.                                                                                                                                                                                 |
| `activeModelPreset`                        | string            | unset                                           | global + project | Selects a named preset from `modelPresets`.                                                                                                                                                                                                           |
| `modelPresets`                             | object            | preset-name map                                 | global + project | Named per-agent override sets.                                                                                                                                                                                                                        |
| `visionFallback`                           | object            | unset                                           | global + project | Vision-capable fallback model used by `see_image` when the active model is text-only.                                                                                                                                                                 |
| `imageGeneration`                          | object            | unset                                           | global + project | Image model used by the `create_image` tool. See [`imageGeneration`](#imagegeneration).                                                                                                                                                               |
| `compactOnResumeThresholdPercent`          | integer           | `1`-`100`, default `50`                         | global + project | `/resume` offers compaction when estimated context reaches this percentage of the selected model context window.                                                                                                                                      |
| `verification_command`                     | string            | no default                                      | project          | Command used by Workflow Validation. Init infers candidates from repository evidence, asks the user to confirm one, and saves the confirmed project command. Selecting no implemented verification saves `echo "verification not implemented yet"`.   |
| `codereview`                               | string            | `none`, `ask`, `always`; default `none`         | global + project | Optional Plannotator human code review gate after local validation and semantic review pass, before merge-back. Invalid values fall back to `none`.                                                                                                   |
| `guidedReview`                             | string            | `none`, `ask`, `auto`, `always`; default `auto` | global + project | Guided Review Explainer generation policy inside human code review. Invalid values fall back to `none`; manual generation remains available when supported.                                                                                           |
| `cleanupMergedWorktrees`                   | boolean           | default `true`                                  | global + project | When true, successful merge-back removes a clean execution checkout, deletes its registry entry, and clears Plan worktree metadata. Unexpected dirty state is preserved rather than force-deleted. Set false to keep merged worktrees for inspection. |
| `workRecords.autoGenerateOnPlanCompletion` | boolean           | default `true`                                  | global + project | Writes a Work Record when a Plan finishes. Only `false` turns it off.                                                                                                                                                                                 |
| `mascot`                                   | boolean           | default `true`                                  | global + project | Hides the agent mascot in TUI and Workspace when false.                                                                                                                                                                                               |
| `notifications`                            | object            | enabled by default                              | global + project | Attention notifications. TUI uses terminal BEL/OSC for agent stops, `plan_written`, `user_interview`, and `/compact`. Workspace uses browser alerts for live `agentStopped` events. Focused surfaces stay quiet by default.                           |
| `workflowMetrics`                          | boolean or object | default disabled                                | global + project | Opt-in local-only JSONL workflow metrics under `~/.wld/workflow-metrics/<encoded-project-root>/metrics.jsonl`. Linked worktrees write to the primary project file. Accepts `true` or `{ "enabled": true }`.                                           |
| `planServerUrl`                            | string            | unset                                           | global + project | Default Plan Server for `wld plans share`. See [`planServerUrl`](#planserverurl).                                                                                                                                                                     |
| `enableExternalSkills`                     | boolean           | default `true`                                  | global           | When true, RunWield includes project `.agents/skills` and home `~/.agents/skills`. When false, it omits both folders. External skills cannot conflict with bundled names or aliases.                                                                  |
| `enableExternalGlobalAgentsMd`             | boolean           | default `true`                                  | global           | When true, global prompt loading includes `~/.agents/AGENTS.md` after `~/.wld/RUNWIELD.md` and `~/.wld/AGENTS.md`.                                                                                                                                    |

### `workflowMetrics`

Type: boolean or object. Default: off.

`workflowMetrics` records how RunWield workflows run, for your own local analysis. It is off by default, and RunWield
writes no metrics until you turn it on. Either form enables it:

```jsonc
{ "workflowMetrics": true }
```

```jsonc
{ "workflowMetrics": { "enabled": true } }
```

Metrics are record-only in this release. RunWield has no reporting UI, CLI summary, or analytics sync. Nothing is
uploaded, and nothing is backfilled for activity before you enabled the setting.

#### Where records go

RunWield appends one JSON object per line to:

```text
~/.wld/workflow-metrics/<encoded-project-root>/metrics.jsonl
```

`<encoded-project-root>` uses the same directory encoding as persisted sessions. Linked execution worktrees write to the
primary project's file, so one project has one metrics file.

There is no retention period or cleanup job. The file stays until you delete it.

#### What is recorded

Each row has a `category` and an `event`:

| Category                                                                        | What it covers                                                                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `routing`, `planning`, `execution`, `validation`, `recovery`, `model_selection` | Workflow lifecycle: routing decisions, planning, execution start and finish, retries, response latency, validation, and recovery. |
| `tool_usage`                                                                    | Which tools were exposed to the model and what they cost in context, plus each tool call in order.                                |
| `model_usage`                                                                   | Token counts and cost per turn or request.                                                                                        |
| `context`                                                                       | Context-size snapshots and compaction.                                                                                            |
| `command`                                                                       | Slash commands and command pickers.                                                                                               |

#### What is never recorded

Records contain no prompts, request text, Plan markdown, diffs, CI output, review feedback, raw tool arguments or
results, file contents, search queries, secrets, full auth configuration, or absolute worktree paths. Shell commands are
reduced to coarse labels such as `git status`, `deno task other`, or `pytest`; their arguments are dropped.

#### Reading the file

**Order rows by `recorderId`, then `seq`.** File order is not a timeline: several executions can append to the same file
at once.

**Version 1 and version 2 rows share the file.** Rows written by older releases (version 1) have no execution links,
sequence numbers, or coverage fields. Do not fill those fields in from neighboring rows.

Every version 2 row has `eventId`, `recorderId`, `seq`, `category`, `event`, `ts`, and `cwdHash`. A row can also carry
links that tie it to the work it belongs to:

| Link                                    | Identifies                                        |
| --------------------------------------- | ------------------------------------------------- |
| `managedSessionId`                      | The RunWield session.                             |
| `sessionId`                             | The backend's transcript.                         |
| `segmentId`, `turnId`, `requestId`      | Position within the session.                      |
| `attemptId`                             | A retry attempt.                                  |
| `parentExecutionId`, `parentToolCallId` | The execution or tool call that started this one. |
| `taskId`                                | A delegated task.                                 |
| `commandId`                             | A slash command lifecycle.                        |

A `null` link means the source did not supply it. RunWield does not invent links. For example, a manual `/compact` run
outside an Agent turn links its context and compaction rows to the session and command, with no execution ID.

**`null` means "not measured", never zero.** This applies to token counts, costs, and links. A missing row is also not a
measured zero.

**Units.** Fields ending in `Ms` are either elapsed durations or epoch timestamps; the field name says which.
`resultBytes` counts UTF-8 bytes of text output. Fields ending in `Tokens` that RunWield estimates (rather than the
provider reporting them) use a local four-characters-per-token estimate, not provider billing. Images are counted, but
their tokens are not estimated.

**Coverage.** `coverage` and per-measurement `availability` are `complete`, `partial`, or `unavailable`.

#### Tool usage events

- `tool_exposure_summary` gives the number of tools offered to the model and their total estimated token cost.
- `tool_exposure` has one row per tool, with its index and two estimates: the schema alone, and the full context it
  occupies.
- `tool_call_started` and `tool_call_finished` share a call ID within an execution. A start with no matching finish does
  not mean the call succeeded.
- `tool_operation` records only the call index and a fixed label: Memory, shell, or batch.

#### Command events

All rows for one command share a `commandId`:

1. `command_started` (phase `opened`) when a command picker opens.
2. `command_dispatched` (phase `dispatched`) when you choose a command, before its outcome is known.
3. `command_finished` with outcome `succeeded`, `failed`, `canceled`, or `rejected`.

Closing a picker without choosing writes `command_finished` with `canceled`. No dispatch row is written and the model
does not change.

#### Model usage and cost

Each `model_usage` row identifies its transcript entry or source observation with `sourceId`.

**Avoid double-counting tokens.** Two fields tell you how to add rows up:

- `inputCacheBasis` says whether the input count already includes cache tokens. If it is `includes_cache` or `unknown`,
  do not add cache tokens on top.
- `aggregationBasis` is `turn` for a turn total or `alternative` for a more detailed breakdown. Claude CLI reports both:
  a turn total and per-request and per-model details that overlap the total and each other. When a turn has a `turn`
  row, sum only that row and use `alternative` rows for detail. Sum `alternative` rows only when no turn total exists.

**Cost.** `costAmount` is in `costCurrency` (currently USD). `costSource` says whether the provider reported the cost,
RunWield calculated it from rates, or it is unavailable. Treat it as a measurement, not an invoice.

#### Reliability

Recording is best effort. Rows can be lost if RunWield is interrupted, a write fails, or you turn metrics off while work
is running.

#### Backend coverage

What RunWield can measure depends on the backend:

- **Pi providers:** usage the provider doesn't report is `unavailable`.
- **Claude CLI and Antigravity CLI:** the tool inventory lists only RunWield's own tools, not the CLI's built-in ones,
  so its coverage is `partial`. The context cost of built-in tools, cache measurements the CLI doesn't report, and usage
  lost when a stream is cut off are `unavailable`.

### `codereview`

Type: string. Default: `ask`.

`codereview` controls whether executable Plan validation includes a human Plannotator code review gate. The gate runs
only after local validation and semantic review pass, and before merge-back or worktree cleanup.

Values:

- `none`: skip the optional human gate and use automated validation.
- `ask`: default. Prompt after semantic review passes. Choosing skip records the Plan as verified after merge-back
  without human review.
- `always`: open the Plannotator code review UI automatically after semantic review passes.

RunWield trims and normalizes this value case-insensitively. A missing value uses `ask`; existing explicit `none`,
`ask`, and `always` choices remain unchanged. Invalid values retain the legacy `none` behavior.

Use `/settings` to change Code review and Guided review for this project or globally. The menu labels stored `none` as
**Never** and preserves Guided review's additional **Auto** choice. Project overrides remain in effect when a global
preference changes. The same menu exposes the existing global-only Default project trust preference (`ask`, `always`,
`never`); changing it does not invent an additional execution permission gate.

This setting governs the gate that runs _after_ semantic approval. It does not suppress the code review offered when
automatic semantic rounds run out: if you choose to open code review there, it opens even under `none`, because nothing
else has approved the change and the alternative is stranding the work. Approving from that path merges back without
semantic approval, and RunWield records that distinction.

Code review feedback — from either path — is repaired by the Reviewer-Feedback Engineer in a fresh session with your
feedback, annotations, and images, after which CI reruns and code review reopens for your explicit approval. That cycle
is uncapped: it repeats for as many feedback rounds as you give and ends only when you approve or quit the review.

Example:

```jsonc
{
    "codereview": "ask"
}
```

### `guidedReview`

Type: string. Default: `auto`.

`guidedReview` controls whether RunWield generates a Guided Review Explainer inside an already-open human code review.
It never opens code review by itself; `codereview` remains the authoritative human-review gate.

Values:

- `none`: do not prompt or auto-start generation. The browser can still offer manual **Generate guided review** when a
  guide-capable provider is available.
- `ask`: prompt only when deterministic diff/Plan signals recommend an explainer.
- `auto`: default. Automatically generate only for large, cross-cutting, visual, or conceptually hard reviews.
- `always`: generate whenever human code review opens.

Guided Review Explainers are ephemeral review-session state. By default, generation uses RunWield's own model access
(`wld`) rather than External Agent Host CLIs; `RUNWIELD_GUIDED_REVIEW_COMMAND` is only an explicit override. RunWield
does not persist guide job IDs, model names, tokens, widget files, or guide completion state in Plan Front Matter.

Example:

```jsonc
{
    "codereview": "always",
    "guidedReview": "auto"
}
```

### `mascot`

Type: boolean. Default: `true`.

The agent mascot is on by default in TUI and Workspace. Set `"mascot": false` to hide it on both surfaces. Only a
literal `false` disables it; project settings override global settings. The TUI `/settings` menu has a **Mascot:
on|off** toggle that writes the global setting and applies on the next render. A project override still wins. After
manual settings-file edits, use `/reload` in TUI or reopen the Workspace Session. Workspace honors the setting but has
no mascot toggle UI.

### `notifications`

Type: object. Default: enabled.

`notifications` controls the alerts RunWield sends when it needs your attention. The TUI alerts you when:

- an Agent stops and hands control back to you;
- a Plan is ready for your review;
- an Agent asks you structured questions;
- a `/compact` you ran finishes.

Workspace sends a browser alert only when an Agent stops.

Defaults:

- `enabled`: `true`; disables TUI terminal delivery and Workspace browser alerts when set to `false`.
- `suppressWhenFocused`: `true`; focused TUI terminals stay quiet. Workspace tabs stay quiet only when the tab is
  visible and focused. Set this to `false` to allow alerts in focused surfaces.
- `events.agentStopped`: `true`; controls TUI agent-stop notifications and Workspace browser alerts for live Agent
  stops.
- `events.planWritten`, `events.userInterview`, `events.compactionFinished`: all `true`; TUI-only delivery.
- `terminalBell`: `true`; TUI-only. Emits one ASCII BEL byte for each enabled TUI attention event that is not suppressed
  by terminal focus.
- `activation`: `tab`; TUI-only compatibility key. RunWield no longer executes activation commands. Native terminal OSC
  notifications own click-to-focus behavior where the terminal implements it.

The TUI uses your terminal's own notifications where it supports them:

| Terminal                               | Notification                              |
| -------------------------------------- | ----------------------------------------- |
| Kitty                                  | Native notification (OSC 99)              |
| WezTerm, Ghostty                       | Native notification (OSC 777)             |
| iTerm2                                 | Native notification (OSC 9)               |
| Terminal.app, VS Code, other terminals | Bell only, when `terminalBell` is enabled |

Inside tmux, screen, or zellij, native notifications need passthrough enabled in the multiplexer. Without it, you get
the bell only.

Example:

```jsonc
{
    "notifications": {
        "enabled": true,
        "terminalBell": true,
        "suppressWhenFocused": true,
        "activation": "tab",
        "events": {
            "agentStopped": true,
            "planWritten": true,
            "userInterview": true,
            "compactionFinished": true
        }
    }
}
```

To suppress all BEL-derived terminal effects while keeping native OSC notifications:

```jsonc
{
    "notifications": {
        "terminalBell": false
    }
}
```

To keep alerts active even when RunWield knows the TUI terminal is focused:

```jsonc
{
    "notifications": {
        "suppressWhenFocused": false
    }
}
```

To disable only routine agent-stop notifications while keeping prompts/review/compaction alerts:

```jsonc
{
    "notifications": {
        "events": {
            "agentStopped": false
        }
    }
}
```

## Pi-Backed Keys

These keys come from the upstream `@earendil-works/pi-coding-agent` settings schema used by RunWield.

| Key                         | Type         | Values / default                                                             | Description                                                                                                                   |
| --------------------------- | ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `lastChangelogVersion`      | string       | unset                                                                        | Last version whose changelog was shown. Usually managed automatically.                                                        |
| `defaultProvider`           | string       | unset                                                                        | Default model provider, for example `anthropic`, `openai`, or `google`.                                                       |
| `defaultModel`              | string       | unset                                                                        | Default model id within `defaultProvider`. Unlike agent overrides, this is only the model id.                                 |
| `defaultThinkingLevel`      | string       | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`                           | Default reasoning depth for thinking-capable models.                                                                          |
| `transport`                 | string       | `auto`, `sse`, `websocket`, `websocket-cached`; default `auto`               | Preferred provider transport when supported.                                                                                  |
| `steeringMode`              | string       | `all` or `one-at-a-time`; default `one-at-a-time`                            | How messages submitted while the agent is streaming are delivered.                                                            |
| `followUpMode`              | string       | `all` or `one-at-a-time`; default `one-at-a-time`                            | How queued follow-up messages are delivered after the agent stops.                                                            |
| `theme`                     | string       | default `catppuccin-mocha`                                                   | Active TUI theme name.                                                                                                        |
| `hideThinkingBlock`         | boolean      | default `false`                                                              | Hide assistant thinking blocks in rendered output.                                                                            |
| `shellPath`                 | string       | unset                                                                        | Custom shell path.                                                                                                            |
| `quietStartup`              | boolean      | default `false`                                                              | Suppress verbose startup output.                                                                                              |
| `defaultProjectTrust`       | string       | `ask`, `always`, `never`; default `ask`                                      | Global setting for default project trust prompt behavior.                                                                     |
| `shellCommandPrefix`        | string       | unset                                                                        | Prefix prepended to each bash command.                                                                                        |
| `npmCommand`                | string array | unset                                                                        | Command argv used for npm package lookup and install operations.                                                              |
| `collapseChangelog`         | boolean      | default `false`                                                              | Show condensed changelog after updates.                                                                                       |
| `enableInstallTelemetry`    | boolean      | default `true`                                                               | Send anonymous version/update ping after changelog-detected updates.                                                          |
| `enableAnalytics`           | boolean      | default `false`                                                              | Opt-in analytics data sharing.                                                                                                |
| `trackingId`                | string       | generated when analytics is enabled                                          | Analytics tracking identifier.                                                                                                |
| `packages`                  | array        | default `[]`                                                                 | Installed npm/git/local package sources. RunWield registers theme resources and package prompt templates from these packages. |
| `extensions`                | string array | default `[]`                                                                 | Local extension file paths or directories.                                                                                    |
| `skills`                    | string array | default `[]`                                                                 | Ignored by RunWield. Use project or home `.wld/skills` or `.agents/skills`.                                                   |
| `prompts`                   | string array | default `[]`                                                                 | Local prompt template file paths or directories.                                                                              |
| `themes`                    | string array | default `[]`                                                                 | Local theme file paths or directories.                                                                                        |
| `enableSkillCommands`       | boolean      | default `true`                                                               | Register skills as Core-owned `/skill:name` named invocations.                                                                |
| `enabledModels`             | string array | unset                                                                        | Model patterns for model cycling, using the same format as the `--models` CLI flag.                                           |
| `doubleEscapeAction`        | string       | `fork`, `tree`, `none`; default `tree`                                       | Action for pressing Escape twice with an empty editor.                                                                        |
| `treeFilterMode`            | string       | `default`, `no-tools`, `user-only`, `labeled-only`, `all`; default `default` | Default filter when opening the session tree.                                                                                 |
| `editorPaddingX`            | number       | clamped to `0`-`3`, default `0`                                              | Horizontal input editor padding.                                                                                              |
| `autocompleteMaxVisible`    | number       | clamped to `3`-`20`, default `5`                                             | Maximum visible autocomplete items.                                                                                           |
| `showHardwareCursor`        | boolean      | default `false`, or `PI_HARDWARE_CURSOR=1`                                   | Show the terminal cursor while positioning it for IME support.                                                                |
| `sessionDir`                | string       | unset                                                                        | Custom session storage directory. `~` and `~/...` are expanded.                                                               |
| `httpProxy`                 | string       | unset                                                                        | Proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` for Pi-managed HTTP clients.                                              |
| `httpIdleTimeoutMs`         | number       | `0` disables                                                                 | HTTP header/body idle timeout in milliseconds.                                                                                |
| `websocketConnectTimeoutMs` | number       | `0` disables                                                                 | WebSocket connect/open handshake timeout in milliseconds.                                                                     |

Nested Pi-backed objects such as `compaction`, `branchSummary`, `retry`, `terminal`, `images`, `thinkingBudgets`,
`markdown`, and `warnings` are covered below and in the schema.

### `compaction`

| Key                           | Type    | Values / default | Description                                                          |
| ----------------------------- | ------- | ---------------- | -------------------------------------------------------------------- |
| `compaction.enabled`          | boolean | default `true`   | Enable automatic context compaction.                                 |
| `compaction.reserveTokens`    | number  | default `16384`  | Tokens reserved for prompt and response during compaction decisions. |
| `compaction.keepRecentTokens` | number  | default `20000`  | Recent context budget retained around the compaction boundary.       |

### `branchSummary`

| Key                           | Type    | Values / default | Description                                                         |
| ----------------------------- | ------- | ---------------- | ------------------------------------------------------------------- |
| `branchSummary.reserveTokens` | number  | default `16384`  | Tokens reserved for prompt and response while summarizing a branch. |
| `branchSummary.skipPrompt`    | boolean | default `false`  | Skip the "Summarize branch?" prompt and default to no summary.      |

### `retry`

| Key                              | Type    | Values / default | Description                                                                                           |
| -------------------------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `retry.enabled`                  | boolean | default `true`   | Enable Pi-backed model-request and Workflow Validation operational retries.                           |
| `retry.maxRetries`               | number  | default `3`      | Maximum retry attempts after the initial attempt.                                                     |
| `retry.baseDelayMs`              | number  | default `2000`   | Base exponential backoff delay in milliseconds.                                                       |
| `retry.validation.maxDelayMs`    | number  | default `60000`  | Maximum Workflow Validation operational retry delay in milliseconds. Must be greater than `0`.        |
| `retry.provider.timeoutMs`       | number  | unset            | Provider SDK/request timeout in milliseconds when supported.                                          |
| `retry.provider.maxRetries`      | number  | unset            | Provider SDK/client retry attempts when supported.                                                    |
| `retry.provider.maxRetryDelayMs` | number  | default `60000`  | Provider SDK maximum server-requested retry delay before failing; `0` disables the provider cap only. |

For temporary Pi-backed model-service failures, the defaults allow one initial request and three retries. The waits
before those retries are 2, 4, and 8 seconds. Set `retry.enabled` to `false` to disable these high-level retries, or
adjust `retry.maxRetries` and `retry.baseDelayMs` to change the attempt count and waits. Cancellation stops retries.
After retries run out, the request stops and you can try again. A Plan that was running stays where it was, and you can
continue it.

Workflow Validation also uses `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`, and
`retry.validation.maxDelayMs` for operational retries. These retries do not spend CI repair rounds or Semantic Code
Review rounds. The `retry.provider.*` settings stay provider-only: they control supported provider SDK requests, not the
Pi-backed model-request retry count above.

### `terminal`

| Key                             | Type    | Values / default                           | Description                                         |
| ------------------------------- | ------- | ------------------------------------------ | --------------------------------------------------- |
| `terminal.showImages`           | boolean | default `true`                             | Render images inline when the terminal supports it. |
| `terminal.imageWidthCells`      | number  | integer minimum `1`, default `60`          | Preferred inline image width in terminal cells.     |
| `terminal.clearOnShrink`        | boolean | default `false`, or `PI_CLEAR_ON_SHRINK=1` | Clear empty rows when content shrinks.              |
| `terminal.showTerminalProgress` | boolean | default `false`                            | Show OSC `9;4` terminal progress indicators.        |

### `images`

| Key                  | Type    | Values / default | Description                                                   |
| -------------------- | ------- | ---------------- | ------------------------------------------------------------- |
| `images.autoResize`  | boolean | default `true`   | Resize images to a 2000x2000 maximum for model compatibility. |
| `images.blockImages` | boolean | default `false`  | Prevent all images from being sent to model providers.        |

### `thinkingBudgets`

Type: object. Values are token budgets for token-budgeted thinking providers.

| Key                       | Type   | Description                 |
| ------------------------- | ------ | --------------------------- |
| `thinkingBudgets.minimal` | number | Token budget for `minimal`. |
| `thinkingBudgets.low`     | number | Token budget for `low`.     |
| `thinkingBudgets.medium`  | number | Token budget for `medium`.  |
| `thinkingBudgets.high`    | number | Token budget for `high`.    |

### `markdown`

| Key                        | Type   | Values / default   | Description                                        |
| -------------------------- | ------ | ------------------ | -------------------------------------------------- |
| `markdown.codeBlockIndent` | string | default two spaces | Prefix used when rendering code block indentation. |

### `warnings`

| Key                            | Type    | Values / default | Description                                                     |
| ------------------------------ | ------- | ---------------- | --------------------------------------------------------------- |
| `warnings.anthropicExtraUsage` | boolean | default `true`   | Warn when Anthropic subscription auth may use paid extra usage. |

## Package Sources

`packages` entries can be strings or filtered objects.

```jsonc
{
    "packages": [
        "npm:@scope/theme-pack",
        {
            "source": "git:https://github.com/example/themes.git",
            "themes": ["themes/theme-a.json"],
            "extensions": [],
            "skills": [],
            "prompts": []
        }
    ]
}
```

Object fields:

- `source`: package source string.
- `extensions`: extension files to load from the package.
- `skills`: ignored. RunWield does not load package skills; see below.
- `prompts`: prompt template files to load from the package.
- `themes`: theme JSON files to load from the package.

RunWield loads passive package prompt templates from `pi.prompts` without requiring an executable-extension
compatibility marker. Package prompts are appended after project, home, and bundled RunWield prompts, so they cannot
silently replace those templates. If a package prompt name collides with a built-in slash command such as `/help`,
`/agent`, or `/theme`, the built-in command wins and RunWield shows a startup warning for the blocked package prompt.
Prompt Template Front Matter can select persistent `agent`, `model`, and `thinkingLevel` Session settings; omitted
values inherit the Session, with Operator defaults for an unconfigured new Session. Invalid values fail before
submission. See [Prompt templates](customization.md#prompt-templates) for the unfinished-workflow guard.

RunWield ignores all Pi-discovered skills, including configured `skills` paths, package skills, and extension skills.
When `wld install <source>` finds package skills, it reports them as ignored and prints `npx skills add <source>`
guidance so users can install them through the external skills CLI instead. RunWield does not shell out to `npx`, copy
package skills, or mutate skill directories.

Pi code extensions are not loaded from packages by default because they can execute arbitrary extension logic. RunWield
only loads package code extensions when both conditions are met:

1. The package declares WLD compatibility in package metadata:

```json
{
    "pi": {
        "extensions": ["./index.js"],
        "wld": {
            "compatible": true,
            "extensionApi": 1,
            "kind": "code-extension"
        }
    }
}
```

2. The user approves the install-time warning. Extension packages are not vetted by RunWield. They can register tools,
   alter prompts, intercept tool calls, read project/session data, call external services, leak data, run unwanted
   commands, or cause other issues.

If the user declines extension loading, RunWield keeps passive resources from the package but persists the package with
`extensions: []` so code extension paths are skipped. Theme package behavior is covered in [themes.md](themes.md).

## Legacy Migrations

RunWield and Pi migrate a few older key shapes while loading settings:

- `queueMode` becomes `steeringMode` when `steeringMode` is not already set.
- `websockets: true` becomes `transport: "websocket"`; `websockets: false` becomes `transport: "sse"`.
- Old object-shaped `skills` settings become `enableSkillCommands` and/or a `skills` path array.
- `retry.maxDelayMs` becomes `retry.provider.maxRetryDelayMs` when the provider field is not already set.
