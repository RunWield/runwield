# Usage and Export Journey Evidence

## Live run

Status: the live journey is complete. Production backend turns, interruption, a real failed-validation repair and
publication, deliberate abandonment, restart, opt-out, and disposable history clear were checked. The owner confirmed
matching physical-phone/desktop values and the initial native Cloud chart. Controlled response loss uses the Plan's
hermetic-only fallback.

The final post-grant cohort has **715 observations**, each received once, with **8,594,559 known tokens** and
**5.74303465 USD** native cost. Core confirms 658 receipts and retains 57 as unconfirmed; all 715 are visible remotely,
and every send-attempt count is one. A separate two-day owner report matches an independent scan of 4,545 model rows.

Two real documentation deliveries are confirmed. The first lost its publication measurement. That defect is repaired;
a fresh normal delivery produced exactly one publication observation, confirmed by Core and Cloud. The first missing
measurement remains missing. Neither dropped usage nor unconfirmed receipt state was reconstructed. The hermetic
results below are separate from live evidence.

### Run identity

| Field                                              | Live value                                                                                                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                                               | 2026-10-23–24                                                                                                                                               |
| Host time zone                                     | America/New_York                                                                                                                                            |
| RunWield commit and local change fingerprint       | Base `2ecf13374`; working changes, fingerprint below                                                                                                        |
| Bun version                                        | 1.4.3                                                                                                                                                       |
| Pi package version                                 | pi-ai 1.0.4; pi-coding-agent 1.0.4                                                                                                                          |
| Claude CLI version                                 | 2.1.303                                                                                                                                                     |
| agy CLI version                                    | 1.4.6                                                                                                                                                       |
| Filesystem type and collection degradation, if any | APFS; initial checkpoint-recovery gap, described below                                                                                                      |
| Destination kind                                   | New disposable Langfuse Cloud Project over HTTPS; live v4 export and public API read-back passed                                                            |
| Owner authorization and new-grant boundary         | Selected real Project and new journey records authorized; no spend cap. One Project boundary captured under the journal lock; no existing history included. |

Final repaired checkout SHA-256, excluding this evidence file: `9034e9e1f493e94d15ffab964f42db49921f1d39e9ac89f44b454188daae6a9f`.

Do not record credentials, prompts, code, private paths, or Project names. Use aggregate counts and opaque observation
references. Keep credentials in the Workspace credential control, not in this file or chat.

### Owner setup and run conditions

1. Authorize creation of the disposable Cloud Project and export of **new journey observations only**. Do not grant
   access to existing history or other local Projects. Record any model-spend limit before starting.
2. Sign in to the model provider, Claude CLI, and agy CLI. Keep the desktop browser and phone available.
3. Create the disposable Cloud Project. Find its keys under **Project → Settings**. Enter the region origin, Project
   ID (not display name), and keys only in Workspace when the Engineer prepares the destination.
4. Use the real owner Workspace with its scheduler and a running TUI Session. Do not use the fixture-backed dev server.
5. Capture aggregate local and remote evidence before clearing history. Clear does not remove remote observations.

