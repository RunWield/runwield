---
planId: "7c9a59b8-8747-454e-9d4d-cef8874374bb"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "HIGH"
affectedPaths:
    - "src/extensions/snip/index.js"
    - "src/extensions/snip/leading-simple-command.ts"
    - "src/extensions/snip/index.test.js"
    - "scripts/bun-test-files.json"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-20"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
---

# Fix Snip Shell-Command Wrapping

## Context

In the v0.12.3 tester study, Alex's agent ran a valid `for … do … done` loop. RunWield's Snip integration rewrote it to
`( …; snip run -- for f in … 2>"$runwield_snip_stderr"; …; exit … ); do echo …`. The wrapper closed before `do`, and
Bash rejected the command with `syntax error near unexpected token 'do'`.

Evidence: `/Users/gandazgul/Documents/web/Codex/2026-10-18/task-3/study/coordinator/snip-shell-syntax-evidence.json`
(original command `bash -n` exit 0, rewritten command exit 2).

**The defect still exists on current `main`.** Planning reproduced it with the pure rewrite function only (no command
was executed): `__testing.rewriteCommand(<historical command>)` returns a string byte-identical to the study's
transformed command.

### Root cause

The rewrite lives in `src/extensions/snip/index.js`, registered for unrestricted Pi Sessions in
`src/shared/session/session.js` when the `snip` binary exists.

```text
tool_call(bash)
  rewriteCommand(command)
    findFirstSegmentEnd   # cuts at the first unquoted ; | && or newline
    parseSimpleSegment    # treats the first word after assignments as an executable
    withFilteredSnipStderr("snip run -- <segment>")  +  <rest unchanged>
```

The scanner knows quotes and four separators. It does not know shell grammar. So it treats any first word as an
executable name and appends the wrapper at the first separator it finds. Planning confirmed these failures on current
code:

