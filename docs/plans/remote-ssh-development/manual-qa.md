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
