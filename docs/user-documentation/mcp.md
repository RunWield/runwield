# MCP Tools

RunWield can start Model Context Protocol (MCP) servers you trust and give their tools to your Agents.

## Configuration files

Use a dedicated MCP file. Do not put MCP commands or secrets in `settings.json`.

- Global file: `~/.wld/mcp.json`
- Project file: `.wld/mcp.json` in your main checkout

A project MCP file runs programs on your machine, so keep it out of Git:

```gitignore
.wld/mcp.json
```

RunWield uses the project file only when Git ignores it. If the file could be committed, RunWield skips it and warns
you.

Both files are JSONC and should use mode `0600` on POSIX systems.

## File shape

```jsonc
{
    "mcpServers": {
        "project-tools": {
            "command": "my-mcp-server",
            "args": ["--stdio"],
            "env": { "TOKEN": "secret-value" }
        },
        "disabled-global-server": {
            "enabled": false
        }
    }
}
```

A project entry replaces the whole global entry with the same name; the two aren't merged. A project entry with
`enabled: false` turns off a global server for that project.

ACP clients can also pass MCP servers when they start a Session. Those servers are used for that Session only and are
not saved.

## What's supported

RunWield uses Pi's
[built-in MCP support](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/mcp.md).

- **Servers:** stdio servers only. HTTP servers, OAuth sign-in, and MCP prompts aren't supported yet.
- **Tools:** each tool appears to Agents as `mcp__<server>__<tool>`. If two names collide or a name is too long, a short
  suffix is added.
- **Resources:** servers that have resources also give Agents tools to list and read them. Text and images reach the
  model. Text over 20 KiB is cut short, and the full output is saved to a temporary file named in the result.
- **Updates:** when a server adds or removes tools, Agents see the change right away. Claude CLI and Antigravity CLI see
  it on their next turn. `/reload` rereads your MCP files.
- **Which Agents:** every main Agent gets your MCP tools. Helper Agents and the review Agents used during validation
  don't.
- **Failures:** if a server can't start, RunWield shows a warning with secrets removed, and the Session keeps working.

## Checking servers

```text
/mcp                      # show each server's status and tool count
/mcp reconnect <server>   # reconnect one server
```

These commands don't use the model. `/mcp` can show a server's own error output, which may include details that startup
warnings hide.

## Trust

MCP servers are programs you choose to run. They can run commands and receive the `env` values you configure. A server
gets a minimal environment plus its own `env`, not all of RunWield's credentials. RunWield hides secrets in its own
warnings, but it can't control what a server writes to its own logs.

MCP tools don't say reliably whether they only read data or also change it, so treat every configured server as able to
change things.
