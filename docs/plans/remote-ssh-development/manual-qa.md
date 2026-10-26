# Manual QA for remote-ssh-development

This checklist is advisory. It does not change RunWield verification status.

<!-- runwield:manual-qa:start child="remote-ssh-development/01-establish-the-remote-connection-and-matched-runtime" -->

## Establish the Remote Connection and Matched Runtime

Manual verification steps for remote-ssh-development/01-establish-the-remote-connection-and-matched-runtime

- [ ] On a supported Linux host, connect to an existing remote folder and confirm the displayed host and canonical
      directory match the remote location.
- [ ] Connect without a path and confirm RunWield opens the remote home directory.
- [ ] Confirm the connection view states that user turns are unavailable, shows the OpenSSH/SFTP access notice, and
      provides an exit control.
- [ ] Try text, slash-command, and shell-shortcut input; confirm none starts a turn or changes remote project or
      personal data.
- [ ] Exit with the displayed control and with Ctrl-C; confirm the connection-owned processes stop and unrelated
      processes remain running.
- [ ] Test a missing folder or failed SSH connection; confirm RunWield reports the cause and does not create the folder
      or leave a usable connection.

<!-- runwield:manual-qa:end child="remote-ssh-development/01-establish-the-remote-connection-and-matched-runtime" -->

## Bridge Local Models and Personal Resources: Bounded Evidence

On 2026-09-25, matching macOS and Linux x86_64 development artifacts (`buildId`
`114b2dbd7021632ede19ac80aa00f32c833504c32ce640892f741b96f34a2d32`) connected to `sct` (Fedora 39, Linux x86_64). The
host used SSHFS 3.7.3, FUSE 3.16.1, and stock OpenSSH SFTP. The mount used
`sshfs_sync,direct_io,no_readahead,cache=no,dir_cache=no,attr_timeout=0,entry_timeout=0,negative_timeout=0`. The tested
Pi packages were version 0.87.1.

- Personal Skill, Agent, and Prompt Template files were created, edited, renamed, and deleted over the remote mount;
  each change was visible on the laptop without a copy step. A laptop Skill edit became visible to a fresh remote read.
  A separate project `.wld` write stayed on the remote host. A nested Skill script read its sibling, and its missing
  custom command reported a shell error without preventing a later core command.
- A synthetic laptop HTTP provider using the `openai-completions` API accepted two requests. The first requested a
  remote-only file tool; the second contained that tool's result and laptop-only authentication. A stalled second
  request closed after cancellation. Two fresh connections repeated the successful two-request proof. A separate
  in-process Pi roundtrip selected the Skill and Prompt Template through RunWield's production resource resolvers, ran
  the Skill's nested sibling script as a project tool, and sent its result in the next model request. That test used
  ordinary temporary directories, not SSHFS.
- Pausing the connection-owned laptop SFTP child made storage stall while SSH control stayed alive. The remote view
  stopped after the storage deadline with a nonzero exit, and the mount was detached. Cleanup reported that a kernel
  operation might remain unfinished. A write beneath the detached mount failed. A separate forced unmount caused the
  remote supervisor to report mount loss, stop the connection with a nonzero exit, and reject an underlying-directory
  write. After the operating system confirmed each unmount, only empty connection-owned directories were removed.
  Killing the laptop launcher also ended its owned remote mount while an unrelated remote process remained alive.

This proof used a synthetic provider and a bounded in-memory Agent Session. It does not establish real-provider OAuth
behavior, ordinary remote user turns, durable Sessions, integrations, or the release platform matrix.

<!-- runwield:manual-qa:start child="remote-ssh-development/02-bridge-local-models-and-personal-resources" -->

## Bridge Local Models and Personal Resources

Manual verification steps for remote-ssh-development/02-bridge-local-models-and-personal-resources

- [ ] Connect to a test host and use the remote Agent to read a project sentinel; confirm the laptop model provider
      receives it and only the laptop request carries credentials.
- [ ] Create, edit, and delete a personal Agent, prompt, and nested Skill through remote file tools; inspect the laptop
      files and confirm the edits are present.
- [ ] Change a personal resource on the laptop, then reload it remotely and confirm the new content appears; run a
      nested Skill that reads a sibling file.
- [ ] Apply a project resource override and confirm it takes precedence while the project file and project settings
      remain on the remote host.
- [ ] Disconnect during a model request; confirm the request stops and the remote Agent reports a clear failure without
      switching to a different provider.
- [ ] Reconnect and confirm the current laptop resources load, with no writes to the remote user's personal profile.

<!-- runwield:manual-qa:end child="remote-ssh-development/02-bridge-local-models-and-personal-resources" -->

<!-- runwield:manual-qa:start child="remote-ssh-development/03-guard-remote-session-writer-access" -->

