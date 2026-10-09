# Sleep

You are running RunWield sleep mode to keep long-term memory current and useful.

## Goal

- Preserve current durable decisions, preferences, constraints, rationale, and reusable lessons.
- Correct or remove misinformation, deprecated guidance, duplicates, and superseded memories.
- Remove routine release dates, commit hashes, completed PR inventories, one-off test counts, and task-completion
  receipts. Extract a durable lesson first when one exists; otherwise retain no active memory of the bookkeeping.
- Keep historical detail only when it explains a still-relevant decision. State the current rule directly rather than
  quoting an obsolete claim beside a correction.
- Keep core memories limited to critical, frequently needed guidance. Memory-count reduction is not a goal.

## Memory Authority

Core memories are strong guidance; other memories are useful, non-authoritative context. Neither overrides the user,
current project documentation, the applicable Plan, or code as evidence of implemented behavior. The user decides
intent; docs and Plans define applicable requirements and scope; code establishes what is implemented. Resolve memory
conflicts against those authorities without treating current implementation as a veto on requested changes. Do not
present proposed work or unverified recollections as current facts.

## Safety Rules

- Age, verbosity, completion, or discoverability in source code alone is not a reason to delete useful durable context.
  Routine bookkeeping is removable because it has no lasting guidance value, not merely because the work is complete.
- Do not collapse distinct decisions merely because they concern the same feature. Preserve still-relevant scope,
  rationale, constraints, and exceptions.
- A consolidation must retain every still-useful durable fact from its sources. Verify current claims against the
  relevant authority; do not preserve false guidance in the replacement for the sake of textual completeness.
- Add and verify any replacement before deleting its source memories. A purely episodic receipt needs no replacement;
  record why it contains no durable lesson and retain its original content in the maintenance backup and manifest.
- Prefer demoting a memory from `core` to regular over deleting it when the content remains useful but is not needed in
  every session. Neither tag makes a memory authoritative.
- Preserve unrelated durable memories. If current truth or lasting relevance is uncertain, investigate or explicitly
  preserve the uncertainty; do not silently discard context or label an unverified claim as current.

## Process

1. Analyze the pre-maintenance export supplied by RunWield. Compare potentially outdated claims with the user’s current
   decisions and applicable docs, Plans, and code. Classify proposed changes as one of:
   - exact duplicate;
   - deprecated or contradicted by an identified current authority;
   - superseded by an identified replacement;
   - consolidation preserving current durable understanding;
   - routine bookkeeping without a durable lesson, or with its lesson extracted;
   - core-tag promotion or demotion;
   - keep, with uncertainty identified when applicable.
2. Before mutating Mnemoteca, write a timestamped deletion manifest in the supplied session artifact directory. For
   every proposed deletion, record the memory ID, full content and tags, classification, reason, and replacement or
   current authority. For routine bookkeeping, record the extracted lesson or why no replacement is needed.
3. If the proposal would delete more than 25 memories or more than 10% of the collection, whichever threshold is reached
   first, stop before mutation and ask the user to review the immutable backup and manifest. Continue only after
   explicit approval.
4. Apply approved changes. Add and verify replacements before deleting their source memories. Move memories between core
   (`--tag core`) and regular storage as needed; core is for critical, frequently needed guidance only.
5. Export the post-maintenance collection to a separate file in the supplied session artifact directory and verify:
   - every untouched memory is still present with its original content and tags;
   - every deletion appears in the manifest with its verified replacement, authority, or bookkeeping rationale;
   - replacements preserve still-useful facts, rationale, constraints, and exceptions and state current guidance
     clearly;
   - no obsolete claim or proposed behavior is presented as implemented truth.
6. Report counts for kept, promoted, demoted, consolidated, and deleted memories, plus the backup, manifest, and
   post-maintenance export paths. Explain the reason for each removal category and disclose the review’s limits; do not
   claim the entire collection is current unless it was actually checked.

Delete with `mnemoteca delete [memory id]` and add with `mnemoteca add [memory content] --tag tag1 --tag tag2`.
