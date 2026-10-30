---
planId: "c6ff0ec0-9d59-47dd-8232-3e853119a30f"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/extensions/mnemoteca/"
    - "src/cmd/sleep/"
    - "src/shared/memory-collection.ts"
    - "src/shared/remote/control.ts"
    - "src/shared/remote/memory-bridge.ts"
    - "src/cmd/remote/index.ts"
    - "src/shared/mcp/config.ts"
    - "src/shared/mcp/integration.ts"
    - "src/shared/work-records/"
    - "src/shared/session/session.js"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-09-21T02:05:50.618Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 5
dependencies:
    - "04-run-and-resume-remote-sessions-with-local-history"
targetBranch: "epic/remote-ssh-development"
userVerifiedAt: null
validatedCommit: "14c1259632ed7a11351787322ce083f5ffdc72dc"
status: "verified"
---

# Keep Memory and Integrations on Their Owning Machine

## Context

Child04 made remote conversation turns work. Memory and MCP still run as if the server were the laptop:

```text
remote TUI (sct)
  memory tool        → `mnemoteca` on sct      → sct's database      wrong: personal data off the laptop
  core injection     → `mnemoteca list` on sct → sct's database      wrong
  /sleep             → export, then the Agent runs `mnemoteca` on sct  wrong
  MCP personal       → sct user's ~/.wld/mcp.json, starts on sct   wrong profile
  MCP project        → project .wld/mcp.json, starts on sct        correct
  Work Record index  → `mnemoteca` collection on sct               correct place, wrong database
```

A remote Session also fails unless `mnemoteca` is installed on the server: `buildAgentSession` calls
`ensureMnemotecaBinary`.

**A local bug has the same cause.** Three entry points choose the Memory collection in three ways:

| Entry point                                                      | Rule                            | In a worktree                 |
| ---------------------------------------------------------------- | ------------------------------- | ----------------------------- |
| `memory` tool (`resolveProjectCollectionName`, `tools.ts`)       | Git common-dir parent name      | `runwield` (correct)          |
| Core injection (`session.js`, `mnemoteca list -t core` in `cwd`) | `mnemoteca` default: cwd folder | `runwield-…-480c7b59` (wrong) |
| `/sleep` (`src/cmd/sleep/index.ts`)                              | `basename(cwd)`                 | `runwield-…-480c7b59` (wrong) |

