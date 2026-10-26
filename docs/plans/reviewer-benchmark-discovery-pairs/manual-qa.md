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
