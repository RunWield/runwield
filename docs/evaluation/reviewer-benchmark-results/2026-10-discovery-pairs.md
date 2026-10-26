# Reviewer discovery pairs — 2026-10-26

## Result

Status: **pending adjudication**.

All 33 production Reviewer rounds completed, one trial per case, across 17 admitted packages. No case was repeated.
Mechanical decision accuracy: **29/33**. Clean approval: **12/16**.
Blocking findings: 25. Semantic recall, precision, and severe-defect recall remain pending; path matches earn no credit.

One trial does not show stability, rate precision, a prompt improvement, or a model support decision. No pass threshold applies.
The nine smoke cases now include revision-2 fixtures (RV-D04, RV-D12, RV-D13, and RV-M01); RV-D05 remains revision 1.
They cannot be compared with the October revision-1 baseline as a trend. The historical baseline report is unchanged.

## Configuration and method

- Run ID: `2026-10-26T01-37-52-346Z-8ca841ae`.
- Local run directory: `/Users/gandazgul/.wld/reviewer-eval/2026-10-26T01-37-52-346Z-8ca841ae`.
- Manifest created: `2026-10-26T01:38:11.707Z`; last result: `2026-10-26T01:59:10.359Z`.
- Actual model/provider in the result records: `gpt-6-astra` / `openai-codex`.
- Effective thinking level: `high`; temperature: `no explicit override captured`.
- Bun: `1.4.3`.
- RunWield revision: `84937e3951e780e4008bf5650c3c441023aa7e12`; dirty: `true`.
- Uncommitted fixture and test changes were present. The revision alone does not identify the evaluated state; the fixture hashes below do.
- All 17 packages passed admission before the first model call. Timeout: 120000 ms per case.
- Production Reviewer discovery prompt, round 1, empty ledger, normal tools, inspection gate, nudges, and structured completion; no reconnaissance candidate.
- Each case used an independent external temporary Git project with neutral main history and one selected patch. Hidden proofs stayed in separate verification trees.
- Production Semantic Review was not changed. No outer workflow lifecycle or Delivery Evidence writes were invoked.
- Commands: `bun scripts/run-reviewer-benchmark.ts run --scenarios all`, then `bun scripts/run-reviewer-benchmark.ts score <run-dir>`.
- The scorer wrote `summary.md` and `summary.json` in the local run directory. No owner verdicts or labels have been inferred.

### Prompt SHA-256

- `src/agent-definitions/subagent-definitions/reviewer-prompt.md`: `81eac63569de584c0f448e3eecceb4500c2a223349726c07a4043c921067aa6e`.
- `src/agent-definitions/subagent-definitions/reviewer-verify-prompt.md`: `158c4fe66d740ee3b17a43f056dd95eaa0e155e61035ae7a392748f5fb069596`.
- `src/agent-definitions/shared-practice/review-practice.md`: `28553494b81ac8b51b18c72ce137060479ecaa9a3c03266bd54b7ed5dcc872af`.

### Saved artifact SHA-256

- `run.json`: `0c8c85799fc96bc6364f68f09e9a9a74daf75ea90b79d3add7e976ede8067f5f`.
- `results.jsonl`: `7ab5b49d3e1922e61df82ecc7d1adec2774cfbd312fb165645a6b754025ddcc3`.
- `summary.md`: `15cbbf29d6df7f86b7fd73017987e08ecd03cae9880ae9987a85ca65ecf22449`.
- `summary.json`: `29c248908a75186cc31f62265bd74bbb4fdeb8b8a3aee613ad566fb855c30707`.

### Fixture identity

Hashes cover source, patches, and hidden verification inputs.

