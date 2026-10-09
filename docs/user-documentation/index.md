# RunWield Documentation

RunWield helps you review what an AI plans to do before it changes your code, then verifies the result. Use this manual
to install RunWield, start a Session, understand its workflows, and configure it for your project.

RunWield builds on [Pi](https://pi.dev). These pages explain RunWield-specific behavior and link to Pi when the behavior
is unchanged. Visit the [RunWield website](https://runwield.dev) for the product overview.

## Start

### Install RunWield

On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/gandazgul/runwield/main/install.sh | bash
```

Make sure `~/.local/bin` is on your `PATH`, then start RunWield from your project root:

```bash
wld
```

On first use, connect a model provider when prompted. Then initialize the project and make a request:

```text
/init
fix the failing parser test
```

- [Quickstart](quickstart.md) — install, authenticate, initialize a project, and run your first request.
- [Workspace](workspace.md) — use RunWield in a browser or on your phone.

## Use RunWield

- [Using RunWield](usage.md) — commands, Agents, Work Records, and where RunWield keeps its data.
- [Plans and workflows](workflows.md) — how requests are routed, reviewed, executed, and verified.
- [Sessions](sessions.md) — resume work, name Sessions, and run background tasks.
- [Self-hosted collaboration](collaboration.md) — share Plans for review through your own Plan Server.

## Configure RunWield

- [Providers and models](providers.md) — credentials, model selection, and CLI backends.
- [Settings reference](settings.md) — global and project settings.
- [Customization](customization.md) — Agent overrides, prompt templates, and Skills.
- [Themes](themes.md) — select and install terminal themes.
- [MCP](mcp.md) — connect Model Context Protocol servers.

## Get help

- [Troubleshooting](troubleshooting.md) — resolve common installation and runtime problems.

For terminal editing, keybindings, and other inherited behavior, use the [Pi documentation](https://pi.dev/docs/latest).

Want to change RunWield itself? See [Contributing](../contributing.md).