## Guard Remote Session Writer Access

Manual verification steps for remote-ssh-development/03-guard-remote-session-writer-access

- [ ] Over the trusted SSH connection, run a remote turn with a tool call and confirm its messages and results appear in
      laptop Session history.
- [ ] Disconnect and reconnect, then resume the Session. Confirm saved history is present and no completed tool action
      runs again.
- [ ] Interrupt a save or disconnect during a save. Confirm the operation stops without publishing success, then recover
      from laptop evidence.
- [ ] Confirm no remote transcript file appears and the personal-resource mount does not receive Session history.

<!-- runwield:manual-qa:end child="remote-ssh-development/03-guard-remote-session-writer-access" -->

<!-- runwield:manual-qa:start child="remote-ssh-development/04-run-and-resume-remote-sessions-with-local-history" -->

## Run and Resume Remote Sessions with Local History

Manual verification steps for remote-ssh-development/04-run-and-resume-remote-sessions-with-local-history

- [ ] Connect with `wld remote <target>`, submit turns that read and edit remote files, and verify local files do not
      change.
- [ ] Attach an image in the remote session and verify the model analyzes the image.
- [ ] Disconnect from the network, run `wld remote sessions` locally, and verify the transcript replays in read-only
      mode without network access.
- [ ] Reconnect to the remote host, run `/resume`, and verify the previous session continues with full history.
- [ ] Stop network transport during an active turn, reconnect, and verify existing history remains without repeated tool
      calls.

<!-- runwield:manual-qa:end child="remote-ssh-development/04-run-and-resume-remote-sessions-with-local-history" -->

<!-- runwield:manual-qa:start child="remote-ssh-development/05-keep-memory-and-integrations-on-their-owning-machine" -->

## Keep Memory and Integrations on Their Owning Machine

Manual verification steps for remote-ssh-development/05-keep-memory-and-integrations-on-their-owning-machine

- [ ] Connect to a remote project that has a local folder with the same name. Select the local project, store a memory
      remotely, and recall it in a local Session. Reconnect and confirm that no question appears.
- [ ] Connect to a remote project with no local folder match. Confirm that no question appears and that memories from
      two remote projects remain separate.
- [ ] Start a remote Session without `mnemoteca` installed on the server. Confirm that Memory recall and core memories
      work, and that `/sleep` reports that it is not available remotely.
- [ ] Open `/mcp` in a remote Session. Confirm that personal servers show as laptop servers and are not started
      remotely, and that project servers show as remote.

<!-- runwield:manual-qa:end child="remote-ssh-development/05-keep-memory-and-integrations-on-their-owning-machine" -->

<!-- runwield:manual-qa:start child="remote-ssh-development/06-forward-personal-mcp-tools-from-the-laptop" -->

## Forward Personal MCP Tools from the Laptop

Manual verification steps for remote-ssh-development/06-forward-personal-mcp-tools-from-the-laptop

- [ ] On the live pilot, call a personal MCP tool and a project MCP tool; confirm the personal server runs on the laptop with laptop home as its cwd, and the project server runs remotely with the Session cwd.
- [ ] Check `/mcp` for each server's location and connection status. Run `/mcp reconnect <server>`, then call the personal tool again.
- [ ] Cancel a cooperative slow personal tool call; confirm the server receives cancellation and does not record the delayed effect.
- [ ] Drop the SSH connection during a tool call, reconnect, and confirm the call is not replayed and no owned laptop server process remains.

<!-- runwield:manual-qa:end child="remote-ssh-development/06-forward-personal-mcp-tools-from-the-laptop" -->

<!-- runwield:manual-qa:start child="remote-ssh-development/07-carry-remote-context-through-delivery-workflows" -->

## Carry Remote Context Through Delivery Workflows

Manual verification steps for remote-ssh-development/07-carry-remote-context-through-delivery-workflows

- [ ] On `sct`, take a remote-only Plan through planning, approval, execution, validation, AI review, any required repair, Work Record generation, merge, and confirmed publication. Confirm the laptop sentinel tree remains unchanged.
- [ ] Complete a remote execution handoff, disconnect, reconnect, and run `/resume`. Confirm it continues in the successor segment and shows laptop-saved lineage.
- [ ] Disconnect during validation and during publication. Reconnect and run `/resume`; confirm it reports proven and uncertain outcomes and does not repeat an external action until you choose.

<!-- runwield:manual-qa:end child="remote-ssh-development/07-carry-remote-context-through-delivery-workflows" -->

<!-- runwield:manual-qa:start child="remote-ssh-development/08-stop-owned-remote-work-on-connection-loss" -->

## Stop Owned Remote Work on Connection Loss

Manual verification steps for remote-ssh-development/08-stop-owned-remote-work-on-connection-loss