| Input class                           | Example                                          | Current result                                                                             |
| ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Loops, conditionals, `case`, `select` | `for f in a b; do echo $f; done`                 | syntax error (exit 2)                                                                      |
| Functions, groups, subshells          | `f() { echo hi; }; f`, `{ echo a; }`, `(echo a)` | syntax error                                                                               |
| Comments                              | `ls # c; echo b`                                 | syntax error (comment eats the wrapper's `)`)                                              |
| Keywords as executables               | `! false`, `[[ -n x ]]`, `time …`                | valid syntax, wrong behavior (`! false` exits 127)                                         |
| Line continuation                     | `ls \`⏎`  /path`                                 | second line runs as a separate command                                                     |
| Escaped separator                     | `printf a\;b`                                    | cut inside the word                                                                        |
| Stderr redirection                    | `cmd 2>&1 \| cat`, `cmd 2>/dev/null`             | RunWield's `2>"$file"` comes last and wins: stderr leaves the pipe, `/dev/null` is ignored |
| Deno stdout redirection               | `deno test > out.txt`                            | RunWield's `>"$stdout"` wins, `out.txt` stays empty                                        |

This is a RunWield integration defect. Snip itself was not involved in any failure; Snip's own `snip hook` declines the
same loop.

### PRD

[Core PRD → Project context and initialization](../prd/runwield-core-prd.md#project-context-and-initialization) lists
**Snip:** optional filtering of command output into compact diagnostics. `docs/domain-language.md` defines Snip as an
optional, fail-open optimization for **eligible** agent shell commands. This Plan defines eligibility precisely and
adds that clarification to the Core PRD Snip bullet. The glossary definition already fits and does not change.

## Objective

RunWield wraps an agent shell command with Snip only when the command starts with a plain simple command whose grammar
and behavior the wrapper provably preserves. Every other command passes through byte-for-byte unchanged. A wrapped
command keeps its exit status, working directory, environment, quoting, redirections, stdout/stderr destinations, and
runs exactly once, under the existing Snip contract (filtered no-filter notice, Deno failure-log pointer).

## Approach

Replace the ad-hoc scanner with one conservative recognizer. It accepts a small, explicit subset of shell and returns
"not wrappable" for anything else. Bypass is always safe; a guess is not.

> [!TIP]
> **Allowlist, not denylist**
>
> Adding `for` to a keyword list would fix the reported case only. The recognizer instead accepts only what it fully
> understands, so a construct nobody listed falls through to "run unchanged".

### Recognizer contract

`src/extensions/snip/leading-simple-command.ts` exports `parseLeadingSimpleCommand(command)`. It scans the whole
string once with correct quote rules and returns either `null` or the leading command split from the rest:

```text
parseLeadingSimpleCommand(command)
  scan with shell quoting:
    '…'   literal, backslash is NOT an escape
    "…"   backslash escapes; $( or ` inside → null
    \x    unquoted escape; backslash-newline → null
  stop at the first unquoted boundary: ; (not ;;)  &&  ||  |  newline
  return null when the leading command contains, unquoted:
    ( or )                 subshell, function, $( ), <( ), >( ), (( )), arrays
    $( or `                command substitution (existing rule)
    # at word start        comment
    single &               background job
    << (not <<<)           here-document
    unterminated quote
  words = leading command words
  skip NAME=value assignments → null if no command word
  null when the command word is a reserved word or starts with a redirection:
    ! { } [[ ]] case coproc do done elif else esac fi for function if in select then time until while
  return { envPrefix, commandText, commandName, words, stderrRedirected, stdoutRedirected, rest }
```

`stderrRedirected` is true for any redirection that changes fd 2 (`2>`, `2>>`, `2>&…`, `&>`, `&>>`, `>&word` where word
is not a digit or `-`) and when the boundary is `|&`. `stdoutRedirected` is true for redirections of fd 1 (`>`, `>>`,
`1>`, `>|`, `>&N`).

### Policy stays in `index.js`

`rewriteCommand` keeps its current policy decisions and adds two:

```diff
 rewriteCommand(command)
-  segment = command.slice(0, findFirstSegmentEnd(command))
-  parsed  = parseSimpleSegment(segment)
+  parsed  = parseLeadingSimpleCommand(command)
   if !parsed → null
   if snip / shell builtin → null
+  if parsed.stderrRedirected → null
   if git diff / NO_REWRITE_PREFIXES → null
   wrap parsed.commandText, append parsed.rest
```

`SHELL_BUILTINS` grows to include builtins that read or change shell state and have no equivalent external program:
`declare`, `typeset`, `local`, `readonly`, `let`, `wait`, `getopts`, `shopt`, `hash`, `builtin`, `enable`, `mapfile`,
`readarray`, `dirs`, `disown`, `kill`, `times`, `caller`, `logout`, `suspend`, `bind`, `fc`, `history`, `complete`,
`compgen`, `compopt`, `help`, `:`.

### Wrapper redirection order

The plain wrapper already puts the user's redirections before RunWield's `2>"$file"`. With fd-2 redirections bypassed,
the remaining user redirections (`> file`, `>&2`, `< file`, `<<< word`, `3> file`) keep their meaning, so the plain
wrapper does not change.

The Deno failure-label wrapper also overrides stdout. It changes to capture around a group, so the user's redirections
apply first:

```diff
-SNIP_TEE=0 ${command} >"$runwield_snip_stdout" 2>"$runwield_snip_stderr";
+{ SNIP_TEE=0 ${command}; } >"$runwield_snip_stdout" 2>"$runwield_snip_stderr";
```

### Stderr redirections bypass Snip (decision)

| Option                                | `deno test 2>&1 \| tail`     | `cmd 2>/dev/null`  | Cost                                                                                                             |
| ------------------------------------- | ---------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Bypass fd-2 redirections (chosen)** | runs unwrapped, uncompressed | silent, as written | Lose Snip compression on this common pattern                                                                     |
| Group capture, keep wrapping          | compressed                   | silent             | Snip's `no filter for …` notice goes into the user's stream (pipe, file), changing output such as `wc -l` counts |
| Today                                 | stderr leaves the pipe       | stderr shown       | Wrong behavior                                                                                                   |

The request says to bypass when wrapping cannot be safe, and Snip has no setting to silence its notice. So the chosen
option is a direct consequence of the stated requirements. It is a reviewable choice: if compression of `2>&1`
pipelines matters more than the notice, the group-capture option is a small follow-up.

### Set aside

- **A shell parser dependency** (for example a WebAssembly build of `mvdan/sh`). It adds a runtime dependency to the
  compiled binary for an optional optimization, and the rewrite still needs to re-emit text safely.
- **A runtime `bash -n` check** of the rewritten text. It costs a subprocess on every bash call and catches syntax
  only, not behavior such as `! false`.
- **Delegating to `snip hook`.** It would drop RunWield's no-filter notice filtering and Deno failure logs, which is a
  contract change.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

```diff
 src/extensions/snip/
+├── leading-simple-command.ts   # shell-grammar recognizer: wrappable leading command or null
 ├── index.js                    # policy + wrapper; drops findFirstSegmentEnd/hasCommandSubstitution/parseSimpleSegment
 └── index.test.js               # construct matrix, historical regression, redirection behavior
```

- `src/extensions/snip/leading-simple-command.ts` — new TypeScript module; owns the one decision "which leading
  command is safe to wrap".
- `src/extensions/snip/index.js` — uses the recognizer, extends `SHELL_BUILTINS`, bypasses fd-2 redirections, groups
  the Deno label wrapper. `getDenoValidationFailureLabel` and `isGitDiffCommand` keep working on the recognizer's words.
- `src/extensions/snip/index.test.js` — regression and behavior matrix.
- `scripts/bun-test-files.json` — only if a new test file is added (for example a recognizer unit test).
- `docs/prd/runwield-core-prd.md` — Snip bullet states eligibility and pass-through.

Not changed: `src/shared/session/session.js` registration, `src/shared/bash-command-policy.ts` (separate allowlist
purpose), `scripts/run-with-snip.ts` (argument-vector execution, no shell text), upstream Snip, `docs/domain-language.md`.

## Reuse Opportunities

- `scripts/bash-fixture.ts` — `bashFixtureExecutable()` and `quoteBashFixture()` for real Bash runs, including Git Bash
  on Windows.
- `src/shared/captured-process.ts` — `captureForegroundProcess` as the existing tests use it.
- The existing fake-Snip pattern in `index.test.js`: a Bash function named `snip` defined in the `-c` prefix, so no real
  Snip binary is needed.
- `src/extensions/snip/index.js` `__testing` export for direct calls to `rewriteCommand`.

## Implementation Steps

- `src/extensions/snip/index.test.js` contains a regression test that holds the historical study command as a string
  and asserts that `__testing.rewriteCommand(historical)` is `null`, and that `bash -n -c <historical>` exits 0. The
  historical command is only syntax-checked, never executed. Run against unmodified code, this test fails; record that
  red result before changing source.
- `src/extensions/snip/index.test.js` contains a construct matrix in which every case declares `wrap` or `bypass`.
  For every case:
    - `bypass` cases: `rewriteCommand` returns `null`.
    - `wrap` cases: `rewriteCommand` returns a string that contains `snip run -- ` and passes `bash -n`.
    - Behavior: the original and the rewritten command each run in their own fresh temporary directory under real Bash
      with a fake `snip` function that checks for `run --`, appends one line to a call log outside the directory, and
      runs `"$@"`. Stdout, stderr, exit code, and the resulting directory contents are equal. A `wrap` case logs
      exactly one Snip call; a `bypass` case logs none.
- The matrix covers at least these harmless fixtures (`printf`, `sh -c`, `cat`, `grep`, `true`, `false`, files in the
  temp directory):
    - **bypass:** `for` loop (the reported shape, with `|| :` inside), `while`, `until`, `select` (syntax-only),
      `if/then/else/fi`, `case … esac`, `f() { …; }; f`, `function g { …; }`, `{ …; }`, `( … )`, `! false`,
      `[[ -n x ]]`, `time true`, `x=$(printf a); printf "$x"`, `` printf `printf a` ``, `cat <(printf a)`, here-document
      `cat <<EOF …`, `cmd # comment; more`, backslash-newline continuation, `sh -c '…' & wait`, `cmd 2>&1 | cat`,
      `cmd 2>/dev/null`, `cmd &> file`, `cmd |& cat`, assignment only `x=1`, `declare x=1; printf "$x"`, `cd sub && pwd`.
    - **wrap:** `ls -la`-style plain command, `FOO=1 sh -c 'printf "$FOO"'` (environment reaches the command),
      `false && printf no` and `false || printf yes` (exit status drives the chain), `printf a | wc -c`, `printf a; for x in
b; do printf $x; done` (leading command wrapped, loop in the rest unchanged and valid), quoted separators
      `printf '%s' 'a;b' "c|d&&e"`, single-quoted backslash `printf '%s' 'a\'; printf b`, escaped separator
      `printf a\;b`, `printf o > out.txt`, `printf e >&2`, `cat < in.txt`, `cat <<< word`, newline-separated
      `printf a⏎printf b`, and a command run from a subdirectory proving `pwd` is unchanged.
- `src/extensions/snip/leading-simple-command.ts` exports `parseLeadingSimpleCommand` implementing the recognizer
  contract in Approach, and `src/extensions/snip/index.js` no longer defines `findFirstSegmentEnd`,
  `hasCommandSubstitution`, or `parseSimpleSegment`.
- `rewriteCommand` returns `null` when the recognizer returns `null`, when the command word is `snip` or in
  `SHELL_BUILTINS` (extended as listed in Approach), or when the leading command redirects stderr; otherwise it wraps
  only the leading command and appends the rest byte-for-byte.
- The Deno failure-label wrapper in `withFilteredSnipStderr` captures around `{ …; }`. A test with a fake `snip` that
  prints fixed output (it never runs real `deno`) shows `deno test > out.txt` writes the output to `out.txt` on success
  and prints nothing to stdout.
- All six existing tests in `src/extensions/snip/index.test.js` pass with their current expectations unchanged.
- `docs/prd/runwield-core-prd.md` Snip bullet reads, in substance: optional, fail-open filtering of command output into
  compact diagnostics; RunWield wraps only a leading plain command and passes every other shell construct through
  unchanged, preserving syntax, exit status, and output destinations.
- If a new test file is added, it is listed in `scripts/bun-test-files.json`.

## Verification Plan

- Red: before source changes, run `bun scripts/run-tests.js src/extensions/snip/index.test.js` with only the new tests
  added. The historical regression and the matrix fail (at least the loop, comment, `! false`, continuation, escaped
  separator, `2>&1`, and Deno `> out.txt` cases). Record the failing names.
- Green: `bun scripts/run-tests.js src/extensions/snip/index.test.js` passes after the change.
- Historical command, syntax only: `bash -n -c` on the original exits 0; `rewriteCommand` returns `null`, so no
  rewritten form exists. Never run the historical command; it reads branches and would operate on a repository.
- Stub detection: a `rewriteCommand` that always returns `null` fails every `wrap` case (no Snip call logged). One that
  only adds `for` to a keyword list fails the comment, continuation, `! false`, escaped separator, and redirection cases.
  One that wraps but drops `rest` fails the chain and newline cases.
- Static checks on touched files: `bun run fmt:check <touched files>`, `bun run seams:check`.
- Full: `bun run ci`. RunWield runs it after implementation.
- Report: root cause, changed files, red/green output, test count in `index.test.js` before (6) and after, and every
  check as passed, failed, or not run.

Behavior that must stay protected (existing tests): Deno label wrapping (`tests`, `lint`, …), env-prefix placement,
`&&` chains, builtin and `cd` bypass, `git clone`/`git worktree`/`git diff` bypass, `snippets list` wrapping, command
substitution bypass, no-filter notice removal with unchanged stdout and exit status, and the filtered Deno failure log.

Behavior expected to stop: wrapping of commands that start with a keyword or compound construct, contain a comment,
continuation, here-document, background `&`, process substitution, or redirect stderr (including `|&`). These now run
unchanged without Snip.

## Edge Cases & Considerations

- **Less compression for `2>&1` pipelines.** Agents often run `deno test 2>&1 | tail`. These now bypass Snip. This is
  the chosen trade-off; see Approach.
- **Stderr gains a trailing newline when wrapped.** The existing `grep` filter adds a final newline to stderr without
  one. This is current contract behavior; matrix fixtures emit newline-terminated stderr so equality checks stay exact.
- **Wrapped builtins with external twins** (`printf`, `echo`, `test`, `[`, `true`, `false`, `pwd`) stay wrappable, as
  today. Existing tests depend on `printf` wrapping. Assumption: their external versions are equivalent enough for agent
  use.
- **Windows.** Tests use `bashFixtureExecutable()` so Git Bash runs the same matrix. Skip `select` behavior (syntax-only).
- **Fail-open stays.** The handler's `try/catch` still runs the original command if the recognizer throws.
- **Restricted Sessions are unaffected.** They never load the Snip extension (ADR-002).