Sources: [exporter setup](../../../../packages/langfuse-exporter/README.md#install-and-authorize),
[Langfuse key location](https://langfuse.com/faq/all/where-are-langfuse-api-keys).

### Observations

| Step          | Required observation                                                                         | Live result                                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1             | Non-Plan work records usage without a Plan link                                              | Six post-grant non-Plan turns; no Plan IDs or remote Plan references                                                                                                                                                                                          |
| 2             | Pi, Claude, and agy produce distinct provenance and per-backend totals                       | Two authoritative model observations per backend; four Claude alternatives excluded; all 12 spans confirmed                                                                                                                                                   |
| 3             | An interruption remains ongoing, not abandoned                                               | Canceled an observed active execution; cancellation acknowledged. No abandonment or publication for that attempt.                                                                                                                                             |
| 4             | Failed validation, repair, and confirmed publication                                         | Fresh delivery: controlled link failure, real repair, unchanged CI pass, AI review, normal Code Review approval, and confirmed publication; one collected publication, confirmed remotely.                                                                    |
| 5             | Deliberate abandonment is distinct from interruption                                         | Normal recovery confirmation removed the worktree and registry entry and emitted one abandonment. Branch retained for rescue.                                                                                                                                 |
| 6             | Disabled interval adds no measurements or export and leaves a visible gap                    | Real model returned READY with native usage, but zero v2 measurements during scoped opt-out. Original inherited setting restored. The report discloses the gap; no corresponding export exists.                                                               |
| 7             | Closing and restarting TUI and Workspace preserves only collected evidence                   | Closed the owned Workspace and both owned TUIs. Restart preserved the retained journal prefix byte-for-byte; a new real model row linked the correct Plan.                                                                                                    |
| 8             | Lost response remains unconfirmed, is not resent, and permits later sends                    | Controlled loss remains hermetic-only. Natural ambiguous live receipts confirmed through read-back, without resend; these are not controlled-loss proof.                                                                                                      |
| 9             | Desktop and paired phone show the same zone, dates, totals, and disclosures                  | Owner confirmed physical phone and desktop match; separate emulation screenshots and registered-root Session navigation passed                                                                                                                                |
| 10            | Langfuse public API and UI counts, sums, and native charts match eligible evidence           | Owner-inspected initial Cloud UI matches 12 observations and USD 0.70645075. Final public API: 715 identities once, 8,594,559 known tokens, USD 5.74303465; receipt-state differences disclosed below.                                                        |
| Clear check   | Report stays readable; Sessions, Plans, settings, and worktrees remain                       | Cleared only an owned disposable Git Project without an export grant: 16 model rows became zero; Session, unchanged Plan, and two Git worktrees remained. Selected history prefix unchanged. Owner report returned 200, with no visible alerts or overflow.   |
| Privacy check | Bodies, responses, logs, and browser storage contain no private content or credential values | Captured OTLP bodies and owner response passed privacy checks. Final Cloud read explicitly requested input/output: both keys exist and are empty on all 715 rows. Browser storage contains no private-root or credential patterns. Temporary tracing removed. |

Step 8 uses the Plan's hermetic-only fallback. A controlled proxy was prepared but not started or granted. The direct
Cloud grant remained unchanged while real workflows produced observations. No controlled live response-loss claim is
made. The hermetic check below proves durable unconfirmed state, no resend after restart, and later delivery.

### Pre-grant backend check

The first three turns returned normally but saved no model measurements while checkpoint recovery was pending. They
remain a collection gap. They were not replayed or reconstructed.

After repair, three new production turns returned model responses and persisted start, usage, and finish observations.
These are local-only checks before the Project grant. This table uses authoritative journal rows, not reporter output:

| Backend    | Known tokens |   USD cost | Cost source | Token / cost coverage | Event ID SHA-256 prefix |
| ---------- | -----------: | ---------: | ----------- | --------------------- | ----------------------- |
| pi         |       17,832 | 0.02269625 | calculated  | complete / complete   | f57f1b24387dd379        |
| claude-cli |       45,550 | 0.00911100 | reported    | complete / complete   | e40d59a238de3168        |
| agy-cli    |       21,957 | 0.01676175 | calculated  | partial / complete    | 56eed7a4d4002b68        |

Known token subtotal: **85,339**. Reported USD subtotal: **0.009111**. Calculated USD cost: **0.039458**.
agy did not report cache-write tokens; its known token count is a subtotal, while catalog cost is complete. Claude
recorded three raw model rows: one authoritative turn and two alternatives. Alternatives do not add to local totals or
export. No pre-grant row was uploaded when the selected Project was added.

The first reconciliation query used temporary runtime IDs. Persisted Session locators supplied the correct identities.
That query error did not require a product change or another model run. Backend dispatch attempt IDs are not Plan
attribution; these turns have no Plan ID or Plan link.

### Post-grant backend batches

The first batch used the execution worktree. Its measurements share the selected Project journal, but Workspace correctly
withholds Session links for that unregistered root. A second batch ran from the registered root. All three Session
links are available there; opening the Pi link reached its Session route without a browser error. No Project
access rule changed.

The installed Workspace executable was inspected read-only: its serving function starts no export scheduler. Other CLI
hosts use separate HOME roots. No other inspected host has a scheduler configured for this destination. The installed Workspace was
not stopped or changed. The approved installed exporter bytes match this checkout.

| Backend    | Model observations | Known tokens |   USD cost | Cost source | Token / cost coverage | Event ID set SHA-256 prefix |
| ---------- | -----------------: | -----------: | ---------: | ----------- | --------------------- | --------------------------- |
| pi         |                  2 |       39,057 | 0.04939750 | calculated  | complete / complete   | 269d5e7a7b41794b            |
| claude-cli |                  2 |       75,741 | 0.62121450 | reported    | complete / complete   | f39e80ae9e21f9b1            |
| agy-cli    |                  2 |       47,489 | 0.03583875 | calculated  | partial / complete    | b0541ec756824938            |

Known token subtotal: **162,287**. Reported USD subtotal: **0.6212145**. Calculated USD cost:
**0.08523625**. Remote native cost across the six model observations: **0.70645075 USD**.
Native usage sums to the same known token subtotal. Both agy observations omit cache-write tokens and disclose partial
token coverage, while their catalog cost is complete. Four Claude alternative rows are excluded.

The public API returned exactly 12 unique spans: six model observations and six execution finishes. Every returned
observation identity matches an eligible post-grant row and a confirmed Core ledger item with one send attempt. The
identity-set SHA-256 is `b044dd369eb91980d38a33a156f9eb9dc7ef77c14ea27b68796843c95231c713`. No pre-grant row or Plan reference appears remotely.
Some acknowledgements were ambiguous; read-back confirmed them after one to three checks, without another send. This
is not a claim that a controlled network response cut has been tested.

An earlier selected-Project day snapshot, before the second batch, covered 2026-10-23 in America/New_York and was
recorded through 18:08:32.226 UTC. An independent streaming journal scan matched all 880 model rows, every token category,
and every backend subtotal: **103,512,546** known tokens, **0.374861 USD** reported cost, and **34.00741976 USD** calculated
cost. That day includes retained and other-epoch local evidence as well as pre-grant turns. It is not the remote-only
batch subtotal. The final journey-period comparison follows below.

### Bounded journey reconciliation

A journal boundary captured at 2026-10-24T16:54:59.953995Z contains 558 eligible post-grant observations, including 205
model observations. Cursor-paginated Cloud read-back contains every identity exactly once. A later read includes ten
additional observations outside that boundary; they do not change this bounded comparison.

| Measure                     | Eligible journal cohort | Cloud received |
| --------------------------- | ----------------------: | -------------: |
| Observations                |                     558 |            558 |
| Model observations          |                     205 |            205 |
| Known tokens / native usage |               7,034,430 |      7,034,430 |
| Reported USD                |               0.6212145 |      0.6212145 |
| Calculated USD              |               4.0725077 |      4.0725077 |
| Native USD total            |               4.6937222 | 4.693722199992 |

Costs agree within 0.00000001 USD. The Core snapshot has 518 confirmed and 40 unconfirmed items; all 558 are present
remotely, and every Core attempt count is one. Remote receipt does not turn an unconfirmed Core item into confirmed
state. No ambiguous item was resent. The identity-set SHA-256 is
`c002a4807e629fc66660eafa94e3b057c6301167ef9f4d010232092fe1a191f8`.

An independent streaming scan also matches the owner report for 2026-10-23 to 2026-10-25 exclusive,
America/New_York, recorded through 2026-10-24T17:42:54.496Z:

- 3,530 authoritative model observations; 312,795,655 known tokens.
- 0.6303255 USD reported; 112.22304224 USD calculated.
- Every token category, overall cost, and backend subtotal matches within 0.00000001 USD.
- The report shows the disabled interval as a gap, not zero. Other unavailable, legacy, not-yet-collected, and
  incomplete coverage remains disclosed.
- The local period includes retained evidence from two history epochs, including pre-grant data. It is not the
  remote-only cohort. No such difference is treated as missing export or reconstructed history.

The Cloud cohort has no stored input or output. Inspection found no selected private roots, prompts, filenames, or
credential values in its received data. The final publication and cumulative cut follow below.

### Final bounded cohort and owner report

The final export boundary was captured at **2026-10-24T20:23:38.614205Z**. All 715 eligible identities appear once in
Cloud, with no later observations in that read. Four alternative model rows and all other-epoch or pre-grant rows are
excluded. Every ledger item has one send attempt. The identity-set SHA-256 is
`75529758f9333389b2ff13d382d87f5f6baaa5b9dc888c55e8adfe189940d8b4`.

| Measure            | Core confirmed | Core unconfirmed, received remotely | Cloud total |
| ------------------ | -------------: | ----------------------------------: | ----------: |
| Observations       |            658 |                                  57 |         715 |
| Model observations |            231 |                                  33 |         264 |
| Known tokens       |      7,415,780 |                           1,178,779 |   8,594,559 |
| Reported USD       |      0.6212145 |                                   0 |   0.6212145 |
| Calculated USD     |     4.49798735 |                           0.6238328 |  5.12182015 |

The native Cloud usage subtotal is **8,594,559**; native cost is **5.743034649986 USD**, within 0.00000001 USD of the
eligible **5.74303465 USD**. Native fields, timing, references, model metadata, and execution coverage also match.
The remaining kinds are 42 execution finishes, 387 tool calls, 14 validation attempts, six repair finishes, one
abandonment, and one publication. The publication is Core-confirmed. The 57 unconfirmed receipts are not reported as
confirmed merely because independent Cloud read-back found them. None was resent.

The final independent owner comparison covers **2026-10-23 to 2026-10-25 exclusive**, **America/New_York**, recorded
through **2026-10-24T20:33:58.769Z**:

- 4,545 authoritative model rows, across two retained history epochs; zero corrupt lines.
- **382,585,203 known tokens**, **0.6303255 USD reported**, and **148.31191661 USD calculated**.
- All token categories and costs match overall, across all three backends, and across all eight model groups.
- Known lifecycle counts: one publication, 14 validation attempts, six repair rounds, three ongoing, one abandoned.
- The owner API returned 200 in 26,927 ms. A separate Core read took 7,057 ms. One earlier automation await timed out;
  it is not counted as a successful check.

The owner period includes 4,281 more model rows than the export cohort: exactly 4,278 retained other-epoch rows and
three pre-grant rows. No same-epoch row inside the export boundary is unexplained. The corresponding known differences
are 373,990,644 tokens, 0.009111 USD reported, and 143.19009646 USD calculated. These are different scopes, not
unexplained export loss.
The disabled interval remains a gap, and partial-token subtotals remain labeled. No absent measurements were filled in.

The Cloud read explicitly requested its `io` field group. Every returned row contains empty input/output fields;
private-content checks pass. A later authenticated owner response, recorded through **2026-10-24T21:11:04.915Z**,
contains no private-root or credential patterns and no raw-content keys. Browser storage passes the same root and
credential checks. Independent Cloud receipt and Core confirmation remain separate facts.

### Initial backend-batch reconciliation

These historical values cover only the two initial post-grant backend batches, not subsequent workflow outcomes.
Count each eligible observation once. Keep reported cost separate from calculated cost. Treat native usage and cost
with missing coverage as subtotals, not complete or measured-zero totals. Explain each difference with the relevant
pre-grant boundary, disabled interval, partial upstream measurement, partial cost, or unconfirmed delivery.

| Measure                                           | Eligible local evidence  | Workspace                   | Accepted or confirmed by Core | Received by Langfuse | Explanation                                         |
| ------------------------------------------------- | ------------------------ | --------------------------- | ----------------------------- | -------------------- | --------------------------------------------------- |
| Authoritative model observations                  | 6 post-grant             | Earlier day snapshot above  | 6 confirmed                   | 6                    | Both backend batches                                |
| Known token subtotal, by backend                  | 162,287; breakdown above | Earlier day snapshot above  | 162,287                       | 162,287              | Two agy rows are token subtotals                    |
| Reported USD cost subtotal                        | 0.6212145                | Earlier day snapshot above  | 0.6212145                     | 0.6212145            | Pre-grant and other-epoch rows stay local           |
| Calculated USD cost                               | 0.08523625               | Earlier day snapshot above  | 0.08523625                    | 0.08523625           | Pre-grant and other-epoch rows stay local           |
| Partial-cost native totals and native model names | Not exercised live       | Not exercised live          | Not exercised live            | Not exercised live   | Hermetic partial-cost proof below                   |
| Unconfirmed observations                          | 0 settled                | 12 confirmed at latest load | 0 settled                     | All 12 received      | Ambiguous acknowledgements confirmed; one send each |

### Workflow acceptance and review-baseline repair

The first documentation workflow encountered real broken relative links before fault injection. Its unchanged CI
failed, repair ran, and later CI passed. A subsequent repair changed runtime source outside its documentation scope.
That attempt was stopped through normal recovery and put on hold. The hold was confirmed; its live state is idle,
with no running operation. No publication or abandonment is claimed for it. Its files remain available for inspection.

A fresh documentation workflow used the approved existing integration target. Its initial documentation-link check
passed across 607 tracked Markdown files. One controlled missing relative target then made that check fail. The
normal workflow ran the unchanged CI, repaired the link, and passed CI. Semantic Review then supplied a broader diff:

- Against the recorded remote execution base: two Markdown files, zero non-documentation files.
- Against the stale local target: 40 files, including 31 non-documentation files from a prior delivery.
- CI passed; Semantic Review requested feedback. The repair agent stopped rather than remove the prior delivery.

The owner authorized the shared baseline repair through a recorded Plan deviation. The common review-diff function
now uses the same target authority policy as publication. AI review, repair context, both human review surfaces,
refresh, and before-file reads share that comparison. It keeps the live target merge-base, includes committed and
uncommitted proposals, supports first delivery to a recorded local target, and fails closed for a lost recorded remote.
Publication recovery uses saved authority before current branch configuration. Final review found one remaining
setup mismatch: worktree preparation still fetched `origin`. It now uses the same authority owner and carries the
resolved ref through preparation. Five real-Git setup-to-review cases first failed, then passed: configured remote,
explicit local-only mode with an origin present, unavailable configured authority, and first-publication/default-source
variants. No manual prefetch hides this boundary.

Real-Git regressions reproduced the stale-local discrepancy, first-delivery failure, and recovery failure. Mutations
that restore those defects fail the regressions. The live helper now returns exactly two Markdown files and zero
non-documentation files. Normal resume then passed unchanged CI and Semantic Review. The normal code-review surface showed the exact same
patch, byte for byte: two Markdown files, 102 additions, no removals. After inspection and normal approval, publication
was independently confirmed at 2026-10-24T18:30:31.300Z. The remote-tracking target, retained delivery ref, validated
ancestry, and controller receipt agree. Normal cleanup removed the execution worktree and registry entry. A completed
model turn or CI pass alone was never counted as publication.

The pre-validation health check also made one Git process per target Plan document. It now reuses the existing batch
reader, without skipping checks. With 32 children, remote inspection fell from 42 Git processes to 10; local inspection
fell from 36 to 4. Real-Git tests preserve child membership, nested and multiple parents, Unicode content, failure
handling, and unchanged Project refs and index. No new cache, setting, or injection seam was added.

### Publication observation repair

The confirmed delivery exposed a separate collection failure: its journal has no publication observation, and the
retained coverage is unverified. The workflow completion was truthful; the publication metric was missing. The live
artifacts do not distinguish deadline exhaustion from a suppressed exception.

Real-Git regressions reproduced both causes. The observer spent its five-second budget on redundant artifact and
controller reads before append, and discarded exceptions. It now reuses classification from the required publication
indexing and epoch evidence from receipt retention. It first retains incomplete coverage with a content-free reason;
only confirmed persistence can mark coverage complete. Recording remains non-fatal, with the same five-second overall
budget and approximately one-second journal acquisition bound. Opt-out still collects nothing.

Restart and repeat cleanup cannot create a previously missing historical observation. The first live delivery stays
outside journal and Cloud publication counts. Its receipt is separate evidence of one actual delivery, not a
reconstructed usage observation. A fresh small delivery then proved collection and export after the repair, as recorded below.

The publication regression portfolio increased from 10 to 23 tests, with none removed. Existing normal full/early
cleanup, disabled recording, unwritable storage, user-file retention, disabled repeat cleanup, and restart-after-clear
cases remain. The process-death-before-observation case now requires incomplete coverage and no replay; the
after-observation case still preserves exactly one durable row. The lost-checkpoint case now requires unchanged
journal bytes rather than replay of retained publication. These changes protect the no-backfill contract. New cases
cover both cleanup paths, real remote publication, slow or thrown external operations, real journal contention, and
legacy unverified state. Five mutations fail the corresponding assertions.

### Fresh live publication proof

After deployment of the observation repair, a new documentation-only workflow used the same normal delivery target
and unchanged verification command. Its direct link check first passed across 609 tracked Markdown files. A single
controlled broken target then failed the normal CI at **2026-10-24T19:43:23.187Z**. The real repair restored the link;
CI passed at **19:51:26.314Z**, followed by AI review at **19:51:42.325Z**.

The normal human-review patch matched the shared target-relative diff byte for byte: two Markdown files, 62 additions
and one removal. It contained only the approved Plan and one documentation clarification, not prior delivered source.
Its SHA-256 is `176a1ad5c195b1dec2562b50150cc9c511e4cb4b7a42388a833717c692ad95d2`.
Normal browser approval completed; no private approval API or synthetic DOM action was used.

Publication was confirmed at **2026-10-24T20:20:25.553Z**, commit
`c275a9e2c8fb481adc183115c1351afab9d15706`. The remote-tracking target and retained delivery ref agree, validated
ancestry is present, the published Plan is verified, and normal worktree/registry cleanup completed.
Exactly one new `publication_confirmed` observation carries the correct Plan classification. It appears once in the
journal, once in Cloud, and as a confirmed Core ledger item. The owner report shows one known publication.
The earlier delivery still has no publication observation; its retained history was not replayed. A final read also
confirms that its original unverified controller marker remains unchanged.

The auxiliary controller coverage remains `incomplete`, with reason `recording_unconfirmed`. That conservative state
is not promoted by external read-back. It does not replace the independently present journal row or confirmed export
receipt. Neither delivery completion nor receipt confirmation is inferred from this auxiliary state.

### Additional collection and clear regressions

Live workflow measurements exposed missing Plan attribution after committed workflow association. An independent
scan found 11, 23, and 10 affected model rows across the three original workflow Sessions. Planning before association
correctly remained unlinked. The repair resolves only committed association evidence that covers the original model
instant and transcript segment, with known workflow scope. It does not rewrite earlier rows or use dispatch identity
as delivery identity. After the owned host restart, one new real model observation linked the expected Plan.

Review also found two defects, now repaired with focused regressions:

- Delayed Pi reconciliation used settlement time for the saved measurement. A New York midnight regression now keeps
  tokens and cost on the original source day and preserves the committed Plan scope. Invalid source time does not
  invent a Plan association. No retained measurement is reconstructed.
- A completed clear during journal refresh bypassed the bounded retry path and could show an unnecessary clear retry.
  Real cross-process clear regressions now cover one transient clear, three repeated clears, stable Project totals,
  and a stranded clear that remains read-only until explicit retry.

The source-time and refresh-race repair increments added four cases. The delayed Pi integration check added in this
change protects both original scope and original local-day accounting. No baseline attribution test was removed.
The final verification and cumulative test accounting follow below.

The scoped opt-out probe changed no global setting. It completed a real model turn with native usage while collecting
zero v2 observations. Restoring the original absent Project override required removing only the owned temporary key
under the existing settings-file lock; the normal settings writer preserves omitted custom keys. The owner API then
confirmed inherited recording again. The saved CI and worktree setup commands did not change.

The disposable live clear retained the Session, the exact Plan bytes, and both Git worktrees. The selected Project's
retained journal prefix stayed byte-for-byte unchanged. Its browser report was readable at 1440 × 1000 with no visible
alert or horizontal overflow. A DOM probe initially counted a hidden connection notice; visibility inspection showed
that it was hidden, not a live connection failure. No product change was made for that probe error.

### Physical phone comparison

On 2026-10-23, the owner confirmed that the already-paired physical phone and headed desktop match for the same selected
Project and date range: 2026-10-23 to 2026-10-24 (exclusive), America/New_York. The comparison covered known token totals,
costs, gap notices, and the 12 confirmed export items. Both reports were refreshed with **Apply range**. This is the
owner's physical-device confirmation; the earlier mobile-emulation screenshots are separate evidence.

### Cloud UI comparison

The owner encountered Google sign-in and Cloudflare bot checks in the automated acceptance browser. Regular Chrome
was opened for owner-led Cloud inspection without attaching automation or transferring credentials or cookies. The owner
was already signed in there and confirmed that the observations and native charts match the public API values:
**12 observations**, including **6 model calls**, **162,287 known tokens**, and **0.70645075 USD** native cost
(**0.71 USD** when rounded). This is owner-led UI evidence; the Engineer's automated read-back independently checked
identities, counts, and sums. Partial-cost suppression remains covered by the hermetic test, not by these live batches.

### Defects and disposition

| Observed defect                                                                                                                                         | Repair and regression evidence                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Large owner reports blocked other requests while resolving repeated and distinct missing Session targets.                                               | Read the existing Session catalog once per authorized Project alias, without catalog writes, and index targets for the request. `owner-usage-scale.integration.test.ts` checks repeated links, 1,000 distinct missing targets, and retained archived links. The distinct-target case failed at 8,361 ms CPU before repair.                                                                                                                  |
| A stale checkpoint was only about 29 MB into more than 560 MB of retained history. Each attempted write advanced one chunk and dropped the observation. | A pending recording call starts automatic bounded recovery. Authorization and clear wait for a complete checkpoint, releasing the guard between chunks. `metrics-journal-recovery.test.ts` checks automatic completion, stable authorization with corruption evidence, and clear without restored history. Live recovery took 3,924 ms; a SHA-256 check confirmed that the existing complete history prefix stayed byte-for-byte unchanged. |
| Long report periods rescanned legacy rows and converted their dates for each chart day.                                                                 | Select by exact local-day boundaries and collect gap-day indexes in one pass. `usage-reporting-scale.test.ts` checks 60,000 legacy rows across 92 days, exact midnight exclusion, legacy/incomplete gaps, and known zero days. It failed at 4,456 ms CPU before repair.                                                                                                                                                                     |

The repaired read-only owner query covered four registered Projects and more than 400,000 observation links. Its direct
owner-adapter duration fell from 72,244 ms to 6,420 ms. The Core portion took 2,904 ms after repair. These measurements
are not a completed desktop/phone comparison or remote reconciliation.

Before the grant, the paired desktop browser loaded the real default all-Project report: HTTP 200 in 10,125 ms, with
201,938,962 bytes of full link evidence. Settings then returned HTTP 200 with zero approved Projects and zero delivery counts. DOM checks at
1440 × 1000 and at an emulated 390 × 844 both found the Usage heading and America/New_York, with no horizontal
overflow. The owner later confirmed the physical phone comparison described above. Screenshots first timed out because the browser helper used
incorrect Retina-scaled pointer and capture coordinates. At scale 1, real checkbox selection and save worked, and desktop
and mobile-emulation screenshots were captured and inspected. No product change was needed for that tool issue.
A later full report returned HTTP 200 in 25,195 ms with 202,878,963 bytes. Physical-device timing was not measured.

A readiness probe initially used the wrong Host header and rejected the expected HTTP 403. With the configured Host,
an anonymous request returned the expected HTTP 401. This was a probe error, not another product defect. Temporary
tracing was removed. The browser has no recorded JavaScript errors. Its network history retains earlier pairing and
502 failures; the fresh report and settings requests returned 200.

Three new recovery checks were first seen failing. Removing durable interior-corruption evidence also made the
recovery check fail; that mutation was removed. The existing distant-boundary test now checks durable gap evidence,
not a repair receipt that background recovery can legitimately consume before the next write. No test was removed.

## Verification and test accounting

The final focused portfolio passed: **36 files, zero failures, zero skips**, in 64.9 seconds through the isolated
runner. It includes the exporter, all changed producer/reporting tests, the real production-chain journey, journal
recovery/clear races, publication observations, target authority, worktree setup, and review consumers. After removing
a redundant post-fetch ref check, all nine target/setup/review files passed again in 6.4 seconds. Successful Git fetch
already proves the requested ref update; an unreadable extra check must not be treated as target absence.

Relative to the checkout base, affected tests increased from **132 to 172 declarations**, or **166 to 222 registered
cases** after parameterized expansion: **+40 declarations / +56 cases**. No whole baseline test was deleted.
Existing coverage changes are accounted for individually:

- Pending-clear owner API: the obsolete 400 and manual marker removal become readable 200, unchanged read-only intent,
  explicit clear, and settled zero. The original internal-code absence check remains.
- Guided Review partial cost: the conflated partial-token assertion becomes complete tokens plus independent partial
  cost. Aggregate count, measured zero, absent cost, and subtotal checks remain.
- Distant journal recovery: the transient append-result gap receipt becomes durable, exactly-once corrupt-line and
  measurement-gap checks. Old retries remain rejected and retained history remains checked.
- Shared review consumers: the original equality test expands to local and remote targets; all four consumer checks
  remain, with before-file and target-authority checks added.
- Publication before-observation process death: the old replay expectation is deliberately removed because historical
  reconstruction no longer exists. Restart must retain incomplete coverage and zero observations instead.
- Publication after-observation process death: exactly one durable observation remains protected.
- Lost publication checkpoint: renamed to state no replay; unchanged journal bytes and successful cleanup remain checked.
- Existing full/early publication, disabled/unwritable recording, user-file retention, opt-out cleanup, and restart-after-clear
  cases remain. The publication portfolio grows from 10 to 23 cases.
- CLI, installation, and existing execution identity/zero-cost checks remain, with cost-coverage assertions added.
  Delayed source-day attribution is new coverage, not a removed baseline case.

Bun 1.4.3 and both frozen dependency graphs passed without dependency changes. Final checks passed for 1,426 typed
source/test entries; Workspace check (200 files, zero errors, zero warnings, 32 hints); Workspace build; 67 explicit
format paths; zero injection seams; and relative links in 606 tracked Markdown files. This untracked evidence file's
relative links were checked separately. Whitespace and public/private evidence checks passed.

Full managed CI remains RunWield's post-implementation gate; the live child workflows' successful CI does not replace it.

## Hermetic acceptance

Test: `src/ui/workspace/usage-export-journey.integration.test.ts`.
Run with `bun scripts/run-tests.js src/ui/workspace/usage-export-journey.integration.test.ts`.

The test uses a sandbox HOME, a real Git Project, and `America/New_York`. Production Session runtime, pinned CLI stream
translation, Guided Review job handling, validation and repair, publication, recovery abandonment, owner API, package
install and approval, grants, journals, and worker export run together. The only scripted capabilities are upstream
model responses, external CLI output, human confirmation, and the remote HTTP service. A fresh host process reloads the
report and export state.

Expected numbers come from fixed upstream inputs, not from the reporter:

| Measure                                         | Local                            | Received remotely                                           |
| ----------------------------------------------- | -------------------------------- | ----------------------------------------------------------- |
| Authoritative model observations                | 9                                | 8                                                           |
| Known token subtotal                            | 48,192                           | 48,176 in metadata; 48,146 in native usage                  |
| Pi plus external-guide backend subtotal         | 126                              | One 16-token pre-grant turn is excluded                     |
| Claude token subtotal                           | 11,871                           | 11,871                                                      |
| agy token subtotal                              | 36,195                           | 36,195; cache-write bucket absent                           |
| Reported cost subtotal (USD)                    | 1.0594932                        | 0.0594932 native; partial guide subtotal 1 in metadata only |
| Calculated cost (USD)                           | 0.766466325                      | 0.641466325; pre-grant cost 0.125 excluded                  |
| Native total cost (USD)                         | Not a local complete-total claim | 0.700959525 across received observations                    |
| Published / validation attempts / repair rounds | 1 / 2 / 1                        | 1 / 2 / 1 completed repair observation                      |
| Ongoing / abandoned                             | 1 / 1                            | Abandonment exported; held workflow remains local           |
| All exported spans                              | Not applicable                   | 22 unique spans; 21 confirmed, 1 unconfirmed                |

The guide's input/cache basis is unknown, so its 30 known tokens stay in metadata rather than native usage. Its cost
subtotal sends no native cost or native model name. agy's token coverage is partial while its calculated cost is
complete. A disabled day has no measurement rows and a null trend point. The lost response concerns one received Pi
usage observation (16 tokens, USD 0.125); it stays unconfirmed through another cycle and host restart. Later work still
sends. Neither the pre-grant turn nor disabled work exports.

The test rejects duplicate span IDs and compares received identities with every eligible post-grant journal event.
It also checks that request bodies, journal records, and the owner response contain no private-content or credential
sentinels. Five deliberate regressions make the journey fail: zero-filled gaps, native partial cost, collection during
opt-out, resending an unconfirmed item, and private-path leakage. Each mutation was removed after the check.
