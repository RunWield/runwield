# Reviewer baseline smoke — 2026-10-23

## Result

Nine production Reviewer rounds completed, one trial per case. No round was repeated.

- Decision accuracy against the stored oracle: **7/9**.
- Defective variants rejected: **5/5**.
- Clean-twin approvals: **2/4**.
- Protocol: 9 complete; 0 paused, failed, timed out, or missing; 0 nudges.
- Blocking findings: 13. The owner accepted all 13 after the walkthrough below.
- Saved labels: six existing oracle matches and seven `novel_valid` findings. The original oracle bundled both RV-D12
  concerns; revision 2 gives them separate identities instead of counting the second finding as a duplicate.
- The saved revision-1 scorer reports **oracle correction required**. No revised precision or recall is claimed.

These are mechanical decision scores, not adjudicated finding-quality scores. A rejection of an oracle-clean twin is
not automatically an unsupported finding: the oracle may have omitted a defect. One trial cannot establish stability,
a prompt improvement, or a model support decision. No pass threshold applies.

## Configuration and method

- Run id: `2026-10-23T14-50-34-259Z-eaf644f1`.
- Run date: 2026-10-23. Manifest created `2026-10-23T14:50:36.723Z`; last result `2026-10-23T14:57:44.791Z`.
- Actual model/provider in all nine records: `gpt-6-astra` / `openai-codex`.
- Effective thinking level: `high`. No explicit temperature override was captured.
- Bun: `1.4.3`.
- RunWield revision: `19669e4f1259cf673fe8079ce553ed73f932f814`; dirty: `true`.
- The checkout included uncommitted runner and fixture changes. Revision alone does not identify the full evaluated state.
- Configuration: current discovery prompt, round 1, empty ledger; no reconnaissance candidate.
- Per-case timeout: `120000` ms. All five packages passed admission before the first model turn.
- Each case used an independent external temporary Git project, neutral `main` history, and a `change` branch.
- Production `runReviewerRound`, tools, inspection gate, nudges, and `review_complete` were used. Outer workflow lifecycle
  and Delivery Evidence writes were not invoked.
- Hidden oracles and proofs stayed outside Reviewer projects. Guessed absolute reads into the checkout are not sandboxed.

### Prompt SHA-256

- `src/agent-definitions/subagent-definitions/reviewer-prompt.md`: `81eac63569de584c0f448e3eecceb4500c2a223349726c07a4043c921067aa6e`.
- `src/agent-definitions/subagent-definitions/reviewer-verify-prompt.md`: `158c4fe66d740ee3b17a43f056dd95eaa0e155e61035ae7a392748f5fb069596`.
- `src/agent-definitions/shared-practice/review-practice.md`: `28553494b81ac8b51b18c72ce137060479ecaa9a3c03266bd54b7ed5dcc872af`.

### Fixture identity

All fixture revisions are `1`. Fingerprints cover source, candidate patches, and hidden verification inputs.

| Package | SHA-256                                                            |
| ------- | ------------------------------------------------------------------ |
| RV-D04  | `7719a077db2a96a5d7b3e4f105a6ada131970fb7bbe762129685fc0bfef1ec58` |
| RV-D05  | `a7396855141ca7b801b09f4ebae996b1ddcc7cae3765fa64284e205e72720ddb` |
| RV-D12  | `bfe47763b1447d8b7831fc1f7637cba461e31a4d3105f65897d8acb4eee5a393` |
| RV-D13  | `2f83ed20e2c33c5f3f7bdf130c8391e19c413af44e391039541c68d45273968b` |
| RV-M01  | `173326bd28658df96acc56f05fbce117c8adb500093c00b869d0f9bbb127d2b0` |

## Mechanical decisions

| Case     | Expected | Observed | Status   | Blocking findings |
| -------- | -------- | -------- | -------- | ----------------- |
| RV-D04/A | reject   | reject   | complete | 2                 |
| RV-D04/B | approve  | reject   | complete | 1                 |
| RV-D05/A | reject   | reject   | complete | 1                 |
| RV-D05/B | approve  | approve  | complete | 0                 |
| RV-D12/A | reject   | reject   | complete | 2                 |
| RV-D12/B | approve  | approve  | complete | 0                 |
| RV-D13/A | reject   | reject   | complete | 2                 |
| RV-D13/B | approve  | reject   | complete | 2                 |
| RV-M01/A | reject   | reject   | complete | 3                 |

### Variant and group splits