- [ ] In a connected remote Session, start a long-running command and an Agent-started `nohup sleep 600 &`; disconnect the laptop SSH process and confirm both processes stop on the server.
- [ ] Start a `sleep` process in a separate SSH login; disconnect the RunWield connection and confirm the separate process continues running.
- [ ] Confirm the remote mount directory is removed after disconnect and no mount-cleanup error appears.

<!-- runwield:manual-qa:end child="remote-ssh-development/08-stop-owned-remote-work-on-connection-loss" -->

<!-- runwield:manual-qa:start child="remote-ssh-development/09-host-reviews-on-one-server-per-process" -->

## Host Reviews on One Server per Process

Manual verification steps for remote-ssh-development/09-host-reviews-on-one-server-per-process

- [ ] Start Plan Review and Code Review in one TUI. Confirm both pages load from the same `127.0.0.1` origin.
- [ ] Open a file and image, upload an annotation image, and run Guided Review. Confirm each action works.
- [ ] Submit Plan Review feedback and confirm the next review round stays at the same URL. Approve both reviews.
- [ ] Stop one review. Confirm the other review still works.
- [ ] Click a Markdown document link in the TUI. Confirm it opens on the same origin.

<!-- runwield:manual-qa:end child="remote-ssh-development/09-host-reviews-on-one-server-per-process" -->

## Open Remote Reviews Locally: Post-Merge macOS/sct Qualification

This evidence replaces the pre-merge pilot below this heading. The old build and token-change failure do not qualify
main's conversational review implementation. These are live checks, not automated-test substitutions.

On 2026-10-24, Bun 1.4.3 built matching macOS arm64 and Linux x86_64 production CLIs after main `e60d86d52` was
merged. Build ID: `38780224ff5d5c93afb3b8f09b16594686e4d2e8daa087caf597cd54aa6c23d1`. The Linux compile used
`compile-command.ts --expect-build-id`. `bun run install:locked`, Workspace asset build, and the driver type check
passed. The final type check covered 1535 first-party entries. No full CI run was made.

The driver `src/shared/remote/verify-remote-reviews.ts` launched the compiled `wld remote sct:<scratch-project>` in a
real PTY. The production launcher installed the matched Linux runtime and started the supervisor, personal-resource
mount, remote view, and **one product review forward**. No runtime fixture client, manual review forward, or replacement
review host was used. Only the laptop HTTP model provider was synthetic. Git, worktrees, Plan lifecycle, validation,
and browser APIs were real. Remote-only PNG and document changes were added to the scratch worktree through SSH as
qualification data. The engineering Agent changed the sentinel through its production `write` tool.

The child PATH `open` shim recorded browser requests and called headed `agent-browser`, session
`remote-reviews-df8a7ec8`, with `AGENT_BROWSER_SOCKET_DIR=/tmp/ab-df8a7ec8`. This qualifies the browser bridge, not
macOS Launch Services. PTY keyboard and mouse bytes are identified below; they are not physical laptop input.

### Live results

- [x] **Plan conversation and revision at one complete URL.** In run `Wfr7EZ`, the headed Plan Review at
      `http://127.0.0.1:51873/review/plan?token=db87a638-e72e-49b7-9911-b2af1b153c7b` accepted a global annotation,
      a reply-only explanation, and a request to revise. The laptop provider received the conversation. The reply-only
      turn did not write the Plan. The revision called `write` and `plan_written`; `Live revision 2` rendered at the
      same complete URL. Browser close and manual reopen kept the pending review. **Approve & Run** started remote
      execution. Screenshots: `plan-explain.png`, `plan-revision2.png`.
- [x] **Workflow Code Review and remote file expansion.** Runs `YE643U` and `FdAO2u` reached real engineering,
      verification command, semantic review, and workflow Code Review. Plan Review and Code Review shared one origin
      in each connection. Selecting `sentinel.txt` expanded its remote diff. Browser shadow-DOM inspection showed the
      remote-only sentinel and the delivered value. Screenshot: `code-sentinel.png`.
- [x] **Remote-only image.** The headed browser loaded the token-authorized `/api/image?path=remote-only.png` on
      origin 57135. The image had `complete=true`, natural width 1, and natural height 1. The file existed only in the
      remote worktree. The binary diff card did not offer an image preview; this check used the actual image URL.
      Screenshot: `remote-image.png`.
- [x] **Annotation image upload.** The Code Review global-comment attachment control uploaded a laptop PNG, opened
      the markup editor, and saved it. Sending the annotation displayed “1 annotations, 1 attachments.” The remote
      conversation received the attachment. Screenshot: `annotation-upload.png`.
- [x] **Guided Review through the laptop model.** The browser generated and displayed “Remote sentinel guide.”
      The laptop provider request contained the remote `read sentinel.txt` result `remote delivered`. The built-in
      in-process guide used the production model bridge. Screenshot: `guided-review.png`.
