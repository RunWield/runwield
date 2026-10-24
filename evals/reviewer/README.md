# Reviewer fixtures

These synthetic Bun 1.4.3 projects define 17 discovery cases in nine packages. Mechanical admission runs before any
model calls. After the paid run, the owner judges each fixture's Plan, patch, proof, and oracle together with the
Reviewer's result. Fixture approval is not a pre-run requirement.

| Package | Plan                                                                                | Oracle                                                    | Candidate patches                                                      |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| RV-D01  | [Project digests](RV-D01/source/docs/plans/select-project-digests.md)               | [Empty selection](RV-D01/evaluation/oracle.yaml)          | [A](RV-D01/variants/defective.patch), [B](RV-D01/variants/clean.patch) |
| RV-D02  | [Receipt offers](RV-D02/source/docs/plans/configure-receipt-offers.md)              | [Explicit false](RV-D02/evaluation/oracle.yaml)           | [A](RV-D02/variants/defective.patch), [B](RV-D02/variants/clean.patch) |
| RV-D03  | [Accession export](RV-D03/source/docs/plans/export-all-accessions.md)               | [Empty cursor page](RV-D03/evaluation/oracle.yaml)        | [A](RV-D03/variants/defective.patch), [B](RV-D03/variants/clean.patch) |
| RV-D04  | [Summary cache](RV-D04/source/docs/plans/reuse-plan-summaries.md)                   | [Cache scope](RV-D04/evaluation/oracle.yaml)              | [A](RV-D04/variants/defective.patch), [B](RV-D04/variants/clean.patch) |
| RV-D05  | [Artifact removal](RV-D05/source/docs/plans/remove-archived-artifact.md)            | [Path containment](RV-D05/evaluation/oracle.yaml)         | [A](RV-D05/variants/defective.patch), [B](RV-D05/variants/clean.patch) |
| RV-D06  | [Shared board links](RV-D06/source/docs/plans/rename-through-board-links.md)        | [Verified authority](RV-D06/evaluation/oracle.yaml)       | [A](RV-D06/variants/defective.patch), [B](RV-D06/variants/clean.patch) |
| RV-D12  | [Registration coverage](RV-D12/source/docs/plans/cover-registration-persistence.md) | [Owned registry machinery](RV-D12/evaluation/oracle.yaml) | [A](RV-D12/variants/defective.patch), [B](RV-D12/variants/clean.patch) |
| RV-D13  | [Archive and listing](RV-D13/source/docs/plans/archive-and-list-plans.md)           | [Plan completion](RV-D13/evaluation/oracle.yaml)          | [A](RV-D13/variants/defective.patch), [B](RV-D13/variants/clean.patch) |
| RV-M01  | [Filtered pagination](RV-M01/source/docs/plans/configure-project-listing.md)        | [Two independent defects](RV-M01/evaluation/oracle.yaml)  | [A](RV-M01/variants/defective.patch)                                   |

## Package boundary

- `source/` is the baseline project. Each candidate has three to eight production modules, public assertion tests,
  configuration, architectural guidance, and an approved Plan.
