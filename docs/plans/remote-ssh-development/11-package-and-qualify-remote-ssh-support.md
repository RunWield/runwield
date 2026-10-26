---
planId: "a65417c5-35b5-4192-9355-c5000440568f"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/cmd/remote/index.ts"
    - "src/shared/remote/release-artifact.ts"
    - "src/shared/remote/runtime.js"
    - "src/shared/remote/target.ts"
    - "src/shared/remote/supervisor.ts"
    - "src/shared/remote/sftp-mount.ts"
    - "packaging/remote/tested-dependencies.json"
    - "scripts/check-remote-ssh-package.ts"
    - ".github/workflows/release.yml"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/contributing.md"
    - "docs/releasing.md"
planDeviations:
    - id: "call_817eec016bc747649877b31c6b186716|fc_03eb5d4179c33120016ade7ccdc5e48197a7ea4d576cd7e6f1"
      supersededRequirement: "Then trigger the release workflow with `workflow_dispatch` on the Epic branch and confirm that both Linux `native-package-check` legs pass the SSH check. Record each leg's duration and the total release wall time compared with the previous run."
      replacementRequirement: "Add a qualification-only workflow dispatch mode that builds release-format candidate archives from the selected branch without publication. Use that mode on the Epic branch to confirm that both Linux native-package-check legs pass the SSH check, and record each leg's duration and total qualification wall time compared with the previous release run. Delivery of the changed workflow to GitHub remains subject to RunWield's delivery boundary."
      reason: "The current manual dispatch accepts an immutable existing release tag and can proceed to publication; it cannot safely qualify unpublished Epic-branch candidate bytes."
      approvedAt: "2026-10-26T01:37:38.726Z"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T02:05:52.824Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 11
dependencies:
    - "01-establish-the-remote-connection-and-matched-runtime"
    - "02-bridge-local-models-and-personal-resources"
    - "03-guard-remote-session-writer-access"
    - "04-run-and-resume-remote-sessions-with-local-history"
    - "05-keep-memory-and-integrations-on-their-owning-machine"
    - "06-forward-personal-mcp-tools-from-the-laptop"
    - "07-carry-remote-context-through-delivery-workflows"
    - "08-stop-owned-remote-work-on-connection-loss"
    - "09-host-reviews-on-one-server-per-process"
    - "10-open-remote-reviews-in-the-local-browser"
userVerifiedAt: null
targetBranch: "epic/remote-ssh-development"
status: "implemented"
---

# Package the Remote Runtime for Released Builds

## Context

A released `wld remote` must work on a clean Linux server that has only system packages. Today it does not:

- Remote startup requires `cymbal` and `ketch` on the server `PATH`. When they are missing, the error tells the user to
  run the personal installer, which the Epic forbids. The `sct` pilot passed only because both were already installed
  in `/usr/local/bin`.
- A released launcher downloads its full Linux archive from GitHub on **every** connection
  (`downloadReleaseRuntime` in `src/shared/remote/release-artifact.ts`), even when the server cache is valid. A
  reconnect fails when GitHub is unreachable.
- A missing `sshfs`, `fusermount3`, or `/dev/fuse` is found only after the runtime is transferred and started
  (`mountLaptopHome` in `src/shared/remote/sftp-mount.ts`). The error names the missing item but not the fix.
- No release check runs the real release archive over SSH. ARM64 has never been exercised end to end.

These parts already work and stay as they are:

- `resolveRemoteTarget` reads the server OS and CPU before any download, and `linuxTarget` refuses other systems.
- Released launchers verify the archive checksum and the build, protocol, version, and target identity.
- `prepareRemoteRuntime` installs atomically into `~/.cache/runwield/runtime/<buildId>/<triple>/<sha256>/wld` under a
  lock, reuses verified entries, repairs abandoned stages, and never touches shell profiles.
- The review UI and Session-save Worker are compiled into the binary.

