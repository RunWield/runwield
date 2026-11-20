# Providers and Models

RunWield uses Pi's provider and model infrastructure with RunWield-owned config paths.

For complete provider-specific setup, OAuth/API-key options, environment variables, and custom provider details, see
[Pi Providers](https://pi.dev/docs/latest/providers), [Pi Custom Models](https://pi.dev/docs/latest/models), and
[Pi Custom Providers](https://pi.dev/docs/latest/custom-provider).

## RunWield storage paths

| Data                  | RunWield path          |
| --------------------- | ---------------------- |
| Credentials           | `~/.wld/auth.json`     |
| Model registry/config | `~/.wld/models.json`   |
| Settings              | `~/.wld/settings.json` |

If a RunWield file does not exist, RunWield may import the matching Pi file from `~/.pi/agent/` once. After that,
RunWield reads and writes the RunWield-owned file.

## Login commands

Inside the TUI:

```text
/login
/logout
/status
```

`/login` can store subscription or API-key credentials. `/status` shows configured providers and available model count.

## Model selection

Use:

```text
/model
```

or from the CLI:

```bash
wld model <provider>/<model_id>
```

In the local TUI model picker, select **Refresh catalog** with the arrow keys and press **Enter**, or press **Ctrl+R**.
This refreshes the Pi model catalog from the network without waiting for its cache to expire. The list updates in place
and keeps your search text. A refresh stops after 15 seconds. If it
fails or times out, the picker reports the error and keeps the cached models. Opening `/model` uses the existing cache;
it does not force a network update. Remote SSH catalogs remain laptop-owned and require a new control connection.

RunWield expects strict `provider/model_id` references for explicit model settings and per-agent overrides.

## Agent model overrides

RunWield can assign different models to different agents:

```jsonc
{
    "agents": {
        "router": {
            "model": "openai/gpt-5-mini",
            "thinkingLevel": "minimal",
            "temperature": 0.1,
        },
        "engineer": {
            "model": "anthropic/claude-sonnet-4-5",
            "thinkingLevel": "high",
            "temperature": 0.4,
        },
    },
}
```

See [Settings Reference](settings.md) for `agents`, `activeModelPreset`, and `modelPresets`.

## Antigravity CLI (removed)

RunWield no longer runs Antigravity CLI models or generates images through Antigravity. Existing Session history
keeps its original model names. To continue with Gemini, configure the `google/<model>` provider with a
[Google AI Studio API key](https://ai.google.dev/gemini-api/docs/api-key). This uses Gemini API billing, not your
Antigravity subscription.

If you used the bundled `agy` preset, choose a supported preset in `/settings` or clear `activeModelPreset`.
Use `/model` to choose a supported model before continuing an affected Session. Update defaults, Agent models,
and personal or project presets that still refer to `agy-cli/<model>`. Change or clear
[`visionFallback.model`](settings.md#visionfallback) and [`imageGeneration.model`](settings.md#imagegeneration)
if they use Antigravity. RunWield does not silently switch the provider or billing method.
