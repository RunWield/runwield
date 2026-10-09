---
planId: "e8fff364-7834-4f36-ae0d-ad3cd06584d4"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "packaging/homebrew/"
    - "scripts/"
    - ".github/workflows/release.yml"
    - "src/cmd/update/"
    - "src/shared/update-check.js"
    - "src/shared/runtime-preflight.ts"
    - "src/ui/tui/chat-footer.ts"
    - "docs/quickstart.md"
    - "docs/releasing.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-11"
status: "validated"
origin: "internal"
parentPlan: "package-manager-distribution"
order: 1
dependencies:
    []
userVerifiedAt: null
targetBranch: "main"
archivedAt: "2026-09-19T21:48:21.140Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/package-manager-distribution/01-homebrew-tap.md"
---

# Prepare the RunWield and Mnemoteca Homebrew Tap

## Context

The owner requested Homebrew distribution through `gandazgul/homebrew-tap`, including Mnemoteca, whose repository the
owner also controls. This is preparation work. Do not create or push the public tap, publish releases, or change account
secrets during execution.

The current release workflow publishes `wld-v<version>-darwin-arm64.tar.gz` and `wld-v<version>-darwin-x64.tar.gz` with
SHA-256 checksums. The earlier conversation's sample URLs omitted the asset name's `v`; derive real names from the
release code, not those samples. The source repository is `gandazgul/runwield`.

`install.sh` supplies Mnemoteca, Cymbal, Ketch, and agent-browser. Snip is optional. Current public helper documentation
lists Homebrew packages for Cymbal, Ketch, and agent-browser. Mnemoteca supplies macOS archives but needs its own
formula. `wld update` currently downloads a tag-pinned shell installer and can replace package-managed files.

## Objective

Deliver release-ready tap source for working `wld` and `mnemoteca` formulas, complete macOS dependency installation,
tested Stable release preparation, and update instructions that respect Homebrew ownership. Prove installation on Apple
Silicon and Intel macOS using this change's compiled package. After the owner publishes the matching RunWield Stable
release, one preparation command produces the ready-to-push tap tree from its actual bytes. Preserve the shell installer
and Linux support. Preparation completion does not require or claim that this new product release already exists.

After owner publication, the user commands will be:

```sh
brew install gandazgul/tap/wld
brew install gandazgul/tap/mnemoteca
brew upgrade gandazgul/tap/wld
```

## Approach

Keep tap source under `packaging/homebrew/`, with formula templates, a tap README, and tap validation automation. Render
a distributable output tree with `Formula/wld.rb` and `Formula/mnemoteca.rb`. This repository owns preparation tooling;
the public tap receives the generated tree through an explicit owner operation. No second checkout is silently edited.
Mnemoteca source changes are not needed for its formula. Checked-in templates may have explicit version/checksum inputs;
an exported publishable formula must never contain placeholders.

```text
confirmed Stable release assets
  -> verify tag, asset names, and SHA-256 bytes
  -> render wld formula / refresh mnemoteca formula by explicit tag
  -> validate and export tap tree
  -> owner publishes gandazgul/homebrew-tap
```

Use fixed release URLs and checksums, never a main-branch installer or install-time `latest` lookup. Reuse upstream
helper formulas:

- `gandazgul/tap/mnemoteca`
- `1broseidon/tap/cymbal`
- `1broseidon/tap/ketch`
- `agent-browser`
- `git` for project workflows

Mnemoteca models and ONNX Runtime keep upstream first-use setup. Browser download keeps `agent-browser install`. Neither
runs during formula installation. Snip remains optional. Do not migrate old memory data, prompt for credentials, or
install npm packages globally from a formula.

Use a small package metadata file beside the actual installed RunWield executable to identify the package owner. For
Homebrew, install the executable and metadata in `libexec`, with a command symlink in `bin`. Resolve the executable's
real location before reading metadata. The shared reader serves update commands and repair/update messages. Do not infer
ownership from the presence of `brew` or from a user's home settings. The Windows child will reuse this metadata
contract.

For a Homebrew installation, `wld update` and its alias give the Homebrew upgrade command without downloading or running
the shell installer. Explicit RC, version, and downgrade flags also must not bypass ownership; explain that these
requests are not supported by this Stable formula. Keep existing standalone update behavior. Update notification and
missing-helper messages must not send Homebrew users to the shell installer.

