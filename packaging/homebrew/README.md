# Homebrew tap preparation

This directory prepares macOS packages for `RunWield/homebrew-tap`. The installed tap identity remains `gandazgul/tap`.

Refresh only RunWield in a copy of the current tap:

```bash
git clone https://github.com/RunWield/homebrew-tap.git /tmp/runwield-tap
bun run package:homebrew --wld-tag vX.Y.Z --output /tmp/runwield-tap
```

Refresh only Mnemoteca in an existing tap tree:

```bash
bun run package:homebrew --mnemoteca-tag vA.B.C --output /tmp/runwield-tap
```

At least one tag is required. RunWield-only refresh does not read the local Mnemoteca inputs or download its archives.
It preserves the Mnemoteca formula, dependency metadata, README, other formulas, and Git metadata.

Supplying both tags explicitly prepares both packages from `tested-dependencies.json`; it is not the ordinary release path:

```bash
bun run package:homebrew --wld-tag vX.Y.Z --mnemoteca-tag vA.B.C --output /tmp/runwield-prepared-tap
```

For Mnemoteca preparation, first update the input file with verified release metadata and checksums that match `vA.B.C`.
The manual preparation workflow accepts either tag or both; a single-package refresh loads the public tap as its base.
Its artifact includes package files only, not checkout metadata or credentials.

Use `--test-only` for local URL overrides. Publishable output must use immutable GitHub release URLs and real license,
homepage, and tested helper version metadata.

Check the rendered tap on disposable macOS infrastructure before publication. The check installs and removes packages;
do not run it against the owner's working Homebrew installation:

```bash
bun run package:homebrew:check --tap /tmp/runwield-tap
```

Use a RunWield Stable release that includes package-owner metadata. Test the binary named in the formula, not a different
local build. Publication must use the same tap revision that passed qualification. If another writer advances the tap,
start from a fresh snapshot and recheck. Never force-push a stale manifest. See [release recovery](../../docs/releasing.md#homebrew-tap-publication).

The generated `wld` formula depends on:

- `gandazgul/tap/mnemoteca`
- `1broseidon/tap/cymbal`
- `ketch`
- `agent-browser`
- `git`

Formula installation does not run account setup, Mnemoteca model setup, or `agent-browser install`. Those remain first
use steps.
