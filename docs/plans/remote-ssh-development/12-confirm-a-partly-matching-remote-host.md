---
planId: "c500158b-9338-4bbd-8c06-82d231f30dda"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "LOW"
affectedPaths:
    - "src/cmd/remote/index.ts"
    - "src/shared/session/file-session-storage.ts"
    - "src/shared/remote/laptop-session-control.ts"
    - "src/shared/remote/memory-binding.ts"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
createdAt: "2026-10-25T21:51:42Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 12
dependencies:
    - "04-run-and-resume-remote-sessions-with-local-history"
    - "05-keep-memory-and-integrations-on-their-owning-machine"
userVerifiedAt: null
targetBranch: "epic/remote-ssh-development"
---

# Confirm a Partly Matching Remote Host

## Context

Saved remote history belongs to an exact host identity: effective SSH hostname, user, port, and host-key fingerprint,
plus the canonical remote project root (`ensureRemoteProject` in `src/shared/session/file-session-storage.ts`, and
`#projectMatches` in `src/shared/remote/laptop-session-control.ts`). Anything else is a new target.

An alias rename already matches, because identity uses the effective hostname from `ssh -G`, not the alias. Two cases
still lose access to saved history:

- The same server is reached by a different hostname or port (for example an IP address instead of a DNS name). The
  host key is the same.
- The server's host key changed (for example after a reinstall), and the user accepted the new key in OpenSSH. The
  hostname, user, and port are the same.

Child 04 moved the confirmation prompt for these cases here. The Epic rule: "Neither alias spelling nor a host-key
fingerprint alone is sufficient. Ambiguous equivalence requires confirmation, not automatic history merging."

Owning requirement: [Core Remote connection → Keep a remote project locator separate from execution
cwd](../../prd/runwield-core-prd.md#project-context-and-initialization).

## Objective

When a connection partly matches a saved remote project, the user confirms once whether it is the same target. Yes
reuses the saved project identity and its Session history. No keeps a separate target. The answer is retained, and
history is never merged without confirmation.

## Approach

To be shaped in this child's planning session. Starting point:

```text
on connect, before the TUI opens
  exact match → reuse (unchanged)
  same root, same user, and (same host key xor same hostname+port) → partial match
    retained answer exists → apply it
    otherwise ask once: "Is <new> the same server as <saved>?"
      Yes → record the new identity as an accepted alias of the saved project
      No  → record the refusal; the new identity is a separate project
  different user → never a partial match
```

```wld-question
{
  "id": "memory-follows-confirmation",
  "type": "yes_no",
  "prompt": "When the user confirms a partly matching host is the same server, should its remote Memory collection also follow the saved project? Memory keys use hostname, user, port, and root, so a hostname change otherwise starts a new collection.",
  "default": true
}
```

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/session/file-session-storage.ts` — the remote project record retains accepted and refused identities.
- `src/shared/remote/laptop-session-control.ts` — `#projectMatches` accepts confirmed identities.
- `src/cmd/remote/index.ts` — asks before the TUI opens.
- `src/shared/remote/memory-binding.ts` — depends on the Memory question above.
- `docs/prd/runwield-core-prd.md` — the locator requirement and its scenarios.

## Reuse Opportunities

- The retained same-name Memory question in `src/shared/remote/memory-binding.ts` — the ask-once and retain pattern.

## Implementation Steps

- A connection whose identity partly matches a saved remote project, as defined in Approach, asks once before the TUI
  opens. A connection with an exact match or no match asks nothing.
- Yes makes the connection use the saved project's ID; `/resume` lists that project's Sessions.
- No creates a separate project; a later connection with the same identity does not ask again.
- A different user, a different root, or a different hostname and host key never asks and never reuses history.
- The Core PRD locator requirement and scenarios describe the prompt.

## Verification Plan

- Automated: tests with real file Session storage in a disposable HOME cover exact, hostname-changed, key-changed,
  user-changed, Yes, No, and the retained answer. A test fails if a partial match reuses history without a Yes.
- Manual: connect to `sct` by IP address after using its DNS name; answer Yes; confirm `/resume` lists the earlier
  Sessions.

## Edge Cases & Considerations

- A changed host key can mean an attack. The prompt states that the key changed and shows both fingerprints. OpenSSH has
  already verified the new key before RunWield asks.
- Non-interactive input cannot answer. Treat it as No for this connection without retaining the answer.
