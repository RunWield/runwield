---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/browser-port.ts"
    - "src/ui/review/"
    - "src/ui/workspace/server.js"
    - "src/shared/session/local-review-interactions.ts"
    - "src/shared/session/browser-question.ts"
    - "src/cmd/guided-review/"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/remote-ssh-prd.md"
executionAgent: "engineer"
createdAt: "2026-09-21T02:05:51.971Z"
status: "draft"
origin: "internal"
parentPlan: "remote-ssh-development"
order: 9
dependencies:
    - "01-establish-the-remote-connection-and-matched-runtime"
    - "07-carry-remote-context-through-delivery-workflows"
    - "08-stop-owned-remote-work-on-connection-loss"
targetBranch: "epic/remote-ssh-development"
planId: "8b3db8e1-34fd-4a8d-9c06-07611d132802"
---

# Open Remote Reviews in the Local Browser

## Context

Review artifacts and pending workflow decisions belong to the remote project process, while the user needs the existing
browser review experience on the laptop. The current review server binds loopback and resolves an in-process
interaction; opening its remote URL locally would not reach its APIs, assets, polling, images, uploads, or pending
promise.

This slice completes the Remote SSH PRD's **Remote workflows and local review** journey and the Core PRD's Plan Review
and delivery scenarios. It changes transport and URL ownership, not the review layout or design system.

## Objective

Forward each remote review server's whole loopback origin through SSH, open an equivalent laptop loopback URL, and
preserve the same live review interaction across feedback revisions, reopen links, browser close, Guided Review, and
connection shutdown.

## Approach

Extend the browser-opening capability so a remote request identifies an origin and original path/query/token. The
launcher creates or reuses a connection-owned local forward for that origin, returns a laptop URL, and opens it. Keep
the remote review server, token checks, artifacts, and pending decision as the authority.

```text
laptop browser -> local loopback forward -> remote review origin -> remote artifacts and decision
```

Do not proxy individual review API calls through a new protocol; forwarding the whole origin preserves existing
same-origin behavior and reduces duplicate review logic.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/browser-port.ts` — represent remote origin-forward and local-open requests without weakening ordinary
  local browser opening.
- `src/ui/review/` and `src/ui/workspace/server.js` — keep review servers remote, produce laptop reopen URLs, and serve
  actual remote artifacts through the forward.
- TUI review integration and local review interaction modules — route feedback and decisions to the same pending remote
  operation.
- Guided Review command and Agent handlers — inherit remote execution and local personal authority through the existing
  connection.
- The owning Core and Remote SSH PRD sections — mark browser review scenarios delivered without claiming hosted
  Workspace support.

## Reuse Opportunities

- Existing Plan Review, Code Review, artifact reader, review tokens, and pending decision promises — preserve them
  unchanged behind the forward.
- `BrowserPort` — extend the genuine OS/browser boundary rather than introducing browser behavior into workflow code.
- OpenSSH local forwarding — reuse connection security and whole-origin TCP transport.
- Existing review frontend and same-origin APIs — no visual redesign or duplicate remote review UI.

## Implementation Steps

- A remote browser-open request carries the remote loopback origin and original path, query, and token without exposing
  control credentials or accepting arbitrary public binds.
- The launcher creates one connection-owned local loopback mapping per active remote review origin, reuses it across
  feedback revisions, and supplies laptop URLs for initial open and reopen links.
- Plan Review, Code Review, artifact reading, API calls, assets, polling, remote files, images, and uploads all traverse
  the same forward and display actual remote project content.
- Feedback and final decisions reach the original pending remote interaction with existing token and live-operation
  checks; transport retry cannot repeat an uncertain review decision.
- Browser close alone leaves the connected review wait active and reopenable. SSH connection loss stops the owned remote
  review server and workflow job through the descendant sweep delivered by child08
  (`08-stop-owned-remote-work-on-connection-loss`).
- Plan review and Code Review in a remote Session already run their remote review server and record laptop Session
  evidence after child07. This child changes only how the laptop browser reaches that server.
- Guided Review starts with the same remote project/worktree, local model and personal resources, local Session
  authority, and connection-owned process supervision.
- Ordinary local review URLs and browser behavior remain unchanged, and hosted Workspace registration is not introduced.
- The Core and Remote SSH PRD requirements and acceptance scenarios match delivered local-browser review behavior and
  preserve current review semantics.

## Verification Plan

- Automated: test origin mapping, path/query/token preservation, mapping reuse, loopback-only binding, credential
  redaction, reopen URLs, browser-close behavior, connection cleanup, and uncertain decision deduplication.
- Automated: run existing Plan Review, Code Review, and review-consumer tests to prove local behavior, token checks,
  feedback revisions, and pending interaction semantics remain protected.
- Automated: run focused tests through `deno run -A scripts/run-tests.js <test paths>`, followed by
  `deno task workspace:check`, `deno task workspace:test`, `deno task seams:check`, and `deno task ci` as applicable.
- Headed browser: start the actual remote runtime and review server through `wld remote`, open the supplied laptop URL,
  inspect a remote Plan and diff, expand files, view remote images, upload review input, submit feedback, reopen the
  revised review, and complete the decision.
- Headed browser: close the tab during a pending review and reopen it from the TUI. Then kill SSH and confirm the
  browser stops reaching the origin, the owned remote review process ends, and unrelated processes survive.
- Guided Review: launch it from the forwarded Code Review, verify it reads the remote worktree and uses the laptop
  model, then return its result to the same workflow.

## Edge Cases

- A browser may retain a stale forwarded URL after reconnect. A fresh connection must create a fresh mapping and must
  not revive the old operation.
- Multiple simultaneous review origins need distinct mappings even when remote ephemeral ports are reused over time.
- Browser close is not connection loss and must not cancel a live pending decision.
- No visual redesign is in scope. If source discovery shows a UI change is required rather than transport adaptation,
  report the expanded product boundary.