- Each `variants/*.patch` applies to the baseline, not to another candidate. Apply exactly one.
- `scenario.yaml` records execution facts and its coverage `group`, not expected decisions. See the
  [manifest contract](../../docs/evaluation/reviewer-benchmark-fixtures.md#scenario-manifest).
- `evaluation/oracle.yaml` is hidden. `variants.A` rejects its named defects. Paired `variants.B` approves with an
  empty defects list. `proofs` maps proof ids to commands and expected assertion markers.
- `evaluation/proofs.ts` goes into `.verification/proofs.ts` in a **separate disposable verification tree only**.
  Add the oracle's `verification.packageScripts` there. Never put hidden files or script entries in a Reviewer project.
- RV-M01's hidden `evaluation/clean.patch` applies to the baseline. Its hidden `fix-*.patch` files apply after A. Their
  proof matrix checks that repairing either defect leaves the other reachable. None belongs in Reviewer context or history.

The public scripts use standalone assertions and require no installed dependencies. RV-D04 uses POSIX `mkfifo` to
coordinate a real filesystem read across refresh; admission therefore needs `mkfifo` on PATH. Run `bun run test` inside a
materialized fixture. RunWield's own test suite uses `bun scripts/run-tests.js`, not these package scripts.

## Fixture revisions after owner adjudication

The recorded October baseline evaluated revision 1. RV-D04, RV-D12, RV-D13, and RV-M01 are now revision 2; RV-D05
remains revision 1. RV-D01, RV-D02, RV-D03, and RV-D06 are new revision-1 packages. No paid Reviewer round has
evaluated revision 2 or the four new packages.

- RV-D04 isolates in-flight reads from later refreshes in both variants. The planted identity collision remains in A.
- RV-D12 has two independent oracle defects: `RV-D12-A` for replaceable owned machinery and
  `RV-D12-TEST-DURABILITY` for the success test that does not prove persistence. Both remain planted in A.
- RV-D13 selects archived records by directory, not timestamp. Both variants have filtered-list tests. A still ignores
  the flag, so its public suite must fail with the declared assertion; B must pass. Admission checks the actual
  `AssertionError` class and exact message in a separate external guard, not just a nonzero exit or matching log text.
- RV-M01 checks the actual continuation cursor in A and the hidden clean candidate. Its two planted production defects
  and independent repair proofs remain unchanged.

The [baseline report](../../docs/evaluation/reviewer-benchmark-results/2026-10-baseline-smoke.md) preserves the original
measurements and owner decisions. Its local `fixtures-revision-1/` archive retains the original fixture inputs. Changed
fixture hashes prevent resume against that run; scoring its saved records still needs no model call.

## Run and score

Use Bun 1.4.3 and install the repository dependencies with `bun run install:locked`. Run the whole admitted corpus:

```bash
bun scripts/run-reviewer-benchmark.ts run --scenarios all
```

This command spends model calls. It uses the effective configured Reviewer model and credentials.
Use `--model <provider/model>` to override the model. The default timeout is 120000 ms per case;
`--timeout-ms` overrides it. Every
selected package must pass admission before the first model turn. Projects live in neutral directories outside this
checkout. Hidden proofs run in separate copies.

Results go to `~/.wld/reviewer-eval/<run-id>/`, or `--out <directory>`. `run.json` records the selected cases, oracle
snapshot, fixture hashes, checkout identity, and prompt hashes. `results.jsonl` is flushed after each case. It preserves
accepted findings, advisories, actual usage, failure causes, and all attempts. Missing measurements say `unavailable`.

```bash
bun scripts/run-reviewer-benchmark.ts score /path/to/run
bun scripts/run-reviewer-benchmark.ts run --scenarios smoke --out /path/to/run --resume
```

Resume needs the same selection, configuration, fixtures, and timeout. It keeps completed cases, including wrong
decisions, and retries only unfinished cases. It does not overwrite previous attempts. The scorer uses the latest
attempt, never the best one. An unreadable or truncated journal stops resume instead of treating work as complete.

`--scenarios all` discovers packages under `evals/reviewer/` that contain `scenario.yaml`, sorted by scenario ID
then variant. A new package needs no runner registry entry. `--scenarios smoke` still selects the original nine cases:
RV-D04 A/B, RV-D05 A/B, RV-D12 A/B, RV-D13 A/B, and RV-M01 A. For a subset, use `--scenarios RV-D04,RV-D05` or
`--scenarios RV-D04/A,RV-D04/B`. Unknown cases fail before admission. The CLI supports one trial per case.

The planned 33-case discovery corpus is not yet delivered. Additional multi-defect fixtures, repair-state execution,
repetitions, and candidate comparison remain target.

### Human adjudication

Scoring writes `summary.md` and `summary.json`. In each case section, `summary.md` presents a readable worksheet
before the exact JSON record: package and patch paths; oracle defect ID, severity, trigger, expected and wrong
behavior, and proof command (or “Oracle: no defect”); blocking findings with zero-based `findingIndex` and suggested
path matches; and any oracle verdict and finding labels.

The owner judges fixture correctness together with the Reviewer's results after the run. An excluded case leaves
**every score**: decision accuracy, clean approval, variant/group splits, recall, precision, and severe-defect recall.
Other cases still score. Failed, timed-out, and missing cases remain in denominators unless excluded. Group splits
use the manifest's coverage group. Path matches are **suggestions only**, never semantic credit.

Put human labels in the run directory's `adjudications.json`, then run `score` again. For example:

```json
{
    "schemaVersion": 1,
    "runId": "replace-with-the-saved-run-id",
    "oracleVerdicts": [
        { "caseId": "RV-D04/A", "verdict": "confirmed" },
        {
            "caseId": "RV-D04/B",
            "verdict": "fixture_needs_repair",
            "note": "Replace with the reason this fixture needs repair."
        }
    ],
    "adjudications": [
        {
            "caseId": "RV-D04/A",
            "attempt": 1,
            "findingIndex": 0,
            "state": "matched",
            "defectId": "RV-D04-A"
        }
    ]
}
```

Use the case, attempt, and zero-based finding index from the report. `matched` earns one oracle match; `duplicate`
references an already matched defect and reduces precision. `unsupported` earns no match. `novel_valid` identifies a
real defect omitted by the oracle and excludes the entire case, not just that finding. It does not earn credit from a
path match. Advisories are not blocking findings and cannot receive these labels.

The optional `oracleVerdicts` list holds `{ caseId, verdict, note? }` entries. Use `confirmed` when the fixture's
oracle is correct or `fixture_needs_repair` when it is not. Either `fixture_needs_repair` or any `novel_valid` finding
excludes the case. `summary.json` lists its reasons under `fixturesNeedingRepair`; `summary.md` lists them under
“Fixtures needing repair.” Reasons include the owner's note (or a default reason) and the indexes of `novel_valid`
findings. Repair the fixture, then run the revised fixture again; relabeling the old output is not a replacement.

Semantic status is `pending adjudication` while any counted case lacks an oracle verdict or any blocking finding in a
counted case lacks a label; otherwise it is `scored`. Older files without `oracleVerdicts` remain valid but pending.
Unknown cases, duplicate verdicts, unknown verdict values, a `confirmed` verdict with a `novel_valid` finding, and
invalid or stale finding labels stop scoring.

Run the runner's tests without model spending:

```bash
bun scripts/run-tests.js scripts/reviewer-benchmark
```

## Manual proof check

Use fresh temporary directories outside the RunWield checkout. Copy `source/`, initialize Git with neutral baseline
history, and apply the selected patch with `git apply --check` followed by `git apply`. Run the public suite and compare its result with the declared variant outcome. RV-D13 A intentionally fails its
filtered-list assertion; other public suites pass. Before any
hidden copy, inspect the candidate tree and history: neither may contain scenario labels, oracles, hidden scripts, or
fixing patches.

Copy that public project to a separate verification directory. Copy the hidden proof file and add its package script
as described above. Run each proof command separately. A must fail with its exact assertion marker, not a syntax,
import, or infrastructure error. B must pass the same command. For RV-M01, use its hidden clean and partial repairs.

| Package | Proof ids                                    | A                 | B or hidden clean |
| ------- | -------------------------------------------- | ----------------- | ----------------- |
| RV-D01  | `empty-selection`                            | Assertion failure | Pass              |
| RV-D02  | `disabled-offers`                            | Assertion failure | Pass              |
| RV-D03  | `empty-middle-page`                          | Assertion failure | Pass              |
| RV-D04  | `project-scope`, `owner-scope`, `plan-scope` | Assertion failure | Pass              |
| RV-D05  | `prefix-sibling`                             | Assertion failure | Pass              |
| RV-D06  | `role-promotion`                             | Assertion failure | Pass              |
| RV-D12  | `seam-check`, `mutation-coverage`            | Assertion failure | Pass              |
| RV-D13  | `archived-list`                              | Assertion failure | Pass              |
| RV-M01  | `explicit-false`, `empty-cursor-page`        | Assertion failure | Pass              |

RV-D12's mutation proof removes the durable rename in another disposable copy and runs its public suite. A's tests
miss the missing write, so the proof fails. B's real fixture detects the missing write, so the proof passes.
