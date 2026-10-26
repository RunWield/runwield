# Manual QA for reviewer-benchmark-discovery-pairs

This checklist is advisory. It does not change RunWield verification status.

<!-- runwield:manual-qa:start child="reviewer-benchmark-discovery-pairs/01-corpus-selection-oracle-verdicts-and-edge-case-fixtures" -->

## Corpus Selection, Oracle Verdicts, and Edge-Case Fixtures

Manual verification steps for reviewer-benchmark-discovery-pairs/01-corpus-selection-oracle-verdicts-and-edge-case-fixtures

- [ ] Read the four new Plans in `evals/reviewer/RV-D01/source/docs/plans/`, `RV-D02/source/docs/plans/`, `RV-D03/source/docs/plans/`, and `RV-D06/source/docs/plans/`. Confirm that none names the planted defect or its fix.
- [ ] Open a scored fixture run's `summary.md`. Confirm that each case shows the oracle details next to the Reviewer's findings, and that excluded cases appear in the "Fixtures needing repair" section.

<!-- runwield:manual-qa:end child="reviewer-benchmark-discovery-pairs/01-corpus-selection-oracle-verdicts-and-edge-case-fixtures" -->

<!-- runwield:manual-qa:start child="reviewer-benchmark-discovery-pairs/02-lifecycle-process-and-publication-fixtures" -->

## Lifecycle, Process, and Publication Fixtures

Manual verification steps for reviewer-benchmark-discovery-pairs/02-lifecycle-process-and-publication-fixtures

- [ ] Read the approved Plan in each fixture. Confirm that it does not name the planted defect or its fix.
- [ ] Review `evals/reviewer/README.md`. Confirm that it lists RV-D07–RV-D10 and states the POSIX and `git` requirements.
- [ ] Review `docs/evaluation/reviewer-benchmark-pilot-corpus.md`. Confirm that RV-D07–RV-D10 are shown as materialized.

<!-- runwield:manual-qa:end child="reviewer-benchmark-discovery-pairs/02-lifecycle-process-and-publication-fixtures" -->

<!-- runwield:manual-qa:start child="reviewer-benchmark-discovery-pairs/03-context-fixtures-and-full-discovery-run" -->

## Context Fixtures and the Full Discovery Run

Manual verification steps for reviewer-benchmark-discovery-pairs/03-context-fixtures-and-full-discovery-run

- [ ] Review the report in code review. Confirm it lists results and worksheets for all 33 cases and is marked pending adjudication.
- [ ] For each case, decide if the defect is real and the clean twin is clean. Label each blocking finding as matched, duplicate, unsupported, or novel_valid.
- [ ] Confirm the Engineer records oracle verdicts and finding labels in `adjudications.json`, scores again, and updates the report.
- [ ] Confirm the updated report lists excluded cases under fixtures needing repair and shows semantic scores as scored when every counted case has a label.

<!-- runwield:manual-qa:end child="reviewer-benchmark-discovery-pairs/03-context-fixtures-and-full-discovery-run" -->
