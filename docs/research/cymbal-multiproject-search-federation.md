# Cymbal Multi-Project Search Federation

**Researched:** 2026-07-20

## Question

Can RunWield Workspace provide explicit multi-Project code search by federating existing per-Project Cymbal indexes,
without adding Sourcebot or merging every Project into one shared index?

This research informs the Workspace code-search boundary.

## Decision

The first Personal Remote Workspace will include RunWield-owned Cymbal federation as its built-in human-facing
cross-Project code search. Queries require explicit registered-Project selection and remain separate from durable
artifact intelligence. Agent code tools remain Project-scoped. Sourcebot is deferred as an optional future provider for
organization-scale or remote committed-code search.

## Findings

- The installed Cymbal `v0.14.0` stores one SQLite index per repository or worktree by default. Indexes live in an OS
  cache directory and can be selected explicitly with `--db` or `CYMBAL_DB`. Source: local `cymbal --version`,
  `cymbal --help`, and upstream [README](https://github.com/1broseidon/cymbal#how-it-works).
- `cymbal ls --repos --json` already enumerates all locally known indexes with each repository path, database path, file
  count, and symbol count. The local machine used for this research contained indexes for several main checkouts and
  many RunWield worktrees. Source: local `cymbal --json ls --repos` on 2026-07-20.
- Cymbal queries auto-build an absent index and incrementally refresh changed files before searching. No daemon or file
  watcher is required. This includes current working-copy changes rather than only committed Git revisions. Source:
  [Cymbal README](https://github.com/1broseidon/cymbal#how-it-works).
- Symbol and full-text searches support structured JSON output, path/language/kind filters, exact search, exclusions,
  and bounded result limits. Source: local `cymbal search --help` and
  [command documentation](https://github.com/1broseidon/cymbal/blob/main/docs/reference/commands.md).
- Cymbal already federates symbol-oriented lookup commands across indexed sibling Git worktrees. Results identify the
  source worktree, while graph traversal remains within the worktree that owns the seed symbol to avoid creating false
  cross-branch relationships. Source:
  [Cymbal worktree documentation](https://github.com/1broseidon/cymbal#git-worktrees).
- Current built-in federation is worktree-family federation, not arbitrary repository federation. A search launched in
  one main checkout does not search unrelated repository indexes. Source: local `cymbal --json search SessionRuntime`
  and upstream worktree documentation.
- Cymbal's JSON symbol-search results provide symbol name, kind, absolute and relative paths, lines, signature,
  language, and optional worktree identity. The current output does not expose a comparable numeric relevance score for
  merging rankings from independently queried Projects. Source: local `cymbal --json search SessionRuntime --limit 3` on
  2026-07-20.
- Cymbal is MIT licensed and exposes its indexing/query engine as a Go library, although RunWield can avoid embedding Go
  or CGO by using the existing CLI JSON contract. Sources: [Cymbal README](https://github.com/1broseidon/cymbal),
  [library guide](https://github.com/1broseidon/cymbal/blob/main/docs/guide/library.md).

## Inference

RunWield does not need to combine Cymbal databases physically. Workspace can act as a bounded query coordinator:

1. Resolve explicitly selected registered Projects.
2. Run the same bounded Cymbal JSON query in each Project root, preferably in parallel with a concurrency cap.
3. Disable sibling-worktree federation for global main-checkout search so Plan worktrees do not create duplicate or
   private intermediate results.
4. Attach canonical Workspace Project identity to every result.
5. Group results by Project or apply a small RunWield ranking layer.
6. Route follow-up source, outline, reference, impact, or trace operations back to the specific Project that produced
   the selected result.

This preserves each Project's index and trust boundary while providing one Workspace experience. It also preserves
working-copy truth, which is the primary weakness of Sourcebot for the personal Workspace.

Cymbal's lack of a cross-repository relevance score is not blocking for the first product. Grouping by Project is more
honest than pretending separately ranked result sets have one mathematically meaningful ordering. Exact symbol matches
can still precede prefixes and fuzzy matches using explicit query/result properties.

Relationship and impact queries should remain Project-scoped. Running independent reference searches across selected
Projects is possible, but RunWield should not connect call graphs across repositories unless it has evidence for the
cross-repository dependency. Otherwise identical symbol names would create false architecture.

## Recommendation

Use **RunWield-owned Cymbal federation as the built-in personal Workspace code search**:

- `Project code search` continues to use Cymbal directly in the active Project.
- `Cross-Project code search` requires explicit Project selection and fans out bounded Cymbal queries only to those
  registered Projects.
- Workspace renders Project-grouped results with relative paths, symbol metadata, index health, and freshness.
- Selecting a result opens the Workspace code viewer or the main-checkout Code Surface at that Project and location.
- Existing Plan worktrees are excluded from global search unless the user explicitly selects a worktree-aware Plan
  context.
- The current Agent `code_search` tool remains Project-scoped. A future cross-Project Agent search must be a separate,
  explicitly scoped capability rather than silently broadening `code_search`.
- Sourcebot remains an optional later provider for organization-scale committed-code search, remote repositories, and a
  richer dedicated code browser.

This approach is substantially lighter than Sourcebot for the personal proof and aligns with RunWield's existing Cymbal
requirement.

## Risks and Limits

- Query fan-out starts one Cymbal process per selected Project. This is suitable for a personal Workspace with dozens of
  Projects but may need a service or native federation support at organization scale.
- First queries can trigger index creation or refresh. Workspace needs visible indexing state, cancellation, bounded
  concurrency, and partial-result behavior.
- `cymbal ls --repos` contains every historical local index, including stale worktrees. Workspace must never treat that
  global list as authorization. Only registered, eligible, explicitly selected Projects may be queried.
- Absolute filesystem paths from Cymbal must be converted to safe Project-relative locations before reaching the browser
  or an Agent.
- Duplicate symbols across Projects are expected. Results need Project identity and should not be silently collapsed.
- Cymbal supports many programming languages but does not parse every file type. Ordinary text search remains necessary
  for unsupported or dynamic sources.

## Open Questions

- Would Cymbal accept an upstream arbitrary-repository federation command that takes an allowlisted set of database
  paths and returns Project-tagged results?
- Should Workspace group results by Project, or offer an optional cross-Project relevance mode after Cymbal exposes
  comparable scores?
- What concurrency and per-Project result limits preserve responsive searches on a developer laptop?
- Should selected Plan worktrees ever participate in human cross-Project search, or remain visible only through their
  Plan workflow surface?