- [x] **Code conversation, revision, and approval at one complete URL.** Run `FdAO2u` used
      `http://127.0.0.1:62156/review/code?token=0c843cb8-65e5-459b-9a51-359337056550`. A reply-only conversation
      did not write code. A later synthetic provider sequence called the real remote `write` and completion tools.
      The browser updated the sentinel diff to `remote revised` at the same URL. Approval displayed “Changes approved”;
      the TUI reported that the user approved the work. Screenshots: `code-revised-stable.png`, `code-approved.png`.
- [x] **Reopen pending Code Review from its TUI action: repaired and retested.** The final rerun below passed
      before and after a code revision. Historical failure on build `38780224…`: the Workflow sidebar displayed **Open Code Review**
      while the browser review was pending and usable. PTY Ctrl+Enter (`CSI 13;5u`) invoked that action repeatedly.
      It printed “The Code Review is starting. Try again when it is ready.” No new browser-open request occurred.
      The result remained the same after a successful code revision. `chat-session.ts` reads
      `snapshot.workflowContext.liveReviewUrl` for this action; the live projection did not supply a URL. This is a
      production defect for repair, not a passed reopen check. SGR mouse input was also attempted; it did not open the
      review. Manual browser navigation did reopen the same pending URL without resolving it.
- [x] **Pending `/plan-review` URL recovery: passed in the final pending-command rerun below.**
      Historical attempts, superseded by that rerun: the original single-Enter PTY attempts did not establish command dispatch.
      Slash autocomplete can consume Enter; those attempts are not proof of failure. A saved-Plan review opened from
      `/load-plan` in run `KAiPsV`, then approved for later, returned “This Session has no previous Plan review” when
      `/plan-review` was dispatched after completion. This does not prove pending review reopen.
- [x] **TUI Markdown document link through the injected browser port.** Run `UCNPnz` advertised `xterm-ghostty`,
      which the remote terminal library recognizes as OSC 8 capable through SSH TERM propagation. A fresh Guide Session
      rendered a Markdown link labeled **Remote document**, targeting the remote `document.md` file. PTY SGR left-button press/release at column 8,
      row 16 opened the document through the laptop browser shim on the same product origin 50545. The headed browser
      showed “Document · document.md” and “Remote document.” Screenshot: `document-link.png`. Earlier plain-terminal
      attempts had no hyperlink capability and are not link-test evidence.
- [x] **Pending Plan reopen through TUI controls.** In `UCNPnz`, browser close left the Plan pending. An SGR click on
      the printed Plan URL reopened the same complete URL. The Workflow sidebar **Open Plan review** action, invoked
      by PTY Ctrl+Enter, also requested that same URL through the injected browser bridge. These are actual PTY input
      actions, not physical terminal clicks. The final pending-command rerun below also qualifies `/plan-review` dispatch and URL recovery.
- [x] **Owned SSH loss cleanup.** Killing SSH PID 43864 removed laptop port 62156, stopped remote supervisor/view
      PIDs 2407357, 2407372, 2407460, and 2407465, and removed
      `/tmp/wld-remote-7e91db7355d594306370334787b59e4f`. Separately started remote `sleep` PID 2416889 remained alive.
      Evidence: `before-cleanup.txt`, `after-cleanup.txt`.
- [x] **Reconnect to the same project.** Run `KAiPsV` reconnected to `/tmp/wld-remote-reviews-Dv4jE4gxZC`, loaded
      the saved Plan, and selected **Re-open for review**, then **Review plan**. The fresh review loaded with HTTP 200
      on origin 64116. The old origin 62156 refused connection. The old Code Review token sent to origin 64116 returned
      HTTP 401. Evidence: `reconnect.json`. This is a same-project reconnect proof, not an automatic Session-resume claim.
- [ ] **Windows laptop:** explicitly deferred. No Windows support claim is made.
- [x] **Opt-in Linux supervisor tests:** all 12 passed against the current source snapshot in the final Linux
      qualification below. The earlier scratch checkout was not used as evidence.

### Evidence and limits

All post-merge builds, logs, screenshots, and small inspection scripts are under
`/tmp/remote-reviews-df8a7ec8/postmerge`. Disposable driver roots are under
`/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-remote-reviews-<suffix>`:

- `Wfr7EZ`: Plan conversation/revision; project `/tmp/wld-remote-reviews-wZWSrWyBz0`.
- `YE643U`: image, annotation upload, Guided Review; project `/tmp/wld-remote-reviews-co95oq5lay`.
- `FdAO2u`: completed code conversation/revision/approval and SSH cleanup; project
  `/tmp/wld-remote-reviews-Dv4jE4gxZC`.