| Package | Revision | SHA-256                                                            |
| ------- | -------- | ------------------------------------------------------------------ |
| RV-D01  | 1        | `9b861c7ac4d6e0e5e9cd891361f303a78d545dcbbcce2a1ac9eea9aff0cd7e47` |
| RV-D02  | 1        | `63a47711941af4981a6a2427e1b4d810bd3250927ae5440ac82a4f2470668a3e` |
| RV-D03  | 1        | `9b31b2bb99e9e7b020cb465ab6f484a807e2261e39dc296d4a10aabf39c1f4c2` |
| RV-D04  | 2        | `32e443157204c66f6f448cdae2251aad56d05b71b13e557fc1894ceec7ecbfbe` |
| RV-D05  | 1        | `9895c8353248a358543cf5e4b198bab32790b2701da208846a5297f468acd10f` |
| RV-D06  | 1        | `9054c2bc0a0419dc3375c8d2014d3093a9e965f01c0673523f5bd3a38d626b80` |
| RV-D07  | 1        | `42ef209e42c145f6d4897eabb70cc396eed594a3efcfd8289ef2e381d085554c` |
| RV-D08  | 1        | `4ec3ff7726bf5f1db14ec97d361633ce30ddd33839c255d7b540933b32caca0e` |
| RV-D09  | 1        | `8984f49e77dd8ff88cadcf5f3dc6ae2d08eb5fa9f41e9b5a1fe83a01622a8389` |
| RV-D10  | 1        | `311190fc8e12e7b28e825e107dca4f0bc6fac589868e0e7e4c469db67d2d351e` |
| RV-D11  | 1        | `c4534a6722e503052b3c50e52ece9bd07bb037a703960cfc86e6e3d89fe4a7ab` |
| RV-D12  | 2        | `34fd0a9b76613d6ba44f7c860191395c50e41a0280f3e8cd563604e851d341c0` |
| RV-D13  | 2        | `a04f88ed779633e05e8858aebab1d0c6c783064be25ebd670e3195a42c139738` |
| RV-D14  | 1        | `7b2ed4d38baf3773efd7bccfcc71dee1358cf63cd70cd95d1c591116f62a19ae` |
| RV-D15  | 1        | `20a382a426b5433ddbf463958173f1970518b2b299dd3bd941cb39781405a65f` |
| RV-D16  | 1        | `6a5198b77cbdf4a89586959cda9574b6cb873f9c8531c9e849d857bcb5225937` |
| RV-M01  | 2        | `3e53c88e1135c92dea1a026114bf210cb8002c10a4487550c2c3bc8ecc2255ae` |

## Mechanical decisions

| Case     | Expected | Observed | Status   | Blocking findings |
| -------- | -------- | -------- | -------- | ----------------- |
| RV-D01/A | reject   | reject   | complete | 1                 |
| RV-D01/B | approve  | approve  | complete | 0                 |
| RV-D02/A | reject   | reject   | complete | 1                 |
| RV-D02/B | approve  | approve  | complete | 0                 |
| RV-D03/A | reject   | reject   | complete | 1                 |
| RV-D03/B | approve  | approve  | complete | 0                 |
| RV-D04/A | reject   | reject   | complete | 1                 |
| RV-D04/B | approve  | approve  | complete | 0                 |
| RV-D05/A | reject   | reject   | complete | 1                 |
| RV-D05/B | approve  | approve  | complete | 0                 |
| RV-D06/A | reject   | reject   | complete | 1                 |
| RV-D06/B | approve  | reject   | complete | 1                 |
| RV-D07/A | reject   | reject   | complete | 1                 |
| RV-D07/B | approve  | reject   | complete | 1                 |
| RV-D08/A | reject   | reject   | complete | 1                 |
| RV-D08/B | approve  | reject   | complete | 1                 |
| RV-D09/A | reject   | reject   | complete | 1                 |
| RV-D09/B | approve  | approve  | complete | 0                 |
| RV-D10/A | reject   | reject   | complete | 3                 |
| RV-D10/B | approve  | reject   | complete | 1                 |
| RV-D11/A | reject   | reject   | complete | 1                 |
| RV-D11/B | approve  | approve  | complete | 0                 |
| RV-D12/A | reject   | reject   | complete | 2                 |
| RV-D12/B | approve  | approve  | complete | 0                 |
| RV-D13/A | reject   | reject   | complete | 1                 |
| RV-D13/B | approve  | approve  | complete | 0                 |
| RV-D14/A | reject   | reject   | complete | 1                 |
| RV-D14/B | approve  | approve  | complete | 0                 |
| RV-D15/A | reject   | reject   | complete | 1                 |
| RV-D15/B | approve  | approve  | complete | 0                 |
| RV-D16/A | reject   | reject   | complete | 1                 |
| RV-D16/B | approve  | approve  | complete | 0                 |
| RV-M01/A | reject   | reject   | complete | 2                 |

### Variant and group splits

| Split                   | Decision accuracy | Clean approval    |
| ----------------------- | ----------------- | ----------------- |
| Variant A               | 17/17             | unavailable (0/0) |
| Variant B               | 12/16             | 12/16             |
| plan-named-edge-case    | 9/10              | 4/5               |
| correctness-beyond-plan | 9/12              | 3/6               |
| architecture            | 2/2               | 1/1               |
| plan-adherence          | 4/4               | 2/2               |
| cross-file-context      | 4/4               | 2/2               |
| multiple-defects        | 1/1               | unavailable (0/0) |

