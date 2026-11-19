---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "packages/ui/components/html-viewer/HtmlViewer.tsx"
    - "packages/ui/components/html-viewer/srcdoc.ts"
    - "packages/ui/components/html-viewer/bridge-script.ts"
    - "packages/ui/components/html-viewer/srcdoc.test.ts"
    - "tests/e2e/"
    - "packages/ui/README.md"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-11-12"
status: "draft"
planId: "d78c5598-f231-49eb-9ea0-4a4ed0cf16ab"
---

# Host-Controlled Restrictions for HTML Annotation

## Context

A host needs to let people interact with self-contained HTML and annotate it without allowing external resource loads.
Today `neutralizeMetaCsp()` removes author CSP, and `injectIntoHead()` puts the bridge after author head scripts.
`BRIDGE_SCRIPT` reads `window.__plannotatorLiveConfig`; an author head script can select its live behavior.

The [proposal](plannotator-fork-extensions.md) records the actual pin, current upstream comparison, and approved fork
setup. The separate [setup Plan](plannotator-fork-setup.md) first creates the fork, clone, and both PR worktrees. This Plan runs in
`~/web/plannotator/.worktrees/host-html-restrictions/` after that setup is verified. All source paths below are relative
to Plannotator. This Plan is not a RunWield submodule patch.

