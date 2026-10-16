# Remote MCP transport pilot

## Scope

[Child06](../plans/remote-ssh-development/06-forward-personal-mcp-tools-from-the-laptop.md) adds personal MCP transport
forwarding. This record covers a bounded live check on `sct`, not release qualification or a production-provider matrix.

The pilot used matching compiled verification entrypoints on macOS ARM64 and Linux x86-64, built with Bun 1.4.3 through
`scripts/compile-bun.ts`. They exercised production configuration resolution, the authenticated control listener,
`RemoteMcpTransport`, laptop `StdioTransport`, and the single remote Pi MCP integration. The fixture used stdio only,
with synthetic laptop-only configuration and no dependency on project files. The pilot did not exercise the TUI or
make a model request. Separate automated remote root-turn tests cover tool declarations and second-request results.

## Observed build and placement

- Build identity on both machines: `5d05be1d8708a720bcf7037554938a0085bc715b8e1b2e08ad7d0b41716d4014`.
- Laptop: `gandazgul-mbp`, macOS ARM64. Personal PIDs: `20776`, `20787` after reconnect, and `20950` on a fresh connection.
- Remote: SSH alias `sct`, hostname `k8s-control-plane`, Linux x86-64. Project PIDs: `288105` and `288667`.
- Personal cwd: disposable laptop home ending in `mcp-live-PyYlMz/home`, not the launch folder or a checkout.
- Project cwd: `/tmp/wld-mcp-pilot-Z4D3ouoLgg/project`, a disposable remote Git repository.
- The fixture reported its actual host, PID, cwd, and configured marker. Only the personal result contained the synthetic
  laptop-only value. `/mcp` reported `personal: laptop`, `project: remote`, and connected status with one tool each.

## Results

- Both tool origins were discovered and called through the same Pi integration over a real SSH reverse forward.
- The native reconnect command stopped personal PID `20776`, started PID `20787`, and a later call succeeded without a
  model request for the command. The project process remained available.
- A cooperative slow call logged admission, then received native cancellation with request ID `4`. Its promise rejected;
  no delayed-effect marker appeared.
- During a second admitted slow call, the owner killed only its SSH process. After the control health window, the
  laptop service had revoked the transport. Every owned personal PID had exited; no delayed effect appeared.
- A fresh authenticated connection started PID `20950` and called a new marker. The old slow-call marker occurred exactly
  twice: the intentionally cancelled call and the intentionally disconnected call. Neither was replayed.
- Normal close stopped the fresh personal and project processes. The pilot removed its owned remote scratch directory.

The local verification entrypoint, compiled artifacts, and full synthetic logs are retained under `.ci-cache/` as
`mcp-pilot-entry.ts`, `mcp-pilot-mac`, `mcp-pilot-linux`, and `mcp-pilot-final.json`. These are local verification artifacts,
not shipped runtime commands.

## Automated checks

The focused MCP, remote MCP, transport, control, and Session policy suites cover real root turns, selection before spawn,
resources, pagination, schemas, annotations, results, roots, progress, updates, handoff, reload, cancellation, process
ownership, failed startup, reconnect, admission races, framing, queue limits, health expiry, and lost acknowledgements.
Local and ACP configuration and root-access policy remain covered by their existing tests.