These are mechanical decisions against the stored oracle, not adjudicated finding-quality scores. A clean-twin rejection is not automatically unsupported.

## Owner adjudication

Read each worksheet with its Plan, patch, proof, and oracle. Confirm that the planted defect is real and the clean twin is clean. Label each blocking finding by its case ID, attempt, and zero-based index.
RV-D15 high severity assumes that every first-run setup fails; RV-D16 is medium. A severity or fixture correction needs a follow-up fixture revision, not a rewrite of these observations.

Write `adjudications.json` in the local run directory. The following is a format example, not owner decisions:

```json
{
    "schemaVersion": 1,
    "runId": "2026-10-26T01-37-52-346Z-8ca841ae",
    "oracleVerdicts": [
        {
            "caseId": "RV-D11/A",
            "verdict": "confirmed"
        },
        {
            "caseId": "RV-D11/B",
            "verdict": "fixture_needs_repair",
            "note": "Replace with the owner’s reason."
        }
    ],
    "adjudications": [
        {
            "caseId": "RV-D11/A",
            "attempt": 1,
            "findingIndex": 0,
            "state": "matched",
            "defectId": "RV-D11-A"
        }
    ]
}
```

- `matched`: one distinct oracle match; include `defectId`.
- `duplicate`: repeats an already matched defect; include `defectId`.
- `unsupported`: no concrete defect is supported.
- `novel_valid`: a real defect omitted by the oracle; excludes the entire case.
- `oracleVerdicts` needs one `confirmed` or `fixture_needs_repair` verdict per case. The optional `note` gives the reason.
- `fixture_needs_repair` or any `novel_valid` finding removes the case from every score, including variant and group splits. Fixtures stay unchanged in this Plan; repair is follow-up work.
- Advisories are not blocking findings and do not receive labels. Suggested path matches are not semantic credit.

