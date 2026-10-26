---
planId: "c500158b-9338-4bbd-8c06-82d231f30dda"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "LOW"
affectedPaths:
    - "src/shared/remote/host-confirmation.ts"
    - "src/cmd/remote/index.ts"
    - "src/shared/session/file-session-storage.ts"
    - "src/shared/session/file-session-store-types.ts"
    - "src/shared/remote/memory-binding.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-25T21:51:42Z"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 12
dependencies:
    - "04-run-and-resume-remote-sessions-with-local-history"
    - "05-keep-memory-and-integrations-on-their-owning-machine"
userVerifiedAt: null
targetBranch: "epic/remote-ssh-development"
status: "implemented"
---

# Confirm a Partly Matching Remote Host

## Context

Saved remote history belongs to an exact host identity plus the canonical remote project root. Host identity is the
effective SSH hostname, user, port, and verified host-key fingerprint (`RemoteHostIdentity` in
`src/shared/remote/target.ts`). Two places enforce it today:

- `ensureRemoteProject` in `src/shared/session/file-session-storage.ts` hashes the identity into the `projectId` when the
  first Session is created.
- `#projectMatches` in `src/shared/remote/laptop-session-control.ts` filters `/resume`, `begin`, and `export` to the
  exact identity.

An alias rename already matches, because identity uses the effective hostname from `ssh -G`. Two cases still lose access
to saved history:

- **Address change.** The same server is reached by another hostname or port (for example an IP address instead of a DNS
  name). The host key is the same.
- **Key change.** The server's host key changed (for example after a reinstall), and the user accepted the new key in
  OpenSSH. The hostname, user, and port are the same.

Child 04 moved the confirmation prompt for these cases here. The Epic rule: "Neither alias spelling nor a host-key
fingerprint alone is sufficient. Ambiguous equivalence requires confirmation, not automatic history merging."