- `KAiPsV`: same-project reconnect and old-token rejection.
- `UCNPnz`: OSC 8 Plan-link click, Plan sidebar reopen, and Markdown document-link click.

Earlier exploratory runs exposed errors in the synthetic provider (missing validation-tool responses and repeated
revision calls). Those failed turns are not product-failure evidence. The provider now handles conversational messages,
engineering completion, semantic inspection, and guide JSON. It also permits explicit provider-response files in its
owned evidence root. The historical Code Review TUI reopen failure above was repeated on a valid pending review,
before and after a successful revision; it did not depend on those provider errors. The final repair rerun below
supersedes that failure.

Approval and review transport were qualified. End-to-end publication, physical terminal clicks, and unchecked journeys
above were not. Do not infer those results from source checks or earlier pilot evidence.

All qualification launchers, owned remote processes, and the named headed browser session were stopped after the checks.
The unrelated-process sentinel was explicitly stopped if it was still running. Scratch projects and evidence remain for
inspection; no active qualification task was left running.

### Final repair rerun — 2026-10-24

Matched native macOS and Linux executables were rebuilt after the reopen repair. Build ID:
`e9198ad6acb253fb2f6d5d82463a9d4864997af2c3e81a50fbd4801df2cb6360`.
`bun run install:locked` and the Workspace build passed. The Linux compile used `--expect-build-id`.
Build logs are `postmerge/rerun-{install,workspace,build}.log`. No full CI run was made.
The browser skill was loaded. This rerun used the same production PTY driver and headed browser bridge described above.

- [x] **Code Review action repaired.** Run `NWKHud`, project `/tmp/wld-remote-reviews-NsGPjIQxBF`, opened
      `http://127.0.0.1:55180/review/code?token=a7424f9a-1bca-4ee4-92e4-f947b4d73443`.
      After closing the Code Review tab, PTY Ctrl+Enter from the Workflow tab reopened that exact complete URL.
      The review remained pending. A `QUALIFY_EXPLAIN` conversation left `sentinel.txt` as `remote delivered`.
      Ctrl+Enter reopened the same URL during that conversation. A subsequent `QUALIFY_REVISE` conversation called
      the real remote `write` and completion tools and changed the sentinel to `remote revised`. Ctrl+Enter again
      opened the same complete URL after revision. `browser-urls` records all five Code Review open requests.
      Approval displayed **Changes approved** and the TUI confirmed approval. Evidence:
      `final-code-revised-reopen.png`, `final-code-approved.png`, and the run's `provider.jsonl` and `terminal.log`.
      Browser errors were empty; the console contained development diagnostics, not application errors.
- [x] **Plan revision and execution approval.** In `NWKHud`, a global annotation and `QUALIFY_REVISE` Planner message
      produced `Live revision 2` at the original complete Plan URL on origin 55180. **Approve & Run** started real
      remote execution and validation. Evidence: `final-plan-revised.png`. The driver now recognizes Plan conversation
      content delivered as a tool result; an earlier run's synthetic provider missed that content. That earlier
      reply-only result is not a product defect.
- **Historical pending `/plan-review` attempt, superseded below.** Double-Enter PTY input was sent while the initial Plan tool
  waited in `NWKHud`. No dispatch or new browser request was observed. Run `UKEjyI` then reconnected to
  `/tmp/wld-remote-reviews-EHXHWOYRwc`, dispatched `/load-plan`, and selected **Review plan**. The browser loaded
  `http://127.0.0.1:55622/review/plan?token=2c8dd033-f496-4f94-9197-0400ebe8acd4`.
  Its tab was closed before `/plan-review` plus two separate Enters. No new browser request or command result
  appeared. The TUI did not show an input editor during either pending review. Manual browser navigation still
  loaded the pending URL; **Approve for Later** then saved the Plan. This does not prove successful slash dispatch
  or same-URL command reopen. Evidence: `live-plan-final.log`, `final-pending-plan.png`, and `UKEjyI/terminal.log`.
- [ ] **Publication did not finish in this rerun.** After Code Review approval, `NWKHud` remained at **Publication**
      with a working spinner for more than three minutes. No later model request arrived. No publication success
      message was observed. Evidence: `final-publication-terminal.txt`. Review approval passed; delivery completion
      must not be inferred from it.

Final driver roots: `NWKHud` is the primary Code Review run; `UKEjyI` is the saved-Plan pending-command retry.
`WzWuij` is the earlier provider-diagnosis run; `CMhQ0v` is an initial launcher run. All roots share the disposable
prefix documented above. The final repair evidence is under `/tmp/remote-reviews-df8a7ec8/postmerge`.
This repair rerun did not include Linux opt-in source tests; the later current-source qualification below passed all 12. The Windows check remains deferred.
All four owned launcher runs were stopped, including the initial background run. The headed browser session was closed.
The Linux process check found no remaining supervisor or view for this build. Both recorded connection socket directories
were removed by product shutdown. Evidence: `final-rerun-cleanup.txt` (empty successful absence check). Scratch projects
and evidence remain; no owned qualification process remains active.

