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

RunWield expects strict `provider/model_id` references for explicit model settings and per-agent overrides.

## Agent model overrides

RunWield can assign different models to different agents:

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
    }
}
```

See [Settings Reference](settings.md) for `agents`, `activeModelPreset`, and `modelPresets`.

## Antigravity CLI

Antigravity models run through the `agy` CLI using your Antigravity sign-in, so you don't need an API key.

**Set up:**

1. Install `agy` and sign in to Antigravity.
2. Select `agy-cli/gemini-3.8-flash` or `agy-cli/gemini-3.1-pro` with `/model` or in your settings.
3. On first use, RunWield asks before installing the Antigravity agent and MCP configuration it needs.

> **Warning:** Antigravity can't ask you to approve actions while RunWield runs it in the background. During execution,
> RunWield therefore starts it with `--dangerously-skip-permissions`, which approves every command and file change the
> Agent requests. Use this backend only when you trust the Agent to run commands and change files with your account's
> permissions. See
> [Antigravity's headless permissions documentation](https://antigravity.google/docs/cli/headless/#permissions-in-headless-mode).

Each Agent can use only the tools it is allowed. For example, an Agent without write access cannot create or edit files.
If Antigravity blocks an action, RunWield shows what was blocked.

**Thinking level** sets Antigravity's effort:

| Thinking level    | Flash effort | Pro effort |
| ----------------- | ------------ | ---------- |
| off, minimal, low | low          | low        |
| medium            | medium       | high       |
| high, xhigh, max  | high         | high       |

**Limitations:**

- You can't attach images to an Antigravity conversation. Use [`visionFallback`](settings.md#visionfallback) to inspect
  images through another model.
- The Session shows Antigravity's commands, file edits, and results as they happen. After a reload, it shows only the
  steps that finished.
