# tgrep Evaluation

**Researched:** 2026-09-11 (America/New_York)\
**Status:** Evaluated; adoption deferred.

## Question

Should RunWield Core use Microsoft's tgrep to accelerate local regex search in large repositories?

## Decision

Keep ripgrep for the current `grep` tool and keep Cymbal for code navigation. Defer tgrep adoption. It remains a
candidate for faster search in large repositories, not a committed product requirement or a rejected technology.

This research note records the evaluation. No PRD change or ADR is needed: no new product requirement or lasting
architectural commitment was made.

## Findings

- tgrep uses a trigram index to select candidate files before regex matching. Its project reports use in GitHub Copilot
  CLI, provides an MIT license, and publishes binaries. The release page showed v1.0.7 with a watcher fix at review
  time. Sources: [README](https://github.com/microsoft/tgrep), [releases](https://github.com/microsoft/tgrep/releases).
- The project's benchmarks report substantial gains on large repositories. They measure searches with an index already
  built and a server running; they do not include initial index construction. Results vary by platform and query. In the
  published suite, ripgrep narrowly wins on Kubernetes under Linux. These are upstream results, not RunWield
  measurements. Source: [benchmarks](https://github.com/microsoft/tgrep/blob/main/BENCHMARKS.md).
- Indexed searches can miss recent edits because watcher updates are asynchronous. A server with no initial index
  returns no matches until its first build completes. A disk-only index does not refresh on search. The documented way
  to search current files is `--no-index`, which gives up indexed search. Source:
  [agent guide, freshness and startup behavior](https://github.com/microsoft/tgrep/blob/main/AGENTS.md).
- RunWield's [grep wrapper](../../src/tools/grep.ts) delegates to Pi's grep. The installed Pi 0.85.1 implementation in
  `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/grep.js` invokes ripgrep with `--hidden`. tgrep bypasses
  its index when this flag is present. A simple executable replacement would therefore lose the expected index benefit.
  Source: local installed code and
  [tgrep flag behavior](https://github.com/microsoft/tgrep/blob/main/README.md#flags-that-bypass-the-index).
- Search coverage also differs: tgrep defaults to a 64 MiB file-size cap and rejects some binary extensions during
  traversal. ripgrep has no default size cap. tgrep documents further differences for invalid UTF-8. Source:
  [compatibility details](https://github.com/microsoft/tgrep/blob/main/README.md).
- tgrep's fastest mode adds a server and an index. Its default index location is `.tgrep/`, but a custom location is
  supported. It does not replace Cymbal's symbol and relationship tools. Sources:
  [tgrep README](https://github.com/microsoft/tgrep), [RunWield Cymbal tools](../../src/extensions/cymbal/tools.ts).

## Inference

Faster repeated searches could help Agents working in large repositories. However, an Agent must find code it just
created or changed. Silent missing results can cause incorrect decisions. The current freshness and hidden-file behavior
make tgrep unsuitable as a direct replacement without further evidence and integration work.

Adding another index and server also adds setup, resource use, and worktree management costs. The published query gains
alone do not show that this trade is worthwhile for RunWield users.

## Revisit When

- Measured search delays in representative user repositories justify another search dependency.
- A comparison includes cold startup, repeated searches, index maintenance, and execution worktrees—not only warm
  queries.
- Tests show that edits, new files, deletions, and branch changes do not cause missing results in the proposed use.
- Hidden-file and other search coverage remain equivalent to the current tool, or a deliberate difference is approved.

## Evidence Limits

This was a documentation and source review. No local tgrep benchmark or runtime correctness test was run. Upstream links
refer to changing documents; verify them against the release under consideration before adoption.
