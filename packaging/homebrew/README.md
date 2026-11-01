# Homebrew tap preparation

This directory prepares macOS packages for `RunWield/homebrew-tap`. The installed tap identity remains `gandazgul/tap`.

Refresh only RunWield against the existing public tap dependency:

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

The existing manifest and macOS dependency asset pair must be valid; publishable refresh rejects test-only bases.

Check a disposable copy on disposable macOS infrastructure before publication. The check installs and removes packages,
and stages and commits its input tree. Keep the publication checkout at the original snapshot revision; do not qualify
on the owner's working Homebrew installation. Test the binary named in the formula, not a different local build:

```bash
mkdir /tmp/runwield-tap-check
cp -R /tmp/runwield-tap/Formula /tmp/runwield-tap/README.md \
  /tmp/runwield-tap/runwield-homebrew-package.json /tmp/runwield-tap-check/
```

```bash
bun run package:homebrew:check --tap /tmp/runwield-tap-check
```

The checker also compares the installed Mnemoteca version with `mnemotecaTag`. Stable publication uses only the verified
wld formula and wld-owned manifest fields from the checked base. A normal push rejects concurrent tap changes. Recovery
starts with a fresh snapshot and repeats qualification; never copy stale metadata over an updated dependency or rerun an
old workflow revision. See [release policy](../../docs/releasing.md#homebrew-tap-publication) for recovery and the separate
public dependency repair. Source prevention does not establish that the public repair is complete.

The generated `wld` formula depends on:

- `gandazgul/tap/mnemoteca`
- `1broseidon/tap/cymbal`
- `ketch`
- `agent-browser`
- `git`

Formula installation does not run account setup, Mnemoteca model setup, or `agent-browser install`. Those remain first
use steps.
