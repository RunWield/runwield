# Remote SSH Feasibility

Last checked: 2026-09-20 EDT

## Question

Can `wld remote host[:folder]` run an interactive TUI against remote files while personal settings, credentials,
memories, and Session history stay on the user's local machine?

This check supports the [Remote SSH proposal](../prd/remote-ssh-prd.md). It inspected source, selected tests, and
first-party documentation. On 2026-09-20, a later throwaway prototype also ran the Pi model path over SSH. Findings
establish feasibility, not delivered remote support.

A remote Pi Agent on `sct` used locally authenticated `openai-codex/gpt-5.6-luna`, executed a remote-only tool, streamed
the tool result through a second local model request, propagated cancellation, settled after reverse-tunnel loss, and
worked on a fresh connection. Full evidence is in ignored `prototypes/remote-ssh-model-proof/evidence.json`; the
continuity summary is in the [development draft](../plans/remote-ssh-development.md#live-pi-model-path-evidence). This
does not prove a full remote RunWield Session or Claude/Antigravity CLI support.

## Findings

### SSH and the reference experience

- OpenSSH supports remote commands, terminal allocation, local and reverse forwarding, and existing user SSH
  configuration. These supply transport capabilities, not RunWield data ownership or process cleanup. Source:
  [OpenSSH manual](https://man.openbsd.org/ssh).
- VS Code Remote SSH installs a remote server, opens remote folders without a local checkout, reuses local user
  settings, and forwards ports. Its extensions can run on different machines and can require adaptation. It does not
  provide automatic source-code synchronization. Source:
  [Microsoft documentation](https://code.visualstudio.com/docs/remote/ssh).
- These are useful precedents for setup and interaction. They do not establish that every local integration works
  remotely or that all remote processes stop when a client disconnects.

### RunWield providers

| Provider path                  | Current evidence                                                                                                                                                       | Remote feasibility assessment                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pi API-key and OAuth providers | `createRunWieldModelRuntime` uses RunWield's credential store and model configuration. `buildAgentSession` supplies the model runtime and tool definitions separately. | Keeping authenticated model requests local appears feasible. Remote context and tools still need adaptation.                                     |
| OpenAI Codex through Pi        | Installed Pi provides `openai-codex` OAuth and model-request handling. It is not a Codex CLI subprocess.                                                               | A live Pi proxy proof passed with local OAuth and remote tools; production Session integration remains unverified.                               |
| Local/custom API endpoints     | RunWield supports configured model endpoints, headers, and credentials.                                                                                                | A laptop-local endpoint must remain reachable from the machine issuing requests. Copying a `localhost` URL remotely changes its meaning.         |
| Claude CLI                     | RunWield starts `claude` in the project directory, enables native file/shell tools, and uses CLI-owned sign-in.                                                        | Current integration does not separate local authentication from remote native tools. Requires proof before claiming support under this proposal. |
| Antigravity CLI                | RunWield starts `agy` in the project directory and uses CLI-owned sign-in and same-machine Agent/MCP configuration.                                                    | Same unresolved split. Additional CLI history/cache behavior also needs verification.                                                            |

Source:

- [`model-registry.ts`](../../src/shared/models/model-registry.ts): `ExecutionBackend`, `RunWieldCredentialStore`,
  `createRunWieldModelRuntime`, `getApiKeyAndHeaders`.
- [`session.js`](../../src/shared/session/session.js): `buildAgentSession`, resource loading, and `createAgentSession`.
- [`Claude command`](../../src/shared/session/backends/claude-cli/command.ts): `prepareClaudeCliCommand` explicitly
  enables native project tools and passes `--no-session-persistence`.
- [`Claude process`](../../src/shared/session/backends/claude-cli/process.ts) and
  [`Antigravity process`](../../src/shared/session/backends/agy-cli/process.ts): subprocesses use the supplied `cwd`.
- [`Antigravity integration`](../../src/shared/session/backends/agy-cli/execution-session.ts),
  [`custom Agent`](../../src/shared/session/backends/agy-cli/custom-agent.ts), and
  [`MCP setup`](../../src/shared/session/backends/agy-cli/mcp-setup.ts).
- Installed Pi package: `dist/core/sdk.js`, `dist/providers/openai-codex.js`, `dist/api/openai-codex-responses.js`, and
  `dist/auth/oauth/openai-codex.js`. Dependency range is recorded in [`deno.json`](../../deno.json); these package
  internals are not a stable RunWield API promise.

Official provider documentation confirms that remote browser login is not the same as keeping credentials local:

- [Claude authentication](https://code.claude.com/docs/en/authentication) supports browser/code login in SSH
  environments. The [CLI reference](https://code.claude.com/docs/en/cli-reference) documents execution and
  authentication commands. Neither inspected page establishes RunWield's desired local-authentication/remote-tool split.
- [Antigravity installation and authentication](https://antigravity.google/docs/cli/install) describes native keyring
  sign-in, a manual SSH OAuth flow, and API-key configuration. These do not prove use of an existing laptop sign-in
  without supplying credentials or establishing an account session remotely.

### Personal data and project context

- Settings, Agents, skills, and project tools currently share a filesystem context. Skills can contain absolute local
  paths. Copying settings alone does not make those resources or their executable dependencies available remotely.
  Sources: [`settings.js`](../../src/shared/settings.js), [`session.js`](../../src/shared/session/session.js),
  [customization documentation](../user-documentation/customization.md).
- Project Memory currently uses the primary repository directory name, with a current-directory name fallback. Unrelated
  same-name folders can select the same collection. Core Memory injection and `/sleep` use additional selection paths.
  Remote support must not infer shared project knowledge from a folder name alone. Sources:
  [`resolveProjectCollectionName`](../../src/extensions/mnemoteca/tools.ts),
  [`session.js`](../../src/shared/session/session.js), [`sleep`](../../src/cmd/sleep/index.ts).
- MCP servers and helper binaries currently execute against one `cwd`. Some need local credentials; others need remote
  project files. An arbitrary personal integration cannot be assumed portable. Sources:
  [`MCP integration`](../../src/shared/mcp/integration.ts),
  [`RunWield MCP bridge`](../../src/shared/session/bridged-tools/mcp-bridge.ts),
  [`helper execution`](../../src/extensions/helper-binary-exec.ts).
- Working outside Git is already supported in parts of Core. A remote home directory is not inherently invalid, but
  Git-dependent workflows must retain their existing checks. Sources:
  [`Session prompt tests`](../../src/shared/session/session-prompt.test.js),
  [`execution start`](../../src/shared/workflow/execution-start.ts).

### Sessions, browser reviews, and disconnects

- [ADR-015](../adr/015-file-authoritative-session-bundles.md) gives local transcript bundles authority. This fits local
  ownership, but current project locators require local paths. The existing live socket explicitly assumes the same user
  and machine/container; it is not already a remote transport. Sources:
  [`root-session.js`](../../src/shared/session/root-session.js),
  [`file-session-store.ts`](../../src/shared/session/file-session-store.ts),
  [`live-session-connection.ts`](../../src/shared/session/live-session-connection.ts).
- Reviews currently bind a server to machine-local loopback. Remote reviews need laptop access and must return decisions
  to the same Session. Sources: [`review server`](../../src/ui/workspace/server.js),
  [`review launcher tests`](../../src/ui/review/review-launcher.test.ts).
- RunWield has process-tree cancellation, but this does not prove cleanup after SSH loss. CLI backends, helpers, and MCP
  subprocesses do not all share the same termination path. Sources:
  [`foreground-process.ts`](../../src/shared/foreground-process.ts),
  [`foreground-process tests`](../../src/shared/foreground-process.test.ts),
  [`MCP integration`](../../src/shared/mcp/integration.ts).
- Network loss is not instantly detectable. Stopping a process does not undo files already written or an external action
  already accepted. Remote output that never reached local storage cannot be described as saved history.

## Inference

The proposed experience is plausible, especially for Pi-backed providers. It is not a wrapper around `ssh … wld` or a
copy of `~/.wld`. Current code combines personal data and project execution on one machine. Splitting their locations is
the substantive work.

Keeping credentials local reduces exposure but does not make an untrusted server safe. The server can see supplied
instructions and memories and can misuse any access granted during a connection. The intended target is a server the
user trusts, not hostile-code isolation.

## Recommendation

Keep the agreed product contract. Require evidence for local data ownership, real remote tool execution, local browser
review, reconnect, and connection-loss cleanup. Use Pi-backed providers as the first feasibility proof, not as a silent
reduction of the requested provider scope.

Do not copy provider credentials or switch models to hide a compatibility gap. The owner has now deferred CLI backends
from the first release. Keep their future compatibility gap explicit, and keep architecture and implementation choices
in the planning handoff.

## Open Checks

- Can each CLI backend preserve its existing local sign-in while all project operations occur remotely, without a local
  checkout? Verify native tools, subprocesses, temporary files, and external CLI history.
- Which host platforms have compatible RunWield/helper builds and reliable connection-loss cleanup?
- Can project Memory, Core injection, `/sleep`, and Work Record search all select the intended project without name
  collisions or silent changes to existing local collections?
- Can every supported workflow stop its owned processes after detected connection loss and resume from truthful saved
  evidence without repeating uncertain effects?