### Final pending-command rerun — 2026-10-24

After the terminal editor visibility fix, matching native macOS and Linux production executables were rebuilt.
Build ID: `ebd417c52fcbe72012ed5dd7613e1cb4e6e97fca5e43f8212916fd2b8c9c06a4`.
`bun run install:locked`, `bun run workspace:build`, both compiles, and the Linux `--expect-build-id` check passed.
`bun scripts/run-tests.js src/ui/tui/runtime-interaction-adapter.test.js` passed (one test file).
No full CI run was made. Logs use the `postmerge/pending-` prefix in the evidence directory above.

- [x] **Pending `/plan-review` dispatch and same-URL recovery.** Run `fb8Ohq`, project
      `/tmp/wld-remote-reviews-WhROUO9KtV`, reached a real pending Plan Review at
      `http://127.0.0.1:56720/review/plan?token=18d8e85c-6bf5-4aaf-88be-cc4f7cab4ffb`.
      The headed tab was closed. PTY input sent `/plan-review` and Enter, then a separate Enter.
      The TUI printed **The current Plan review is open.** followed by that exact complete URL.
      This command prints the URL; it does not request `browser.open`. No extra browser request was expected.
      Manual headed `agent-browser` navigation to the printed URL showed the same pending Plan, `Live revision 1`,
      and the approval controls. **Approve for Later** displayed **Approved for later** and
      **This Plan is approved and saved for later execution.** The TUI confirmed **RunWield Plan saved**.
      This result supersedes the unqualified historical command attempts above.
- [x] **Normal input did not start a concurrent turn.** While that Plan remained pending, PTY input sent
      `QUALIFY_EXPLAIN queued normal input`. The TUI displayed it as **Steering**. The provider log remained at
      three requests throughout the pending interval and approval; no concurrent model turn started. This confirms
      pending input retention, not later execution of that input after an approve-for-later Session completion.

Evidence: `pending-live.log`, `pending-command-terminal.log`, `pending-approved-terminal.log`, and the run's
`terminal.log`, `provider.jsonl`, and `browser-urls`. The driver root is
`/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-remote-reviews-fb8Ohq`.
Browser snapshot inspection confirmed the pending Plan; no screenshot is claimed because screenshot calls timed out.
The headed browser session and owned launcher were stopped. The remote build-process check found no supervisor or
view, the connection socket directory was absent, and laptop port 56720 had no listener. Scratch evidence remains.
Publication was not attempted in this bounded rerun; the earlier publication spinner observation is unchanged.

## Current-source Linux supervisor and compiled review smoke: 2026-10-24

The source snapshot included tracked edits and untracked source files. It excluded personal `.git`, `.wld`, and
`node_modules` state. Its archive SHA-256 is `fa1b7be46e21a844678b6bb044d21f425517bd18612e6af59ef75162de243aba`.
A file-hash check after the runs found no source changes since capture.

- On `sct`, Bun 1.4.3 ran `bun run install:locked`: root and docs frozen locks, with lifecycle scripts disabled. No
  Deno graph was installed. The host used non-root UID 1000, Linux x86_64, SSHFS 3.7.3, FUSE 3.16.1, and `/dev/fuse`.
- From the remote snapshot's `source` directory, the runner used `WLD_TEST_SSHFS_STALL=1` and the owned Bun on PATH.
  It ran `bun scripts/run-tests.js src/shared/remote/supervisor.test.ts` with
  `--report-dir /tmp/remote-supervisor-current-df8a7ec8/reports`. The isolated runner supplied the disposable HOME,
  temporary directory, database path, and preload guard. No guard was bypassed. `linux-evidence/final-command.txt`
  records the exact shell command.
- JUnit reports **12 tests passed, 0 failed, 0 skipped**, in 122.24 seconds. All nine opt-in cleanup scenarios ran.
  The pre-existing-directory, setup-terminal closure, and terminal-setup failure cases also passed. The first runner
  attempt stopped before discovery because the snapshot had no Git metadata. A fresh, local-only `git init` and
  `git add -A` in that owned snapshot repaired discovery; no personal Git data was copied.
- Matching native macOS and Linux production binaries compiled from this snapshot. Their common build ID is
  `fdd7d8ecb18661393da413ca85206fddbf3a0aebf6fe6f6d193d09bc496f23f3`. The unchanged qualification driver used a
  synthetic laptop provider and the real compiled SSH launcher, supervisor, SSHFS mount, remote Session, and browser.
  A generated Plan opened at the exact laptop origin `http://127.0.0.1:58745`. **Approve for Later** returned the TUI
  save message and set the remote Plan to `status: approved`. The no-argument `/plan-review` command opened that Plan
  again at the same origin with a new review token. The argument form correctly reported `Usage: /plan-review`.
  This is a bounded open, save, and reopen smoke, not a new full delivery or real-provider qualification.
