---
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "formal/publication/publication.fizz"
    - "formal/README.md"
    - "formal/fizzbee-release.json"
    - "scripts/check-formal-models.ts"
    - ".github/workflows/pr.yml"
    - "package.json"
    - "packages/workflow/publication-machine.ts"
    - "packages/workflow/publication-attempt.ts"
    - "packages/workflow/publication-format/index.ts"
    - "src/shared/isolated-publication.ts"
    - "src/shared/worktree-registry.ts"
    - "src/shared/workflow/validation-publication.ts"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-11-27"
status: "draft"
executionAgent: "engineer"
collaborationRecommendation: "pair"
planId: "a8d54ab1-a343-4f00-8b58-bcb2c16a54c0"
---

# Formal Model of the Publication State Machine

## Context

RunWield promises that delivery ends in only two ways: confirmed publication or deliberate user abandonment. A crash,
retry, or concurrent writer must never lose work, report delivery without proof, or repeat a proven effect. The
[Workflow completion and automatic recovery](../prd/runwield-core-prd.md#workflow-completion-and-automatic-recovery)
and [Delivery and publication](../prd/runwield-core-prd.md#delivery-and-publication) capabilities own these
requirements. [ADR-015](../adr/015-proof-bearing-publication-state-machine.md) defines the design.

Example-based tests cover one crash per run at 12 fixed boundaries
(`src/shared/workflow/publication-machine-local.e2e.test.ts`, `publication-machine-remote.e2e.test.ts`) plus a failure
matrix. They do not explore two crashes, crashes combined with a moving target branch, or two publishers combined
with a crash. A model checker explores all of those interleavings within small bounds.

A code read during planning found four suspected gaps. They are inferred from the code and are not confirmed:

1. **Local mode writes the effect before the record.** `refs/heads/<target>` moves before `target_integrated` is
   recorded. After a crash there, the re-run records the post-merge head as `targetBaseCommit`, but ADR-015 requires
   the true pre-merge base.
2. **Revalidation after a local merge.** `preparePublicationRevalidation` treats `artifacts_committed` as safe to
   reset. In local mode, the target can already contain the work at that phase.
3. **No replay guard on the legacy path.** At `target_published`, a failed proof does not throw. `publishOnce` can
   then run the merge or push again.
4. **Upstream is not frozen at `target_integrated`.** `upstreamRemote` and `upstreamBranch` are recorded only at
   `target_published`.

This Plan is a time-boxed trial. It builds one model, checks it, and records a go/stop decision. The work starts after
the December 4 demo and must not displace the package refactor.

> [!NOTE]
> **No JVM**
>
> The owner rejected TLA+ tooling (TLC, Apalache) because it needs the JVM. FizzBee ships as a prebuilt binary for
> macOS and Linux with a Go model checker and a bundled Python parser. Nothing in this Plan may add a Java dependency.

## Objective

Add an executable FizzBee model of RunWield's publication phase machine. Check it in CI on every pull request with
small bounds. Record what the checker finds about gaps 1–4 and any new gaps.

Success means one of these, written down with evidence:

- **Go:** the checker found at least one real gap, or the owner judges that the model adds confidence worth its upkeep.
  Follow-up Plans fix the gaps and extend the model.
- **Stop:** the model found nothing and costs more than it returns. The model and CI job are removed in a follow-up.

## Approach

Model the phase machine at the level of durable facts. Do not model TypeScript control flow. Each model action
names, in a comment, the source function it abstracts. That keeps drift visible, and `affectedPaths` warns when a Plan
changes those files.

**Variant scope**

```wld-question
{
  "id": "model-variant",
  "type": "multiple_choice",
  "prompt": "Which publication variant should the first model cover? The home-package path is the default for users. The legacy repository path is the fallback and holds suspected gap 3.",
  "choices": [
    { "value": "package-and-legacy-local", "label": "Local mode, home-package and legacy paths (one flag switches the replay guard)" },
    { "value": "package-local", "label": "Local mode, home-package path only" },
    { "value": "legacy-local", "label": "Local mode, legacy path only" },
    { "value": "package-and-legacy-local-and-remote", "label": "Local and remote modes, both paths (larger, about 2 more days)" }
  ],
  "default": "package-and-legacy-local"
}
```

Remote mode and managed-remote proof stay out of the first model unless the answer above includes them.

**State the model holds**

```text
registry record   phase, revision, evidence fields (validatedCommit, artifactCommit,
                  targetBaseCommit, integrationCommit, publishedCommit), failure, revalidation
git               execution branch head, local target ref, delivery ref
                  refs/runwield/deliveries/<attemptId>, target checkout dirty flag
controller        publicationReceipt, verifiedAt
filesystem        execution worktree present, publicationRoot present
plan              public status (implemented | reviewed | verified)
```

Commits are abstract tokens with parent links, which is enough to answer "is X an ancestor of the target".

**Actions**

```text
publisher(p)   seal, commitArtifacts, integrate, publish, verify, cleanup steps 1-8
               each step = Git effect, then registry write (CAS on revision), in source order
reconcile(p)   advance only when the modeled Git proof exists (mirrors reconcileStoredPublication)
crash(p)       FizzBee fault injection: any process may stop between any two writes
restart(p)     a fresh process runs reconcile, then publishOnce
environment    another commit lands on the target; source changes (revalidation request);
               user dirties the target checkout
```

Bounds for the pull-request run: 2 publishers, 1 attempt, at most 2 crashes, at most 1 target advance, at most 1
source change. A deeper configuration runs on demand.

**Properties**

| Property                  | Kind     | Checks                                                                                                                                         |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `NoDeliveryWithoutProof`  | safety   | `verifiedAt` or a receipt exists ⇒ the target contains `integrationCommit` with finalized metadata                                             |
| `PhaseMonotonic`          | safety   | the recorded phase never moves backward                                                                                                        |
| `NoDuplicateIntegration`  | safety   | the target never holds two merges of the same candidate                                                                                        |
| `NoReplayAfterProof`      | safety   | after `target_published` is recorded, no merge or push effect runs for that attempt (gap 3)                                                    |
| `RecordedBaseIsPreMerge`  | safety   | `targetBaseCommit` never contains the candidate (gap 1)                                                                                        |
| `NoResetAfterIntegration` | safety   | the Plan never returns to `implemented` while the target contains the candidate (gap 2)                                                        |
| `EvidenceBeforeCleanup`   | safety   | worktree or branch removed ⇒ receipt and delivery ref exist                                                                                    |
| `UserWorkKept`            | safety   | a dirty target checkout never has its ref moved                                                                                                |
| `EventuallySettles`       | liveness | with fair restarts and no further environment events, the attempt reaches `cleanup_complete` or a user-decision pause (dirty target, conflict) |

Gap 4 needs remote mode. It is checked only if the variant answer includes remote.

**Proving the model can fail**

A model that cannot fail proves nothing. The check script also runs named mutants. Each mutant removes one guard, and
the checker must report the named property:

| Mutant                   | Guard removed                | Must violate                                 |
| ------------------------ | ---------------------------- | -------------------------------------------- |
| `no-cas`                 | registry revision check      | `PhaseMonotonic` or `NoDuplicateIntegration` |
| `cleanup-before-receipt` | receipt write before removal | `EvidenceBeforeCleanup`                      |
| `advance-without-proof`  | Git proof check in reconcile | `NoDeliveryWithoutProof`                     |
| `ignore-dirty-target`    | dirty checkout pause         | `UserWorkKept`                               |

**Findings and fixes**

```wld-question
{
  "id": "findings-scope",
  "type": "multiple_choice",
  "prompt": "When the checker confirms a gap, what does this Plan deliver for it?",
  "choices": [
    { "value": "findings-only", "label": "Findings only: counterexample trace and a check against source. Fixes go to follow-up Plans." },
    { "value": "findings-and-repro", "label": "Findings plus a real-Git reproduction test per confirmed gap, marked as a known failure" },
    { "value": "findings-and-fix", "label": "Findings plus fixes in this Plan (larger, unbounded)" }
  ],
  "default": "findings-only"
}
```

Until answered, a property that the current-code model violates is kept as a **known violation**. The check script
expects that violation and passes. Then CI stays green, and a fix that resolves the gap makes the script fail until the
property moves to the enforced list. This keeps findings visible without blocking unrelated pull requests.

**Tool pinning and CI**

- `formal/fizzbee-release.json` pins the FizzBee release tag and the SHA-256 checksums of the Linux x64 and macOS arm64
  archives.
- `scripts/check-formal-models.ts` finds `fizz` (the `FIZZ` environment variable, then `PATH`) and runs the model,
  the mutants, and the known-violation checks. It prints state count and wall time.
- A new `formal-models` job in `.github/workflows/pr.yml` downloads the pinned archive, verifies the checksum, caches it
  the same way the Snip binary is cached, and runs `bun run check:formal`.
- `bun run ci` does not run the model. Developers without FizzBee are not blocked.

Option set aside: fast-check model-based tests against the TypeScript. They check the real code but only sample, and
FizzBee's own model-based testing needs Go adapters. Add them in a follow-up if the result is Go.

## Expected Change Surface

This list is guidance, not an allowlist: verify the real footprint during implementation and change whatever the
Implementation Steps need, including files not named here. Stop and report only when discovery changes approved
intent — the change reaches another subsystem, public behavior or architecture shifts, migration or compatibility risk
grows, or the Verification Plan no longer proves the objective.

```text
formal/
├── README.md                  # what is modeled, how to run, bounds, findings, go/stop decision
├── fizzbee-release.json       # pinned release tag and archive checksums
└── publication/
    └── publication.fizz       # the model, properties, and mutant markers
scripts/
├── check-formal-models.ts     # runs model, mutants, known violations; reports time and states
└── check-formal-models.test.ts
```

- `package.json` — adds `check:formal`.
- `.github/workflows/pr.yml` — adds the `formal-models` job.
- `scripts/ci-policy.test.ts` or related CI policy files — only if they enforce the workflow job list.
- Publication source files in `affectedPaths` are **read, not changed**. They are listed so drift warnings fire when a
  later Plan changes the behavior the model describes.

No PRD, ADR, or glossary changes. This Plan adds an internal check and does not change product behavior. If the result
is Go, the follow-up Plan adds a reference from ADR-015 to the model.

## Reuse Opportunities

- `.github/workflows/pr.yml` "Restore Snip binary" step — the pattern for caching a pinned external binary.
- `scripts/script-process.ts` `captureScriptProcess` — for running `fizz` from the check script.
- `src/shared/workflow/publication-machine-test-helpers.ts` `CRASH_BOUNDARIES` — the 12 crash boundaries. Every
  boundary must map to a crash point in the model.
- `packages/workflow/publication-runtime.ts` `EFFECT_FIELDS` — which evidence each phase writes.

## Implementation Steps

- `formal/fizzbee-release.json` names one FizzBee release tag and the SHA-256 checksum of its Linux x64 and macOS arm64
  archives. The checksums match the published archives.
- `formal/publication/publication.fizz` models the variant chosen in `model-variant`. It holds the state, actions,
  and environment events listed in Approach. Each action has a comment that names the source function it abstracts.
- Each of the 12 `CRASH_BOUNDARIES` in `src/shared/workflow/publication-machine-test-helpers.ts` maps to a crash point
  in the model. `formal/README.md` has a table of that mapping.
- The model's registry write refuses a stale revision, as `updatePublication` in `src/shared/worktree-registry.ts`
  does, and two publishers can race on it.
- The local-mode integrate action moves the target ref before the registry write, as `publishToLocalTarget` does today.
- The model defines every property in the Approach table. Liveness uses fairness on restart only.
- Each mutant in the Approach table is defined in the model, switched by a marker that the check script enables. With
  the mutant enabled, the checker reports the named property.
- `scripts/check-formal-models.ts` exits non-zero when: an enforced property fails on the unmutated model, a mutant
  passes, a known violation no longer occurs, `fizz` is missing, or the pull-request configuration exceeds 120 seconds.
  It prints the property results, state count, and wall time.
- `scripts/check-formal-models.test.ts` covers the exit rules above with a stub `fizz` executable. It fails if the
  script treats a passing mutant or a vanished known violation as success.
- `package.json` has `check:formal`, which runs `scripts/check-formal-models.ts` through the pinned Bun launcher.
- `.github/workflows/pr.yml` has a `formal-models` job. It installs the pinned FizzBee archive after a checksum check,
  caches it by tag, and runs `bun run check:formal`. It installs no Java.
- `formal/README.md` lists, for gaps 1–4 and for any new counterexample: confirmed or refuted, the shortened trace, and
  the matching source lines. It records the pull-request bound run time, and a Go or Stop recommendation with reasons.

## Verification Plan

- Automated:
    - `./scripts/with-bun.sh run check:formal` passes. Its output shows every enforced property holding, every mutant
      failing with its named property, and each known violation still occurring.
    - `./scripts/with-bun.sh scripts/run-tests.ts scripts/check-formal-models.test.ts` passes.
- Discrimination:
    - Each mutant proves that its property can fail. A model with no real guards, or a property that is always true,
      makes a mutant pass and fails the script.
    - Disable the CAS check by hand in the model. `PhaseMonotonic` or `NoDuplicateIntegration` must fail.
- Manual:
    - Read the README crash-boundary table against `CRASH_BOUNDARIES`. Every boundary has a crash point.
    - For each confirmed gap, follow the trace in the README against the named source lines. The trace must be possible
      in the real code, not only in the model.
    - Run the `formal-models` job on a pull request. It finishes, runs no Java, and the pull-request bounds finish under
      120 seconds.
- Existing behavior: no source behavior changes. The existing publication crash tests and failure matrix stay as they
  are and must still pass.

## Edge Cases & Considerations

- **Model drift.** The model can diverge from the code after later changes. Mitigation: per-action source comments,
  `affectedPaths` drift warnings, and the crash-boundary table.
- **False counterexamples.** An abstraction can allow a trace the real code cannot take. Mitigation: confirm each
  counterexample against source before calling it a gap; record refuted ones with the reason.
- **State explosion.** Larger bounds can run for a long time. Mitigation: the pull-request configuration has a 120-second
  limit; deeper runs are manual.
- **FizzBee maturity.** The project is young and has a small community. Mitigation: the trial is time-boxed and the Stop
  decision removes it cleanly. The prebuilt archive bundles Python; the CI job must confirm it runs without a separate
  Python install, or add one.
- **macOS quarantine.** A browser-downloaded binary can trigger Gatekeeper warnings. Mitigation: the README documents
  the `curl` install or `brew install fizzbee`.
- **Assumption:** the model is not part of `bun run ci`, so local full-gate runs do not need FizzBee.
- **Assumption:** about 3–5 days for local mode on both paths. Remote mode adds about 2 days.