| Split                   | Decision accuracy | Clean approval    |
| ----------------------- | ----------------- | ----------------- |
| Variant A               | 5/5               | unavailable (0/0) |
| Variant B               | 2/4               | 2/4               |
| correctness-beyond-plan | 1/2               | 0/1               |
| plan-named-edge-case    | 2/2               | 1/1               |
| architecture            | 2/2               | 1/1               |
| plan-adherence          | 1/2               | 0/1               |
| multiple-defects        | 1/1               | unavailable (0/0) |

Semantic scores remain frozen against the original oracle in every group. The current oracle has six defects, including three high/critical
defects. No matched-defect count or false-positive rate is inferred from path overlap.

### Coverage metadata correction

After execution, RV-D05 A/B were moved from `correctness-beyond-plan` to `plan-named-edge-case`. Their Plan explicitly
requires path containment. The runner mapping and regression coverage were corrected. Only the two group fields in
the local manifest changed; the original is retained as `run.before-group-correction.json`. No oracle, model output,
trial, or result-journal byte changed. The tables above use the corrected groups.

- `run.before-group-correction.json` SHA-256: `9b51006f6689ec09a0357116dc1f5daaaa8aefc71bcd969a8f71a4868ca54a51`.
- `run.json` SHA-256: `10e538452c8e775568e9ba6df3bf0332aa31de95c3699de449d6c6987e8d0aad`.
- `results.jsonl` SHA-256: `bb9c4790fc0a04cc127d42d5763cc809b3c22c0e116ba233d1f690edeea9d5d0`.

## Measured usage

These values come from the production metrics journal. Token columns remain separate; they are not estimates.
Elapsed seconds are the recorded case elapsed times rounded to two decimal places, not total batch wall time.

| Case     | Input | Output | Cache read | Cache write | Tools | Elapsed, s | Nudges |
| -------- | ----- | ------ | ---------- | ----------- | ----- | ---------- | ------ |
| RV-D04/A | 15462 | 778    | 62592      | 0           | 13    | 53.17      | 0      |
| RV-D04/B | 8579  | 648    | 69248      | 0           | 13    | 57.82      | 0      |
| RV-D05/A | 9786  | 562    | 86784      | 0           | 15    | 45.67      | 0      |
| RV-D05/B | 9074  | 486    | 72576      | 0           | 13    | 49.73      | 0      |
| RV-D12/A | 12026 | 590    | 77952      | 0           | 14    | 47.89      | 0      |
| RV-D12/B | 7811  | 394    | 26496      | 0           | 11    | 22.40      | 0      |
| RV-D13/A | 9690  | 576    | 75008      | 0           | 13    | 48.27      | 0      |
| RV-D13/B | 16007 | 730    | 46720      | 0           | 14    | 44.89      | 0      |
| RV-M01/A | 9812  | 768    | 67456      | 0           | 13    | 56.77      | 0      |
| Total    | 98247 | 5532   | 584832     | 0           | 119   | 426.61     | 0      |

## Owner adjudication and fixture repairs

The owner accepted the cache refresh bug, archive membership bug, missing filtered-list tests, independent registry
architecture and durability-test concerns, and weak cursor assertion. RV-D05's planted path defect was acknowledged.
The local `adjudications.json` records these decisions without changing any accepted Reviewer text or result-journal
byte. All six original planted defects have matched findings. The other seven finding records require corrections to
the original oracle snapshot; they are not automatically scored as duplicate or unsupported feedback.

