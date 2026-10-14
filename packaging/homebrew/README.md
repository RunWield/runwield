# Homebrew tap preparation

This directory prepares `gandazgul/homebrew-tap` output for macOS.

Generate formulas from immutable Stable release assets:

```bash
bun run package:homebrew --wld-tag vX.Y.Z --mnemoteca-tag v0.3.3 --output /tmp/runwield-tap
```

Refresh only Mnemoteca in an existing tap tree:

```bash
bun run package:homebrew --mnemoteca-tag vA.B.C --output /tmp/runwield-tap
```

Use `--test-only` for local URL overrides. Publishable output must use immutable GitHub release URLs and real license,
homepage, and tested helper version metadata.

Check the rendered tap on macOS before publishing it:

```bash
bun run package:homebrew:check --tap /tmp/runwield-tap
```

The first public tap must use a RunWield Stable release that includes package-owner metadata. Do not publish a formula
that points at an older `wld` binary and only test a newer local binary.

The generated `wld` formula depends on:

- `gandazgul/tap/mnemoteca`
- `1broseidon/tap/cymbal`
- `ketch`
- `agent-browser`
- `git`

Formula installation does not run account setup, Mnemoteca model setup, or `agent-browser install`. Those remain first
use steps.