This supplies a library prerequisite for **Preserve a simple, contained review experience** in
[interactive prototype review](../prd/product-planner-prd.md#interactive-prototype-review). It does not deliver RunWield's
integration, storage, or workflow. Plannotator's package README/HANDOFF must describe the new supported behavior in the
same PR. Preserve ordinary HTML rendering and all unrestricted live and bridge-asset callers.

## Objective

An optional host policy blocks external scripts, images, frames, and data requests before author content runs. Inline
interaction and real annotations still work. With this policy, author code cannot select live bridge mode through
`window.__plannotatorLiveConfig`. With no option, existing behavior remains unchanged.

## Approach

### A narrow opt-in contract

**Owner decision:** keep this PR limited to the two gaps in the existing sandbox: install a host resource policy before
prototype code runs, and prevent prototype code from selecting live bridge mode. Reuse the iframe sandbox; do not
replace it or add a general security-policy framework.

The selected profile permits inline scripts, inline event handlers, inline styles, embedded data images, and the inline
annotation bridge. Remote and sibling-file dependencies are not self-contained. Callers without the option stay unchanged.

**Reviewable API naming assumption:** `HtmlViewer` accepts `resourcePolicy="self-contained"`, with the corresponding typed
option in `SrcdocInjectionOptions`. This selects one documented policy, not a page-authored CSP or configurable allowlist.

Start with this CSP, adjusting only when browser evidence requires an equivalent restriction:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none';
worker-src 'none'; base-uri 'none'; form-action 'none'
```

The restricted iframe uses `sandbox="allow-scripts"`. It has no same-origin, popup, modal, form, download, or top-navigation
allowance. Current upstream exposes custom sandbox and host-served frame options; reject conflicting live `src`,
`liveSession`/live sandbox, `frameUrl`, `hostNavigates`, and wider sandbox combinations before mounting a document. Never
silently fall back to unrestricted rendering.

**Selected delivery:** inline bridge only when restricted. Reject `bridgeScriptUrl` with this option; leave external
bridge delivery unchanged without it. Supporting a separately served bridge in restricted mode is out of scope. A nonce
exception can disable inline scripts, and broad script-origin allowances violate the resource restriction.

### Enforce restrictions before author content

```text
host option + rawHtml
  remove author CSP from author input only
  construct document with host CSP first
  run synchronous non-live bootstrap
  preserve author script order + existing bridge placement
  mount sandboxed iframe
```

Keep the unconfigured path intact. A separate restricted assembly path must put CSP in the first real head before any
resource-bearing author markup, including scripts that precede an authored head. Handle full documents, fragments,
uppercase tags, comments, quoted fake tags, and malformed structure. Normalize inertly if needed; parsing must not
execute author code or fetch author resources. Do not rely on a search for the first literal `</head>`.

Reuse current upstream's `headStart`/early-injection knowledge where correct, but do not mistake an early script shim
for a complete CSP-placement proof. Preserve doctype/standards mode and authored script order.

Before author scripts, reserve `window.__plannotatorLiveConfig` as non-writable and non-configurable `null`. The bridge
must capture non-live behavior and not later consult an author-controlled global to select it. Do not use a post-ready
message, mutable policy marker, or JavaScript fetch patch as the restriction. The default live proxy still installs
its config and runs normally when this host option is absent.

Never run the finished restricted document through author-CSP removal. The host CSP must survive assembly. Treat the
page as untrusted even after CSP is applied; the bridge and author code share a realm.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `packages/ui/components/html-viewer/HtmlViewer.tsx` — typed host option, safe combinations, iframe sandbox, and reload behavior.
- `srcdoc.ts`, `bridge-script.ts`, HTML-viewer exports — early host policy and forced non-live bootstrap, without default changes.
- Existing srcdoc, bridge-asset, live/link/pinpoint tests — preserve the default contracts and prove the new branch.
- `tests/e2e/` and a small viewer fixture — actual browser restriction and annotation proof using existing Playwright.
- `packages/ui/README.md`, `HANDOFF.md` — supported combinations, self-contained authoring, inherited CSP, and navigation limits.

No Artifact Server, proxy redesign, RunWield source, dependency pin update, or annotation context work belongs in this PR.

## Reuse Opportunities

- `buildSrcdocInjection`, `buildBridgeScriptTag`, `neutralizeMetaCsp`, and current upstream early-injection logic.
- Existing bridge `onReady`, `HtmlViewer` message checks, annotation controls, and live-proxy compatibility tests.
- `tests/e2e/surface.spec.ts` proves interaction and refused fetches in a real browser; reuse its test methods, not its
  inherited restrictive host CSP. The new fixture must prove the viewer option itself enforces restrictions.

## Implementation Steps

1. **The host contract is optional and fail-closed.** `HtmlViewer` and srcdoc types expose the agreed option. Invalid
   combinations render no author document and report a clear error. Changing the option remounts/reloads as required so
   the new sandbox applies; the current document is never relabeled as restricted without a new load.
2. **The browser receives policy before author content.** Restricted assembly retains a valid first CSP, standards
   mode, and author script order. Its synchronous bootstrap fixes live config to null before any author script. No
   subsequent helper strips the host policy. Without the option, existing output and live configuration behavior remain.
3. **Local work remains usable.** Inline scripts, handlers, styles, data images, text selection, pinpoint comments,
   highlights, and annotation submission work through the actual bridge. Restrictions block the named resource classes
   at browser enforcement boundaries, not only through intercepted APIs.
4. **Tests distinguish protection from a dead viewer.** Unit/component tests cover placement, invalid combinations,
   live-config overwrite attempts, reload, and compatibility. Browser tests run the same hostile-resource fixture with
   and without the option and assert both request suppression and successful local interaction/annotations.
5. **Host documentation matches the delivery.** README/HANDOFF document the agreed option, examples, rejected combinations,
   parent CSP limitations, and explicit navigation non-guarantee. Keep RunWield integration requirements targeted.

## Approval Confirmation

No Work Records are proposed for supersession. Fork, clone, and worktree setup is the approved first step. The owner
selected a self-contained profile with the inline bridge and limited this PR to early resource restrictions and non-live
bridge enforcement. API naming remains a reviewable assumption. No RunWield dependency upgrade is authorized.

## Verification Plan

Run commands from the selected Plannotator worktree, using its locked dependencies and contribution guidance. These are
focused checks, not a proposed replacement for its full CI:

- `bun run test packages/ui/components/html-viewer/srcdoc.test.ts packages/ui/components/html-viewer/bridgeAsset.test.ts packages/shared/live-proxy-bridge-inline.test.ts`
- `DOM_TESTS=1 bun run test --preload ./packages/ui/test-setup/happy-dom.ts packages/ui/components/html-viewer/HtmlViewer.bridgeAsset.test.tsx packages/ui/components/html-viewer/htmlLiveProtocol.test.tsx packages/ui/components/html-viewer/htmlLinkProtocol.test.tsx packages/ui/components/html-viewer/htmlPinpointProtocol.test.tsx`
- Add a focused Playwright config/fixture if the existing Inbox config cannot host component-level opt-in tests. The
  proposed entry is `bunx playwright test -c tests/e2e/playwright.html-viewer.config.ts tests/e2e/html-viewer-restrictions.spec.ts`.
  The fixture mounts the real `HtmlViewer`; its parent does not impose the restriction under test. Keep all resource
  attempts on disposable loopback endpoints, with request counters and valid positive-control responses.
- The fixture tries early external scripts, images, CSS URLs/imports, nested frames, fetch, XHR, WebSocket, workers, and
  beacon requests, plus late dynamically inserted equivalents. A control run without the option proves each tested
  endpoint is reachable. Restricted runs report CSP violations and zero received requests for the covered classes.
  Parser-order tests include leading scripts/resources, no head, mixed-case tags, fake head text, and author CSP.
- In that same restricted browser, click an inline handler and a registered listener, change a simulated cart state,
  see an embedded image, select text, make a pinpoint comment, submit, and restore highlights. Assert callback payloads,
  not merely a bridge-ready event. A blanket script disable or stub bridge must fail this test.
- Attempt assignment, deletion, and property redefinition of live config before and after bridge load. Assert null
  config and non-live message behavior while real comments still submit. Test unconfigured genuine live mode separately.
- Exercise inherited restrictive host CSP as a distinct compatibility case; do not weaken the parent policy to hide a
  limitation. Preserve existing asset timeout, version mismatch, theme neutrality, and annotation/link tests.
- **Headed check:** open the worktree-owned browser fixture with `agent-browser --headed --session <plan-worktree>`.
  Repeat the state-change, text, and pinpoint flow. Inspect console and request evidence. Record the actual fixture URL
  and command; do not guess an existing dev route.
- **AI review:** inspect every path that can mount `src`/srcdoc, the order of policy installation, and all live-mode reads.
  Confirm the README does not claim a universal navigation or no-network boundary.

## Edge Cases & Considerations

- Self-navigation is not reliably blocked by CSP. Existing link handling can remain, but neither click interception nor
  frame source checks justify a universal navigation guarantee.
- A page can interfere with other code in its realm. This change restricts resource loading and live-mode selection,
  not all bridge tampering or forged descriptions.
- A host CSP can be stricter than this child CSP. Never loosen it. The inspected inline bridge path has no ready timeout;
  do not promise a new failure banner. Record inherited-policy failures in browser evidence and document that limitation.
- URL-delivered bridge/lite bundles are incompatible with the selected first version only when restrictions are enabled.
- Automatic parsing and serialization can change malformed HTML. Test normal full documents and fragments for preserved
  rendering and interaction; do not expand this into an HTML cleanup feature.