- The browser and connection-owned processes stopped. The test sandbox was removed. The final Linux scan found no
  fixture processes and no SSHFS mounts.

Evidence is in `/tmp/remote-supervisor-current-df8a7ec8` on the laptop and `sct`. The laptop `linux-evidence` directory
contains JUnit, runner summary, environment, frozen-install log, exact repaired command, and cleanup scan. Build logs,
matching binary metadata, browser snapshots and screenshots, exact browser origin, remote Plan state, and terminal
output are in the laptop root. The live driver evidence is in its `wld-remote-reviews-c5FtO1` subdirectory; the remote
smoke project is `/tmp/wld-remote-reviews-PNW12vqalY`. No production or test file was changed for this run.

<!-- runwield:manual-qa:start child="remote-ssh-development/10-open-remote-reviews-in-the-local-browser" -->

## Open Remote Reviews in the Local Browser

Manual verification steps for remote-ssh-development/10-open-remote-reviews-in-the-local-browser

- [ ] Start a remote Session and run planning to review. Confirm the laptop browser opens the remote Plan at `127.0.0.1` and shows its content. Submit feedback, confirm the revision appears at the same URL, then approve and confirm the workflow continues.
- [ ] In Code Review, expand a file, view a remote-only image, upload an annotation image, and run Guided Review. Confirm the guide reads remote files and uses the laptop model.
- [ ] Close the browser tab during a pending review. Reopen the review from the TUI and `/plan-review`; confirm the same review remains pending.
- [ ] Click a printed review link and a Markdown document link in the laptop terminal. Confirm each opens in the laptop browser at `127.0.0.1`.
- [ ] End the SSH connection. Confirm the forwarded address no longer connects, the remote view ends, and an unrelated remote process continues.
- [ ] Record the deferred Windows check as unchecked in the manual QA record: Plan Review opens and approves through the forward from Win32-OpenSSH.

<!-- runwield:manual-qa:end child="remote-ssh-development/10-open-remote-reviews-in-the-local-browser" -->

## Release-format remote package evidence: 2026-10-26

This is child 11 package evidence, not child 13 real-provider qualification. The unpublished `v0.0.0-rc.1`
archives share build ID `ccfe8d2b68aa8f17a74ff6b7788db8620d40eecca44babe15664a76e42531ceb`. Bun 1.4.3 built
Linux x64/ARM64 and macOS x64/ARM64 targets. `scripts/release-assets.js` verified all four archive pairs. Archives
contain `wld`, `wld.build.json`, and `LICENSE` only.

- **Linux x64 archive gate:** `bun scripts/check-remote-ssh-package.ts . v0.0.0-rc.1` passed on Fedora `sct` in
  **81.39 seconds**. A disposable server account used a private network namespace with no internet route. The real
  SSH/SSHFS connection read a remote-only sentinel, returned it in the second synthetic-provider request, and saved
  one laptop Session. Private helpers and notices were present; no remote transcript, owned process, or mount remained.
- **Native macOS ARM64 laptop → Fedora x64:** the compiled macOS launcher passed cold helper setup, warm reconnect
  with HTTPS blocked, and setup after removing the server cache with HTTPS still blocked. Because the candidate is
  unpublished, its verified runtime archive was seeded into the laptop cache; cold helper archives were downloaded
  normally. The cold connection read the remote sentinel. The laptop saved one Session, and exit left no owned remote
  process or mount. Helpers were absent from the disposable account's system `PATH`; owner installations were unchanged.
- **Early refusal:** hiding `sshfs` from that disposable account's `PATH` produced `sudo dnf install sshfs fuse3`
  before runtime or helper transfer. No real macOS SSH server was tested; automated subprocess coverage checks that refusal.
- **Linux supervisor and mount checks:** 13 supervisor tests and nine mount tests passed, with no skips. Mount tests
  used both `WLD_TEST_SSHFS=1` and `WLD_TEST_SSHFS_STALL=1` and exercised real FUSE mounts.
- **Focused source checks:** 498 tests: 478 passed, 20 platform/opt-in skips, none failed, across 81 files with runner
  concurrency two. The change adds **88 tests** and removes none. An earlier concurrency-eight run failed while waiting
  for laptop MCP dispatch; the isolated rerun and the complete concurrency-two rerun passed. No MCP implementation
  change was made. Type, lint, seam, document-link, and whitespace checks passed. Full managed CI has not run.