Use an owner-maintained public tap rather than `homebrew-core`: it supports owner-controlled distribution of the current
source-available release without requiring a source-build contribution. Bundling all helpers on macOS was set aside
because maintained dependencies already exist.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `packaging/homebrew/` — tap tree, fixed package inputs, and local validation/export instructions.
- `scripts/` and `deno.json` — explicit-tag preparation commands, checksum verification, formula generation tests, and
  package smoke checks.
- `.github/workflows/release.yml` — prepare Homebrew output only after successful Stable asset publication; preserve
  existing release operation ownership.
- `src/shared/update-check.js` and a focused package-install metadata reader — determine the installed package owner
  from the real executable location.
- `src/cmd/update/index.ts`, its tests, and `src/cmd/registry.js` — protect Homebrew files and keep CLI help accurate.
- `src/shared/runtime-preflight.ts` and `src/ui/tui/chat-footer.ts` — show the correct package-manager repair and
  upgrade instructions.
- `docs/quickstart.md`, `docs/releasing.md`, and affected helper lists in `docs/index.md`, `docs/contributing.md`,
  `docs/troubleshooting.md` — document complete dependency setup and preparation versus published availability.
- `docs/prd/runwield-core-prd.md` — add the installation and updates capability and its acceptance scenarios,
  distinguishing prepared packages from public availability.

No new domain term is needed. Preserve the current glossary. Do not change Mnemoteca's runtime, license, migration
rules, or release process in its separate repository.

## Reuse Opportunities

- `scripts/release.js` release metadata and Stable/RC parsing — one channel rule, not a new version classifier.
- `scripts/compile.js` and current release archives — preserve bundled Agents, Skills, and browser assets.
- `src/shared/update-check.js` and `src/cmd/update/index.test.ts` — preserve tag-pinned installer selection, channel
  checks, confirmation, downgrade, and error behavior for standalone installs.
- `scripts/install-*.test.js` — retain checksum and platform selection coverage for the shell path.
- `src/testing/process-global-lock.ts` and the isolated test runner — safe temporary home directories.
- Official tap guidance: https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap . Upstream formulas:
  https://github.com/1broseidon/homebrew-tap . These are references, not Tickets.

## Implementation Steps

1. The tap tree installs working `wld` and `mnemoteca` commands on both macOS architectures. Both formulas use verified
   immutable upstream archives, correct licenses and notices, and nontrivial formula tests. RunWield declares all
   required package dependencies. Independent `brew install .../mnemoteca` works without RunWield. Formula installation
   does not invoke `install.sh`, run account/model/browser setup, or overwrite unrelated helper installations.
2. Preparation commands accept explicit released Stable tags and an output directory. Use
   `deno task package:homebrew --wld-tag <tag> --mnemoteca-tag <tag> --output <dir>` as the documented interface. They
   verify actual archive bytes against recorded SHA-256 values and reject missing assets, mismatches, RC releases,
   invalid tags, and incomplete platform inputs before emitting a publishable tree. Mnemoteca can be refreshed
   independently with `--mnemoteca-tag` while preserving the RunWield formula. Every exported publishable tree has real
   versions, URLs, checksums, and license metadata, not placeholders. Local package-check output is labeled test-only
   and cannot be exported for publication. Inputs preserve the tested helper version information without falsely pinning
   upstream Homebrew dependencies.
3. Homebrew package metadata is part of the installed artifact. The shared reader follows real executable paths, handles
   missing or invalid metadata safely, and does not classify ordinary source or standalone installs as Homebrew.
   `wld update`, `wld upgrade`, update notifications, and missing-helper instructions respect the package owner. An
   install-directory environment override cannot bypass Homebrew protection.
4. Stable release automation exports a checksummed, ready-to-push tap artifact after RunWield release assets succeed.
   Candidate releases do not update Stable package output. Add a preparation-only manual workflow for testing and
   recovery; it neither creates product release tags nor pushes a tap. A failed package-preparation job is retryable for
   the same immutable release without recompiling or changing released bytes. Document owner publication and later
   formula refresh commands, including independent Mnemoteca releases and any future optional cross-repository
   credentials. Do not require such credentials for normal compilation or CI.
5. Native Homebrew checks install the generated formulas and real dependencies, exercise RunWield and Mnemoteca, and
   test upgrade/uninstall behavior. A test-only local artifact input serves the exact compiled RunWield build containing
   this change before its first public release, using the same formula rendering/install logic as production. Production
   output requires immutable released URLs. `deno task package:homebrew:check --tap <directory>` installs and checks the
   rendered artifact, including ownership behavior against those exact downloaded bytes. The owner must repeat this
   command on final Stable output before pushing the tap. Separate success for an old public binary's checksum and a new
   local binary's behavior must never be combined as proof of one ready package.
