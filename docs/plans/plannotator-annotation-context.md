---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "packages/ui/components/html-viewer/bridge-script.ts"
    - "packages/ui/components/html-viewer/useHtmlAnnotation.ts"
    - "packages/ui/components/html-viewer/HtmlViewer.tsx"
    - "packages/ui/types.ts"
    - "packages/core/html-anchor.ts"
    - "packages/ui/utils/parser.ts"
    - "packages/ui/README.md"
devServerCommand: null
devServerUrl: null
devServerHmr: null
createdAt: "2026-11-12"
status: "draft"
planId: "d948b485-18ed-4987-bacf-c26a1199879b"
---

# Displayed Context on HTML Annotations

## Context

Text and element anchors do not identify the simulated state in which a comment was made. Existing `pageUrl` describes
a live route; `elementContext` describes a target. Neither is a generic contract for labels such as screen and state.

The bridge already captures element context at selection time. `parseBridgeMessage()` reconstructs allowed fields;
`commitComposerDraft()` and quick-label paths construct annotations. Merely adding an optional type field would lose the
new data at these boundaries. Global comments use a separate path in `HtmlViewer`.

The [proposal](plannotator-fork-extensions.md) records source versions and approved repository setup. The separate
[setup Plan](plannotator-fork-setup.md) first creates the fork, clone, and both PR worktrees. This Plan runs in
`~/web/plannotator/.worktrees/annotation-context/` after setup verification. Paths below are relative to Plannotator.
This library extension supports **Keep feedback tied to what was reviewed** in
[interactive prototype review](../prd/product-planner-prd.md#interactive-prototype-review), without implementing RunWield
revision identity or persistence. Keep that downstream journey targeted, not delivered.

## Objective

When enabled by a host, HTML annotations carry a small snapshot of displayed labels. A comment selected in state A
keeps A after the page changes to B. The public contract is generic, bounded, and optional. Existing annotations and
callers remain valid without context.

## Approach

### Host-approved labels, captured with the target

**Owner decision:** prototype HTML declares and updates explicit screen/state labels. The host chooses which labels
Plannotator reads; Plannotator reports them rather than inferring state. Use a bounded mapping of generic keys to root
`data-*` attributes. The bridge reads only those attributes on `document.documentElement`, synchronously with target
capture or when handling a global-comment capture request. Example, not reserved fields:

```text
host mapping: screen -> data-demo-screen, state -> data-demo-state
page root:    data-demo-screen="cart" data-demo-state="empty"
annotation:   displayedContext.entries = [{key: "screen", value: "cart"},
                                          {key: "state", value: "empty"}]
```

A `HtmlDisplayedContext` value contains an ordered list of string key/value entries. Optional `displayedContext` fields
belong to `Annotation` and `HtmlAnnotationTarget`. Define the reusable type, parser, and bounds in the core HTML contract
and re-export through supported UI entry points. Keep it separate from `HtmlElementContext`, since ordinary text
selection has no element-description requirement.

**Proposed bounds:** at most eight entries; keys at most 40 characters; values at most 160 characters; serialized UTF-8
JSON at most 2 KiB. Host configuration must have unique valid keys and valid `data-*` attribute names. Read only the
configured fields, copy the snapshot, and validate again at the parent boundary. Missing/empty attributes are omitted.
If a supplied snapshot is malformed or over budget, omit that snapshot but keep the valid annotation. Do not truncate
identifiers into different identifiers, collect form values, or accept nested application state.

Using a page callback could report state that is not in attributes, but adds execution/error handling and a larger
public API. An asynchronous callback also risks mixing selection and submit state. Do not add one without that need.

### One snapshot follows the draft

```text
select target in state A
  bridge selection + displayedContext A
    validated draft snapshot: target, text, context
      page changes to B
        submit comment -> annotation still carries A
```

Keep context with the actual target/draft, not in a separate latest-state variable. Preserve it in built-in comment,
looks-good/quick-label, and `onHostDraft` outputs. Extra targets capture their own context; primary-target removal
promotes the next target's context together with its anchor and text. Do not silently give every target the primary
state. Cancellation and document replacement clear the active snapshot.

**Scope after owner feedback:** global comments also carry displayed page context. Include anchored text, element,
multi-target, host-composed, and global comments. Having no selected target does not prevent capture of the page's state.

**Owner decision:** capture global context as part of opening the comment composer, not at submission. Ask the current
frame to read its configured attributes, using the same bounded reader as target capture. Bind the response to that
document load and composer draft. Do not use a cached last-selection context or reread state at submission. A response
for a closed, cancelled, or replaced draft cannot update a later comment. This adds one bridge request, not a new state
service. The captured state stays with the comment even if the page changes while the user types.

Context is descriptive and page-controlled. It does not grant authority, choose a revision, prove visible pixels, or
cause state replay. RunWield owns revision identity, persistence, and validation against its own prototype manifest.

### Preserve the data through existing output boundaries

Extend the pure `buildPersistedHtmlAnchor()` / `projectHostThreads()` path so hosts retain context in ordinary round trips.
This is serialization support, not a new persistence service. Keep old-record compatibility and the existing total
anchor budget. The current helper sheds optional context and targets; it does not expose an over-budget failure result.
Do not invent a throwing or rejecting persistence contract.

**Reviewable budget assumption:** shed optional element-description text before displayed labels. If the total budget
still requires shedding displayed labels, remove extra-target labels from the end, then primary labels, as optional
metadata before applying the existing target/quote shedding rules. Do not truncate label values. Document that this
bounded helper can omit optional context under a tight host budget; the original annotation callback still contains
its valid captured snapshot. Tests must distinguish an ordinary exact round trip from deliberate budget-driven omission.

Extend annotation feedback formatting with a bounded escaped displayed-context section for the primary and each extra
target. Context-free output must remain unchanged. Check explicit external-annotation validators and allowlists where
these fields pass through; preserve accepted optional context rather than inventing an external state API.

Keep URL sharing's existing deliberate omission of HTML anchor metadata. This PR does not expand share payloads or add
state badges, replay controls, storage, revisions, or a RunWield-specific schema.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `packages/ui/components/html-viewer/bridge-script.ts`, `srcdoc.ts`, `HtmlViewer.tsx` — host opt-in, shared attribute capture,
  and current-frame context requests for global comments.
- `useHtmlAnnotation.ts` — message parsing, cohesive draft snapshots, target promotion, all supported annotation outputs.
- `packages/ui/types.ts`, `packages/core/html-anchor.ts`, supported exports — generic types, bounds, parsing, and pure host round trips.
- `packages/core/external-annotation.ts` where relevant — prevent explicit field selection from dropping accepted context.
- `packages/ui/utils/parser.ts` — escaped context in exported feedback, without changing context-free output.
- Existing bridge/protocol/anchor/export tests and a browser fixture — capture timing and preservation through real boundaries.
- `packages/ui/README.md`, `HANDOFF.md` — source, bounds, timing, trust limits, and host example.

No RunWield code or PRD changes, new persistence backend, Artifact Server, approval workflow, or general DOM-state capture.

## Reuse Opportunities

- `handleSelection` and `annotateElement` in the bridge already define the relevant selection boundary.
- `parseBridgeMessage`, `HtmlDraftTarget`, `applyTargetRemoval`, `commitComposerDraft`, and `HostDraft` carry target data today.
- Core HTML anchor parsers and existing element-context budget tests establish parsing and byte-budget patterns.
- `elementContextExportBlock` and annotation export tests establish how agent-facing context is escaped and formatted.

## Implementation Steps

1. **A bounded public contract exists.** Core owns the agreed displayed-context type/parser/limits. UI types and supported
   entry points expose optional fields and host configuration. Old annotations parse unchanged; absent configuration
   emits no new metadata. Validate configured keys and byte limits, not only TypeScript types.
2. **Capture belongs to the annotation event.** The shipped bridge snapshots the configured root attributes during text,
   pinpoint, keyboard, and additional-target selection. The host parser copies and bounds the payload. Page changes before
   submit cannot replace it. Invalid context alone does not discard a valid selection or comment.
3. **Every scoped output preserves the correct snapshot.** Built-in comments, quick labels, and host drafts retain it.
   Target removal/promotion moves the corresponding context. Cancel/reselection/document replacement cannot leak an older
   draft's context. Extra targets retain their own state. Global comments capture page context when the composer opens,
   through the same bounded reader. Their request/reply uses draft/load correlation; stale replies cannot change another draft.
   `handleGlobalCommentSubmit` preserves the captured context in its emitted annotation and feedback.
4. **Existing host helpers and feedback retain context.** Core serialization/projection and relevant explicit validators
   round-trip the optional value with stated budget behavior. Feedback export contains escaped key/value text for the
   correct targets. Existing context-free output and intentional URL-share omission remain unchanged.
5. **Tests and documentation prove timing and compatibility.** Component and browser tests exercise actual bridge capture,
   draft processing, submit output, export, and pure host round trips. README/HANDOFF describe only supported sources,
   comment types, bounds, and trust limits. RunWield revision/retention remains downstream scope.

## Approval Confirmation

No Work Records are proposed for supersession. Fork, clone, and worktree setup is the approved first step. The owner
included global comments, selected capture when their composer opens, and selected explicit labels declared by the
prototype and chosen by the host. Type/API names, entry limits, per-target capture, and malformed-context omission are
reviewable implementation assumptions.

## Verification Plan

From the selected Plannotator worktree, use its locked dependencies and contribution guidance:

- `bun run test packages/ui/components/html-viewer/bridgeElementContext.test.ts packages/core/html-anchor.test.ts packages/ui/utils/parser.test.ts`
- `DOM_TESTS=1 bun run test --preload ./packages/ui/test-setup/happy-dom.ts packages/ui/components/html-viewer/srcdoc.test.ts packages/ui/components/html-viewer/htmlPinpointProtocol.test.tsx`
- Add the browser fixture/spec using the existing Playwright dependency. Proposed focused command:
  `bunx playwright test -c tests/e2e/playwright.html-viewer.config.ts tests/e2e/html-viewer-context.spec.ts`.
  Keep the context PR independently testable; include its minimal fixture support rather than importing unmerged PR code.
- **Timing discriminator:** use a real rendered checkout fixture. Select empty-cart text or an element, change its root
  state to full-cart before submission, then submit. The emitted annotation and exported feedback contain empty-cart;
  the next annotation contains full-cart. This fails for a submit-time read or a type-only/pass-through implementation.
- Cover text selection without an element description, textless pins, keyboard selection, quick labels, `onHostDraft`,
  extra targets in different states, and primary removal/promotion. Assert the corresponding snapshot at each boundary.
- **Global comments:** with no prior target selection, open a comment in empty-cart state, change the page to full-cart,
  and submit. The emitted annotation and exported feedback retain empty-cart, as selected by the owner.
  A new composer captures full-cart. Close/reopen the composer and replace the frame while a reply is pending; old replies
  cannot attach to the new draft. Missing or invalid optional context does not discard the comment.
- Cover missing attributes, unexpected keys, non-string payloads, duplicate keys, over-limit count/strings, multibyte
  UTF-8 budget, and malformed frame messages. Valid annotations survive invalid optional context; no raw attributes leak.
- Capture A, cancel, capture B, and submit; only B survives. Replace the document and try a delayed prior-document message;
  it must not attach old context to a new draft. Reuse existing load/message identity where possible; if the current
  protocol cannot distinguish a queued old-frame message, add the smallest per-load correlation for this optional capture.
- Serialize and project a multi-target annotation through the real host helpers. Verify exact context preservation,
  deterministic over-budget handling, and old-record compatibility. Feedback escapes markup/control content as data.
  Preserve existing element geometry, host draft, live-route, and URL-sharing tests; no existing behavior is retired.
- Once both PRs are available, run the same browser flow with restrictions enabled. Context capture must also work with
  restrictions absent; neither public option implies the other.
- **Headed check:** in a worktree-specific `agent-browser --headed --session <plan-worktree>` session, switch cart state,
  annotate text and a button, and inspect submitted data and exported feedback. Record the actual fixture URL/command.
- **AI review:** follow every annotation constructor, primary promotion, host helper, and feedback serializer. A field
  that exists in a type but disappears at a boundary fails review. Check package examples against real public exports.

## Edge Cases & Considerations

- Displayed context is a new proposed term, not a RunWield glossary change. No Plannotator glossary was found; document
  the public type in existing package guidance rather than creating a new documentation system.
- The page may lie about its own state. The host treats context as description, not revision or authorization evidence.
- Multiple targets can belong to different displayed states. Preserve those differences instead of recapturing all
  targets at submit time or introducing a new cross-state selection restriction.
- If metadata is invalid, normal annotation still works. Do not silently truncate identity-like values.
- URL sharing remains unchanged. Revision storage, persistence guarantees, badges, and state replay are excluded.
