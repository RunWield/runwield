# Manual QA for remote-ssh-development

This checklist is advisory. It does not change RunWield verification status.

<!-- runwield:manual-qa:start child="remote-ssh-development/01-establish-the-remote-connection-and-matched-runtime" -->

## Establish the Remote Connection and Matched Runtime

Manual verification steps for remote-ssh-development/01-establish-the-remote-connection-and-matched-runtime

- [x] On a supported Linux host, connect to an existing remote folder and confirm the displayed host and canonical
      directory match the remote location.
      [Child 13 location and cold setup evidence](#remote-home-confirmation-repair-and-rebuilt-candidate).

- [x] Connect without a path and confirm RunWield opens the remote home directory.
      [Child 13 release-CLI non-Git home evidence](#remote-home-confirmation-repair-and-rebuilt-candidate).

- [ ] Confirm the connection view states that user turns are unavailable, shows the OpenSSH/SFTP access notice, and
      provides an exit control.
      The connection-only view is historical; ordinary turns are now available. The [child 13 notice
      repair](#startup-laptop-account-disclosure-final-repair) does not prove this old composite item.

- [ ] Try text, slash-command, and shell-shortcut input; confirm none starts a turn or changes remote project or
      personal data.
      Historical connection-only input restriction; current remote turns are enabled. Not a current acceptance gate.

- [ ] Exit with the displayed control and with Ctrl-C; confirm the connection-owned processes stop and unrelated
      processes remain running.
      [Child 13 natural exit and loss checks](#rebuilt-artifacts-and-affected-fault-reruns) pass; both original
      displayed-control and Ctrl-C paths were not rerun as this composite item.

- [x] Test a missing folder or failed SSH connection; confirm RunWield reports the cause and does not create the folder
      or leave a usable connection.
      [Child 13 missing-path check](#current-build-fault-reruns-and-missing-path) rejected the missing path
      without creating it; see its original build ID.

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

- [x] Connect to a test host and use the remote Agent to read a project sentinel; confirm the laptop model provider
      receives it and only the laptop request carries credentials.
      [Child 13 real delivery and saved-context evidence](#managed-real-delivery-and-first-exit-on-6de8ba7f) uses
      the laptop Pi model with remote project tools; credentials remain laptop-owned, not confined from trusted
      SFTP access.

- [ ] Create, edit, and delete a personal Agent, prompt, and nested Skill through remote file tools; inspect the laptop
      files and confirm the edits are present.
      [Child 13 personal Skill edit](#managed-real-delivery-and-first-exit-on-6de8ba7f) passes, but it does not
      rerun creation, editing, and deletion of every listed resource kind.

- [ ] Change a personal resource on the laptop, then reload it remotely and confirm the new content appears; run a
      nested Skill that reads a sibling file.
      The full laptop reload plus nested sibling-script composite was not rerun in child 13. Earlier bounded
      evidence remains above.

- [x] Apply a project resource override and confirm it takes precedence while the project file and project settings
      remain on the remote host.
      [Child 13 real project override](#managed-real-delivery-and-first-exit-on-6de8ba7f) changed only the remote
      fixture and kept the laptop fixture and protected settings unchanged.

- [ ] Disconnect during a model request; confirm the request stops and the remote Agent reports a clear failure without
      switching to a different provider.
      [Child 13 real Stop](#managed-real-delivery-and-first-exit-on-6de8ba7f) and [synthetic fault
      cuts](#rebuilt-artifacts-and-affected-fault-reruns) pass separately; they do not prove this complete real
      in-flight disconnect item.

- [ ] Reconnect and confirm the current laptop resources load, with no writes to the remote user's personal profile.
      [Child 13 exact saved continuation](#third-owner-packet-drop-and-real-saved-continuation-2026-10-30) passes;
      a complete fresh-resource reload/profile-write audit for this composite was not repeated.

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
      Child 13 retained a same-name separation answer, not this Yes/share/store/local-recall composite.

- [ ] Connect to a remote project with no local folder match. Confirm that no question appears and that memories from
      two remote projects remain separate.
      Child 13 used separate scratch targets; it did not repeat a two-project Memory recall/isolation check.

- [ ] Start a remote Session without `mnemoteca` installed on the server. Confirm that Memory recall and core memories
      work, and that `/sleep` reports that it is not available remotely.
      Child 13 did not repeat Memory recall/core injection and remote `/sleep` without server Mnemoteca.

- [ ] Open `/mcp` in a remote Session. Confirm that personal servers show as laptop servers and are not started
      remotely, and that project servers show as remote.
      Child 13 did not repeat the complete personal/project `/mcp` placement check. Earlier child 06 evidence is
      separate.

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
      [Child 13 owned-process fault checks](#rebuilt-artifacts-and-affected-fault-reruns) pass, but do not record
      this exact long-command plus `nohup sleep 600 &` live composite. Group A/supervisor tests remain separate
      evidence.

- [x] Start a `sleep` process in a separate SSH login; disconnect the RunWield connection and confirm the separate process continues running.
      [Child 13 fault reruns](#rebuilt-artifacts-and-affected-fault-reruns) and [owner packet
      loss](#third-owner-packet-drop-and-real-saved-continuation-2026-10-30) preserve an independently started
      exact sleeper.

- [x] Confirm the remote mount directory is removed after disconnect and no mount-cleanup error appears.
      [Child 13 SSH-kill cleanup](#rebuilt-artifacts-and-affected-fault-reruns) removes the owned mount and
      connection directories. The separate stalled-storage case deliberately retains a sealed root, not a live
      mount.

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

- [x] Start a remote Session and run planning to review. Confirm the laptop browser opens the remote Plan at `127.0.0.1` and shows its content. Submit feedback, confirm the revision appears at the same URL, then approve and confirm the workflow continues.
      [Child 13 real browser feedback, revision, and delivery](#managed-real-delivery-and-first-exit-on-6de8ba7f)
      passed on its original build.

- [ ] In Code Review, expand a file, view a remote-only image, upload an annotation image, and run Guided Review. Confirm the guide reads remote files and uses the laptop model.
      Child 13 checked remote Code Review bytes; it did not rerun the complete image/upload/Guided Review
      composite. [Child 10 results](#open-remote-reviews-locally-post-merge-macossct-qualification) remain
      historical evidence.

- [ ] Close the browser tab during a pending review. Reopen the review from the TUI and `/plan-review`; confirm the same review remains pending.
      [Child 13 Plan browser close/reopen](#managed-real-delivery-and-first-exit-on-6de8ba7f) passed. The complete
      combined Plan/Code and `/plan-review` reopen item was not rerun; retain the earlier child 10 results
      separately.

- [ ] Click a printed review link and a Markdown document link in the laptop terminal. Confirm each opens in the laptop browser at `127.0.0.1`.
      The complete printed-link and terminal Markdown-click composite was not repeated in child 13.

- [x] End the SSH connection. Confirm the forwarded address no longer connects, the remote view ends, and an unrelated remote process continues.
      [Child 13 pending-review cuts](#additional-stage-specific-cuts-and-publication-repeats) and [current fault
      reruns](#rebuilt-artifacts-and-affected-fault-reruns) removed owned forwards/view processes and preserved
      unrelated sleepers.

- [ ] Record the deferred Windows check as unchecked in the manual QA record: Plan Review opens and approves through the forward from Win32-OpenSSH.
      Windows laptop qualification is deferred; no Windows support is claimed.

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
      [Child 13 cold private caches](#managed-real-delivery-and-first-exit-on-6de8ba7f) pass on existing `sct`,
      not a new clean-server/PATH-isolation rerun. The [child 11 disposable-account
      gate](#release-format-remote-package-evidence-2026-10-26) remains separate.

- [ ] Disconnect, block `github.com` on the laptop, and reconnect. Confirm the connection succeeds.
      Child 13 did not repeat the explicit laptop HTTPS block. Earlier child 11 warm-cache evidence is retained above.

- [ ] Remove `sshfs` from the server and connect. Confirm the launcher stops before transfer and shows `sudo dnf install sshfs fuse3`.
      Child 13 did not remove or hide server `sshfs`; earlier child 11 early-refusal evidence remains above.

- [ ] Connect to a macOS host over SSH, if available. Confirm the launcher refuses the host before any download.
      No real macOS SSH server was tested; automated refusal coverage is not live platform qualification.

<!-- runwield:manual-qa:end child="remote-ssh-development/11-package-and-qualify-remote-ssh-support" -->

## Confirm a Partly Matching Remote Host: Live Evidence

On 2026-10-26, matching macOS arm64 and Linux x86_64 development executables used build ID
`a40669f1d0f40d695d60bc541161471d04dcc3f3acd544dbbefe9369177fa89f`. The production launcher ran in a real tmux PTY
with an isolated laptop HOME. Only the HTTP model provider was synthetic. OpenSSH, runtime preparation, the personal
mount, Session persistence, and the remote TUI were real. The IP connection used an isolated SSH configuration with
`sct`'s port, user, identity file, and existing trusted host key.

- [x] Connected through `sct` to remote scratch folder `/tmp/host-confirmation-HhxzHBzF` and saved a conversation with
      `LIVE_HOST_CONFIRMATION_SENTINEL`.
- [x] Connected through `47.165.36.233` to the same folder. Before the TUI opened, the host question showed the saved
      DNS target, matching fingerprint, and address-change reason.
- [x] Answered `1` (Yes). `/resume` listed the DNS conversation. Selecting it restored the earlier user message and
      assistant response, with “Conversation restored.”
- [x] Reconnected by IP. The TUI opened without another host question. The project record retained the IP identity in
      `acceptedHosts`, and the isolated HOME still held one Memory binding with the original DNS collection name.
- [x] Exited both IP connections through `/exit`; both launchers returned status 0.

Evidence: `/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/host-confirmation-live-btqgw2gg/` contains terminal logs,
screens, and `evidence.json`. This check covers DNS-to-IP confirmation and resume, not live host-key rotation or a
production model provider.

<!-- runwield:manual-qa:start child="remote-ssh-development/12-confirm-a-partly-matching-remote-host" -->

## Confirm a Partly Matching Remote Host

Manual verification steps for remote-ssh-development/12-confirm-a-partly-matching-remote-host

- [ ] Connect by DNS name and save a Session. Connect to the same server by IP address, choose Yes, and confirm `/resume` lists the saved Session.
      Child 13 [alias identity check](#remote-home-confirmation-repair-and-rebuilt-candidate) is an exact match,
      not a new DNS/IP confirmation. The [earlier DNS/IP
      pass](#confirm-a-partly-matching-remote-host-live-evidence) keeps its development build ID.

- [ ] Connect again by IP address and confirm no host question appears.
      No new IP-confirmation rerun in child 13; earlier saved-answer evidence remains separately labeled above.

- [ ] Connect to a host with a changed key. Confirm the question shows both fingerprints and warns that OpenSSH accepted the new key.
      Live host-key rotation was not tested. Automated fingerprint coverage does not prove this live item.

<!-- runwield:manual-qa:end child="remote-ssh-development/12-confirm-a-partly-matching-remote-host" -->

## Child 13: Qualification Preparation

### Automated checks (not release-archive or real-provider journeys)

On 2026-10-28, the supervisor tests ran as a non-root user on Fedora Server 39 x64 (`sct`), with Bun 1.4.3,
SSHFS, and `/dev/fuse`. The command was:

```sh
WLD_TEST_SSHFS=1 WLD_TEST_SSHFS_STALL=1 bun scripts/run-tests.js src/shared/remote/supervisor.test.ts
```

- Before the fix: 13 passed, 1 failed. The new `production supervisor cleans up on background-logs without stopping
unrelated work` test failed with `background task log directory survived forced TUI cleanup`.
- After the fix: all 14 passed. The test starts a real shell Background Task, reads its output, and forces supervisor
  shutdown while the view ignores SIGTERM. The background-log directory and owned processes are removed; unrelated
  `sleep` survives. The view now receives the supervisor-owned connection directory as `TMPDIR`.
- The eight existing remote-runtime effect tests passed, including graceful background-log cleanup.
- The seam-detector tests passed: 50 tests. Its new regression rejects a false positive from Python keyword arguments
  inside literal text while it still detects injected code inside a template interpolation. The zero-seam baseline
  remains unchanged.
- Type checking passed for 1,551 source and test entries. Test-count delta: **+2**; no tests removed or replaced.

Evidence: `/tmp/wld-child13-evidence/` on the laptop. The private source fixture on `sct` is
`/tmp/wld-child13-d02ibLX1XL`. These checks use source-built fixtures, not a candidate release build.

### Driver-only safety and diagnostic checks

An inert launcher exercised real-provider driver mode without calling a model or starting a product Session.
The disposable HOME's `models.json`, `auth.json`, and `settings.json` hashes were byte-identical before and after.
Evidence: `/tmp/wld-child13-driver-safety-kSvxYYKx/` and `/tmp/wld-child13-driver-stall-XnjCGn9E/`.

A 65-second `Publication` display produced `stall-1.txt` with the scratch project's Plan-lock path, process listing,
and validation-log sentinel. The launcher PID was recorded in `qualification.json`. Evidence:
`/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-remote-reviews-7WoG34/` on the laptop.
These driver checks do not qualify release archives, SSH/SFTP PID discovery, a real provider, or publication.

### Candidate archives and live checks, 2026-10-28

Build ID: `28c8b7e5b75e13ce7cc92794ba3c2694d86316f99bea8864bda6fbc1947a0314`.
Candidate: `v0.0.0-rc.13`. Evidence root on the laptop: `/tmp/wld-child13-candidate-JOR6msX8/`.
The source snapshot is recorded by `source-head` and `source.patch`; no release was published or promoted.

The four platform builds produced `.tar.gz` and `.tar.zst` archives. The unchanged `scripts/release-assets.js`
verified their inventories, metadata, and checksums (`release-verify.log`). The live launcher is macOS arm64;
its server runtime is Linux x64 on Fedora Server 39 (`sct`). Archive verification does not qualify other live platforms.
A mismatched archive build ID was refused before launch; the disposable profile's three sentinel files stayed
byte-identical (`archive-mismatch.log`, `archive-safety-before.sha256`, `archive-safety-after.sha256`).

| Case                                                                                 | Observed result                                                                                                                                                                                            | Evidence below the evidence root                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Scripted runtime delivery, validation cut, proven publication, uncertain publication | Passed through the separately compiled test-client entry, not the release CLI. The release CLI passed only the preliminary save smoke check. Uncertain publication required a choice; no automatic replay. | `workflows.log`; run root `/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-workflows-live-gjO4PQ` |
| Normal exit                                                                          | Owned laptop processes, server processes, mount, and connection directory gone; unrelated remote `sleep` survived. Cleanup: 1.909 seconds.                                                                 | `fault-normal-exit-result.json`                                                                        |
| Laptop SSH process SIGKILL                                                           | Loss detected in 0.204 seconds; cleanup checked in 0.710 seconds. Unrelated `sleep` survived.                                                                                                              | `fault-transport-kill-result.json`                                                                     |
| Launcher SIGKILL                                                                     | Launcher exit detected in 0.204 seconds; cleanup checked in 1.268 seconds. Unrelated `sleep` survived.                                                                                                     | `fault-launcher-kill-result.json`                                                                      |
| Laptop SFTP child SIGKILL                                                            | Loss detected in 0.406 seconds; cleanup checked in 0.878 seconds. Unrelated `sleep` survived.                                                                                                              | `fault-sftp-kill-result.json`                                                                          |
| Loss during a shell write, then reconnect and `/resume`                              | Saved context restored. The interrupted shell ran once; `sentinel.txt` remained `partial` after a further model turn. Both connections cleaned up; unrelated `sleep` survived.                             | `write-cut-result.json`, `write-cut.log`                                                               |

A real-provider attempt used the owner's HOME and project settings that pinned all Agent roles to
`openai-codex/gpt-5.6-luna` through Pi. Plan Review feedback, Approve & Run, isolated execution, verification, AI review,
and laptop-browser Code Review ran. The bare origin contains `remote delivered` on `plan/remote-delivery`.
The driver reached its time limit before the full exit/offline-history/reconnect journey was checked. This is not a
Group R pass. Evidence: `real-pinned-driver.log`, `real-pinned-root`, `real-code-review.png`, `publication-targets.txt`.

Two qualification checks were corrected rather than changing product behavior:

- Publication targets the recorded delivery branch, not necessarily `main`. An initial assertion waited for `main`
  even though the receipt named `plan/remote-delivery`. Later runs check the receipt branch and Session completion.
- A timed-out SFTP lookup can leave a sealed private directory after its live mount and owned processes stop.
  `sftp-mount.test.ts`, **stalled laptop SFTP detaches its live mount before connection cleanup returns**, requires
  that safety behavior. A private directory alone is not evidence of a live mount. The storage-stall check now reads
  the mount table and checks connection-directory and process ownership; it does not require deleting an uncertain
  sealed directory.

The corrected storage-stall run passed on the same build. Loss was detected in 46.670 seconds; cleanup was checked
in 47.150 seconds. No owned process, live mount, or connection directory remained, and the unrelated `sleep`
survived. The retained private mount root had mode `700`; its sealed `global` directory had mode `500`.
Evidence: `fault-storage-stall-result.json` and `storage-stall-corrected.log`. The existing storage-stall contract test
also passed as a non-root user on `sct` (`stall-contract-test.log`).

Three synthetic release-archive publication runs confirmed `remote delivered` on the recorded delivery branch,
reached Session completion, and passed owned-process, mount, connection-directory, and unrelated-process checks:

| Run                       | Publication time | Evidence                                                                                                                  |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `synthetic-publication-4` | 218.676 seconds  | `synthetic-publications-final.log`; run root `/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-remote-reviews-oLKdyl` |
| `synthetic-publication-5` | 218.092 seconds  | Same log; run root `/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-remote-reviews-V5Fl5H`                           |
| `synthetic-publication-6` | 218.237 seconds  | Same log; run root `/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-remote-reviews-QCGSaq`                           |

These runs recorded no stall diagnostics. Earlier runs whose harness assertions failed are not counted as cleanup
passes. An unchanged `main` did not establish a publication failure: the delivery branch was `plan/remote-delivery`.
An empty controller lock file did not establish that an OS lock was held.

### Repaint diagnostics and rebuilt archives, 2026-10-28

A driver-only regression used `PublicatioX`, a cursor-left escape, and `n` to paint **Publication** without emitting
that literal word. Before the fix it produced no diagnostic. After the fix it produced exactly one diagnostic with
the fixture lock, Git process listing, and validation-log sentinel. The disposable HOME's three profile hashes stayed
byte-identical. The driver now observes the rendered terminal with `@xterm/headless`, not ANSI-stripped chunks.
This inert launcher did not call a provider or start a product Session.
Evidence: `/tmp/wld-child13-driver-repaint-p7R22hHz/{red.log,green.log,before.sha256,after.sha256}` and
`/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-remote-reviews-b775P2/stall-1.txt`.

The next archive set had build ID `b57f8f8750d851cda3700809505228c843748c5f5a408d58032e044d8210c7de`, under
`/tmp/wld-child13-candidate-vcB0XzaE/`. A real `gpt-5.6-luna` request was stopped; the saved assistant entry recorded
`stopReason: aborted`. Planning then continued on that model and opened Plan Review. This run exited before
implementation. Owned processes, mounts, and connection directories were absent; unrelated `sleep` survived and the
laptop sentinel hash matched. Evidence: `real-final-root`, with `exit-result.json` below its run root. This was not a
full Group R journey.

The driver limit is now one hour because the earlier real journey reached the 20-minute limit before its final
checks. The rebuilt `v0.0.0-rc.13` archives have build ID
`b35c3f16dfedea7363744df242803993db8f790e8e2feac781d44b833acfc003`, under
`/tmp/wld-child13-candidate-L702RR2D/`. All four Unix targets have both archive formats, and the unchanged
`scripts/release-assets.js` verified them. `source-head` and `source.patch` record the source snapshot. No release was
published or promoted. Earlier results above keep their original build IDs; archive verification alone does not
qualify a live journey on the new build.

### Group A: automated evidence, not live signal cuts

Ten focused test files passed with no failures or skips (13.6 seconds). Evidence:
`/tmp/wld-child13-candidate-L702RR2D/group-a.log`. These tests use the source test runner, not external signals against
a release Session. No tests were removed or replaced; at this check, the child 13 test-count delta was **+2**.

| Case                        | Test file and test name                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save Worker death           | `src/shared/remote/session-save-bridge.test.ts`: **remote save Worker termination wakes the caller and leaves the manager permanently denied**; `src/shared/remote/session-worker-death.test.ts`: **Worker startup death faults at the total deadline without a main-thread callback** |
| Lost save acknowledgement   | `src/shared/remote/remote-runtime-save-fault.test.ts`: **lost first user-save acknowledgement stops the remote turn and resume does not replay the submitted request**                                                                                                                 |
| Session-owner process death | `src/shared/session/remote-session-lifecycle.test.ts`: **owner OS-process death recovers exact laptop evidence and a fresh operation without effect replay**                                                                                                                           |
| Generation commit           | `src/shared/owner-coordination/segment-rollover-commit.test.js`: **commitSegmentRolloverAndPublish seals, appends, moves activation, publishes, and releases atomically**; **failed rollover transaction leaves no successor row, no seal, no pointer move, and no generation**        |
| Rollover interruption       | `src/shared/remote/remote-runtime-workflows-rollover.test.ts`: **a lost rollover acknowledgement releases the transferred writer as uncertain and resume uses saved evidence**                                                                                                         |

### Production-CLI driver and managed approval handoff: 2026-10-29

The owner accepted a Plan Deviation on 2026-10-28. The scripted runtime-client journeys remain code-level evidence.
Release workflow qualification now uses the unchanged CLI in a PTY, supported terminal commands, and visible plus
durable evidence. No qualification-only product command was added. The archive mode is:

```sh
bun src/shared/remote/verify-remote-workflows.ts --archives <directory> v0.0.0-rc.13
```

The first three attempts on build `b35c3f16dfedea7363744df242803993db8f790e8e2feac781d44b833acfc003` did not
pass. They reported a missing execution successor, connection loss after Code Review approval, or an AI-review wait.
The last attempt also timed out during shutdown. Evidence roots are `wld-cli-workflows-S1Bd5i`,
`wld-cli-workflows-Npac8L`, and `wld-cli-workflows-uCMPo5` under the laptop temporary directory. No complete cleanup
pass is claimed for these attempts.

A source regression then isolated the missing successor: direct Approve & Run executed the Engineer inside the
planning writer. Both the Planner and Router paths now return execution intent to the runtime. After that writer is
released, the existing managed execution path seals the predecessor, creates the execution successor, and runs
validation. Approval-time Plan action evidence is retained.

- The regression failed before the fix: **Approve and Run must create an execution successor**, actual 1, expected 2.
- Both new tests passed after the fix. Disabling each managed deferral branch made its test fail with the same assertion.
- Eight focused test files passed with no failures or skips (28.2 seconds). Evidence:
  `/tmp/wld-child13-handoff-focused.log`.
- Type checking passed for 1,552 entries; the injection-seam baseline remains zero.
- Regression and mutation evidence: `/tmp/wld-child13-approval-rollover-red.log`,
  `/tmp/wld-child13-approval-rollover-green.log`, and `/tmp/wld-child13-approval-rollover-mutation.log`.
- At this stage, the test-count delta was **+4** for child 13. No existing test was removed or replaced.

A focused review found three further defects in that handoff. Each was reproduced with the real remote runtime and
laptop Session owner before repair. The tests pause the external checkpoint reply, rename the scratch Plan after actual
approval acceptance, and serialize `TURN_END` synchronously in a subscriber. They do not replace ownership or Plan
machinery.

- Cancellation at the planning checkpoint now prevents the execution successor and any Engineer provider request.
- A failed action-evidence read now releases the Agent transition.
- Public `TURN_END` results exclude the internal execution intent.
- The two approval-path tests moved into `src/shared/remote/remote-runtime-initial-execution.test.ts`. Three tests were
  added there. The rollover file retains all its original tests. Child 13's total test-count delta is **+7**, with no
  baseline tests removed or replaced.
- Red evidence: `/tmp/wld-child13-handoff-review-red.log` (2 passed, 3 failed). Green evidence:
  `/tmp/wld-child13-handoff-review-green.log` (all 5 passed).
- Broader focused verification: 12 test files passed, no failures or skips, 55.6 seconds. Evidence:
  `/tmp/wld-child13-handoff-review-focused.log`. Type checking passed for 1,553 entries; formatting and the zero-seam
  check passed.

### Rebuilt handoff fix and release-CLI diagnostics: 2026-10-29

The rebuilt `v0.0.0-rc.13` archives under `/tmp/wld-child13-candidate-mWhFePKH/` have build ID
`56af9e9a33b1bee7319b34d557badec61068a6b43185fdb1058ebc2b5d99762d`. All four Unix targets and both archive
formats passed the unchanged release verifier. The snapshot includes `source-head`, `source.patch`, and untracked
first-party files under `source-untracked/`.

The release-CLI delivery attempt at `wld-cli-workflows-7uPo3I` reached an execution successor, approved AI and Code
Review, confirmed publication, and **Session complete**. The predecessor was planning; the successor was execution.
The delivery commit is `2a7a6929c86023dddfcd2b11fb73926d03b58a3f` on `plan/remote-delivery`. The recorded Code
Review approval was at 14:37:50 UTC; the verified Session result was at 14:41:43 UTC. The driver missed the completion
because its required publication phrase had scrolled out of view. Manual scrolling exposed **Published commit
confirmed**. This attempt is not a complete driver pass.

Supported `/exit` then reported a fatal connection error. The failure cleanup was confirmed and the unrelated sleeper
survived. Evidence: `/tmp/wld-child13-cli-delivery-repaired.log`, the run's `evidence.jsonl`, and
`/tmp/wld-child13-delivery-after-approval-{diagnostics,locks,progress,io}.txt`. The SSH forwarding messages do not prove a
remote TUI crash or identify the cause of the nonzero SSH result.

Two smaller checks used that same archive build:

- Idle normal exit passed: detection 1.021 seconds, cleanup 1.490 seconds, all owned resources absent, unrelated sleeper
  survived. Evidence: `/tmp/wld-child13-normal-exit.log`; run `wld-remote-reviews-iS9kyt`.
- Reconnect to the delivered project, supported `/resume`, and `/exit` passed: the terminal showed restored conversation
  and checked Publication and Completion stages. Exit code was 0; the PTY helper did not request termination. Detection
  was 1.432 seconds and cleanup was 1.926 seconds. All owned resources were absent; the unrelated sleeper survived.
  Evidence: `/tmp/wld-child13-resume-exit-retry.log`; run `wld-remote-reviews-xRulbp`.

A prior resume probe, `wld-remote-reviews-me144K`, timed out waiting for an `/init` offer that correctly did not recur.
It is not a resume or cleanup pass. On reconnect, the workflow driver accepts the ready prompt without requiring that
offer. Fresh projects still wait for the `/init` choice before sending commands. The driver checks visible completion
plus committed verified delivery and the actual Git destination, and recognizes the restored
sidebar's completed stages. The PTY helper now records the launcher's actual wait status in `launcher-exit.json`; normal
exit requires code 0 without helper termination. Connection cuts also match the recorded connection directory before
signalling an SSH PID.

At this stage, the exit cause was not known. Temporary probes distinguished the laptop cleanup deadline, helper
termination, and remote cleanup failure. These instrumented runs are diagnostic evidence, not final qualification.
They do not establish a publication-stall fix. No support-matrix claim has changed.

### Confirmed review-forward exit defect: 2026-10-29

Instrumented build `ee5173146f684c6035abd1707cd02fb775718c193201e372579d48abd9c75118` reproduced the failure
both after delivery and after Plan Review with **Approve for later**. The view exited with code 0. Remote cleanup
completed in about 220 milliseconds. Five seconds later, the laptop killed its owned SSH process; SSH returned 137,
and the launcher returned 1 without helper-requested termination.

The bounded OpenSSH channel trace identifies the cause: the remote command's session channel closed, but six browser
review-forward channels remained half-open. This was not a remote TUI crash or a cleanup operation exceeding five
seconds. Evidence: `/tmp/wld-child13-exit-diagnostic-retry.log`, `/tmp/wld-child13-review-exit.log`, and
`wld-child13-review-exit-3pl87hl0/ssh.log` under the laptop temporary directory.

The existing authenticated shutdown acknowledgement now follows a natural, successful view exit and confirmed
process, mount, and connection-directory cleanup. Health checks continue during cleanup. The laptop distinguishes this
acknowledgement from its own stop request. Its intentional SIGKILL of a retained SSH forwarder is normal only after
that acknowledgement. A natural SSH failure or missing acknowledgement still fails. No command, transport, or
qualification-only product protocol was added.

Five regression tests cover this behavior:

- `src/cmd/remote/index.test.ts`: confirmed cleanup with open forwards; natural SSH exit 42 after confirmation; open
  forwards without a cleanup receipt.
- `src/shared/remote/control.test.ts`: only authenticated peer shutdown confirms cleanup, not local stop intent.
- `src/shared/remote/supervisor.test.ts`: the peer acknowledgement follows actual owned-process, mount, and
  connection-directory cleanup; unrelated work survives.

The positive CLI case failed before repair with exit 1 instead of 0. The Linux receipt-order case failed before repair:
three owned descendants and both directories still existed when shutdown arrived. After repair, all 20 CLI/control
tests and all 15 non-root Linux/FUSE supervisor tests passed. Removing the receipt guard made the missing-receipt
regression fail with exit 0 instead of 1; the mutation was restored. Eight Group A/runtime files also passed.

Evidence: `/tmp/wld-child13-shutdown-regressions-red.log`, `/tmp/wld-child13-cleanup-order-red-details.log`,
`/tmp/wld-child13-shutdown-green-final.log`, `/tmp/wld-child13-shutdown-supervisor-final.log`,
`/tmp/wld-child13-shutdown-mutation.log`, and `/tmp/wld-child13-shutdown-group-a.log`. Type checking passed for 1,553
entries; the injection-seam baseline remains zero. Diagnostic probes were removed. At this checkpoint, child 13's
test-count delta was **+12**, with no baseline tests removed or replaced. The original connected-CLI test retains its exit-zero assertion;
only its duplicate assertion inside the fixture helper was removed to permit negative cases.

Fresh `v0.0.0-rc.13` archives under `/tmp/wld-child13-candidate-EkyqEPDv/` have build ID
`58aac41a5718cf887d304e9317d693af71c7efbc5f92caa9f425ce248dc53154`. All four Unix targets and both archive formats
passed the unchanged release verifier. On these archives, Plan Review, **Approve for later**, and supported `/exit`
passed with launcher exit 0, no helper termination, all owned resources absent, and the unrelated sleeper alive.
Detection was 6.238 seconds; cleanup was checked at 6.750 seconds. Evidence:
`/tmp/wld-child13-review-exit-fixed2.log`, run `wld-remote-reviews-SbKs55`. The first repair probe had a harness
`NameError`; it is not counted as a qualification pass. This exit result does not establish the publication-stall cause.

The same build completed the production release-CLI `delivery` journey: publication, planning-to-execution rollover,
transport cut, reconnect, `/resume`, no repeated CI/push/provider request, normal exit, and per-connection cleanup.
The unrelated sleeper survived. Evidence: `/tmp/wld-child13-cli-delivery-shutdown-fixed.log`,
`wld-cli-workflows-PhtrUn`; Session `24c33834-e712-487d-8a74-82a0c3470e85` retained execution successor
`3dc27ce7-8883-4324-91e5-a9ea659da75a`. These archives precede the next two repairs.

### Cleanup failure and restored uncertainty: 2026-10-29

A sixth shutdown regression uses a real, non-writable connection directory. It failed because the supervisor returned
success after directory removal failed, even though it withheld acknowledgement. The supervisor now returns failure
when owned-process termination, connection-directory removal, or mount cleanup is unconfirmed. The test changes only
its owned connection directory's permissions; it never changes a mounted path. All **16** non-root Linux/FUSE supervisor
cases passed after repair. Evidence: `/tmp/wld-child13-cleanup-failure-red-details.log`,
`/tmp/wld-child13-cleanup-failure-green-final.log`, and `/tmp/wld-child13-supervisor-16-green.log`.

The interrupted Session's runtime projection was correct: paused, with the message “The interrupted result is
uncertain. Remote evidence does not prove completion. No workflow was repeated.” The sidebar truncated that message
before “uncertain” at both supported sidebar widths. `/resume` now includes the existing paused-progress message in its
conversation notice. Two existing reconnect cases now check the complete notice through the real runtime and command:
uncertain publication and interrupted validation. They failed before repair; all three reconnect cases and both
resume/chat regression files then passed. Evidence: `/tmp/wld-child13-resume-notice-red.log` and
`/tmp/wld-child13-resume-notice-green-final.log`. Removing the notice again made both uncertainty checks fail while
the confirmed-publication case still passed; the mutation was restored (`/tmp/wld-child13-resume-notice-mutation.log`).
Test-count delta remains **+13**, with no baseline tests removed or replaced; the two reconnect cases retain their prior
recovery and no-replay assertions.

Driver investigation also found that an early model footer does not acknowledge input readiness. Keyboard-help probes
must clear pending editor text before retrying. Two manual probes submitted pending question marks with `/exit`,
creating new planning Sessions in the disposable fixture. One later probe selected that newer Session, not the cut
Session. Those probes are diagnostics, not recovery qualification. Explicit selection of the interrupted Session showed
paused stages; evidence: `/tmp/wld-child13-resume-original-paused-screen.txt`. The driver now waits for keyboard help,
clears pending text before exit, selects the workflow sidebar when needed, and records matched launcher-exit receipts
and detection/cleanup times. It does not call recovery to manufacture an observed result.

All three older timed workflow attempts failed: `validation-cut` timed out at the resume selector;
`publication-proven` and `publication-uncertain` timed out at the visible-stage check. Failure cleanup was confirmed and
the unrelated sleeper survived each case. Evidence: `/tmp/wld-child13-cli-faults-shutdown-fixed.log`,
`wld-cli-workflows-h186Km`. They are not qualification passes.

The rebuilt candidate is `/tmp/wld-child13-candidate-f4CCJfUe/`, version `v0.0.0-rc.13`, build ID
`d540fd6f21f956618096fb98307155533dcaef11a2d076d0ef444d04d2da5c47`. All four Unix targets and both archive formats
passed the unchanged release verifier. Type checking passed for **1,553** entries; the seam baseline remains zero.
The original publication-stall cause remains unestablished.

### Rebuilt release-CLI and fault results

These results use build `d540fd6f21f956618096fb98307155533dcaef11a2d076d0ef444d04d2da5c47`,
`v0.0.0-rc.13` archives. Times are seconds from signal dispatch or `/exit` submission. Workflow detection times use the
matched launcher-exit receipt; basic-fault detection times use the first terminal loss report or driver exit. Cleanup
means owned laptop processes, server processes, live mounts, and connection directories are absent. Every case confirmed
that its unrelated remote sleeper survived.

| Release-CLI journey                                                         | Cut detection / cleanup | Reconnected `/exit` / cleanup | Result                                                           |
| --------------------------------------------------------------------------- | ----------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `delivery`, disconnect after rollover and confirmed publication             | 0.050 / 1.158           | 1.507 / 2.514                 | Verified on `/resume`; no repeated CI, push, or provider request |
| `validation-cut`, blocked CI                                                | 0.053 / 1.222           | 1.221 / 1.989                 | Full uncertainty notice visible; no replay                       |
| `publication-proven`, bare ref changed before push returned                 | 0.056 / 1.197           | 1.175 / 2.021                 | Publication confirmed from remote evidence; no replay            |
| `publication-uncertain`, same cut with destination unavailable on reconnect | 0.035 / 1.169           | 1.467 / 2.003                 | Full uncertainty notice visible; no replay; destination restored |

All four journeys passed. Normal exits returned launcher status 0 without helper termination. Fault-cut exits retained
status 1. The execution successor and sealed planning predecessor remained in laptop-owned Session storage. The laptop
namesake sentinel stayed unchanged. Evidence: `/tmp/wld-child13-cli-validation-current.log`,
`wld-cli-workflows-bJI1Rm`; `/tmp/wld-child13-cli-remaining-current.log`, `wld-cli-workflows-GYJb7V`.

| Basic fault               | Detection / cleanup | Actual launcher result |
| ------------------------- | ------------------- | ---------------------- |
| Normal `/exit`            | 1.439 / 2.166       | 0                      |
| Owned SSH SIGKILL         | 0.211 / 0.973       | 1                      |
| Launcher SIGKILL          | 0.211 / 1.474       | SIGKILL                |
| Laptop SFTP child SIGKILL | 0.624 / 1.347       | 1                      |
| Laptop SFTP child SIGSTOP | 44.671 / 51.589     | 1                      |

All five passed. Storage-stall cleanup left no live mount and retained the deliberately sealed `0500` mount directory.
No retained mount directory was changed or deleted by the harness. Evidence: `/tmp/wld-child13-faults-current.log` and
`fault-*-result.json` under the candidate directory.

The protected compiled-pair mode also passed with development version `d4845e40a`, the same source build ID, and adjacent
matching macOS/Linux binaries. A real remote read reached the synthetic provider; the laptop sentinel stayed unchanged;
normal exit returned 0 without helper termination. Detection was 1.080 seconds; cleanup was 1.628 seconds. Evidence:
`/tmp/wld-child13-compiled-pair-current-final.log`, run `wld-remote-reviews-53RJFq`. This is compiled-pair evidence, not
release-archive qualification. Two earlier harness failures—reading a terminal file before creation and waiting for a
transient Guide-switch message instead of its stable footer—are not passes.

Formatting, Markdown links across 597 tracked files, type checking, and zero seams passed. The server process audit
found no remote supervisor or view. The new Group R journey was not started: macOS reported `IOConsoleLocked = Yes`.
The owner must unlock the Mac for headed browser checks. Evidence: `browser-readiness.json` under the candidate directory.
The real-provider journey, owner-run packet drop, and remaining setup/write/review/checkpoint/merge/path cases remain
required before proposal retirement or support claims change.

### Real delivery, resource checks, and native Git cuts: 2026-10-29

Build `d540fd6f21f956618096fb98307155533dcaef11a2d076d0ef444d04d2da5c47` completed real-provider planning,
Stop cancellation, browser Plan feedback and revision, same-URL pending Plan Review close/reopen, Engineer/Autonomous
approval, isolated execution, validation, AI-review repairs, browser Code Review approval, and confirmed scratch
publication. The review added before/after SHA-256 checks for `document.md`. The final sentinel was exactly
`remote delivered\n`; the document remained exactly `# Remote document\n`. AI review repaired a settings change; the
execution worktree's settings then matched the original bytes. The published branch was `plan/remote-delivery`, commit
`b477b4a69aae5d803154ed6c507a3a4238b51842`.

Evidence is under `/tmp/wld-child13-candidate-f4CCJfUe/real-current-c862a033d2`: `real-stop.json`,
`plan-browser-reopen.json`, `plan-revision-proof.json`, `code-review-byte-proof.json`, and headed browser screenshots.
The browser session was `remote-reviews-df8a7ec8`; the PTY run was `wld-remote-reviews-qyLUzg`. The laptop namesake
sentinel stayed unchanged. Protected `auth.json`, `models.json`, and `settings.json` hashes also stayed unchanged.
Real Session and project records were created in laptop history.

After delivery, the real Operator changed a mounted personal Skill fixture from `LAPTOP_BEFORE` to `LAPTOP_AFTER`.
A same-name remote project Skill then changed only its remote fixture to `REMOTE_AFTER`; the laptop fixture stayed
`LAPTOP_AFTER`. The missing-dependency Skill reported command-not-found status 127; `/help model` then displayed
`Usage (model):`. Evidence: `personal-file-edit.txt`, `project-override.txt`, `personal-override-results.json`,
`missing-dependency.txt`, and `core-help-after-missing.txt`. A queued duplicate override invocation was canceled after
the successful check. These fixture edits were deliberate qualification actions, not driver profile initialization.

Direct `/model claude-cli/sonnet` and `/model agy-cli/gemini-3.1-pro` attempts were rejected before activation. Their
messages were `Unknown model` and `Unsupported Antigravity CLI model`, respectively. The remote picker excludes these
providers. This establishes direct-command rejection, not selecting an advertised picker entry and reaching the backend
guard. Evidence: `claude-cli-refusal.txt` and `agy-cli-refusal.txt`.

Two more synthetic release-CLI publication runs passed, for three on this build. The two repeats used supported review
HTTP decisions, not rendered browsers. Evidence: `/tmp/wld-child13-repeat-publications-current.log` and candidate
`publication-repeat-{2,3}.log`. The real run captured six `stall-*.txt` diagnostic files; their meaning and the original
publication-stall disposition require separate review. Eventual publication alone does not exclude a stall.

An external Git-hook adapter cut the unchanged release CLI during a native checkpoint commit and a native publication
merge. Each corrected journey reconnected, displayed paused uncertainty, and performed no automatic replay: CI count 1,
push count 0. All owned connection resources disappeared; unrelated sleepers survived.

| Cut               | Detection / cleanup | Reconnected exit / cleanup |
| ----------------- | ------------------- | -------------------------- |
| Checkpoint commit | 0.050 / 1.199 s     | 1.035 / 2.012 s            |
| Publication merge | 0.048 / 1.199 s     | 1.160 / 1.996 s            |

Evidence: `/tmp/wld-child13-checkpoint-cut-retry.log`, `wld-cli-workflows-f6rUlL`;
`/tmp/wld-child13-git-cuts-current.log`, `wld-cli-workflows-yUL7nj`. The first checkpoint adapter had a wrong relocated
import, then an incorrect `/tmp`-only cwd assertion and a cleanup timeout. Those attempts remain failures. A later
read-only process/directory audit found no owned remnants; only the fresh corrected checkpoint retry is a pass.

### Delayed real-provider exit: reproduced and repaired

The first real connection did not finish `/exit` within the harness's 45-second limit. Remote processes, mounts,
connection directory, laptop SSH, and SFTP were already absent, but the laptop launcher remained alive. It eventually
exited naturally with status 0, without helper termination, about 123 seconds after submission. The failed timed check
remains a failure. Evidence: `exit-ownership.json`, `exit-wait-remote.txt`, and `first-connection-eventual-exit.json` in
the real-run evidence directory. A later attempt to pause the bookkeeping driver found that it had already exited; no
pause signal was delivered. Offline history and saved-context reconnect were not completed in this connection.

A short local WebSocket reproducer used the real Pi Codex transport through `LocalModelBridge`. After a successful
response, bridge closure left one cached provider socket and its five-minute idle timer alive. The subprocess did not
exit. Calling Pi's public, Session-scoped resource cleanup made the same subprocess exit in 11 ms. The bridge now
records the provider Session IDs used by accepted streams and cleans only those IDs on close. No protocol or shutdown
health timing changed.

`model-bridge-lifecycle.test.ts` adds two native-provider contract tests. Before the fix: one passed, one failed because
the child stayed alive. After the fix: both passed. Replacing scoped cleanup with global cleanup made both fail because
an unrelated Session lost its existing connection. The mutation was restored, and both passed again. No test was
removed or replaced; this repair adds **2 tests**, bringing child 13's test-count delta to **+15**. Eight focused test
files passed in 54.7 seconds; type checking covered 1,554 entries; injection seams remained zero. Evidence:
`/tmp/wld-child13-provider-lifecycle-{red,green,global-mutation,restored}.log`,
`/tmp/wld-child13-provider-cleanup-focused.log`, and `/tmp/wld-child13-codex-exit-{red,green}.log`.

Rebuilt candidate `/tmp/wld-child13-candidate-hJkcWCoe`, version `v0.0.0-rc.13`, has build
`3cbe351ca425774e0183ac7851d33960c222bdd4dd45f9810b2449a3d48f1912`. The unchanged archive verifier passed all four Unix
targets in both archive formats. A minimal release-archive real `openai-codex/gpt-5.6-luna` Guide turn then passed:
normal exit 0, no helper termination, detection 0.870 seconds, cleanup 1.537 seconds, unrelated sleeper alive, and protected
profile hashes unchanged. Evidence: candidate `real-exit-probe/result.json` and
`/tmp/wld-child13-real-exit-probe.log`. This is a minimal real-provider shutdown check, not a full Group R pass.

The full affected journeys, owner-run packet drop, and remaining setup/review/path cases are still required. The
proposal remains in place and support claims are unchanged.

### Publication diagnostic audit and correction

The real `d540fd6f…` run had 218.173 seconds between human-review approval at `19:06:46.406Z` and the first merge-running
event at `19:10:24.579Z`. An Operator Manual QA result appeared at `19:08:47.534Z`, within that window. Current publication
code starts Manual QA and Work Record generation before its first merge-running event. Therefore, the saved
`human_review` stage alone does not exclude model work. The evidence does not allocate the full wait between generation,
storage, locks, and Git operations. The original defect remains **not reproduced, not resolved**; unexplained latency is
retained as a limit.

None of that run's six diagnostic files captured this window. One was made during planning; the other five were made
after verified completion. The detector matched the forthcoming or completed `Publication` label. It also reset its
timer on every repaint while the first publication message stayed visible. Its old lock snapshots showed empty,
persistent controller files, not lock holders, and excluded Git metadata directories.

The driver now requires the current-stage `● Publication` marker. It resets its timer only when it sees a new publication
progress message, using the existing message builder for all phases. Diagnostics have UTC timestamps, Git process rows,
Git metadata lock files, and matching Linux kernel lock records, in addition to Plan locks and validation logs. No
product protocol changed.

Four 65-second driver-only fixtures passed: an upcoming stage caused no capture; an active ANSI-repainted stage caused
one; a stalled first progress message caused one; a later progress message restarted the timer and caused none before
exit. Both captures included the fixture's held Git-directory lock and its kernel lock record. All disposable profile
sentinels stayed byte-identical. Evidence: `/tmp/wld-child13-detector-cases-green.log`. These fixtures do not qualify a
release binary, real provider, or full remote workflow. The corrected detector must run during the next real journey.

Changing the guard back to any `Publication` label made the upcoming-stage fixture fail: it captured a false stall. The
fixed driver was then restored byte-for-byte. Evidence: `/tmp/wld-child13-detector-cases-mutation.log` and
`/tmp/wld-child13-detector-mutation-result.json`.

### Corrected-driver candidate and cold setup cut

Candidate `/tmp/wld-child13-candidate-9MWg6ufC`, version `v0.0.0-rc.13`, has build ID
`6de8ba7f077500f460ff5af078f865c975173e9cacf1fe06ac6702d8ede61696`. It includes the scoped provider-resource repair and
the corrected diagnostic driver. The unchanged archive verifier passed all four Unix targets in both formats. No
publication or promotion was performed.

A fresh release-archive setup journey passed on this build. An external SSH stdin adapter held runtime transfer after
1,048,576 of 175,572,960 bytes. The server cache was cold; a tagged installer and a partial `.stage-*` binary proved the
cut point. The harness killed the actual launcher, not SSH. Launcher death was observed in 0.002 seconds; owned installer
and SSH cleanup took 1.043 seconds. Reconnect installed a binary with the expected digest, accepted `/help model`, and
exited naturally with code 0. Exit detection took 0.895 seconds; cleanup took 1.499 seconds. The unrelated sleeper survived
both checks and was then stopped by the harness.

The adapter added an unused installer argument for PID ownership and paused its own forwarding pipe. It did not change
the runtime protocol or product. A first attempt failed because an unrelated same-user `/proc/*/environ` was unreadable.
Two later attempts reached the cut and repaired installation, but their input-readiness checks timed out before startup
modal dismissal. All three remain failed attempts. The passing attempt was a fresh full journey that dismissed startup
modals, received the core-command acknowledgement, and needed no helper termination. Evidence:
`/tmp/wld-child13-setup-cut-dismiss-init.log`; the candidate's `setup-cut-current-path` identifies its full receipts.

A fresh real-provider journey is in progress on this candidate. Cold-cache receipts, same-name Memory separation, the
matched remote project record, and an aborted real `openai-codex/gpt-5.6-luna` Planner turn are recorded under the
candidate's `real-current-path`. These are partial Group R results, not a full pass. The owning packet-drop and other
remaining gates still apply.

### Current-build fault reruns and missing path

All five basic synthetic faults passed on build `6de8ba7f…`. Detection is the first terminal loss report or driver exit;
actual launcher exit comes from the matched receipt. Cleanup includes owned local/server processes, live mounts, and
connection directories. Each unrelated sleeper survived and was then stopped by the harness.

| Case              | Detection | Actual launcher exit |  Cleanup | Launcher result |
| ----------------- | --------: | -------------------: | -------: | --------------- |
| Normal exit       |   1.428 s |              1.290 s |  2.145 s | 0               |
| SSH kill          |   0.204 s |              0.056 s |  0.921 s | 1               |
| Launcher kill     |   0.206 s |              0.002 s |  1.495 s | SIGKILL         |
| Laptop SFTP kill  |   0.410 s |              0.277 s |  1.163 s | 1               |
| Laptop SFTP stall |  49.173 s |             55.128 s | 56.056 s | 1               |

No helper requested launcher termination. The stall retained the deliberately sealed, mode-0500 mount directory, not a
live mount; the harness did not change or delete it. Evidence: `/tmp/wld-child13-faults-6de.log` and the candidate's
`fault-*-result.json` files.

The missing-path case also passed on this build. A path with spaces, a semicolon, and a literal `$()` expression failed
with `Remote target is not an existing directory`. Exit 1 took 0.840 seconds; owned SSH cleanup took 1.340 seconds. The
path was not created; no new server runtime, connection directory, or personal mount appeared. The unrelated sleeper
survived. Evidence: `/tmp/wld-child13-missing-path-current-retry.log`. An earlier harness assertion expected different
error text and failed; it is not counted as a pass.

### Abandoned real attempt and managed-delivery retry

The `real-current-ab48a7b459` attempt on build `6de8ba7f…` passed Stop cancellation, browser feedback/revision, and an
actual browser close followed by same-URL TUI reopen. Two earlier `tab close` commands failed; only the successful whole
browser closure counts. The execution Agent then pushed commit `c95135fac1dbabf54793f02a3c905fbbb010bf1b` to scratch
`origin/main` before validation and Code Review. The local main remained at the fixture commit and an isolated execution
worktree existed. This is a **failed delivery sequence**, not a full Group R pass. No product defect was established by
the model's premature push.

After cancellation during the active managed handoff, `/exit` failed its 45-second check. The launcher later exited
naturally with code 0, without helper termination, about 59.837 seconds after the last input. One owned SSH process was
observed during the delay, but its command was not captured; its role and the delayed boundary are not established. This
is not evidence of another provider-cache leak. A later read-only audit confirmed all owned resources absent, unchanged
laptop sentinel/profile hashes, and unrelated-sleeper survival; the sleeper was then stopped. That audit does not convert
the failed timed check into a pass. Receipts are in that attempt's `abandoned-real-*.json` files.

A fresh attempt, `real-current-1b0d7f6c6b`, uses the same release build. Its scratch fixture has an ordinary `AGENTS.md`
that assigns all staging, commits, merges, and pushes to RunWield after the review gates. The user task and reviewed Plan
repeat this rule. This is fixture guidance, not a product or protocol change. Its real cancellation proof, same-URL
browser close/reopen, SHA-256 feedback revision, and Engineer/Autonomous approval are recorded. The delivery and first
exit results below supersede the earlier pending status. Offline history, continuation, and other gates remain open.

### Managed real delivery and first exit on `6de8ba7f…`

The `real-current-1b0d7f6c6b` attempt completed isolated execution, the configured validation, AI review, headed browser
Code Review, and confirmed publication. Before Code Review approval, scratch `origin/main` still matched fixture commit
`54da27dc57cc5fb3d7f2ed367b2e0d2a13c4facf`. The execution worktree held the changed sentinel. After approval, RunWield
published commit `205a3fa604707cfd9d062e5f83387dfa9d9f7dd5` on `plan/remote-delivery`; it did not publish into `main`.
`sentinel.txt` contained exactly `remote delivered\n`. `document.md` and project settings were byte-identical. The document
SHA-256 was `7cb460cdcb19dd744805c00f8a5ff7ccf963290f74a05dea1eba7d60d5d9dbf0`.

The corrected detector captured the actual pre-publication window:

| UTC event                    | Time         |
| ---------------------------- | ------------ |
| Code Review approved         | 22:03:55.894 |
| Human review passed          | 22:03:57.264 |
| Driver lock/process snapshot | 22:04:57.878 |
| Operator checklist result    | 22:05:47.140 |
| First merge-running event    | 22:07:21.026 |
| Verified publication         | 22:09:25.097 |

The pre-merge window was **205.132 seconds** after approval. The snapshot showed View PID 2769888 holding real kernel
FLOCKs for the Plan/catalog and execution-worktree Plan locks. It showed no live Git process; its Git rows were zombies.
This proves lock ownership at that instant, **not a blocked waiter or a lock-wait duration**. The checklist result proves
model work occurred in the window, but does not allocate all elapsed time. The original defect remains **not reproduced,
not resolved**, with unexplained latency retained. This is not evidence that a 205-second wait is normal.

After delivery, an existing personal Skill changed its mounted laptop fixture from `LAPTOP_BEFORE\n` to `LAPTOP_AFTER\n`.
A same-name project Skill then changed only the remote fixture to `REMOTE_AFTER\n`; the laptop fixture stayed unchanged.
The missing-dependency Skill ran its command exactly once and reported status 127. `/help model` then acknowledged input
without adding an assistant/provider turn. A newly created Skill name first returned `Unknown command`; that attempt is
not counted as resource-access proof. The successful checks used the existing Skill loaded at startup.

The actual first-connection launcher receipt records code 0, no helper termination, **1.787 seconds** to exit and
**2.279 seconds** to owned-resource cleanup. All owned local/server processes, live mounts, and connection directories
were absent. The unrelated sleeper survived. The laptop sentinel tree and protected profile hashes were unchanged.
The sleeper remains available for the continuation check.

Evidence directory: `/tmp/wld-child13-candidate-9MWg6ufC/real-current-1b0d7f6c6b`. It holds the browser screenshots,
`code-review-byte-proof.json`, `published-origin-proof.txt`, `resource-results.json`, `first-connection-exit.json`, and
`post-exit-profile-hashes.json`. Driver `stall-1.txt` is under `wld-remote-reviews-tpbixB`. The read-only bundle audit is
`42858659-4700-4106-bad1-beeb71aea774.out.log`. Stable Session UUID for continuation:
`effe6799-d1e8-425b-84d5-f822b6343841`; execution transcript UUID:
`01a189a1-79de-7537-9f5f-51ef6200b3e3`. These identities are not interchangeable.

**Limit:** this is a delivery/first-exit pass on build `6de8ba7f…`, not a complete Group R pass. Offline history, exact
Session reconnect, saved-context follow-up, interactive CLI-backend refusal, and other gates remain open.

### Remote-home confirmation repair and rebuilt candidate

The release command `wld remote sct` failed before reaching an interactive home outside Git. Its directory safety check
saw the supervisor's input pipe, not a local terminal, and threw `Use wld --allow-system-directory…`. The confirmation
could not be offered. The fix opens the existing remote TUI before consent **only when the selected directory is
classified**. It preserves the ordinary directory warning, default Quit choice, explicit Continue choice, and laptop
browser port. It does not bypass consent or add a protocol.

`src/shared/remote/remote-home-entry.test.ts` runs the real private entry with a real control service and piped input.
It proves that the safety prompt appears and default Quit cancels startup without creating files in the remote home.
The test failed before the fix, passed after it, and failed when the early TUI initialization was deliberately disabled.
Source bytes were restored. Five focused entry/directory test files passed; type checking covered **1,555** entries;
seams remained zero. This adds **one test**, for a Child 13 total delta of **+16**; none were removed or replaced.

Candidate `/tmp/wld-child13-candidate-b5fH3YR4`, version `v0.0.0-rc.13`, build
`693c6b969867fe7c1b5f23e1e367a725b5fa89ab95b3067b1b61f71cc5aa6824`, passed the unchanged archive verifier for all four
Unix targets and both archive formats. Earlier build IDs remain separate evidence; they do not become this build's
passes.

All five basic synthetic faults passed again on `693c6b96…`:

| Case              | Detection | Actual launcher exit |  Cleanup |
| ----------------- | --------: | -------------------: | -------: |
| Normal exit       |   1.437 s |              1.206 s |  2.174 s |
| SSH kill          |   0.206 s |              0.062 s |  1.700 s |
| Launcher kill     |   0.205 s |              0.001 s |  1.464 s |
| Laptop SFTP kill  |   0.406 s |              0.376 s |  1.115 s |
| Laptop SFTP stall |  44.599 s |             50.644 s | 51.448 s |

Owned resources were absent after each case; unrelated sleepers survived. No helper requested launcher termination.
The stall retained only the deliberately sealed mode-0500 directory, not a live mount. Evidence:
`/tmp/wld-child13-faults-693.log` and candidate `fault-*-result.json` files.

The corrected home journey displayed consent, selected Continue, acknowledged `/help model`, and exited naturally with
code 0. Its actual canonical cwd was `/media/main/gandazgul`, still outside Git. Alias connections each saved a synthetic
`ALIAS_READY` reply. Original host and alias resolved to the same durable project identity
`remote-02cb60339e4adaec4d1350118628dc05`, with separate saved Sessions. Each connection cleaned its owned resources and
preserved its unrelated sleeper.

| Case             | Natural exit detection | Cleanup |
| ---------------- | ---------------------: | ------: |
| Home outside Git |                1.450 s | 2.004 s |
| Original host    |                1.740 s | 2.498 s |
| SSH alias        |                1.528 s | 2.543 s |

Evidence: `/tmp/wld-child13-paths-693-provider.log` and candidate `paths-*` directories. The final harness used an external
synthetic HTTP provider and public terminal commands. Earlier attempts are retained: missing alias SSH configuration,
the pre-fix home refusal, a banner-specific readiness assumption, and attempts to demand durable registration from core
help or a shell command alone. Those failed attempts are not passes. The release-home result is not real-provider
qualification, and these results do not authorize support expansion or proposal retirement.

### Current candidate workflow and compiled-pair reruns

All four unchanged release-CLI workflow journeys passed on build `693c6b96…`. Each demonstrated a sealed planning
predecessor, execution successor, and actual launcher receipts. Cuts returned nonzero; reconnected `/exit` returned 0
without helper termination. Owned resources were absent and the unrelated sleeper survived each connection.

| Journey               | Cut detection / cleanup | Reconnected exit detection / cleanup |
| --------------------- | ----------------------: | -----------------------------------: |
| Delivery              |         0.036 / 1.190 s |                      1.414 / 1.968 s |
| Validation cut        |         0.047 / 1.168 s |                      1.514 / 2.483 s |
| Proven publication    |         0.039 / 1.219 s |                      1.097 / 1.984 s |
| Uncertain publication |         0.041 / 1.158 s |                      1.282 / 1.978 s |

Proven publication reconciled from destination-ref evidence captured before the push returned. Uncertain publication
remained paused while destination evidence was unavailable; it showed the full uncertainty notice and did not replay.
The destination was restored. CI/push counts did not increase on reconnect. Evidence:
`/tmp/wld-child13-cli-693.log`, exit receipt 0, and `wld-cli-workflows-eTESPr`; selected journeys 4, failures 0.

The existing compiled-pair input mode also passed with separately compiled adjacent macOS/Linux binaries, build
`693c6b96…`, development version `d4845e40a`. A public Guide turn read the remote sentinel; the synthetic laptop provider
received its tool result, while the laptop sentinel stayed unchanged. Natural exit took **1.244 seconds**, cleanup
**1.801 seconds**; the sleeper survived. This is compiled-pair evidence, not another archive or real-provider journey.
Evidence: `/tmp/wld-child13-pair-693.log` and candidate `compiled-pair-read-exit-final-result.json`.

### CLI-model refusal through per-Agent settings

Both CLI backends were explicitly refused on release build
`693c6b969867fe7c1b5f23e1e367a725b5fa89ab95b3067b1b61f71cc5aa6824`, using the real laptop HOME and provider. The scratch
project used complete `agents.<agent>.model` references and an empty `activeModelPreset`. After a completed real Operator
turn made the Session durable, `/agent guide` selected `claude-cli/sonnet` and `/agent ideator` selected
`agy-cli/gemini-3.1-pro`. Each reached the execution-backend refusal before discovery. Before/after exports retained the
same committed assistant, model, and active-Agent facts: no substitution occurred. The no-request proof is the production
pre-discovery guard plus these unchanged facts, **not packet-level observation**.

The launcher exited naturally with code 0 in **1.259 seconds**; cleanup took **1.919 seconds**. Owned resources were absent,
the unrelated sleeper survived, and all three protected profile hashes stayed equal. Evidence:
`/tmp/wld-child13-candidate-b5fH3YR4/cli-refusal-real-355d2f8c/result.json` and
`/tmp/wld-child13-cli-refusal-real-693-retry.log`. The first harness attempt timed out while looking for a wrapped export
filename even though the file existed; that attempt remains a failure. The correction waits for the actual export file.

No picker or backend-support policy changed. Picker exclusion and direct `/model` lookup errors remain separate from this
backend-refusal proof. Group R still requires live offline history and saved-context continuation.

### Additional stage-specific cuts and publication repeats

These release-CLI results ran on build
`693c6b969867fe7c1b5f23e1e367a725b5fa89ab95b3067b1b61f71cc5aa6824`, with the synthetic provider. Each cut was followed by
reconnect and `/resume`, with no automatic provider, edit, CI, or Git replay. Owned resources were absent after each
connection; unrelated sleepers survived. Reconnected exits were natural code 0, without helper termination.

| Cut                          | Cut detection / cleanup | Reconnected exit detection / cleanup | Result                                 |
| ---------------------------- | ----------------------: | -----------------------------------: | -------------------------------------- |
| Native Git checkpoint commit |         0.052 / 1.187 s |                      1.212 / 1.981 s | Paused; no replay                      |
| Native publication merge     |         0.052 / 1.930 s |                      1.200 / 1.960 s | Paused; no replay                      |
| Shell write                  |         0.054 / 0.976 s |                      1.716 / 2.531 s | Partial bytes retained; one invocation |
| Pending Plan Review          |         0.051 / 0.997 s |                      0.999 / 1.997 s | Saved context restored; no replay      |
| Pending Code Review          |         0.057 / 0.981 s |                      1.768 / 2.501 s | Saved context restored; no replay      |

Native Git hooks proved the checkpoint and merge stages, rather than inferring them from banners. The shell-write
follow-up used saved context and left both the partial bytes and invocation count unchanged. Evidence:
`/tmp/wld-child13-git-cuts-693.log`, `/tmp/wld-child13-write-cut-693.log`,
`/tmp/wld-child13-plan-review-cut-693.log`, and `/tmp/wld-child13-code-review-cut-693.log`.
The extra-cut roots are `wld-extra-cuts-jGd2bu`, `wld-extra-cuts-FS6Ixc`, and `wld-extra-cuts-fuCmrD`.

The initial delivery and two additional synthetic publication deliveries all passed on this build. Repeats 2 and 3
finished at **2026-10-29T23:02:51.564Z** and **23:09:37.528Z**. Neither repeat produced a stall snapshot. Evidence:
`/tmp/wld-child13-repeat-publications-693.log` and candidate `publication-repeat-2.log` / `publication-repeat-3.log`.
This completes three synthetic publication runs, not a diagnosis of the original stall. Its disposition remains
**not reproduced, not resolved**; the earlier real-window diagnostics and unallocated latency remain as recorded above.

### Linked-checkout document roots: two repairs

An ordinary Git linked checkout exposed two incorrect primary-root substitutions. Neither repair changes shared
registry ownership.

1. On `693c6b96…`, the Planner wrote a valid Plan only in the selected linked checkout. `plan_written` returned
   `canceled` / `review_error` before opening Plan Review. The tool's evidence input and the runtime's mandatory review
   preflight now retain the selected document root. A real-Git regression proves the correct Plan/revision reaches the
   review adapter, the saved review reference persists, and the primary Plan remains absent.
2. Rebuilt candidate `/tmp/wld-child13-candidate-UOGDoaqM`, build
   `9daa88d50ec07d8e6eb8771372adce31ee202b089a868705eb2762614e1cd9d1`, opened and approved Plan Review. Execution then failed
   with `Canonical Plan source is absent ... (missing parent docs)`: execution-start had discarded the selected root.
   Its two document lookups now receive the selected cwd; Git/controller operations still receive the primary root.
   A real-Git regression proves isolated execution identity/body, unchanged selected sentinel, absent primary Plan, and
   primary-owned registry state.

Both regressions failed before their fixes and after restoring the incorrect input normalization. Restored fixes passed.
No existing test was removed or replaced. These add **two tests**, bringing Child 13's total delta to **+18**. Six focused
files passed for review; nine passed for execution. Type checking covered **1,556 entries**; seams remained **0**.
Logs: `/tmp/wld-linked-execution-{red,mutation,focused,types,seams}.log`; review verification is also recorded in the
execution transcript.

The final candidate `/tmp/wld-child13-candidate-hwGPKk0M`, version `v0.0.0-rc.13`, build
`7cc4991f5f014ebf42951d159bcceccf8720f68d4bc93a48b235f90c6f4e9fc4`, passed the unchanged archive verifier for all four
Unix targets and both archive formats.

Its first native linked journey completed delivery and rollover, then reconnect failed with local `ENOSPC` during
release extraction. Ownership/cleanup assertions for that never-started reconnect also failed. This is a failed full
journey, retained in `/tmp/wld-child13-linked-execution-fixed.log`, not a Code Review or lock failure.
To recover capacity, 92 inactive binary copies were each SHA-256 matched to a retained canonical archive before unlinking;
14.218 GiB was freed. Metadata, logs, source snapshots, and canonical archives remain. Only roots with matching natural
code-0 receipts and no inventoried live owned PID/path were eligible. Ledger:
`/tmp/wld-child13-binary-prune-nwkkx28o.jsonl`.

The fresh rerun passed the whole linked workflow: native cwd and `.git` file proof, Plan Review, isolated execution,
validation, AI review, Code Review, publication, sealed predecessor/execution successor, transport cut, reconnect,
`/resume`, verified publication, no replay, and natural final exit. Cut detection/cleanup were **0.048 / 1.202 seconds**;
final exit/cleanup were **1.152 / 1.983 seconds**. Both connections preserved the unrelated sleeper and cleaned owned
resources. Published branch `plan/remote-delivery` points to `5d83807d06a4ed07cb53461612e5a768190e161c`.
Evidence: `/tmp/wld-child13-linked-space-retry.log`, receipt 0, suite `wld-cli-workflows-uCJ5WN`.

#### Evidence boundaries after these repairs

`source-delta-from-693.json` in the final candidate compares the saved snapshots. The base HEAD is unchanged. Production
changes since `693c6b96…` are limited to `plan-written.ts`, `session-runtime-interactions.js`, and `execution-start.ts`;
other differences are documentation, test registration, and tests. Existing ordinary-primary-checkout journeys pass the
same cwd value before and after these substitutions. Cases without Plan Review or execution-start do not enter the
changed paths. Thus the earlier results keep their original build IDs and this explicit unaffected-case rationale;
they are not relabeled as new-build runs. The affected linked workflow was rerun on the final archives.
The prior real delivery remains evidence from `6de8ba7f…`, not a new full Group R pass.

### Owner packet-drop gate and offline-history preparation

At preparation, no owner-run PF action had occurred. The later failed owner attempt is recorded below. The external wizard was
`bash /tmp/wld-child13-packet-drop-wizard.sh`; its README records the exact seven stages, unique anchor, reference-token
handling, independent restoration bound, and evidence requirements. That prepared version was fixed to `693c6b96…`; the later document-root
repairs do not enter its idle connection or history-reader paths. No health or graceful-shutdown timing changed.

A native TCP observation found that SSH also owns loopback control forwards and duplicate descriptors for its remote
socket. The old harness rejected these. The corrected parser ignores only local-to-local loopback on non-SSH ports,
deduplicates the remote tuple, and still rejects foreign non-loopback peers or unknown/empty evidence. Pure fixtures and
another native observation passed. The two observations exited naturally and proved cleanup/sleeper survival. They did
not use PF and do not qualify packet loss. Logs: `/tmp/wld-child13-native-tcp-{probe,fixed}.log`.

The public history-picker dry check selected real Session `effe6799-d1e8-425b-84d5-f822b6343841` at
`sct:/tmp/wld-remote-reviews-3v4vB9szXO`, displayed its exact read-only footer, and exited naturally in 1.274 seconds with
unchanged protected profile hashes. The next exact-target rerun passed in **1.401 seconds**. The host was reachable: this is **dry UI evidence only**, not offline qualification.
The first helper failed before opening the UI because a metadata name collided with a function argument; that failed
attempt remains. The owner window must prove a fresh SSH timeout, the exact history view before restoration, actual
natural loss detection, PF restoration, cleanup, and sleeper survival. Group R continuation and final cleanup follow.

The proposal and support scope remain unchanged until the live owner gate, real saved continuation, and final document
and validation gates pass. The abandoned managed-handoff exit delay remains unclassified: eventual natural exit at
59.837 seconds does not replace its failed 45-second check or prove an SSH/provider cause.

A final static wizard review corrected four safety issues: cleanup ownership is set before arming; the first restoration
marker uses exclusive creation and cannot be overwritten by concurrent restorers; incomplete lsof process/descriptor
records are rejected even after a valid peer; and the offline target must match exactly. Concurrent-writer/truncation
fixtures pass. Static review found no remaining blocker in those repairs. Actual PF permission, rule acceptance, packet
loss, restoration, and cleanup still require the owner-run gate.

### First owner packet-drop attempt: failed timing, cleanup preserved

On **2026-10-30**, the owner ran the PF wizard against build
`693c6b969867fe7c1b5f23e1e367a725b5fa89ab95b3067b1b61f71cc5aa6824`. Evidence:
`/tmp/wld-child13-candidate-b5fH3YR4/packet-drop-OgBJGXRTYl`.

- Actual DROP counters were **13 outbound / 10 inbound**. The fresh nonmultiplexed SSH probe timed out with exit 255.
- The matching launcher exited naturally with code 1, without helper termination, **21.082 seconds** after the request
  and **20.966 seconds** after activation. This failed the harness's 20-second gate. That gate used launcher exit, not
  the earlier health-loss decision; the decision time was not captured. The attempt remains **FAIL**.
- Cleanup receipts showed no live owned local or remote resources and no retained mount roots. The unrelated sleeper
  survived, then only its nonce/log/starttime-matched fixture was stopped. The laptop sentinel and protected profiles
  stayed unchanged. Captured PF status returned from Disabled to Disabled; the anchor was empty and root rules were
  byte-identical. The wizard exited 1 and did not create an owner-PASS receipt.
- The exact real Session's native read-only history view completed in 4.306 seconds, with natural exit 0 and unchanged
  profiles. Its child receipt is partial evidence, not a passing full owner journey. The cross-process chronology gate
  also needs repair: system Python 3.9 recorded process-relative `time.monotonic()` values near 0, while Python 3.12
  recorded a different origin near 987,480. Those values cannot establish ordering. The failed attempt is not rewritten.

#### Loss notice and clock repairs

The CLI now reports `Remote connection lost. Closing this connection.` when its health monitor stops the connection,
**before** transport teardown. It does not report this on an already exited SSH process, user interruption, or confirmed
peer cleanup. The five-second health interval, three missed checks, and five-second graceful termination remain unchanged.
The new public CLI subprocess regression uses the real control service and an external SSH peer that deliberately takes
1.5 seconds to exit after SIGTERM. It failed before the notice, passed afterward, failed when the notice was removed,
and passed after restoration. Successful authenticated cleanup also asserts no loss notice. Four focused files passed.
This adds **one test**, bringing Child 13 to **+19**, with no tests removed or replaced. Type checking remains at 1,556
entries and the seam baseline remains zero. Parent rerun:

```sh
bun scripts/run-tests.js src/cmd/remote/index.test.ts --filter 'remote CLI reports health loss before slow SSH teardown completes'
```

Result: one file passed, zero failures/skips, 24.4 seconds. Evidence:
`/tmp/wld-child13-loss-notice-regression-green.log` and `/tmp/wld-child13-loss-notice-types.log`.

External status writers now use explicit POSIX `CLOCK_MONOTONIC` with a matching clock-domain identifier. Unknown domains
are rejected. The actual-writer contract starts both Python interpreters, reads their receipts through the real reader,
and proves increasing times. It failed against the old clock, passed after the fix, and failed under the old-clock
mutation. A retained actual offline-helper dry receipt also precedes the owner writer in this common domain.
The loss observer now requires a fresh native notice after its activation baseline, with the matching launcher and
nontruncated log. Launcher exit and cleanup are separate measurements. Stale-notice and unknown-clock mutations failed;
restored fixtures passed. The 20-second detection gate was **not raised**.
Evidence: `/tmp/wld-child13-clock-{red,green,restored}.log`,
`/tmp/wld-child13-clock-both-writers-green.log`, and `/tmp/wld-child13-packet-mutations.json`.

#### Rebuilt artifacts and affected fault reruns

Candidate `/tmp/wld-child13-candidate-sROZ4WZb`, version `v0.0.0-rc.13`, build
`80ac8ec61fc90a74358a9dd011328d660c7936dae0ac03c04355fc49edc02715`, passed the unchanged verifier for all four Unix
targets and both archive formats. `source-delta-from-7cc4.json` shows that the only production change from `7cc4991f…` is
in `src/cmd/remote/index.ts`; the other differences are that file's regression tests and these evidence notes.
Healthy delivery/review/resume and authenticated shutdown do not enter the new loss-notice branch. Earlier results keep
their original build IDs; they are not relabeled. All five basic release faults were rerun:

| Case          | Detection | Actual launcher exit |  Cleanup |
| ------------- | --------: | -------------------: | -------: |
| Normal exit   |   1.221 s |              0.997 s |  1.879 s |
| SSH kill      |   0.207 s |              0.047 s |  0.919 s |
| Launcher kill |   0.206 s |              0.002 s |  1.419 s |
| SFTP kill     |   0.204 s |              0.274 s |  1.075 s |
| SFTP stall    |  46.320 s |             52.261 s | 53.109 s |

All passed, with matching actual launcher receipts, no helper-requested termination, owned-resource cleanup, and unrelated
sleeper survival. The stalled mount root remained sealed 0500 with no live mount. Its raw terminal contains the new loss
notice. Storage-stall timing is not the blocked-network timing gate. Evidence: `/tmp/wld-child13-faults-80ac.log`, wrapper
receipt 0, and candidate `fault-*-result.json`.

The new archive's exact-Session history dry check passed in **2.442 seconds**, natural exit 0, protected profiles unchanged.
Evidence: `/tmp/wld-child13-offline-80ac-sZD9yCpC/offline-history-result.json`. It remains **DRY_UI_PASS**, not offline
qualification. The seven-stage wizard now selects this build. Static review found no new false-PASS or safety issue;
actual owner-run PF timing and offline chronology still require a fresh attempt. No autonomous PF action occurred.

The six external stateless-snapshot fixtures were rewritten against the real pure validator, replacing an internal gate
stub: accept Enabled/empty states with explicit zero entries; reject an absent entry count; reject nonzero entries with
empty states; reject an owned ephemeral port; accept a nonmatching state; reject unknown output. These preserve the six
parser behaviors. The actual liveness/counter/ownership gate remains part of the owner-run check, not a fixture PASS.

### Second owner attempt: expired confirmation before DROP

Build `80ac8ec61fc90a74358a9dd011328d660c7936dae0ac03c04355fc49edc02715`, evidence
`/tmp/wld-child13-candidate-sROZ4WZb/packet-drop-95vtUfbFxg`, remains **FAIL**. The native harness reported
`Owner second gate expired` at 03:39:20 UTC after its 240-second ready window. The owner answered the still-open prompt
at about 03:42:27; the fresh-heartbeat check refused the operation. No DROP request or activation was recorded. Cleanup
could not run because sudo authorization had expired. The attempt used helper-requested launcher termination; natural
exit 0 during that intervention is not qualification.

The owner then ran scoped manual cleanup. The command sequence completed successfully; retained manual receipts show
PF **Disabled**, zero anchor bytes, and root rules identical to the original. The private reference was released without
printing it again. At 03:46:15, a fresh nonprivileged SSH check proved the unrelated fixture still matched its nonce,
log, starttime and exact `sleep 1800` argv, then stopped only that fixture. At 04:00:37, a fresh audit found no owned local
processes, remote commands, connection directories, live mounts, or retained mount roots. Evidence:
`manual-{after-info,after-anchor,after-root}.txt`, `manual-fixture-cleanup.json`, and
`manual-final-resource-audit.json`. No failed receipt was overwritten or converted to PASS.

The external wizard now bounds the final confirmation to 90 seconds or less, reserving 30 seconds before the actual
POSIX readiness deadline. It renews foreground owner authorization after human pauses, uses bounded noninteractive
refreshes during polling, and can renew credentials during **pre-DROP** cleanup. It never prompts for a password during
active-fault restoration. Noninteractive PF calls use the existing four-second wrapper. The seven stages and bundled
library are unchanged. The native health interval, missed-reply count, grace, and 20-second observation gate are unchanged.

A review caught a race in an added pre-DROP `/exit` cleanup path. That path was removed. An exclusive fault decision now
arbitrates cancellation against request; cancellation prevents load, while a request winner or unreadable decision
prevents transport intervention until restoration is positively confirmed. Sequential and concurrent public controller
contracts prove both outcomes. A second review found a weak Stage 5 renewal assertion; the test now starts with an
expired fixture ticket, executes the post-confirmation authorization action, and requires renewal. These are external
harness repairs; the production archives remain `80ac8ec6…`.

`/tmp/wld-child13-prompt-auth-contract.py` reproduced both original symptoms with the actual shell stage/cleanup code and
real metadata routines. Only sudo is replaced at the hardware boundary; no PF command runs. Red:
`/tmp/wld-child13-prompt-auth-red.log`. Final green: `/tmp/wld-child13-prompt-auth-final-green.log`. Four independent
mutations (unbounded prompt, omitted pre-DROP renewal, omitted Stage 5 renewal, omitted cancellation guard) failed;
restored checks passed. Authorization positive/expired/timed-out cases returned 0/1/124. Pure static fixtures, Bash
syntax and the cross-interpreter clock contract passed. These are **not live PF qualification**. Suite delta remains
**+19**, no first-party tests removed or replaced. A fresh owner attempt and the real saved continuation remain required.

### Third owner packet DROP and real saved continuation: 2026-10-30

The owner-run case `/tmp/wld-child13-candidate-sROZ4WZb/packet-drop-dYuDTeq4Gp` passes on build
`80ac8ec61fc90a74358a9dd011328d660c7936dae0ac03c04355fc49edc02715`. Both earlier attempts retain their failed
receipts; neither is replaced by this result. No Agent ran privileged PF commands.

- Stateless preflight and real DROP counters prove the active path was blocked: **5 outbound, 10 inbound** packets.
  A fresh nonmultiplexed SSH connection timed out with exit **255**.
- The fresh native loss notice appeared **15.356 seconds** after request (**15.260** after activation). Actual launcher
  exit **1**, without helper termination, followed at **20.328 seconds** after request. Detection, exit, and cleanup are
  separate measurements; the 20-second detection gate was not raised.
- The real-HOME public history picker opened exact stable Session `effe6799-d1e8-425b-84d5-f822b6343841` for
  `sct:/tmp/wld-remote-reviews-3v4vB9szXO` while SSH was unreachable. It exited naturally **0** in **4.084 seconds**,
  **16.119 seconds before** the immutable first restoration marker. Both writers report `POSIX_CLOCK_MONOTONIC` with
  the same nonce/build. Natural connection failure and offline history both preceded the restoration request.
- PF returned from **Disabled** to **Disabled**; the owned anchor is empty, root rules are byte-identical, and only the
  owned enable reference was released. No cleanup failure or fallback-termination receipt exists. The real profile
  hashes and laptop sentinel match their baselines. No owned remote command, connection, live mount, or residual root
  remained. The unrelated exact fixture survived, then was stopped using its nonce/log/starttime/argv identity.
- `independent-receipt-audit.json` independently checks identity, chronology, raw notice offset, matching actual launcher
  receipt, counters, profile hashes, and restoration files without rewriting any original receipt or running PF.

The subsequent real-provider connection uses the same `80ac8ec6…` archives and the original remote project, not a copied
Session. Evidence: `/tmp/wld-child13-candidate-sROZ4WZb/real-saved-continuation`; PTY root
`/var/folders/hw/zrm0bqr90xz63nflnb2g_qqr0000gn/T/wld-remote-reviews-wP2dY2`.

- Startup required a supported `/help model` acknowledgement. `/resume` selected the original real Session and restored
  its completed workflow/sidebar and conversation. The current successor remained
  `0797b688-4ce7-4ce4-9f3c-f96bdc3e15a4`, with the planning predecessor sealed.
- The next prompt requested a **read-only saved-context answer**, with no tools, file access, edits, verification, or
  workflow actions. It did not supply the marker, document name, or digest. The committed assistant message used
  **`openai-codex/gpt-5.6-luna`**, returned `R_1B0D7F6C6B`, `document.md`, and its exact SHA-256
  `7cb460cdcb19dd744805c00f8a5ff7ccf963290f74a05dea1eba7d60d5d9dbf0`, with **zero tool calls**.
- The public nonmutating `readVerifiedTranscriptSegments` reader verified both segments and committed generation **590**.
  The manifest was idle after exit. Evidence: `verified-saved-context.json`; no checkpoint, rollover, or recovery write
  was invoked for inspection.
- Protected remote files, project refs, and scratch-origin refs are byte-identical to the pre-turn snapshot. `/exit`
  produced actual natural exit **0** in **1.411 seconds**, without helper termination; cleanup completed in **1.999
  seconds**. No owned SSH/SFTP, remote process, connection, mount, or residual root remained. A separately started sleep
  survived and was then stopped by exact identity. Real profile hashes and the new laptop sentinel stayed unchanged.

This closes the owner packet-loss, exact offline-history ordering, and saved real continuation gates. The original full
delivery/browser/resource journey retains build `6de8ba7f…`; later unaffected-path analyses remain attached to their
actual build IDs. This result does not relabel historical runs, record user verification, or publish a broader support
matrix. The publication-stall disposition remains **not reproduced, not resolved**, with the recorded real diagnostics
and three successful synthetic publications. The failed abandoned managed-handoff 45-second exit check and later
59.837-second exit remain an unclassified historical result, not a passing fault case. Full managed validation is pending.

### Documents fold: checklist evidence and limits

The earlier child checklists above record only complete items that child 13 proved. An unchecked composite can contain
proved parts; its note states the missing part. The other child checklists were not re-audited for this Documents step.
No checkbox records human User Verification. Historical failures and build IDs above are unchanged.

| Evidence                                                                                                                                                                                                      | Matrix and boundary                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Real delivery, Stop, browser revision/reopen, personal Skill edit, override, missing dependency, first exit](#managed-real-delivery-and-first-exit-on-6de8ba7f)                                              | macOS arm64 → Fedora Server x64 `sct`, Pi `openai-codex/gpt-5.6-luna`; build `6de8ba7f077500f460ff5af078f865c975173e9cacf1fe06ac6702d8ede61696`.           |
| [Release-CLI delivery and uncertainty journeys](#current-candidate-workflow-and-compiled-pair-reruns), [stage cuts and three synthetic publications](#additional-stage-specific-cuts-and-publication-repeats) | Synthetic provider; build `693c6b969867fe7c1b5f23e1e367a725b5fa89ab95b3067b1b61f71cc5aa6824`. Not a real-model rerun.                                      |
| [Linked-checkout delivery and reconnect](#linked-checkout-document-roots-two-repairs)                                                                                                                         | Synthetic provider; build `7cc4991f5f014ebf42951d159bcceccf8720f68d4bc93a48b235f90c6f4e9fc4`. Affected workflow rerun after the two document-root repairs. |
| [Current faults](#rebuilt-artifacts-and-affected-fault-reruns), [owner packet DROP, exact offline history, real saved continuation](#third-owner-packet-drop-and-real-saved-continuation-2026-10-30)          | Build `80ac8ec61fc90a74358a9dd011328d660c7936dae0ac03c04355fc49edc02715`; synthetic faults and real Luna continuation are separate evidence.               |
| [Linux ARM64 native release gate](#hosted-qualification-passed)                                                                                                                                               | Real SSH/SSHFS and synthetic provider only. No real-provider ARM64 journey.                                                                                |

The [document-root delta](#evidence-boundaries-after-these-repairs) and
[loss-notice delta](#rebuilt-artifacts-and-affected-fault-reruns) explain unaffected paths. They do not rename older builds
or turn them into current-build reruns. The broad SFTP laptop-account notice remains an ordinary Core acceptance
requirement. Its subsequent [startup repair and live receipts](#startup-laptop-account-disclosure-final-repair) are
recorded below. The personal mount is not credential confinement.

Other glibc distributions remain untested. Windows laptops and CLI backends remain unsupported. Remote ACP, direct server
CLI review, and remote `/sleep` are outside current scope. No support for arbitrary personal mount roots is added.
The original publication stall remains **not reproduced, not resolved**. The real 205-second and earlier approximately
218-second windows retain unallocated model/storage/lock/Git latency; snapshots do not prove a blocked lock waiter or a
root cause. Both failed PF attempts and the abandoned managed-handoff 45-second exit failure (later 59.837 seconds)
remain failures, not successful qualification cases. Full managed validation, artifact audit, and publication remain
outside this Documents step.

### Startup laptop-account disclosure: final repair

The final audit found a real UI defect: the launcher supplied the broad SFTP access notice, but ordinary remote startup
only validated it. The initial display repair was tightened so it precedes model/setup choices and home/system-directory
consent. The existing default **Quit**, explicit **Continue**, and laptop browser port remain unchanged. Connection facts
use one terminal-safe formatter; the notice is UI text, not a provider or durable Session message.

- The native `--remote-view` regression starts the real CLI and control service without replacing owned machinery.
  It supplies no setup input and checks disclosure order. The home regression checks notice-before-consent and retains
  its default-Quit and no-home-write assertions. Both missing-display and missing-consent-notice mutations failed;
  restored focused checks passed. Read-only review confirmed both ordering findings fixed.
- Build `9fb31ea7aafb96f37b612d40251864747c62b20fda0c224fc02a9593151f6650`, candidate
  `/tmp/wld-child13-candidate-igemf4U9`, passed five synthetic fault/startup cases with the visible notice:

    | Case          | Detection | Actual launcher exit |  Cleanup |
    | ------------- | --------: | -------------------: | -------: |
    | Normal exit   |   1.676 s |              1.531 s |  2.430 s |
    | SSH kill      |   0.211 s |              0.053 s |  0.891 s |
    | Launcher kill |   0.211 s |              0.002 s |  1.444 s |
    | SFTP kill     |   0.204 s |              0.278 s |  1.081 s |
    | SFTP stall    |  45.935 s |             51.890 s | 52.817 s |

    Each has a matching actual receipt, no helper termination, owned-resource cleanup, and unrelated-sleep survival.
    The stall retained an unmounted sealed directory; it is not blocked-network qualification.

- The same `9fb31ea7…` archives displayed the notice with the real HOME and Luna, then restored the original Session.
  Another no-tools context turn returned the original marker, protected document, and exact digest. The verified reader
  checked generation **655**, the same execution segment and sealed predecessor, and **zero tool calls**. Remote hashes,
  project/origin refs, profiles, and laptop sentinel stayed unchanged. Natural exit **0** took **1.132 s**; cleanup
  **1.789 s**. Evidence: `real-saved-continuation/{startup-notice-terminal.txt,verified-saved-context.json,final-exit-result.json}`.
- The consent refinement built and verified all four Unix targets and both archive formats as
  `cd8f77d7c60704de1cdf384d99f8eb32610e79cda959f975d293fc649bcf3928`, candidate
  `/tmp/wld-child13-candidate-LyfhYVlS`. Fresh normal startup/notice and natural exit passed: actual exit **1.082 s**,
  cleanup **1.904 s**. A native release connection to non-Git home `/media/main/gandazgul` showed the account notice
  **before** directory consent, accepted explicit Continue, acknowledged `/help model`, and exited naturally **0** in
  **1.141 s**, with cleanup **2.006 s** and unrelated-sleep survival. Evidence:
  `paths-ca7f0fae/home-outside-git/{directory-consent.txt,result.json}`.
- The first home attempt (`paths-ebadfb21`) failed before readiness with genuine SSH
  `kex_exchange_identification: read: Connection reset by peer`. Its failure remains recorded. A fresh SSH reachability
  check passed before retry; the later home result does not relabel that failure.

`source-delta-from-80ac.json` and `source-delta-from-9fb31.json` retain build-specific boundaries. The final consent delta
changes only initial/primary-root directory-warning presentation; ordinary unclassified directories return before that
branch. Prior delivery/review, fault, real-continuation, and owner packet-DROP evidence keeps its original build ID.
No further privileged fault was run. Model dispatch, tools, save/recovery, workflow, health thresholds, and cleanup are
unchanged by these presentation repairs.

The final read-only audit found no remote Core process, connection directory, or live SFTP mount. **Ten** old residual
roots remain unmounted with `global` mode `0500`; none was chmodded or deleted. Real auth/models/settings hashes stayed
unchanged. Source and tests match the final archive snapshot. Evidence: `final-{source-audit,remote-resource-inventory,profile-audit}.json`.
The source-test delta is **+20**, with none removed or replaced; the existing home regression gained assertions.
Final focused checks passed **9 files**, with zero failures or skips (65.7 seconds). Type checking covered **1,557**
entries; the injection-seam baseline stayed **0**; relative links passed in **597** Markdown files. Formatting and
`git diff --check` passed. Logs: `/tmp/wld-child13-final-notice-focused.log`,
`/tmp/wld-child13-consent-notice-types.log`, and `/tmp/wld-child13-final-{doc-links,seams,format}.log`.
Full managed validation remains pending. No release was published, no commit was made, and no User Verification was recorded.

<!-- runwield:manual-qa:start child="remote-ssh-development/13-qualify-remote-ssh-and-retire-the-proposal" -->

## Qualify Remote SSH and Retire the Proposal

Manual verification steps for remote-ssh-development/13-qualify-remote-ssh-and-retire-the-proposal

- [ ] On the real-provider run, confirm the complete remote delivery and review journey, publication, disconnect, reconnect, and saved continuation. Check that the same-name laptop sentinel is unchanged.
- [ ] During the paired network-loss check, confirm the connection detects the loss within about 15 seconds, the unrelated remote `sleep` process survives, and cleanup leaves no connection-owned processes or mounts.
- [ ] Confirm real-provider mode leaves sentinel `models.json`, `auth.json`, and `settings.json` files in the disposable HOME unchanged.
- [ ] Review `manual-qa.md` and Core documentation. Confirm each live result names its release build ID, the support matrix matches tested evidence, and the retired proposal has no remaining links outside archived plans.

<!-- runwield:manual-qa:end child="remote-ssh-development/13-qualify-remote-ssh-and-retire-the-proposal" -->
