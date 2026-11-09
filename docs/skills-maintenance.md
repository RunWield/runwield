# Maintaining portable skills

[RunWield/skills](https://github.com/RunWield/skills) owns the installable Guide, Ideator, Review, and Write Tests skills. Its checkout
lives at `skills/` in Core as a Git submodule. The small repository contains the skills, their supporting documents,
MIT license, README, and installation metadata; installing it never needs Core's history or dependencies.

```sh
npx skills@latest add RunWield/skills
```

## Existing installations

Users who installed from `gandazgul/runwield` or `RunWield/runwield` should run the installation command above once,
selecting the same agents and scope (`-g` for global installs), and accept replacement if prompted. Installed skill
copies remain usable, but the saved source must change for future updates to follow the dedicated repository.
GitHub's repository-transfer redirect points to Core; it cannot redirect only the old skills directory to another repo.
The skills CLI does not initialize submodules when cloning, so the Core submodule is for maintenance, not an installer
redirect.

## Checkout and compare

```sh
git submodule update --init skills
bun run skills:sync:check
```

The submodule revision makes checks reproducible. CI reads the pinned checkout and never fetches the latest branch or
publishes changes. Existing recursive submodule checkout and cleanliness checks apply to `skills/` too.

To bring published changes from the skills repository into Core deliberately:

```sh
git submodule update --remote --merge skills
bun run skills:sync:check
```

Start with a clean skills checkout. Review the resulting changes before accepting the baseline and submodule revision.

## Edit and review

| Portable skill                | Source in Core                     |
| ----------------------------- | ---------------------------------- |
| `skills/ideator/SKILL.md`     | `src/agent-definitions/ideator.md` |
| `skills/guide/SKILL.md`       | `src/agent-definitions/guide.md`   |
| `skills/review/SKILL.md`      | Independently maintained           |
| `skills/write-tests/SKILL.md` | Independently maintained           |

1. Edit the skill directly inside `skills/`, or edit its source Agent definition.
2. Carry relevant wording changes to the other side. Describe capabilities without RunWield-specific tool names or
   workflow machinery. These are deliberate adaptations, not byte-for-byte copies.
3. Run `bun run skills:sync:check` to see source, skill, and supporting-document drift.
4. After reviewing the differences, run `bun run skills:sync:update` to record the accepted hashes, then check again.

The update command validates portable wording, published skill discovery, and `.claude-plugin/plugin.json` before
writing `scripts/skill-sync-baseline.json`. It accepts reviewed hashes; it does not rewrite prompts, commit, or push.
Every Markdown file within each published skill is discovered from disk, including newly added support documents.
Add new published skills to the baseline and the skills repository's plugin manifest together. Internal skills must
opt out of installation with `metadata.internal: true` in their front matter.

## Publish in dependency order

Publish the reviewed skills commit to `RunWield/skills` first. Then record that submodule revision and its matching
baseline in Core. The pinned skills commit must be fetchable before Core's change can pass release validation.
Commit and push only when the repository owner requests them.

## Public and bundled copies

Review and Write Tests each have two distribution paths. Maintain their portable packages in `skills/review/` and
`skills/write-tests/`. Carry each change into the matching runtime directory under `src/skills/` in the same change.
The compiler embeds `src/skills/`; it does not use the public submodule at runtime. RunWield extracts those assets to
`~/.wld/bundled-skills/`, where `/skill:write-tests` is available without a separate public Skills installation.

Catalog tests compare both copies independently of the accepted sync hashes. The only accepted instruction-file
difference is `license: MIT; complete terms in ../LICENSE` in the public package versus
`license: MIT; complete terms in LICENSE` in the runtime package. Each runtime directory has a local `LICENSE` that
matches `skills/LICENSE`.

Run the focused checks after updating either copy:

```sh
bun scripts/run-tests.ts scripts/check-skill-sync.test.ts src/shared/session/skill-catalog.test.ts
bun run skills:sync:check
bun run compile:bun .ci-cache/write-tests-package/wld
bun run check:package:bun .ci-cache/write-tests-package/wld
```

The relocated package check selects and expands bundled Write Tests in a clean HOME and compares its extracted
instructions and license with runtime source bytes. On macOS, it also denies the child process read access to the
checkout. Publish the public commit before recording its final gitlink and baseline in Core, as described above.