6. The Core PRD, quickstart, troubleshooting, and release instructions agree on dependencies, first-use downloads,
   supported macOS architectures, package-owned upgrades, and the publication boundary. Public install commands are
   marked pending owner publication until the tap is actually available. No document claims the tap shipped during
   preparation.

## Approval Confirmation

No Work Record supersession is proposed. Approval covers local tap preparation and repository automation, not public
repository creation or package publication.

## Verification Plan

- Run
  `deno run -A scripts/run-tests.js scripts/package-homebrew.test.ts src/cmd/update/index.test.ts src/shared/update-check.test.js scripts/install-integrity.test.js scripts/install-platforms.test.js scripts/install-interaction.test.js`,
  adding the focused metadata and message tests implemented with this change. Use `deno task ci` for repository checks.
  Never run `deno test` directly.
- Preparation tests use local release HTTP fixtures and real archives. Assert exact architecture-to-URL/checksum
  mapping, tampered bytes rejected, RC rejected, absent architecture rejected, no half-publishable output after failure,
  and independent Mnemoteca refresh preserving RunWield. A generator that emits fixed or placeholder formulas must fail.
- Real executable tests launch a compiled RunWield package through its Homebrew symlink in a temporary installation.
  Exercise both update aliases and RC/version/downgrade arguments, with an override install directory set. Verify the
  correct command is printed, the installer subprocess is not invoked, and package bytes remain unchanged. Launch an
  ordinary standalone binary to prove its update behavior remains available. Use existing network/subprocess boundaries
  only; no test hook for owned package identity.
- On clean Apple Silicon and Intel macOS environments: run `brew audit --strict gandazgul/tap/wld`,
  `brew audit --strict gandazgul/tap/mnemoteca`, `brew install gandazgul/tap/wld`, and both `brew test` commands against
  the locally registered generated tap. Record tap trust prompts and prerequisites exactly as current Homebrew requires;
  never use `brew link --overwrite` to hide a conflict.
- With disposable home/cache/database paths: add and search a distinctive memory through real Mnemoteca after its normal
  model setup; index a tiny real Git project and find a named function with Cymbal; fetch a local HTTP page through
  Ketch; install the browser through the documented command and open a local page with agent-browser. Assert real
  results, not merely helper `--help` exits.
- Start installed `wld` in a temporary project, reach provider setup, and verify no missing-helper failure. Check
  `wld version`, help, and packaged Workspace assets. With owner-provided credentials, complete one Agent turn and
  resume it; do not place credentials in CI artifacts.
- Upgrade between two generated test package versions: verify the new executable runs, saved Session/settings/memory
  data survives, and the old package is not overwritten in place. Uninstall RunWield: its command disappears while
  separately installed Mnemoteca and user data remain. Test an unrelated earlier PATH entry: document the conflict
  instead of deleting or silently replacing it.
- Re-read release automation: only Stable success produces Stable formula updates; failures and manual preparation do
  not publish externally. The owner handoff in `docs/releasing.md` requires publication of a Stable containing this
  change, formula generation from that release, and `package:homebrew:check` against that rendered tree before tap
  publication. Repeat byte and ownership checks together; log the tested archive digest. Local preparation can complete
  with its test-only package evidence, while this final public-asset check remains an explicit owner release step.

## Edge Cases & Considerations

- This working tree already has unrelated edits, including `src/cmd/update/index.test.ts`. Preserve and incorporate
  those edits; never reset or replace the file wholesale.
- Latest helper metadata can be rate-limited. Use fixed verified inputs and explicit failures, not an unverified
  download fallback. Refresh chosen versions at implementation time and record the tested combination.
- RunWield uses a custom source-available license. Use truthful Homebrew license metadata such as `:cannot_represent`
  where appropriate and include the license link. Do not label it MIT or change the license.
- Homebrew owns helper dependency versions. The release records what was tested; it does not promise that independent
  taps never update. Run package smoke checks again when dependencies change.
- Initial publication must use a RunWield release containing package-owner handling. An older release may prove formula
  download mechanics but cannot prove safe package updates.
- Model and browser setup needs network access and writable user caches. A failed first-use download must report its
  actual cause, not be called an installation success. No models, credentials, or user databases belong in the tap
  artifact.
- Linux Homebrew support is deferred. Do not remove existing Linux shell assets or imply that macOS verification covers
  Linux.