Current fixtures correct the unplanted defects. RV-D04, RV-D12, RV-D13, and RV-M01 are revision 2; RV-D05 stays at
revision 1. See the [repair details](../../../evals/reviewer/README.md#fixture-revisions-after-owner-adjudication).
RV-D13 A now fails its public filtered-list assertion, so a future run has different visible validation evidence.
No new paid rounds have run. The local `fixtures-revision-1/` archive retains the exact original packages.

The tables and hashes above describe the original run, not the repaired fixtures. Do not combine revision-2 source
with revision-1 observations or interpret the historical clean-twin rejections as unsupported findings.

## Accepted findings

All references below use attempt `1` and a **zero-based** finding index. Titles, requirements, and evidence are the
accepted Reviewer text. The owner accepted their substance after the contextual walkthrough. Suggested ids come only from evidence-path overlap and earn no recall.

Run id for `adjudications.json`: `2026-10-23T14-50-34-259Z-eaf644f1`.

### Adjudication context

- RV-D04/A index 1 and RV-D04/B index 0 allege a refresh race, not the seeded cache-key defect. The former receives a
  path suggestion despite its different claim. Assess it independently; do not accept the suggestion as a match.
- RV-D13/B index 0 challenges use of timestamp metadata to identify archive membership. This has no oracle match.
- The test-coverage findings need separate causal review. Decide whether each is a supported independent defect, a
  duplicate, or unsupported. Do not assume that a missing test alone proves a product defect.
- If any finding is `novel_valid`, correct the oracle before semantic scoring. Do not report clean rejections as noise
  or claim precision while these decisions remain open.

### RV-D04/A

#### Index 0: The cache uses a display name instead of the repository identity

Suggested oracle ids: `RV-D04-A`. Human state: accepted; `matched`.

**Requirement:** Keep repository contracts and displayed titles unchanged. AGENTS.md requires stable identities separate from presentation labels.

**Evidence:** src/browser.ts, load(): `const key = ref.name` merges different records that share a name. PlanRepository identifies records by [projectId, ownerId, planId]. After loading one record, loading another record with the same name returns the first record's title and summary without reading the second record. A name change also bypasses the cached snapshot for the same record.

#### Index 1: A pending read can restore stale data after refresh

Suggested oracle ids: `RV-D04-A`. Human state: accepted; `novel_valid` against the original oracle.

**Requirement:** A refresh starts a new view of the data, and the next read must use current repository content.

**Evidence:** src/browser.ts, load() and refresh(): load() awaits repository.read() and then writes to the same map that refresh() clears. If a pre-refresh read captured old content but completes after an edit and refresh, it restores that old summary to the cleared cache. The next load can then return stale content. Cache writes need to remain scoped to the refresh in which the read started.

### RV-D04/B

#### Index 0: A pending load can restore stale data after refresh

Suggested oracle ids: `none`. Human state: accepted; `novel_valid` against the original oracle.

**Requirement:** A refresh starts a new view of the data, and the next read must use current repository content.

**Evidence:** src/browser.ts: load() writes to this.summaries after awaiting repository.read(), while refresh() only clears the map. A read started before refresh can finish afterward and insert its old summary into the cleared cache. After an edit and refresh, a later load can then return that old summary without reading the repository. Cache writes must remain confined to the refresh interval in which the load started.

### RV-D05/A

#### Index 0: The containment check permits deletion outside the archive root

Suggested oracle ids: `RV-D05-A`. Human state: accepted; `matched`.

**Requirement:** Delete only a regular file beneath the root. Refuse paths outside it.

**Evidence:** src/archive.ts, removeArtifact: `target.startsWith(base)` checks a string prefix, not a directory boundary. With root `/tmp/archive` and requested path `../archive-backup/report.txt`, an existing regular file at `/tmp/archive-backup/report.txt` passes the check and is deleted by `unlink(target)`. The existing `containedFile` helper in src/paths.ts checks relative path boundaries correctly.

### RV-D12/A

#### Index 0: Registration now permits callers to replace persistence and locking

Suggested oracle ids: `RV-D12-A`. Human state: accepted; `matched`.

**Requirement:** Repository architectural policy forbids optional dependency bags, substitutable writes, and injected locks. Only the catalog is an external boundary here.

**Evidence:** src/register.ts:7-17 adds RegistrationDependencies and selects putEntry and withRegistryLock from the caller's optional bag. Callers can bypass both registry persistence and lock acquisition.

#### Index 1: The success test does not check durable registration

Suggested oracle ids: `RV-D12-A`. Human state: accepted; `novel_valid` against the original oracle.

**Requirement:** Approved step 2 requires durable state after reopening. The request requires a successful registration to be visible when the registry is opened again.

**Evidence:** tests/public.ts:52-64 replaces persistence with a no-op and locking with direct callback execution. It asserts only the returned entry and never reopens the registry. An implementation that returns the catalog entry without writing any registry data would pass this test. Use real registry operations and assert the saved entry through listRegistry after registration.

### RV-D13/A

#### Index 0: The archived-only list still returns active Plans

Suggested oracle ids: `RV-D13-A`. Human state: accepted; `matched`.

**Requirement:** Step 3 requires list --archived-only to return only archived Plans.

**Evidence:** src/commands.ts, runCommand list branch: parseListOptions returns options, but options is unused. listPlans(root) reads both active and archived areas, and the command returns all records.

#### Index 1: Tests do not cover the archived-only list

Suggested oracle ids: `none`. Human state: accepted; `novel_valid` against the original oracle.

**Requirement:** The validation deliverable requires coverage of list behavior, including the new archived-only mode.

**Evidence:** tests/public.ts adds move and archive-time tests, but no test calls list --archived-only. The existing list tests cover only unfiltered output. An implementation that ignores the new flag, as the current code does, passes these assertions. Add a real temporary catalog with both active and archived Plans and assert that the filtered result contains only archived Plans.

### RV-D13/B

#### Index 0: The archived-only list uses the timestamp instead of the storage area.

Suggested oracle ids: `none`. Human state: accepted; `novel_valid` against the original oracle.

**Requirement:** Step 3 requires list --archived-only to return only archived Plans. Steps 1 and 2 distinguish the archive location from its time metadata.

**Evidence:** src/commands.ts filters the combined list with record.archivedAt !== undefined. src/model.ts makes that field optional, and src/store.ts permits archived records without it. Such records are omitted. Active records with that field are included; archivePlan can also leave this state if rename fails after savePlan. Select records from plans/archived rather than infer their location from metadata.

#### Index 1: The tests do not cover list --archived-only.

Suggested oracle ids: `none`. Human state: accepted; `novel_valid` against the original oracle.

**Requirement:** The Plan requires tests with real temporary catalogs that cover list behavior, including the new archived-only option.

**Evidence:** tests/public.ts adds move and timestamp tests, but no test invokes list --archived-only. An implementation that ignores the option and always returns all Plans would pass the entire suite. Add a mixed-catalog assertion that the filtered list returns only archived Plans.

### RV-M01/A

#### Index 0: Explicit false does not disable the archive filter

Suggested oracle ids: `RV-M01-A`. Human state: accepted; `matched`.

**Requirement:** Step 1: Default filterEnabled to enabled only when absent; explicit false disables the filter.

**Evidence:** src/settings.ts, loadSettings: `configured.filterEnabled || true` returns true for false. Thus listProjects still removes archived projects when the caller disables the filter.

#### Index 1: An empty page stops collection even when a next cursor exists

Suggested oracle ids: `RV-M01-B`. Human state: accepted; `matched`.

**Requirement:** Step 2: Empty item arrays can have a next cursor; stop only when that cursor is absent.

**Evidence:** src/pagination.ts, collectProjects: `if (!page.items.length) break` stops before checking nextCursor. Projects on later pages are omitted, and a repeated cursor on an empty page is not rejected.

#### Index 2: The two-page test accepts an incorrect continuation cursor

Suggested oracle ids: `none`. Human state: accepted; `novel_valid` against the original oracle.

**Requirement:** Step 4 requires public coverage of normal cursor traversal. Changed tests must not accept a plausible wrong implementation of the behavior they cover.

**Evidence:** tests/public.ts, `listing collects ordinary continuation pages in order`: the fixture returns page two for every non-undefined cursor. An implementation that requests a hard-coded cursor instead of the returned `nextCursor` would pass. The fixture must check that the continuation request uses `two`.

## Advisories

RV-D05/B returned one non-blocking advisory. All other cases returned none. Advisories receive no blocking labels.

- **Containment checks are duplicated.** src/archive.ts repeats the path containment logic in src/paths.ts. Use one shared implementation to keep read and remove behavior consistent.

## Local artifacts and reproduction

Raw run files are local, not checked in: `~/.wld/reviewer-eval/2026-10-baseline-smoke-20261023T145033Z/`. They contain `run.json`, `results.jsonl`, `summary.json`, and
`summary.md`. The owner labels are saved in `adjudications.json`; original fixture inputs are in `fixtures-revision-1/`.

To score these saved results without model calls:

```bash
bun scripts/run-reviewer-benchmark.ts score "$HOME/.wld/reviewer-eval/2026-10-baseline-smoke-20261023T145033Z"
```

To create a new baseline (this spends model calls):

```bash
bun run install:locked
bun scripts/run-reviewer-benchmark.ts run --scenarios smoke --timeout-ms 120000
```

Do not repeat the measured baseline to select better outcomes. Use the [adjudication format](../../../evals/reviewer/README.md#human-adjudication)
for the saved label format. Current scoring retains the original oracle and correctly freezes semantic metrics; it does
not grade repaired fixtures using old model observations. The [scorecard](../reviewer-benchmark-scorecard.md) keeps the shared harness,
candidate comparison, repetitions, repair-state scenarios, and stability measures as target.