This child delivers the Memory and integration placement part of the Remote SSH PRD
[Local personal environment](../../prd/runwield-core-prd.md#agent-and-skill-customization) and
[Local memories and saved Sessions](../../prd/runwield-core-prd.md#session-continuity) capabilities: the
**Read and update the same local memories** requirement and the Memory part of **Keep project knowledge correctly
scoped**. It changes the PRD's "ask once when the mapping is ambiguous" rule, as decided below.

It must preserve Core Memory scopes, trusted Team Memory, Work Record authority, project MCP override rules, and the
collection names of existing local main checkouts.

### Decisions from planning

- **Remote Memory identity is host plus folder.** A remote project's collection comes from the resolved SSH hostname,
  user, and port (from `ssh -G`) plus the remote project root. The host key is not part of it, so a rebuilt server with
  a new key keeps its memories. A remote worktree uses its parent project's root.
- **Normal rule: automatic, no prompt.** The collection name is built from the normalized server name and the remote
  project folder name. As long as the user connects to the same server and folder, they find the same memories.
- **One exception: same folder name as a local project.** When the remote project folder name equals the folder name of
  a local project on the laptop (`sct:~/web/runwield` and `~/Documents/web/runwield`), the laptop asks whether this is
  the same project. **Yes** binds the connection to that local project's collection, so both share memories. **No** uses
  the normal rule. The answer is remembered, and the question is not asked again for that connection.
- **One collection resolver everywhere.** The `memory` tool, core injection, and `/sleep` use the same resolver, local
  and remote. Local main checkouts keep their current collection names. Local worktrees start using their parent
  checkout's collection.
- **Remote `/sleep` is deferred.** In a remote Session, `/sleep` does nothing and says it is not available remotely yet.
  It never runs against a server database. Local `/sleep` uses the shared resolver.
- **Personal Memory runs on the laptop.** Remote Memory operations go through an authenticated laptop control-service
  route. The laptop acknowledges a write only after `mnemoteca` completes it.
- **MCP placement only; forwarding is child06.** This child stops reading the server user's personal `mcp.json`.
  Personal servers do not start remotely. Project servers start remotely, and `/mcp` shows where each server runs.
  [06-forward-personal-mcp-tools-from-the-laptop](06-forward-personal-mcp-tools-from-the-laptop.md) forwards personal
  tools.
- **The Work Record index stays on the server,** in a project-local database under the remote project's
  `.wld/internal/`, not in a personal database.

### Epic Scope Changes

- New `06-forward-personal-mcp-tools-from-the-laptop` — receives personal MCP forwarding (laptop host, tool list, call,
  result, cancellation) from this child.
- `06-carry-remote-context-through-delivery-workflows` is renamed `07-…`, `07-open-remote-reviews-in-the-local-browser`
  is renamed `08-…`, and `08-package-and-qualify-remote-ssh-support` is renamed `09-…`. Their `order` and `dependencies`
  follow. The Remote SSH PRD links follow. Their empty planning worktrees were removed with the owner's approval.
- Remote `/sleep` (Memory cleanup for a remote project's collection) is deferred. No sibling receives it yet; the Epic
  records it as deferred scope.

## Objective

In a remote Session, the `memory` tool and core memories read and write the laptop's Memory database, in the collection
for that remote project. Two different remote projects never share memories by accident. Personal MCP servers do not
start on the server, and project MCP servers do. Locally, a worktree sees its parent checkout's memories.

## Approach

### One collection resolver

A new module owns the collection decision. Every caller asks it; none derives a name itself.

```text
resolveMemoryCollection(context)
  local session
    Git common-dir parent name, else cwd folder name    (today's memory-tool rule)
  remote session
    the collection the laptop chose at connect time
```

`resolveProjectCollectionName` in `tools.ts`, the core-injection call in `session.js`, and `basename(cwd)` in `/sleep`
all move to it.

### Remote collection binding at connect time

The laptop decides the remote collection during `wld remote` startup, before the remote TUI opens:

```text
wld remote sct:~/web/runwield
  key = hostname + user + port + remote project root
  saved binding for key?                          → use it
  local project with folder name "runwield"?      → ask:
                                                      Is sct:~/web/runwield the same project as
                                                      ~/Documents/web/runwield?
                                                      [Yes] → that local project's collection
                                                      [No]  → normal rule
                                                    save the answer
  otherwise                                       → normal rule, save it

normal rule = "<folder>@<hostname>-<hash>"   e.g. "runwield@sct.home.lan-3f9a"
```

- **Local projects** are the local (non-remote) project records the laptop Session store already keeps
  (`listProjectsFromDisk`). The folder name compared is the basename of the project root, so a local worktree counts as
  its main checkout.
- **Several local matches** (two local `runwield` folders) are listed as separate **Yes** choices, plus **No**.
- **Yes** binds to the collection the shared resolver gives that local project root, so local and remote Sessions read
  the same memories.
- **The binding** is stored on the laptop, keyed without the host key. The remote runtime receives only the collection
  name.

### Laptop Memory route

The control service adds `/memory`, beside the existing settings route in `src/shared/remote/control.ts`:

```text
remote memory tool / core injection
  POST /memory {requestId, action, collection, args}
    laptop: run `mnemoteca` with the bound collection
    reply after the write completes
```

- It reuses the settings route's authentication and request-id receipts, so a retried write runs once.
- The laptop accepts only the collection bound to this connection.
- In remote mode, `buildAgentSession` no longer requires `mnemoteca` on the server for personal Memory.

### MCP location

`resolveMcpConfig` already merges personal then project definitions. Each effective server gets an origin and a
location. In a remote Session, personal definitions come from the laptop settings snapshot, not the server user's home,
and are not started. Project definitions start remotely after the existing safety checks.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/memory-collection.ts` (new) — the one collection resolver for local and remote Sessions.
- `src/extensions/mnemoteca/tools.ts` — uses the resolver; in remote mode sends operations to the laptop route.
- `src/shared/session/session.js` — core injection uses the resolver and, remotely, the laptop route; the remote
  `ensureMnemotecaBinary` requirement ends for personal Memory.
- `src/cmd/sleep/` — collection from the resolver; in a remote Session, stops before any Memory work.
- `src/cmd/remote/index.ts` — computes the Memory binding and asks the same-project question before the TUI opens.
- `src/shared/session/file-session-storage.ts` — read-only use of `listProjectsFromDisk` to find local projects with the
  same folder name. No change to project records.
- `src/shared/remote/control.ts` and a new remote Memory client — the `/memory` route and its caller.
- `src/shared/mcp/config.ts` and `integration.ts` — origin and location per server; no personal servers remotely.
- `src/shared/work-records/` — the remote index uses a project-local database.
- `docs/prd/remote-ssh-prd.md`, `docs/prd/runwield-core-prd.md`, `docs/domain-language.md` — delivered Memory and MCP
  placement.

Not in this change: remote `/sleep` (deferred), personal MCP forwarding (child06), workflows (child07), Team Memory
trust rules, and Session identity from child04.

## Reuse Opportunities

- The settings route in `src/shared/remote/control.ts` and `settings-bridge.ts` — authentication and request-id
  receipts.
- `RemoteHostIdentity` in `src/shared/remote/target.ts` — `hostname`, `user`, and `port` from child04.
- `resolveProjectCollectionName` — the local rule moves into the resolver unchanged.
- `listProjectsFromDisk` and the `remote` field from child04 — the laptop's list of local projects.
- `resolveMcpConfig` personal-then-project merge and `isSafeProjectMcpFile`.

## Implementation Steps

1. `src/shared/memory-collection.ts` exports the one collection resolver. For a local Session it returns the Git
   common-dir parent name, or the cwd folder name outside Git, with `global` mapped to `default`. For a remote Session
   it returns the bound collection.
2. The `memory` tool, core-memory injection in `session.js`, and `/sleep` get their collection only from the resolver.
   No other code in these paths derives a collection from `cwd`. A local worktree and its main checkout resolve to the
   same collection. A local main checkout resolves to the same name as before.
3. Core injection passes the collection explicitly to `mnemoteca`; it does not rely on the process cwd.
4. `wld remote` computes a remote Memory key from the resolved `hostname`, `user`, `port`, and the remote project root.
   The host key fingerprint is not in the key. A remote worktree uses its parent project root.
5. A saved binding for the key is reused with no prompt. With no binding, `wld remote` looks for local projects (records
   from `listProjectsFromDisk` without `remote`) whose root folder name equals the remote project root's folder name.
    - No match: the normal collection is chosen with no prompt.
    - One or more matches: the laptop terminal asks whether the remote project is the same project, with one **Yes**
      choice per matching local root and one **No** choice. **Yes** binds to the collection the shared resolver returns
      for that local root. **No** binds to the normal collection.
    - Either answer is saved on the laptop before the remote TUI opens. The next connect with the same key does not ask.
6. The normal collection name is `<folder>@<hostname>-<hash>`. `<hostname>` is the resolved `ssh -G` hostname in lower
   case. `<hash>` is a short hash of the full key. Two folders with the same name on one host, or on two hosts, get
   different names.
7. The control service serves `/memory` for `recall`, `store`, `delete`, and `list-core`, only for the bound collection
   or `global` scope. Writes use request-id receipts; a retried `store` adds one memory.
8. In a remote Session, the `memory` tool and core injection use the `/memory` route. No `mnemoteca` process runs on the
   server for personal Memory. A remote Session starts with no `mnemoteca` binary on the server.
9. In a remote Session, `/sleep` shows one line saying it is not available in remote Sessions yet. It creates no backup,
   switches no Agent, and runs no `mnemoteca` command on either machine.
10. In a remote Session, the effective MCP configuration takes personal definitions from the laptop settings, never from
    the server user's home. Personal servers are not started. Project servers start remotely with the existing safety
    checks and override rules. `/mcp` shows `laptop` or `remote` for each server and marks personal servers as not
    started remotely.
11. The Work Record index for a remote project uses a database under the remote project's `.wld/internal/`. It never
    writes to a personal Memory database.
12. The Remote SSH PRD replaces "ask once when the mapping is ambiguous" with the server-plus-folder rule and the
    same-folder-name question, and marks **Read and update the same local memories** delivered. Remote `/sleep` is
    listed as deferred. Personal MCP forwarding stays target for child06. The Core PRD Memory references match.
13. `docs/domain-language.md` describes the remote Memory binding: the remote Memory key, the bound collection, and that
    a shared collection never merges Sessions.

## Verification Plan

Run focused tests with `deno run -A scripts/run-tests.js <paths>`, then `deno task seams:check`. Use sandboxed `HOME`
and `MNEMOTECA_DB_PATH`, `defineGitFixture`, and the real remote process fixture. Do not add a Memory seam.

### Automated

- **One resolver, local:** in a Git fixture with a worktree, the `memory` tool, core injection, and `/sleep` all select
  the main checkout's collection. A core memory stored from the main checkout appears in the worktree's injected prompt.
  This fails today for injection and `/sleep`.
- **Main checkout names unchanged:** a plain checkout and a non-Git folder resolve to the same names as before.
- **Remote key:** two aliases with the same hostname, user, and port give one key. A different port, user, hostname, or
  root gives another. A changed host key gives the same key.
- **Prompt rule:** with no local project folder named `proj`, no prompt appears and `proj@<host>-<hash>` is saved. A
  local Memory collection named `proj` with no local project record does not cause a prompt. With a local project
  `~/x/proj`, one prompt appears. **Yes** binds to that project's resolver collection, and a memory stored locally is
  recalled remotely. **No** binds to `proj@<host>-<hash>`. Each answer is saved, and the next connect does not ask. With
  two local `proj` projects, the prompt lists both.
- **Laptop authority:** a remote `memory store` lands in the laptop database before its acknowledgement. The remote
  fixture has no `mnemoteca` binary and no personal database. A retried request id adds one memory.
- **Collection scoping:** a `/memory` request for a collection other than the bound one is refused.
- **Core injection remote:** a core memory in the bound laptop collection appears in the remote prompt.
- **Remote `/sleep` deferred:** in a remote Session, `/sleep` shows the not-available line. No backup file exists, the
  active Agent is unchanged, and the fixture records no `mnemoteca` call.
- **MCP:** in a remote Session, a personal fixture server defined in the remote user's home is not read; a personal
  server from laptop settings is listed as `laptop` and not started; a project server starts with the remote cwd.
- **Work Record index:** a remote index rebuild writes under the project `.wld/internal/` and not the personal database.

### Paired live flow (`sct`)

- Connect to `sct:~/web/runwield` with a local `~/Documents/web/runwield`. Answer **Yes**. Store a memory remotely and
  recall it in a local `runwield` Session. Reconnect and see no prompt.
- Connect to a remote folder with no local namesake. See no prompt, and confirm its memories are separate.
- Run `/sleep` remotely and see the not-available line.
- Open `/mcp` and confirm each server's location.

### Behavior to protect and behavior that ends

- Protect: existing local main-checkout collection names, Memory scopes, Team Memory trust, project MCP override and
  safety checks, and local MCP behavior.
- Ends: worktree-named collections for core injection and `/sleep`, the remote `mnemoteca` requirement for personal
  Memory, and reading the server user's personal `mcp.json`. Tests that assert these are rewritten.

## Edge Cases & Considerations

- **Earlier worktree memories (assumption).** Memories stored in a worktree-named collection by core injection or
  `/sleep` stay where they are. They are not migrated.
- **Which local folders count (assumption).** Only local projects the laptop already has a Session project record for
  are compared. A folder never opened with RunWield does not trigger the question. The comparison is exact and
  case-sensitive.
- **Saving a No answer (assumption).** **No** is remembered the same as **Yes**, so the question is asked once per
  connection key. A later way to change the answer is out of scope.
- **Hash in the normal name (assumption).** The short hash keeps `~/a/proj` and `~/b/proj` on one server apart. The
  readable part is still server plus folder.
- **Shared collection, separate Sessions.** Choosing a local collection shares memories only. Session history stays
  keyed by child04's identity.
- **Remote folder renamed.** A rename gives a new key and a new collection, the same as child04 Session identity.
- **Laptop unreachable during a write.** The write fails and the tool reports it. It is not queued for later.
