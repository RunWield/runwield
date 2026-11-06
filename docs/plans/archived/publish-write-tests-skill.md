---
planId: "ced024e1-f8ce-4da0-96c5-bf810f3a5106"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "skills"
    - "src/skills/write-tests"
    - "scripts/skill-sync-baseline.json"
    - "src/shared/session/skill-catalog.test.ts"
    - "src/cmd/package-smoke"
    - "scripts/check-bun-package.ts"
    - "docs/skills-maintenance.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-04"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "bd333eba7df60af79732d22ecc617cefc77e8c67"
status: "verified"
workRecord:
  status: "generated"
  recordId: "0506633d-ea5f-4f79-bde3-61cb86939b5e"
  path: "docs/work-records/2026-11-05-independent-write-tests-distribution-with-bundled-availability.md"
  lastAttemptAt: "2026-11-05T16:10:10.224Z"
archivedAt: "2026-11-06T02:19:52.915Z"
archivedFromStatus: "verified"
archivedFromPath: "docs/plans/publish-write-tests-skill.md"
---

# Publish Write Tests Without Losing the Bundled Skill

## Context

The user wants `write-tests` available from the open-source `RunWield/skills` repository while keeping it in every
RunWield installation. The current instruction package is already portable and lives at `src/skills/write-tests/SKILL.md`.
The public repository is the Git submodule at `skills/`.

The existing Review Skill provides the pattern: a public package, a retained runtime copy, and a test that compares
both. `scripts/compile-bun.ts` embeds `src/skills`, not the public submodule. The release checker already detects missing
or stale extracted Skill Markdown, including `write-tests`. The relocated package checker does not yet prove Skill
invocation from the compiled executable.