Owning requirement: [Core → Keep a remote project locator separate from execution
cwd](../../prd/runwield-core-prd.md#project-context-and-initialization). It currently says a changed hostname, port, or
fingerprint "creates a distinct target and never merges history" and that "Ambiguous host confirmation for Sessions
remains target scope." The transient [Remote SSH PRD](../../prd/remote-ssh-prd.md#local-memories-and-saved-sessions)
says the same. This child delivers that target scope.

## Objective

When a connection partly matches a saved remote project, `wld remote` asks once, before the TUI opens, whether it is the
same server. Yes makes the connection use the saved project and its Session history. No keeps a separate target. The
answer is saved and a later connection does not ask again. History is never merged without a Yes.

## Approach

**Resolve one canonical host identity at connect time, and keep exact matching everywhere else.** A new module decides
which saved identity this connection uses. Everything downstream receives that identity and keeps its exact comparison:

```text
runRemoteCommand (src/cmd/remote/index.ts)
  resolveRemoteTarget            → observed host identity
  ...runtime and helper setup (unchanged)
+ confirmRemoteHost(target)      → same target, host replaced by the canonical identity
  bindRemoteMemory(...)          → see the Memory question below
  startRemoteControlService({ target: confirmed, ... })
    LaptopSessionControl         → exact #projectMatches / ensureRemoteProject, unchanged
```

Because the confirmed target carries the saved project's `remote.host`, `ensureRemoteProject` hashes the same
`projectId` and `#projectMatches` succeeds. Neither function changes.

> [!TIP]
> **One decision point, not several**
>
> Teaching `#projectMatches`, `ensureRemoteProject`, and the Memory key about equivalent hosts would encode the same rule
> in three modules. Substituting the canonical identity once keeps the rule in one owner.

**The project record keeps the answers.** `RemoteProjectLocator` gains two optional lists. The project record is
already the source of truth for which host owns that history, so the answers live beside it:

```diff
 export interface RemoteProjectLocator {
     host: RemoteHostIdentity;
     root: string;
     targetLabel?: string;
+    /** Identities the user confirmed are this project's server. */
+    acceptedHosts?: RemoteHostIdentity[];
+    /** Identities the user said are a different server. */
+    refusedHosts?: RemoteHostIdentity[];
 }
```

**The decision rule.** For each saved remote project, compare the observed identity with `remote.host` and every entry
in `acceptedHosts`:

```text
confirmRemoteHost(target)
  exact = a project whose remote.host equals the observed identity and root
  if exact → return target unchanged
  accepted = a project whose acceptedHosts contains the observed identity, same root
  if accepted → return target with host = accepted.remote.host
  partial = projects with the same root and the same user, where the observed identity is not
            in refusedHosts, and some compared identity has
              (same non-null fingerprint, different hostname or port)  → "address changed"
           or (same hostname and port, different fingerprint)           → "host key changed"
  if none → return target unchanged (new target, nothing saved)
  ask once, listing each partial project with its reason
    choice n → add observed identity to project n's acceptedHosts; return host = project n's remote.host
    choice 0 → add observed identity to refusedHosts of every listed project; return target unchanged
    cancel or invalid → throw before the TUI opens; save nothing
```

A different user, a different root, or a different hostname-or-port together with a different fingerprint is never a
partial match. Two `null` fingerprints are not the same key. Comparing against `acceptedHosts` lets a second change
(for example, a key change after an address change was accepted) still find the project.

**The prompt follows the existing Memory question.** `bindRemoteMemory` already asks a numbered question through
`globalThis.prompt` and saves the answer before the TUI opens. This prompt uses the same form:

```text
dev@10.0.0.5:22 /home/dev/proj partly matches saved remote history.
1. sct:/home/dev/proj — dev@sct.example:22. Same host key SHA256:abc…; hostname or port changed.
2. box:/home/dev/proj — dev@10.0.0.5:22. Host key changed from SHA256:old… to SHA256:new…
   OpenSSH accepted the new key. Choose this only if you expect the change.
0. No: keep a separate history
Is this the same server? Choose 0–2:
```

**Memory follows the Session answer — open decision.** The Memory key is lower-case hostname, user, port, and root, with
no host key. A key change therefore keeps the same Memory collection already. An address change starts a new collection
and can trigger the folder-name Memory question again.

> **Question (memory-follows-confirmation):** After the user confirms that a partly matching host is the same server, should remote Memory also use the saved project's collection? Yes passes the confirmed target to bindRemoteMemory, so an address change keeps its memories with no second question. No keeps Memory on the observed hostname, which starts a new collection after an address change.
>
> **Answer:** Yes (answered in review)

Recommendation: Yes. One answer about "the same server" then means the same thing for history and memories, and it is a
one-line difference in `src/cmd/remote/index.ts`. With No, the Memory key stays tied to the observed hostname.

**Set aside:** a separate binding-file directory like `~/.wld/remote-memory-bindings`. It mirrors the Memory pattern but
puts project identity outside the project record, and a chained change (address, then key) would need a directory scan
to find the project.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/remote/host-confirmation.ts` (new) — owns the decision rule, the prompt, and the canonical identity.
- `src/shared/remote/host-confirmation.test.ts` (new) — behavior tests against real file Session storage.
- `src/shared/session/file-session-store-types.ts` — `acceptedHosts` and `refusedHosts` on `RemoteProjectLocator`.
- `src/shared/session/file-session-storage.ts` — one function that adds an identity to either list and writes the
  project record atomically. The project record's writer stays in this module.
- `src/cmd/remote/index.ts` — calls `confirmRemoteHost` before `bindRemoteMemory` and passes the confirmed target on.
- `src/shared/remote/memory-binding.ts` — no change expected; it receives the confirmed or observed target depending on
  the Memory decision.
- `docs/prd/runwield-core-prd.md`, `docs/prd/remote-ssh-prd.md` — the locator requirement and scenarios.
- `docs/domain-language.md` — the **Remote project locator** entry (and **Remote Memory key** if Memory follows).

Deliberately unchanged: `#projectMatches`, `ensureRemoteProject`, `listSavedRemoteSessions`, and `wld remote sessions`.
They keep exact matching on the stored identity.

## Reuse Opportunities

- `bindRemoteMemory` in `src/shared/remote/memory-binding.ts` — the numbered `globalThis.prompt` question, its
  cancel/invalid handling, and "save before the TUI opens".
- `listProjectsFromDisk`, `remoteProjectRoot`, and `writeJsonAtomically` in the Session storage modules.
- The `globalThis.prompt` replacement and `withProcessGlobalTestLock` pattern in
  `src/shared/remote/memory-binding.test.ts`.
- The real-store fixture in `src/shared/remote/laptop-session-control.test.ts` for a saved Session under one identity.

## Implementation Steps

- `RemoteProjectLocator` in `src/shared/session/file-session-store-types.ts` has optional `acceptedHosts` and
  `refusedHosts` arrays of `RemoteHostIdentity`. Project records without them read and match exactly as before.
- `src/shared/session/file-session-storage.ts` exports a function that adds one `RemoteHostIdentity` to a remote
  project's `acceptedHosts` or `refusedHosts`, skips a duplicate, rewrites that project's `project.json` with
  `writeJsonAtomically`, and leaves `projectId`, `remote.host`, and `remote.root` unchanged.
- `src/shared/remote/host-confirmation.ts` exports `confirmRemoteHost(target, baseDir?)`. It applies the decision rule
  in Approach to `listProjectsFromDisk(baseDir)` (default `getRunWieldSessionsBaseDir()`) and returns a
  `ResolvedRemoteTarget` that differs from its input only in `host`.
- An exact match, an accepted identity, or no partial match calls no prompt and writes nothing.
- A partial match calls `globalThis.prompt` once. The question lists each matching project with its target label, its
  saved `user@hostname:port`, and its reason. A host key change shows both fingerprints and says that OpenSSH accepted
  the new key.
- Choice `n` saves the observed identity in project `n`'s `acceptedHosts` and returns project `n`'s `remote.host`.
  Choice `0` saves the observed identity in `refusedHosts` of every listed project and returns the observed host.
- A `null` answer throws `Remote host choice canceled`, and an out-of-range or non-numeric answer throws
  `Invalid remote host choice`. Both happen before the TUI opens and save nothing.
- `runRemoteCommand` in `src/cmd/remote/index.ts` calls `confirmRemoteHost` after runtime and helper preparation and
  before `bindRemoteMemory`. `startRemoteControlService` receives the confirmed target. `bindRemoteMemory` receives the
  target chosen by the `memory-follows-confirmation` decision.
- `docs/prd/runwield-core-prd.md` describes the delivered confirmation under **Keep a remote project locator separate
  from execution cwd**: a partly matching identity asks once; Yes reuses the saved project; No keeps a distinct target;
  answers are saved; different user or root never asks. The sentence "Ambiguous host confirmation for Sessions remains
  target scope" is removed. Acceptance scenarios cover address change with Yes, key change with No, and a different
  user.
- `docs/prd/remote-ssh-prd.md` no longer lists ambiguous alias confirmation as target scope and links the Core
  requirement.
- `docs/domain-language.md` **Remote project locator** says a confirmed identity reuses the saved project and an
  unconfirmed difference stays distinct. If Memory follows the answer, **Remote Memory key** says a confirmed host uses
  the saved project's key.

## Verification Plan

- Automated (`bun scripts/run-tests.js src/shared/remote/host-confirmation.test.ts
src/shared/remote/laptop-session-control.test.ts src/shared/remote/memory-binding.test.ts`). Tests use real file
  Session storage in the runner's disposable HOME and replace `globalThis.prompt`:
    - **Exact** identity: the prompt is never called, the result equals the input.
    - **Address change** (new hostname, same fingerprint) and **key change** (same hostname and port, new fingerprint):
      the prompt is called once and names the reason; the key-change question contains both fingerprints.
    - **Yes:** the result carries the saved `remote.host`. A Session saved under the original identity is listed by a
      `LaptopSessionControl` built with the confirmed target, and `ensureRemoteProject` with the confirmed target
      returns the saved `projectId`. This test fails if `confirmRemoteHost` returns its input unchanged.
    - **No:** the result carries the observed host; `LaptopSessionControl` with it lists no saved Sessions.
    - **Retained answer:** a second call after Yes or No with a prompt that throws returns the same host.
    - **Never asks:** different user, different root, different hostname and fingerprint, and two `null` fingerprints
      with different hostnames all return the input and leave the prompt uncalled.
    - **Chained change:** after Yes for an address change, a later key change on the accepted address asks about the
      same saved project.
    - **Cancel and invalid answers** throw and leave `project.json` unchanged.
    - If Memory follows: `remoteMemoryIdentity` of the confirmed target equals that of the saved identity.
- Protected behavior: the existing `laptop-session-control.test.ts` case where a changed hostname, user, port, or
  fingerprint lists no Sessions and refuses `begin`, `list`, and `export` stays unchanged and passing.
  `LaptopSessionControl` still matches exactly; confirmation only happens upstream. Existing Memory binding tests stay
  unchanged.
- Inspection: `runRemoteCommand` passes the confirmed target to `startRemoteControlService`, and the confirmation runs
  before the TUI starts.
- Manual: connect to `sct` by DNS name and save a Session. Connect by IP address; answer Yes; `/resume` lists the
  earlier Session. Connect again by IP; no question appears.
- Documents: the Core PRD requirement, its scenarios, the Remote SSH PRD reference, and the glossary describe the
  delivered behavior and no longer call this target scope.

## Edge Cases & Considerations

- **A changed host key can mean an attack.** The prompt states the key changed and shows both fingerprints. OpenSSH has
  already verified the new key against `known_hosts` before RunWield asks; RunWield does not weaken that check.
- **Canceled or non-interactive input (assumption).** Like the Memory question, a `null` answer cancels the connection
  before the TUI opens and saves nothing. The draft's "treat as No without saving" would let the user create Sessions
  under a new target, which then exact-matches and silently becomes a permanent No.
- **Concurrent connections.** Two connections answering at the same time read and rewrite the same `project.json`. The
  later write can drop the earlier answer; the cost is one repeated question. No lock is added.
- **Several partial matches.** All are listed. No adds the refusal to each; Yes accepts only the chosen one.
- **Certificate connections.** A `null` fingerprint never counts as a matching key. Same hostname and port with a `null`
  fingerprint on one side and a known one on the other counts as a key change and asks.
- **Hostname case.** Session identity compares hostnames exactly, so `SCT.example` and `sct.example` with the same key is
  an address change and asks. The Memory key already lower-cases hostnames.
- **No migration.** Existing project records gain the lists only when the user answers a question.
