# Settings

Use this file for settings and model questions. Link to these docs for depth:

- https://docs.runwield.dev/settings/
- https://docs.runwield.dev/providers/
- https://github.com/gandazgul/runwield/blob/main/docs/router-model-selection.md

## Files and merge behavior

RunWield reads JSONC settings from `~/.wld/settings.json` and project `.wld/settings.json`. Project settings override
global settings. RunWield merges custom object keys `agents` and `modelPresets` by top-level object key instead of
replacing them wholesale.

MCP servers use separate files, not settings: `~/.wld/mcp.json` and optional project `.wld/mcp.json`. The project MCP
file must be local-only: regular file, untracked, not staged, and ignored by Git. See https://docs.runwield.dev/mcp/.

If a user asks what their setup does, read these files before answering.

## Per-Agent model overrides

`agents.<name>` can set:

- `model`: a string in `provider/model_id` form.
- `thinkingLevel`: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `temperature`: a number from `0` to `2`.

Bundled Agent names are `architect`, `engineer`, `guide`, `ideator`, `operator`, `planner`, `router`, and `tester`.

## Model presets

RunWield ships `codex`, `agy`, `opencode`, `claude-mixed`, `claude-opus`, and `codex-claude`. They are available in
`/settings` without personal preset definitions. Files in `~/.wld/bundled-model-presets/` are disposable copies of
bundled assets. Copy a definition into settings to customize it. Presets resolve by name: project over personal over
bundled, replacing the whole lower-priority preset. Bundled presets are never activated automatically.

`activeModelPreset` names a bundled or user-defined entry in `modelPresets`. If it is unset, missing, or unknown,
RunWield uses base `agents` settings. Presets are partial: missing values fall back per Agent to the base `agents`
entry. A manual `/model` override wins until the active Agent changes.

Working example:

```jsonc
{
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
    "activeModelPreset": "cheap",
    "modelPresets": {
        "cheap": {
            "agents": {
                "router": {
                    "model": "openai/gpt-5-mini",
                    "thinkingLevel": "minimal",
                    "temperature": 0.1
                },
                "planner": {
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
    }
}
```

To make Router cheaper, add or edit `agents.router` in the active preset, then set `activeModelPreset` to that preset
name and run `/reload` in active sessions.

## `visionFallback`

`visionFallback.model` configures a vision-capable fallback model for image inspection when the active Agent model is
text-only. Resolution order:

1. `modelPresets.<activeModelPreset>.visionFallback.model`.
2. Top-level `visionFallback.model`.
3. Disabled when unset.

Vision-capable active models keep receiving images directly and do not get the `see_image` tool. Text-only active models
with a fallback receive image descriptions through `see_image`. Text-only active models without a fallback block image
paste/submission non-destructively.

## Providers and authentication

Use `wld login` to configure subscription or API-key credentials before a Session starts. It also requires a usable
default model before it exits successfully. Use `/login` inside the TUI to configure credentials and switch the live
Session model. Use `/status` to show configured providers and available models. RunWield stores credentials in
`~/.wld/auth.json`.

`~/.wld/models.json` is the model registry for custom or self-hosted models such as Ollama, LM Studio, vLLM, API
proxies, or OpenAI-compatible servers. Explicit settings use `provider/model_id` values from that registry.

## `metricsExport` (global scope only)

`metricsExport.destinations` holds Core Export grants: approved exporter identity, endpoint, external project, explicit
Project allowlist, and each Project's start position. Project-scope values are ignored. A grant sends only eligible
observations collected after its start boundary. Endpoint changes and re-enablement start new consent; credential
rotation keeps the boundary. No Project is added automatically.

This key holds no secrets. Credentials live separately in `~/.wld/metrics-export/credentials.json` with owner-only
permissions; status shows only configured or not configured. Exporter package approval and local `workflowMetrics`
collection opt-in are separate permissions. Core functions manage grants; Workspace controls and Langfuse remain planned
capabilities. Do not advise a command-line setup flow.

## Other user-facing keys

- `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`: base model defaults.
- `theme`: active TUI theme.
- `compaction.enabled`, `compaction.reserveTokens`, and `compaction.keepRecentTokens`: automatic compaction behavior.
- `compactOnResumeThresholdPercent`: when resume offers compaction.
- `verification_command`: local validation command used by Mechanical Validation.
- `codereview`: human code-review gate; `none`, `ask`, or `always`.
- `cleanupMergedWorktrees`: whether verified merged worktrees are cleaned up.
- `workRecords.autoGenerateOnPlanCompletion`: automatic Work Record creation after supported terminal outcomes.
- `plans.archiveRetentionDays`: project-scope-only archived Plan retention delay. Default `14`. `0` makes a covered
  archived Plan due immediately.
- `plans.archiveKeepLast`: project-scope-only floor that spares the newest eligible archived Plans. Default `10`. `0`
  disables the floor.
- `workflowMetrics.enabled`: local workflow metrics recording.
- `planServerUrl`: default Plan Server URL for collaborative Shared Spaces.