Owning capability: [Core — Agent and skill customization](../prd/runwield-core-prd.md#agent-and-skill-customization).

- **Change “Portable skills install independently”:** add Write Tests to Guide, Ideator, and Review.
- **Preserve “Test authoring earns its coverage”:** publish the current instructions without changing their meaning.
- **Preserve “One Skill catalog”:** retain bundled discovery, invocation, and existing override precedence.
- Add acceptance scenarios for independent Write Tests installation, public/bundled parity, and compiled availability
  without the public checkout. No existing requirement is removed.

[Core — Installation and updates](../prd/runwield-core-prd.md#installation-and-updates) owns package qualification.
This work adds focused evidence for its existing requirement, not a new installer or release policy.

## Objective

Users can install `write-tests` from `RunWield/skills` without Core. RunWield users still receive the same instructions
as a bundled Skill and can invoke `/skill:write-tests` without installing public Skills separately.

## Approach

Keep the two distribution paths separate and enforce agreement, following Review:

```text
skills/write-tests/SKILL.md         -> public Skills installer
             parity test
src/skills/write-tests/SKILL.md     -> compiled assets
                                   -> ~/.wld/bundled-skills/write-tests
                                   -> /skill:write-tests
```

Use the current source instructions for the initial public copy. After publication, maintain the portable package in
`skills/` and carry changes into the runtime copy in the same change, as documented for Review. Register it as a
standalone entry in the existing sync baseline; the catalog parity test independently rejects divergent copies even
after someone accepts new hashes.

Use Review's license convention: public front matter points to `../LICENSE`; bundled front matter points to a local
`LICENSE`, copied from the public repository. Content comparison permits only that exact license-path difference.

Extend the existing internal package-smoke command and relocated package verifier. The compiled process must select
the bundled Skill and expand its actual instructions. The verifier compares extracted bytes with source bytes. Keep
its clean HOME and macOS checkout-read denial.

A build-time fetch or new copy generator would add failure modes without changing the result. Do not introduce one.
No catalog precedence, runtime extraction, compiler layout, or architectural decision changes are required.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `skills/write-tests/SKILL.md`, `skills/README.md`, and `skills/.claude-plugin/plugin.json` — publish the instructions,
  list their purpose, and expose the fourth installable Skill.
- `skills` Git submodule revision — pin the published public repository commit in Core.
- `src/skills/write-tests/` — retain the runtime instructions and add explicit MIT metadata and local license terms.
- `scripts/skill-sync-baseline.json` and `scripts/check-skill-sync.test.ts` — register the public package and ensure the
  inventory test explicitly requires Write Tests rather than accepting matching omissions from disk and baseline.
- `src/shared/session/skill-catalog.test.ts` — prove invocation, extracted content, and portable/runtime parity.
- `src/cmd/package-smoke/` and `scripts/check-bun-package.ts` — exercise Skill selection and invocation in the compiled,
  relocated executable; verify packaged instruction and license bytes.
- `docs/skills-maintenance.md` and `docs/prd/runwield-core-prd.md` — document the fourth public Skill, dual distribution,
  sync checks, publication order, and acceptance scenarios.

The glossary already defines Skill and Testing Skill. Their meanings do not change. Other public Skills, testing
policy, and the compiler's existing `src/skills` inclusion stay unchanged.

## Reuse Opportunities

- `src/shared/session/skill-catalog.test.ts` — reuse the Review parity pattern and `withRuntimeCommandFixture`.
- `listSkills` and `resolveNamedInvocation` — use the real selection and invocation interfaces; do not fake the catalog.
- `scripts/check-skill-sync.ts` — existing discovery, manifest, portable-wording, and hash checks cover the new entry.
- `runPackageSmokeCommand` and `checkBunPackage` — extend the existing internal diagnostic path and isolated executable
  check instead of adding another build harness or public command.
- `scripts/release-check.js` — retain the existing extraction checker and its missing/stale Write Tests coverage.

## Implementation Steps

1. `skills/write-tests/SKILL.md` contains the current `src/skills/write-tests/SKILL.md` instructions, with explicit MIT
   license metadata and no instruction rewrite. Its name remains `write-tests`. The public README includes its test
   authoring, repair, pruning, and test-value review purpose. The plugin manifest lists `./write-tests` alongside the
   existing three Skills. All public references resolve without Core or other required Skill packages; TDD stays optional.
2. `src/skills/write-tests/` remains a real runtime directory. Its instructions match the public package except for the
   exact license-path adjustment. Its local `LICENSE` matches `skills/LICENSE`. The sync baseline records the public
   package as a standalone entry with reviewed hashes. Existing inventory checks still reject accidental public Skills,
   missing manifest entries, and nonportable wording; the committed-inventory test explicitly requires Write Tests.
3. A catalog scenario uses a real temporary project and HOME. It finds exactly one `write-tests` entry with source
   `bundled` at the extracted HOME path. `/skill:write-tests check the recovery contract` resolves as a Skill, retains the
   extra instruction, and includes the current body. The extracted file equals the runtime source; public/runtime
   equality permits only the license-path difference. License bytes also match. A missing Skill or unrelated placeholder
   must fail; assert representative current sections such as `## Decide Whether a Test Is Warranted` and
   `### Fake the environment, never your own machinery` as well as full-body equality.
4. The existing gated `package-smoke` command supports a `skills` check that uses real catalog selection and named
   invocation for Write Tests, asserts bundled selection and meaningful expanded instructions, and exits nonzero on
   failure. `checkBunPackage` runs it in its relocated executable fixture and checks success, then compares the extracted
   `write-tests/SKILL.md` and `LICENSE` with their runtime source bytes. This must not read public `skills/` at runtime,
   require credentials, or contact a model. Keep the internal-command environment gate and update its usage text.
5. The owning Core capability names Write Tests as independently installable and retains all test-contribution and
   catalog requirements. Its scenarios cover independent public discovery, parity failure, and installed invocation.
   The maintenance guide explains the two copies, accepted license difference, checks, and public-first publication.
   No documentation claims the public package shipped before its commit is available remotely.
6. The public Skills commit is published before Core records its final submodule revision. Confirm that revision is
   fetchable from `RunWield/skills`; then retain the matching sync baseline and gitlink in Core. Use the existing delivery
   workflow and repository permissions. Do not change unrelated Skills or publish a RunWield release as part of this Plan.

## Approval Confirmation

No Work Record supersession is proposed. Approval covers the coordinated change to the public Skills repository and
its pinned Core revision, not a new RunWield release.

## Verification Plan

Use Bun 1.4.3 and run `bun run install:locked` before checks.

- `bun scripts/run-tests.js scripts/check-skill-sync.test.ts src/shared/session/skill-catalog.test.ts` — proves public
  inventory, portable wording, actual bundled selection and invocation, and full-content parity. Existing Review,
  custom-layer precedence, external-name protection, and disabled-external-skill scenarios must remain protected.
- `bun run skills:sync:check` — requires the new public package, manifest entry, and accepted baseline to agree.
- `bun run compile:bun .ci-cache/write-tests-package/wld`, then
  `bun run check:package:bun .ci-cache/write-tests-package/wld` — proves the final compiled executable can extract and
  invoke Write Tests in a clean HOME. On macOS the child cannot read the checkout; the verifier can read expected bytes.
- Demonstrate sensitivity in disposable copies/builds: change only the public instruction body and confirm parity fails;
  omit `write-tests` from the packaged runtime assets and confirm the compiled `skills` check fails. Restore the correct
  inputs and rerun the affected checks. Do not mutate the owner's working files for these negative checks.
- Inspect the published Skills commit through a fresh standalone checkout. Run
  `npx skills@latest add RunWield/skills --list` and confirm `write-tests` is offered. Install just `write-tests` into a
  disposable project with the supported agent/scope options shown by that CLI, then compare its installed instructions
  and confirm no Core checkout is required. Do not alter personal agent installations.
- Run `bun run submodules:check` and `bun run submodules:check:remote` after public publication and Core gitlink update.
  Confirm the exact public revision is fetchable. If remote access is unavailable, report publication as pending, not done.
- Review the delivered instructions against the existing “Test authoring earns its coverage” requirement and scenarios.
  Confirm the PRD and maintenance references describe the same two distribution paths. No existing behavior is retired.

## Edge Cases & Considerations

- **Two repositories:** a Core-only commit cannot publish a public Skill. Publish the dependency first; never leave Core
  pinned to an unreachable commit.
- **Baseline acceptance is not parity:** accepting hashes can bless divergent copies. The independent content comparison
  must continue to fail when either copy differs outside the one license-path adjustment.
- **Current source is authoritative for the initial copy:** use the repository's current instructions, not an older
  locally installed Skill under the maintainer's HOME.
- **Portable copy also installed locally:** preserve catalog rules. An `.agents` copy must not replace the bundled name;
  intentional `.wld` overrides still work.
- **Platform limits:** checkout-read denial is available in the existing macOS package fixture. Other platforms still
  relocate the binary and use a clean HOME; do not claim they enforce the same filesystem denial.
- **Reviewable assumption:** maintain Write Tests like Review, with a standalone public baseline entry and an explicit
  parity test. This avoids changing the sync schema or introducing a new generation step.