**Owning requirements.** The change delivers part of
[Remote connection and setup → Prepare RunWield automatically](../../prd/remote-ssh-prd.md#remote-connection-and-setup)
and changes [Core Installation and updates](../../prd/runwield-core-prd.md#installation-and-updates) and
[Core Remote connection → Prepare a matching development runtime](../../prd/runwield-core-prd.md#remote-connection).
The remote host prerequisites change: `cymbal` and `ketch` no longer need to be on the server `PATH`.

### Decisions from planning

- **Laptop download and cache (owner, 2026-10-25).** On the first connection, the laptop downloads the Linux `wld`
  archive and the pinned helper archives for the server's CPU, verifies them, and caches them on the laptop. Later
  connections use the cache. The server needs no internet access.
- **Check the server first (owner, 2026-10-25).** The launcher identifies the server OS, CPU, and prerequisites before
  it downloads or transfers anything. A macOS server fails at that point with a clear message. Remote macOS servers
  stay out of scope, as the Epic states.
- **SSHFS is a server package (owner, 2026-10-25).** RunWield does not ship `sshfs`. The server installs `sshfs` and
  `fuse3` from its own packages; RunWield names the install command for the server's distribution. Non-root FUSE
  mounts need the system's setuid `fusermount3` either way, and not shipping `sshfs` avoids a GPL source obligation.
- **Release gate on GitHub (owner, 2026-10-25).** The release workflow runs the real release archive over SSH on the
  existing x64 and ARM64 Linux runners. This is the ARM64 support evidence.

### Epic Scope Changes

This child previously also held the host-match prompt and the release qualification. The prompt moved to
`12-confirm-a-partly-matching-remote-host`. The live journey, failure matrix, and transient-PRD retirement moved to
`13-qualify-remote-ssh-and-retire-the-proposal`.

## Objective

A released launcher connects to a clean, supported Linux server that has `python3`, `sshfs`, and `fuse3` installed.
It supplies the RunWield runtime and its required helpers privately, works again without GitHub after the first
connection, and gives an actionable error before any download when the server cannot run it. Every release proves
this on x64 and ARM64 before publication.

## Approach

The launcher gains two steps before runtime preparation: a prerequisite verdict from the existing resolver, and a
laptop cache that supplies the runtime archive and helper archives.

```diff
 runRemoteCommand (src/cmd/remote/index.ts)
   resolveRemoteTarget            # also reports os-release and sshfs/fusermount3//dev/fuse
+  assertRemoteHostReady          # OS, CPU, prerequisites; distro install command
-  downloadReleaseRuntime         # every connection
+  obtainReleaseRuntime           # laptop cache, download on miss
+  obtainRemoteHelpers            # pinned cymbal/ketch, laptop cache, download on miss
   prepareRemoteRuntime           # existing two-phase transfer and remote cache
+  prepareRemoteHelpers           # same transfer protocol, private helper cache
   ssh … exec wld --remote-supervisor
+    supervisor prepends private helper dirs to PATH, then starts the view
```

**One owner for helper identity.** `packaging/remote/tested-dependencies.json` pins each helper per Linux CPU: version,
upstream URL, archive SHA-256, license, and the binary name. One module reads it and owns both the laptop cache path
and the remote helper path. The launcher uses that module to transfer helpers; the remote supervisor uses the same
module to find them. No other module knows the layout.

**One code path for the runtime archive.** The laptop cache stores the archive and its `.sha256` file exactly as
published. On a hit, the launcher verifies them as it does after a download, then runs the existing
`extractReleaseRuntime`. On a miss, it downloads and writes both files atomically to the cache. The release gate puts
the candidate archive into this cache; it needs no URL override or test seam.

**Laptop cache location.** `<home>/.cache/runwield/remote/`, resolved through `getHomeDir()` on macOS and Linux. It
stays outside `~/.wld`, so the personal mount does not expose large binaries to the server.

**The release gate.** `scripts/check-remote-ssh-package.ts` runs in the Linux legs of `native-package-check`. The
runner is both laptop and server: it installs `openssh-server`, `sshfs`, and `fuse3`, starts `sshd` on loopback, and
writes a disposable HOME with an SSH alias. It seeds the laptop cache with the candidate archive, connects the release
launcher in a PTY (as `verify-remote-reviews.ts` does), and runs one synthetic-provider turn that reads a remote-only
sentinel. Then it exits and checks cleanup.

> [!TIP]
> **Why the gate costs little wall time**
>
> `native-package-check` already runs in parallel with `homebrew-check` (30-minute limit) and the CI shards. A few
> extra minutes on the Linux legs should not lengthen the release. Without the gate, the release-only path (archive
> extraction, laptop cache, ARM64 helper pins, ARM64 SSHFS and supervisor) would first run on a user's machine.

Set aside: shipping helpers inside the ordinary Linux release archive. That would change every shell install and
duplicate what `install.sh` already does for local installs.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/remote/target.ts` — the fixed resolver also reports `/etc/os-release` `ID`/`ID_LIKE` and whether `sshfs`,
  `fusermount3`, and a `/dev/fuse` character device are present.
- New host-prerequisite module under `src/shared/remote/` — the readiness verdict and per-distribution install command.
  `sftp-mount.ts` keeps its mount-time checks as the mount owner's invariant guard, and reuses this module's wording.
- `src/shared/remote/runtime.js` — `linuxTarget` messages name the supported systems.
- `src/shared/remote/release-artifact.ts` — the laptop runtime cache replaces per-connection download.
- New helper module under `src/shared/remote/` and `packaging/remote/tested-dependencies.json` — pinned helpers, the
  laptop helper cache, and the remote helper path.
- `src/shared/remote/runtime.js` (`PREPARE_SOURCE`, `prepareRemoteRuntime`) — the transfer protocol also installs a
  helper into its private versioned path, with checksum and `--help` preflight.
- `src/shared/remote/supervisor.ts` — verifies private helpers and prepends their directories to `PATH` before the
  remote view starts.
- `src/cmd/remote/index.ts` — the new launcher order.
- `scripts/check-remote-ssh-package.ts` and `.github/workflows/release.yml` — the SSH release gate on both Linux legs.
- `docs/prd/runwield-core-prd.md`, `docs/prd/remote-ssh-prd.md`, `docs/contributing.md`, `docs/releasing.md` — the
  changed prerequisites, cache behavior, and release gate.

`src/shared/runtime-preflight.ts` is deliberately unchanged. The remote supervisor verifies its helpers before the view
starts, so general preflight needs no remote branch.

## Reuse Opportunities

- `extractReleaseRuntime`, `verifyBuildArtifact`, and `sha256Bytes` — the archive and identity checks for cached bytes.
- `prepareRemoteRuntime` and `PREPARE_SOURCE` — the two-phase transfer, lock, atomic replace, stage repair, and reuse.
- `packaging/windows/tested-dependencies.json` and `scripts/package-windows.ts` — the pinned-helper manifest shape and
  checksum check. Use the same helper versions unless a Linux asset is missing.
- `install.sh` `helper_asset_name` — the upstream Linux asset names for `cymbal` and `ketch`.
- The PTY helper and synthetic provider in `src/shared/remote/verify-remote-reviews.ts` — the gate's terminal driver.
- `native-package-check` in `.github/workflows/release.yml` — the existing x64 and ARM64 runners and release bytes.

## Implementation Steps

- `resolveRemoteTarget` returns the server's `os-release` `ID` and `ID_LIKE` and the presence of `sshfs`,
  `fusermount3`, and a `/dev/fuse` character device, in addition to its current fields. Existing callers compile
  unchanged.
- Before any laptop cache read, download, or transfer, `runRemoteCommand` refuses a server that is not Linux, a CPU other
  than x86-64 or ARM64, or a Linux server that lacks `sshfs`, `fusermount3`, or `/dev/fuse`. A macOS server reports that
  Remote SSH supports Linux x86-64 and ARM64 servers and that the target runs macOS.
- A missing-prerequisite error lists every missing item and one install command for the distribution family: Fedora/RHEL
  `sudo dnf install sshfs fuse3`, Debian/Ubuntu `sudo apt install sshfs fuse3`, Arch `sudo pacman -S sshfs fuse3`,
  openSUSE `sudo zypper install sshfs fuse3`, and a generic package-manager sentence for any other distribution. A
  resolver failure caused by a missing `python3` says that the server needs `python3`.
- A released launcher with a verified archive and `.sha256` in `<home>/.cache/runwield/remote/` for its VERSION and the
  server's CPU makes no network request for the runtime. On a miss, it downloads both files, verifies the checksum
  line, writes both atomically to the cache, and then extracts. A cached archive that fails verification is deleted and
  downloaded again once.
- The laptop runtime cache keeps entries only for the current launcher VERSION. Entries for other versions are removed
  after the current entry is verified.
- `packaging/remote/tested-dependencies.json` pins `cymbal` and `ketch` for `linux-x64` and `linux-arm64`: version,
  upstream URL, archive SHA-256, license, license URL, and binary name. One module under `src/shared/remote/` reads it
  and is the only owner of the laptop helper cache path and the remote helper path.
- The launcher supplies each pinned helper from the laptop cache, or downloads, verifies, and caches it on a miss. It
  transfers the helper binary and its license file to `~/.cache/runwield/helpers/<name>/<version>/<triple>/<archive
sha256>/` on the server through the existing preparation protocol. The server verifies the binary checksum, runs
  `--help`, installs atomically, and reuses a valid entry without a second transfer. Development launchers use the same
  helper path; only release launchers use the runtime cache.
- With a warm laptop cache and a warm server cache, a connection completes with no request to GitHub. With a warm laptop
  cache and an empty server cache, it transfers the runtime and both helpers and makes no request to GitHub.
- The remote supervisor verifies that each pinned helper exists at its private path and prepends those directories to
  `PATH` before it starts the remote view. A missing or damaged helper stops startup with a message to reconnect, which
  repairs the private cache. Nothing changes the remote user's profile, system packages, or `/usr/local/bin`.
- `scripts/check-remote-ssh-package.ts` runs on a Linux runner against a release archive directory and a VERSION. It
  installs and starts a loopback `sshd`, seeds the laptop cache with the candidate archive, connects the extracted
  release launcher in a PTY, and completes one synthetic-provider turn whose second model request contains a
  remote-only sentinel. It then exits and fails unless no supervisor or view process and no `fuse.sshfs` mount remain,
  the private helpers exist under the server cache, the laptop saved one Session, and no remote transcript exists.
- `native-package-check` runs `scripts/check-remote-ssh-package.ts` on the `linux-x64` and `linux-arm64` legs. A failure
  blocks the `release` job through the existing `needs` gate. The macOS legs are unchanged.
- The Core PRD Installation and Remote connection sections, the Remote SSH PRD connection section, `docs/contributing.md`,
  and `docs/releasing.md` state the new server prerequisites (`python3`, `sshfs`, `fuse3`, usable `/dev/fuse`, glibc
  Linux x86-64 or ARM64, OpenSSH with TCP and Unix-socket forwarding). They also state the laptop and server caches,
  that RunWield supplies `cymbal` and `ketch` privately, and the SSH release gate. They no longer say helpers must be on
  the server `PATH`. The live platform matrix and the retirement of the Remote SSH PRD stay with child 13.

## Verification Plan

**Automated, focused** (`bun scripts/run-tests.js <paths>`):

- Prerequisite verdict: a resolver result for Darwin, for `armv7l`, and for Fedora, Ubuntu, Arch, and an unknown
  distribution with each prerequisite missing produces the exact refusal and install command. A test runs
  `runRemoteCommand` against a fake `ssh` executable on `PATH` that reports macOS. It fails unless the command fails
  before any cache directory is created or any download starts. The fake `ssh` is an external subprocess boundary, not
  a new seam.
- Laptop runtime cache: with a real archive built by the existing release-artifact test fixtures in a disposable HOME,
  a cache hit verifies and extracts without network access. A corrupted cached archive is replaced. Another VERSION's
  entry is removed. This test fails if the launcher still calls `downloadReleaseRuntime` on a hit.
- Helper module: the manifest parses, has both CPUs for both helpers, and every entry has a 64-hex SHA-256. The laptop
  path and remote path come from the same function. A cached helper archive with a wrong checksum is rejected.
- Remote helper installation: run the preparation protocol's Python source locally against a disposable HOME, as the
  existing `runtime.test.js` does. A first run installs the helper, and a second run reuses it without reading bytes.
  An abandoned stage is repaired. A checksum mismatch leaves no installed file.
- Supervisor `PATH`: a test starts the supervisor entry with a disposable HOME that contains the private helpers. It
  fails unless the started view's environment has them first on `PATH`, and unless a missing helper stops startup with
  the reconnect message.

**Release gate:** run `bun scripts/check-remote-ssh-package.ts` locally on a Linux x64 machine against archives made
with `bun scripts/release-assets.js`. Then trigger the release workflow with `workflow_dispatch` on the Epic branch and
confirm that both Linux `native-package-check` legs pass the SSH check. Record each leg's duration and the total
release wall time compared with the previous run.

**Manual (owner, macOS arm64 laptop → Fedora Server x64):**

- Delete `~/.cache/runwield/remote/` on the laptop and `~/.cache/runwield/` on the server. Remove `/usr/local/bin/cymbal`
  and `/usr/local/bin/ketch` from the server, or take them off `PATH`. Connect with a release-format launcher. Confirm
  it downloads once, transfers the runtime and helpers, and opens the TUI.
- Disconnect, block `github.com` on the laptop, and reconnect. Confirm the connection succeeds.
- Temporarily uninstall `sshfs` on the server. Confirm the error appears before any transfer and shows
  `sudo dnf install sshfs fuse3`.
- `wld remote` to a macOS host over SSH, if one is available. Confirm the macOS refusal happens before any download.

**Protected behavior:** development-bundle connections, build and protocol identity refusal, remote cache reuse and
stage repair, `install.sh` helper installation for local installs, `runtime-preflight` messages for local and
package-managed installs, and the existing `native-package-check` identity checks.

**Expected to stop:** the per-connection GitHub download for a released launcher, and the requirement that `cymbal` and
`ketch` be on the server `PATH` for remote startup.

**Documents:** run `bun run doc-links:check`. Confirm the Core PRD and Remote SSH PRD no longer list helper `PATH`
prerequisites and do not claim the live platform matrix that child 13 owns.

## Edge Cases & Considerations

- **GitHub runners without FUSE.** If a hosted runner cannot mount FUSE, the gate cannot prove the mount. Stop and
  report; do not drop the mount from the check or mark it optional.
- **Missing upstream Linux ARM64 helper asset.** If a pinned version lacks a Linux ARM64 asset, pick the nearest version
  that has both, and record it. Do not ship an x64-only helper set.
- **Server without internet.** This is supported by design: only the laptop downloads.
- **Server cache growth.** Old `~/.cache/runwield/runtime/<buildId>` and helper entries stay on the server. Pruning
  while another laptop version may still be connected needs a separate decision. It is out of scope here.
- **`AllowStreamLocalForwarding no`.** Child 10 left a diagnostic to this child only if qualification found such
  servers. None was found; no probe is added.
- **Third-party notices for the RunWield archive itself** (for example the Bun runtime) are a general release question,
  not remote-specific. They are out of scope.
- **Assumption: `snip` is not delivered.** It is optional at runtime, so remote Sessions run without it unless the
  server already has it.
- **Assumption: laptop cache location** `<home>/.cache/runwield/remote/` on both macOS and Linux laptops.