After the owner supplies decisions, record them, run `score` again, and update this report from the new summary. List excluded cases under fixtures needing repair. Semantic status becomes `scored` only when every counted case has a verdict and all its blocking findings have labels.
See [the full label contract](../../../evals/reviewer/README.md#human-adjudication).

## Fixtures needing repair

None adjudicated yet. This is not a claim that every fixture is confirmed.

## Case worksheets

The worksheet text below comes from the saved `summary.md`. Blocking-finding requirement and evidence are included from its saved result records. All findings use attempt 1. No semantic match has been assigned.

### RV-D01/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D01/
Patch: evals/reviewer/RV-D01/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D01-A (medium)

- Trigger: Call refreshDigests with an explicit empty selection against a catalog with two stale digests.
- Expected behavior: Leave both project records unchanged and return no updated identities.
- Wrong behavior: The empty list selects every project and overwrites both digests.
- Proof: bun run test:oracle empty-selection

#### Blocking finding 0: An explicit empty selection refreshes every project

Suggested path matches: RV-D01-A.
Label: pending adjudication.

**Requirement:** The request states: omission means all projects; an explicit empty list means none.

**Evidence:** src/batch.ts: The expression `selection?.length ? selection : projects.map(...)` treats `[]` as an omitted selection. Thus `refreshDigests(root, [])` rebuilds and saves all digests and returns all project identities instead of leaving the catalog unchanged and returning `{ updated: [] }`.

### RV-D01/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D01/
Patch: evals/reviewer/RV-D01/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D02/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D02/
Patch: evals/reviewer/RV-D02/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D02-A (medium)

- Trigger: Load receipt-settings.json with enabled set to false and render a receipt.
- Expected behavior: Keep the normalized setting false and omit the rewards footer without changing invoice content.
- Wrong behavior: Boolean normalization enables offers and prints the footer despite the explicit opt-out.
- Proof: bun run test:oracle disabled-offers

#### Blocking finding 0: Explicit false does not disable the rewards footer

Suggested path matches: RV-D02-A.
Label: pending adjudication.

**Requirement:** Explicit false must disable the footer; omitted settings must keep it enabled.

**Evidence:** src/settings.ts: loadSettings returns `enabled: configured || true`. When saved.enabled is false, this expression returns true. As a result, src/receipts.ts still prints the rewards footer for a shop configured with `"enabled": false`.

### RV-D02/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D02/
Patch: evals/reviewer/RV-D02/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D03/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D03/
Patch: evals/reviewer/RV-D03/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D03-A (medium)

- Trigger: An accession API returns a populated first page, an empty second page with nextCursor, and a populated terminal third page.
- Expected behavior: Export records from both populated pages in API order.
- Wrong behavior: The export stops at the empty second page and silently omits the later accession.
- Proof: bun run test:oracle empty-middle-page

#### Blocking finding 0: Empty pages with a continuation cursor stop the export early

Suggested path matches: RV-D03-A.
Label: pending adjudication.

**Requirement:** An empty items array with a continuation cursor is not the end of the export. Only a missing nextCursor ends traversal, and repeated cursors must cause an error.

**Evidence:** src/export.ts: `if (page.items.length === 0) break;` exits before checking nextCursor. A filtered empty page with a new cursor therefore skips later records and returns a partial export as complete. An empty page with a repeated cursor also returns successfully instead of reporting the cycle. Remove the items-length termination condition; use nextCursor to control traversal.

### RV-D03/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D03/
Patch: evals/reviewer/RV-D03/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D04/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D04/
Patch: evals/reviewer/RV-D04/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D04-A (high)

- Trigger: Two Plan references share the display name Delivery but differ in projectId, ownerId, or planId. Read both with one SummaryBrowser.
- Expected behavior: Each read returns the summary stored under that stable project, owner, and Plan identity.
- Wrong behavior: The second read returns the first scope's cached content. A title collision can disclose another owner's content.
- Proof: bun run test:oracle project-scope

#### Blocking finding 0: The cache uses a display name instead of the repository identity

Suggested path matches: RV-D04-A.
Label: pending adjudication.

**Requirement:** Keep repository contracts and displayed titles unchanged. AGENTS.md requires stable identities and separate presentation labels.

**Evidence:** src/browser.ts, SummaryBrowser.load: `const key = ref.name` merges distinct records that share a name. PlanRepository identifies records by [projectId, ownerId, planId]. Loading two such records returns the first record's title, excerpt, and word count for the second. Changing only a record's name also bypasses its cached summary within the same refresh. Use the complete repository identity for the cache key.

### RV-D04/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D04/
Patch: evals/reviewer/RV-D04/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D05/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D05/
Patch: evals/reviewer/RV-D05/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D05-A (high)

- Trigger: An archive root named archive has a real sibling archive-old. Request removal of ../archive-old/keep.txt.
- Expected behavior: Refuse the request and preserve the sibling file unchanged.
- Wrong behavior: The resolved sibling path shares a string prefix with the root and is unlinked outside the archive.
- Proof: bun run test:oracle prefix-sibling

#### Blocking finding 0: The containment check permits deletion outside the archive root

Suggested path matches: RV-D05-A.
Label: pending adjudication.

**Requirement:** Delete only a regular file beneath the archive root. Refuse paths outside it.

**Evidence:** src/archive.ts, removeArtifact: `target.startsWith(base)` checks a text prefix, not a directory boundary. With root `/tmp/archive`, requested path `../archive-backup/report.txt` resolves to a target that passes this check. If that target is a regular file, `unlink(target)` deletes it outside the archive. The existing `containedFile` helper uses a boundary-aware check.

### RV-D05/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D05/
Patch: evals/reviewer/RV-D05/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D06/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D06/
Patch: evals/reviewer/RV-D06/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D06-A (high)

- Trigger: Use a valid reviewer capability for a board and set the caller-controlled role query parameter to maintainer before submitting a title update.
- Expected behavior: Return forbidden and preserve the board title because the verified capability is read-only.
- Wrong behavior: The display-role claim authorizes a persistent rename using a read-only capability.
- Proof: bun run test:oracle role-promotion

#### Blocking finding 0: Rename authority comes from the caller-controlled display role

Suggested path matches: RV-D06-A.
Label: pending adjudication.

**Requirement:** Mutation authority must come only from the verified, board-scoped capability. The role query parameter must remain a display hint, and reviewer capabilities must remain read-only.

**Evidence:** src/service.ts: the new mutation branch checks link.displayRole instead of capability.role. A valid reviewer capability with only the URL role changed to maintainer passes verification and can rename its board. Conversely, a maintainer capability with a reviewer display hint is refused. The new tests in tests/public.ts always set the signed role and display role to the same value, so this incorrect authorization rule passes both the maintainer and reviewer tests. Those tests do not distinguish capability authority from the caller-controlled hint.

### RV-D06/B

Status: complete; decision correct: false.

Package: evals/reviewer/RV-D06/
Patch: evals/reviewer/RV-D06/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

#### Blocking finding 0: The authorization tests cannot distinguish signed authority from the role hint

Suggested path matches: none.
Label: pending adjudication.

**Requirement:** Mutation authority must come only from the verified capability. The caller-controlled role parameter must not grant authority. The Plan requires rename and refusal tests.

**Evidence:** tests/public.ts: the new rename and refusal tests use linkFor(role), which sets both the signed capability role and the query role to the same value. Replacing `capability.role` with `link.displayRole` in src/service.ts would still pass every added test. Add cases with different roles: a reviewer capability with a maintainer hint must return 403 and leave the stored title unchanged; a maintainer capability with a reviewer hint must permit the rename.

### RV-D07/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D07/
Patch: evals/reviewer/RV-D07/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D07-A (medium)

- Trigger: A command spawns a descendant that acknowledges readiness and waits for a go file created only after cancellation returns.
- Expected behavior: Cancellation settles the process group before returning a cancelled result; no descendant can write after go.
- Wrong behavior: Only the direct child is killed, so its live descendant writes a sentinel after cancellation returns.
- Proof: bun run test:oracle descendant-cancel

#### Blocking finding 0: Cancellation leaves command subprocesses active

Suggested path matches: RV-D07-A.
Label: pending adjudication.

**Requirement:** Steps 1–2 require cancellation and a cancelled outcome after settlement. AGENTS.md states that commands own their subprocesses and that a cancelled result means command activity has settled.

**Evidence:** src/command.ts, cancel(): the code probes the process group with -pid but sends SIGKILL only to pid. It then treats the direct child's close event as settlement. With tests/workload.ts in branch mode, the leaf uses ignored stdio and survives while cancel() returns cancelled; it can still write the sentinel. With inherited pipes, a surviving descendant can instead prevent close and leave cancel() pending. The added test uses only direct mode, so it does not expose this defect.

### RV-D07/B

Status: complete; decision correct: false.

Package: evals/reviewer/RV-D07/
Patch: evals/reviewer/RV-D07/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

#### Blocking finding 0: The public result reports cancellation before process-group settlement

Suggested path matches: none.
Label: pending adjudication.

**Requirement:** Return a cancelled outcome only after settlement. AGENTS.md states that validation commands own their subprocesses and that a cancelled result means command activity has settled.

**Evidence:** src/command.ts: the `close` handler resolves `this.result` with `status: "cancelled"` immediately. Only `cancel()` then checks process-group settlement. The direct child's close event does not establish that descendants with independent stdio have settled. A caller awaiting `run.result` can therefore receive a cancelled outcome before the group check completes, even when that check later times out. Route cancelled results through the settlement check before exposing them through either public promise.

### RV-D08/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D08/
Patch: evals/reviewer/RV-D08/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D08-A (medium)

- Trigger: Deliver one completed live repair task through TaskService.completeTask while validation owns that repair.
- Expected behavior: Exactly one validation owner consumes the result and records one transition; restart recovery uses saved evidence without replay.
- Wrong behavior: The root listener consumes the repair and the validation owner consumes the same event again, recording duplicate consumers and transitions.
- Proof: bun run test:oracle single-consumer

#### Blocking finding 0: Live repair completion consumes the same repair twice

Suggested path matches: RV-D08-A.
Label: pending adjudication.

**Requirement:** Step 2 requires resuming checks after repair. AGENTS.md assigns repair consumption and validation transitions to the validation controller, not the application completion listener.

**Evidence:** In src/service.ts, completeTask calls onCompletion, which consumes the repair with owner "listener", then calls consume again with owner "validation". ValidationOwner.consume appends a consumer and a transition on each call without a phase guard. Thus one live repair records two consumers and two repairing->checking transitions. The new live-repair test in tests/public.ts checks only phase and completion evidence, so it passes with this duplicate consumption. Check that live completion produces one validation-owned consumption and one transition.

### RV-D08/B

Status: complete; decision correct: false.

Package: evals/reviewer/RV-D08/
Patch: evals/reviewer/RV-D08/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

#### Blocking finding 0: Saved completion evidence prevents pending completion delivery

Suggested path matches: none.
Label: pending adjudication.

**Requirement:** Expose completion delivery and resume checks after a completed repair; preserve ordinary task completion delivery.

**Evidence:** src/service.ts, completeTask: `if (prior?.completed) return` skips delivery based only on completion evidence. Calling requestRepair("r"), recordCompletion("r"), then completeTask("r") leaves validation in `repairing`. The same guard prevents a general task notification after recordCompletion, which previously worked. It also prevents retry after a delivery failure following the successful evidence write. Completion evidence does not establish that delivery succeeded; recover handles only the repair case and is not called by completeTask.

### RV-D09/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D09/
Patch: evals/reviewer/RV-D09/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D09-A (high)

- Trigger: The configured transition command edits the author body after status changes to validating, then exits nonzero.
- Expected behavior: Restore the previous lifecycle front matter on the latest author body and propagate the command failure.
- Wrong behavior: Whole-file snapshot rollback restores the earlier body and deletes the concurrent author revision.
- Proof: bun run test:oracle body-rollback

#### Blocking finding 0: Failed validation deletes author edits made while the command runs

Suggested path matches: RV-D09-A.
Label: pending adjudication.

**Requirement:** Restore earlier lifecycle metadata on command failure. AGENTS.md requires metadata updates to retain author text, which can change while commands run.

**Evidence:** src/lifecycle.ts: startValidation catches command failure and calls writePlan(path, previous). This writes the body captured before the command started. If the author edits the Markdown body while the command runs and the command then fails, rollback deletes those edits. tests/public.ts keeps the body unchanged during each command, so its rollback assertions also pass with this destructive implementation.

### RV-D09/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D09/
Patch: evals/reviewer/RV-D09/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D10/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D10/
Patch: evals/reviewer/RV-D10/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D10-A (high)

- Trigger: A publication push is rejected and saved as pending; another workspace advances the target before retryPublication resumes the attempt.
- Expected behavior: Integrate the current target into the saved repair and prove both the fetched target and validated candidate are ancestors of the commit sent with the fresh lease.
- Wrong behavior: Retry fetches a new lease but pushes the old prepared commit without integrating the current target, replacing the branch and losing the intervening target commit.
- Proof: bun run test:oracle target-ancestry

#### Blocking finding 0: Retry can overwrite commits added to the target after the first send.

Suggested path matches: RV-D10-A.
Label: pending adjudication.

**Requirement:** Step 2 requires reuse of the existing target-branch lease publication flow, which integrates the fetched target.

**Evidence:** src/publication.ts, retryPublication: expectedTarget is replaced with the newly fetched target, but preparedCommit remains the old commit. If another writer advances the branch after rejection, the force-with-lease push can succeed and remove that writer's commits. The original prepare flow checks that the fetched target is an ancestor of the sent commit; retry bypasses this protection.

#### Blocking finding 1: The rejected-retry test does not check that the latest send result is saved.

Suggested path matches: none.
Label: pending adjudication.

**Requirement:** Steps 3 and 4 require persistence of each send result and coverage of remote rejection.

**Evidence:** tests/public.ts, 'a rejected retry retains its candidate and diagnostic record': both sends use the same rejection message. An implementation that performs the retry but returns and retains the original record on failure passes every assertion. Use distinct rejection diagnostics for the two sends and check that the second diagnostic is returned and persisted.

#### Blocking finding 2: The completed-attempt test does not prove that retry avoids remote contact.

Suggested path matches: none.
Label: pending adjudication.

**Requirement:** A published attempt must return without another send; step 4 requires coverage of a repeated completed request.

**Evidence:** tests/public.ts, 'a completed attempt can be read without contacting the remote': renaming the remote only makes contact fail. An implementation that contacts the remote, catches the failure, and returns the saved published record passes both assertions. The test needs an observable record of remote contact so that an ignored failure cannot pass.

### RV-D10/B

Status: complete; decision correct: false.

Package: evals/reviewer/RV-D10/
Patch: evals/reviewer/RV-D10/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

#### Blocking finding 0: The rejected-retry test accepts a stale attempt record

Suggested path matches: none.
Label: pending adjudication.

**Requirement:** Steps 3 and 4 require persistence of each send result and test coverage of remote rejection.

**Evidence:** tests/public.ts, the new rejected-retry test: both sends receive the same rejection message, and the target does not change. A retry implementation that sends but returns the old saved attempt on failure, without saving the new failure, passes every assertion. Give the retry a distinct rejection diagnostic and assert that the returned and persisted records contain that new diagnostic.

### RV-D11/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D11/
Patch: evals/reviewer/RV-D11/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D11-A (medium)

- Trigger: A long-lived command host loads the commands module in one project, summarizes it, selects a second project, then summarizes again.
- Expected behavior: Each summary reads notes from the project active for that operation.
- Wrong behavior: The module-level projectRoot retains the initial cwd, so the second operation returns the first project summary.
- Proof: bun run test:oracle active-project

#### Blocking finding 0: The summary uses the project active at module load, not at call time

Suggested path matches: RV-D11-A.
Label: pending adjudication.

**Requirement:** projectSummary() must summarize the active project. README.md states that the host can change the active project while it stays open.

**Evidence:** src/commands.ts: module-level `const projectRoot = process.cwd()` captures the directory once. If the host imports the module in project A, then changes its working directory to project B, `projectSummary()` still reads A's notes. This returns the wrong count and titles, including when B is empty.

### RV-D11/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D11/
Patch: evals/reviewer/RV-D11/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D12/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D12/
Patch: evals/reviewer/RV-D12/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D12-A (high)

- Trigger: A caller supplies RegistrationDependencies replacing putEntry and withRegistryLock.
- Expected behavior: Registry persistence and lock acquisition remain production-owned.
- Wrong behavior: The optional dependency bag substitutes owned mutation and locking.
- Proof: bun run test:oracle seam-check

#### Oracle defect RV-D12-TEST-DURABILITY (medium)

- Trigger: Remove the real durable rename and run the public registration tests.
- Expected behavior: The success test reopens the real registry and detects a missing durable write.
- Wrong behavior: The test substitutes a no-op write, checks the returned entry, and passes without persistence.
- Proof: bun run test:oracle mutation-coverage

#### Blocking finding 0: Registration exposes overrides for product-owned persistence and locking

Suggested path matches: RV-D12-A.
Label: pending adjudication.

**Requirement:** The review rules and AGENTS.md prohibit optional dependency bags and injected registry writers or locks.

**Evidence:** src/register.ts adds RegistrationDependencies and a fourth registerProject argument. The deps?.putEntry and deps?.withRegistryLock fallbacks let callers bypass persistence and lock acquisition.

#### Blocking finding 1: The success test does not cover persistence after reopening

Suggested path matches: RV-D12-TEST-DURABILITY.
Label: pending adjudication.

**Requirement:** Approved step 2 requires durable state after reopening. The request requires a successful registration to remain visible when the registry is opened again.

**Evidence:** tests/public.ts, 'successful registration remains available', replaces putEntry with a no-op and withRegistryLock with a direct callback. It asserts only the returned entry and never reads the registry again. An implementation that returns the catalog entry without saving anything would pass. Use the real registration path and assert the saved entry through a fresh registry read.

### RV-D12/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D12/
Patch: evals/reviewer/RV-D12/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D13/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D13/
Patch: evals/reviewer/RV-D13/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D13-A (medium)

- Trigger: Archive one Plan while another stays active, then run list --archived-only through the command entry point.
- Expected behavior: Return only the archived Plan with its archive timestamp.
- Wrong behavior: The parsed archivedOnly option is ignored and the result also contains the active Plan.
- Proof: bun run test:oracle archived-list

#### Blocking finding 0: The archived-only command still returns active Plans

Suggested path matches: RV-D13-A.
Label: pending adjudication.

**Requirement:** Step 3 requires list --archived-only to return only archived Plans.

**Evidence:** src/commands.ts, runCommand list branch: parseListOptions produces options, but the branch ignores options.archivedOnly and calls listPlans(root) without selecting the archived area. Thus filtered and unfiltered commands return the same records, including active Plans.

### RV-D13/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D13/
Patch: evals/reviewer/RV-D13/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D14/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D14/
Patch: evals/reviewer/RV-D14/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D14-A (medium)

- Trigger: Pruning sees more than 10 records younger than 30 days, or fewer than 10 records all older than 30 days.
- Expected behavior: Apply the approved replacement: retain all records at or after the 30-day cutoff and delete all older records, regardless of count.
- Wrong behavior: The implementation follows the superseded newest-10 instruction, dropping young history and retaining old history.
- Proof: bun run test:oracle age-retention

#### Blocking finding 0: Pruning uses a record limit instead of the approved 30-day cutoff

Suggested path matches: RV-D14-A.
Label: pending adjudication.

**Requirement:** Approved Plan Deviation 1 requires deleting only records older than 30 days and retaining every record at or after the cutoff, regardless of count.

**Evidence:** src/retention.ts: pruneHistory uses records.slice(0, 10) and does not use now. This deletes recent records when there are more than 10 and retains expired records when they fall within the newest 10. saveHistory persists this incorrect selection.

### RV-D14/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D14/
Patch: evals/reviewer/RV-D14/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D15/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D15/
Patch: evals/reviewer/RV-D15/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D15-A (high)

- Trigger: A new user initializes a workspace with no saved selection.
- Expected behavior: Setup stores the default stable id default with the new display label My Workspace.
- Wrong behavior: The default stored id becomes My Workspace; the untouched identifier validator rejects its spaces and capitals, so every first-run setup fails before saving.
- Proof: bun run test:oracle first-run

#### Blocking finding 0: The new default ID prevents first-run workspace creation

Suggested path matches: RV-D15-A.
Label: pending adjudication.

**Requirement:** Change the visible default label to `My Workspace` without breaking workspace initialization.

**Evidence:** src/setup.ts:5 changes the ID from `default` to `My Workspace`. initializeWorkspace passes this ID to saveWorkspace, which calls validateIdentifier in src/identifier.ts. That validator rejects uppercase letters and spaces, so initialization throws when no saved workspace exists. Keep the ID as `default` and change only the label.

### RV-D15/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D15/
Patch: evals/reviewer/RV-D15/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-D16/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D16/
Patch: evals/reviewer/RV-D16/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-D16-A (medium)

- Trigger: A calendar user in America/Los_Angeles asks for reminders for the evening of January 14; an event starts at 2026-01-15T01:30:00Z.
- Expected behavior: The event appears on the local January 14 reminder list, while summary export date prefixes use UTC January 15.
- Wrong behavior: Changing the shared localDateKey to UTC shifts the untouched reminder caller by one calendar day: the event disappears from January 14 and appears on January 15.
- Proof: bun run test:oracle local-reminder-day

#### Blocking finding 0: UTC conversion breaks local-day reminders

Suggested path matches: RV-D16-A.
Label: pending adjudication.

**Requirement:** Preserve existing behavior outside the dated summary export. README.md specifies that reminders use local calendar dates.

**Evidence:** src/dates.ts replaces local date getters with toISOString().slice(0, 10). src/reminders.ts also calls localDateKey, so reminders now select events by UTC day. For example, in America/New_York, an event at 2026-01-16T02:00:00Z belongs to January 15, but remindersForDay now returns it for January 16 instead. Keep localDateKey local and use a separate UTC conversion for summary exports.

### RV-D16/B

Status: complete; decision correct: true.

Package: evals/reviewer/RV-D16/
Patch: evals/reviewer/RV-D16/variants/clean.patch
Oracle verdict: pending adjudication.
Scoring: counted.

Oracle: no defect

### RV-M01/A

Status: complete; decision correct: true.

Package: evals/reviewer/RV-M01/
Patch: evals/reviewer/RV-M01/variants/defective.patch
Oracle verdict: pending adjudication.
Scoring: counted.

#### Oracle defect RV-M01-A (medium)

- Trigger: List a terminal page containing an archived project with filterEnabled explicitly false.
- Expected behavior: Disable the filter and return the archived project.
- Wrong behavior: Boolean truthiness defaulting overwrites false with true, hiding the archived project.
- Proof: bun run test:oracle explicit-false

#### Oracle defect RV-M01-B (medium)

- Trigger: With filtering explicitly true and all projects active, the second page is empty but supplies a cursor to a nonempty third page.
- Expected behavior: Continue to the third page and return the first and third pages in order.
- Wrong behavior: An empty item array ends traversal early, omitting the third page.
- Proof: bun run test:oracle empty-cursor-page

#### Blocking finding 0: Explicit false does not disable the archive filter

Suggested path matches: RV-M01-A.
Label: pending adjudication.

**Requirement:** Step 1: Default filterEnabled to enabled only when absent; explicit false disables the archive filter.

**Evidence:** src/settings.ts: loadSettings uses configured.filterEnabled || true, which returns true for false. Thus listProjects(catalog, { filterEnabled: false }) still removes archived projects.

#### Blocking finding 1: An empty page stops collection even when a next cursor exists

Suggested path matches: RV-M01-B.
Label: pending adjudication.

**Requirement:** Step 2: Continue through empty item arrays and stop only when the next cursor is absent; refuse repeated cursors.

**Evidence:** src/pagination.ts: collectProjects breaks at if (!page.items.length) before checking nextCursor. An empty intermediate page drops all later results. An empty page with a repeated cursor also returns success instead of rejecting.
