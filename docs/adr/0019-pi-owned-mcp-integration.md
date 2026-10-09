---
status: accepted
---

# Pi owns MCP protocol behavior

## Context and Constraints

The owner chose Pi's official MCP integration after the Pi 1.0 upgrade, with codemode handled separately. RunWield
already owns trusted `.wld/mcp.json` loading, additive ACP request configuration, and Session access rules. Root Agents
can change or use external CLI backends while the Session's MCP connections remain available. Delegated and isolated
Agents do not inherit those connections.

## Decision and Rationale

Use Pi's public `createMcpExtension()` in a Session-owned, in-memory SDK host. This host never prompts a model or writes
a conversation. Pi owns connection discovery, tool definitions and names, result conversion, resource access,
reconnection, and shutdown. RunWield supplies approved configuration and a stdio transport factory that retains its
minimal inherited environment.

Root Pi sessions register Pi's original tool definitions through an extension binding, including subsequent tool-list
updates. External CLI backends expose current definitions through their existing per-turn bridge. Agent disposal
releases the root binding; owning Session disposal awaits Pi's shutdown hook before disposing the host. An explicitly
supplied authorized integration remains bound when its inventory is empty, because discovery and recovery are
independent of the current tool count. Isolated invocation clears both the tool snapshot and the integration.

Using only Pi's client library still required RunWield to maintain discovery orchestration, naming, conversion, and
reconnection. Loading the MCP extension independently in each root Agent was also considered: it would tie connections
to replaceable Agents and would not provide definitions to external CLI backends. A separate Session host fits the
existing lifetime and backend constraints.

## Implications

There is one extra in-memory SDK host for each Session with configured MCP servers. It reuses RunWield's model/auth
runtime and performs no model turns. MCP definitions adopt Pi's native names and output contract; configuration paths
and trust rules remain RunWield-owned.

Pi's SDK name allowlist is fixed at session construction. MCP roots therefore exclude unavailable non-MCP tools and
select the Agent's initial tools while permitting Pi to register new MCP names. Isolated Agents retain explicit
allowlists and receive no MCP binding. A root tool-call guard restricts other late extension tools to the Agent's
selected names; MCP access comes from Pi's current registered definitions. External CLI tool lists refresh between
turns.

This migration keeps stdio configuration and direct exposure. Codemode, HTTP/OAuth configuration, and Pi's interactive
configuration/sign-in manager remain separate scope. RunWield exposes the official status and reconnect command actions
without a model turn. Automatic diagnostics stay redacted; explicit inspection can show server error text.

Product requirements belong in
[Core's customization capability](../prd/runwield-core-prd.md#agent-and-skill-customization). User configuration and
behavior are documented in [MCP tools](../user-documentation/mcp.md).