Retained laptop evidence: `.ci-cache/remote-package-final2/`, `/tmp/remote-package-final2-build.log`,
`/tmp/remote-package-bounded-reports`, and
`/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-native-package-u4xlobzp`.
Linux evidence: `sct:/tmp/wld-package-qualification-GMGbHhrX/gate-final2.log`,
`sct:/tmp/wld-remote-ssh-3zfEzZ`, `sct:/tmp/remote-package-linux-final-reports`, and
`sct:/tmp/remote-package-linux-mount-reports`. The native driver is `/tmp/remote-package-native-qa.py` on the laptop.

### Hosted qualification passed

The owner authorized commit and push on 2026-10-26. Commit `6d1124613` reached `epic/remote-ssh-development`.
[First qualification run](https://github.com/RunWield/runwield/actions/runs/40266281678) built all four archives and
passed their native identity checks. Both Linux SSH gates failed before starting SSH: the disposable account could
not traverse the runner's private temporary-directory ancestors. Evidence upload also tried to traverse private
server files. The gate now places the shared fixture in `/tmp` and copies only diagnostic logs and results into a
separate runner-owned upload directory. Two regression tests cover private runner ancestors and evidence isolation.
Local SSH probes also measured `sudo` startup at 3.4–4.0 seconds, above the old three-second connection deadline;
the gate now allows 15 seconds without changing its required mount, tool-result, Session, or cleanup checks.

[Repaired qualification run 40268662240](https://github.com/RunWield/runwield/actions/runs/40268662240) passed against
commit `28d16e673ac16aac3bb42390f82bbc9b097e49aa`. Its common release build ID is
`c757d88f86095e0b4ed844af87c2c6db2384d3756ed8f29e7011c1fce53e979a`. All four native archive identity checks passed.
The Linux SSH gates and evidence uploads passed on both hosted CPUs. Publication, package promotion, documentation
publication, and Release Branch integration jobs were skipped.

| Check                                 | Linux x64   | Linux ARM64 |
| ------------------------------------- | ----------- | ----------- |
| Real SSH/SSHFS step                   | 90 seconds  | 88 seconds  |
| Complete native-package job           | 117 seconds | 120 seconds |
| Previous release's native-package job | 39 seconds  | 71 seconds  |
| Native-job increase                   | 78 seconds  | 49 seconds  |

The overall qualification took **4 minutes 18 seconds**. The previous
[release run 40256858840](https://github.com/RunWield/runwield/actions/runs/40256858840) had a created-to-updated
interval of 13 minutes 11 seconds. The qualification mode omits source/Golden and other release lanes, so this is not
a measurement of full-release overhead. Both new native jobs remained below the unchanged ten-minute limit.

Both downloaded `remote-ssh-linux-<cpu>-1` artifacts contain a passing `result.json`, exactly two provider requests,
one saved laptop Session, an actual `fuse.sshfs` mount record, and a zero exit code. The common build ID matches the
run above. The archives contain only diagnostic files, not account homes or SSH keys. Copies and inspected results
are in `/tmp/remote-package-hosted-evidence`; complete run/job/artifact metadata is in
`/tmp/remote-package-hosted-repair-result.json` on the laptop. The five-file repair check passed 78 tests with no skips;
the two new regressions bring the change's test-count delta to **+90**, with none removed. Three mutations rejected
private-runner placement, inclusion of private files, and following evidence symlinks.

Extra Fedora checks with private temporary-directory ancestors failed after the repair: one at SSH banner exchange,
and a later retry at prerequisite setup when `dnf install` exceeded 120 seconds. They are not counted as passed.
Direct SSH to `sct` also timed out, and the laptop's configured DNS resolver stopped answering. GitHub API and artifact checks used an alternate DNS lookup with normal TLS verification, without changing
system DNS settings. The earlier successful Fedora checks above and the current hosted Ubuntu checks remain distinct
pieces of evidence. Full managed CI and child 13 real-provider journeys remain separate from this package qualification.

<!-- runwield:manual-qa:start child="remote-ssh-development/11-package-and-qualify-remote-ssh-support" -->

## Package the Remote Runtime for Released Builds

Manual verification steps for remote-ssh-development/11-package-and-qualify-remote-ssh-support

- [ ] On a clean Fedora x64 server, connect with the release launcher. Confirm it opens the TUI and does not require `cymbal` or `ketch` on the server `PATH`.
- [ ] Disconnect, block `github.com` on the laptop, and reconnect. Confirm the connection succeeds.
- [ ] Remove `sshfs` from the server and connect. Confirm the launcher stops before transfer and shows `sudo dnf install sshfs fuse3`.
- [ ] Connect to a macOS host over SSH, if available. Confirm the launcher refuses the host before any download.

<!-- runwield:manual-qa:end child="remote-ssh-development/11-package-and-qualify-remote-ssh-support" -->
