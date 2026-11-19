# Prototype Review Options

**Status:** Research only. No tool selected, installed, or tested at runtime.

## Question

What should RunWield reuse for interactive prototypes reviewed alongside product-grounded Plan drafts?

The intended workflow is broader than the earlier [Replica assessment](replica-integration-assessment.md): a
product-first Agent develops feasible product intent, users annotate prototypes and text, and Planner or Architect adds
technical decisions. This note compares review tools; it does not define an accepted workflow or PRD.

## Findings

### Plannotator offers a smaller path than Artifact Server

The separate [Plannotator review application](https://github.com/backnotprop/plannotator) already documents rendered
HTML review, text and element annotations, feedback return to an agent, local version history, and encrypted sharing.
HTML runs in a sandboxed frame. Scripts can still make outbound requests. Its HTML diff marks changed text, not script
or style changes. This is not proof of interactive-state capture or a complete visual regression comparison.

Source: [HTML workflow](https://docs.plannotator.ai/open-source/workflows/html).

Upstream exposes `@plannotator/ui` and browser-safe `@plannotator/core` for embedded use without its server. The host owns
storage and backend behavior. This is a reuse option, not verified compatibility with RunWield's pinned checkout.

Source: [embedding guidance](https://github.com/backnotprop/plannotator/blob/main/packages/ui/HANDOFF.md).

RunWield already imports Plannotator's Viewer, AnnotationPanel, MarkdownEditor, and PlanDiffViewer into
[PlanReviewSurface](../../src/ui/workspace/react/PlanReviewSurface.tsx). Its
[review widget store](../../src/ui/workspace/routes/api/review-widget-handlers.ts) can serve HTML and supporting assets,
but keeps them in temporary directories and deletes them on cleanup. Existing widgets do not establish durable
prototype review.

### Artifact Server is a separate, fuller product

[Artifact Server](https://github.com/plannotator/artifact-server) provides versioned publication, review, comments,
sharing, and agent access through CLI, HTTP, and MCP. MCP includes publication, exact-version links, version listing,
and comment operations. Local operation is available; a hosted service is not required for a personal trial.

Sources: [README](https://github.com/plannotator/artifact-server#readme),
[MCP contract](https://github.com/plannotator/artifact-server/blob/main/docs/mcp.md).

Remote deployments add an application origin, isolated wildcard content domain, identity, storage, and backups. These
are additional product responsibilities, not prerequisites for every local use. The README distinguishes source-level
live Pi and Claude Channels support from OpenCode, which is not release-qualified.

The current repository offers MIT or Apache-2.0 licensing. Its older
[Plannotator documentation page](https://docs.plannotator.ai/open-source/artifact-server) conflicts with current
repository documentation on capabilities and setup. Use the current repository and deployment-specific documentation,
not the older overview, for a future compatibility check.

### Lightweight alternatives do not replace the whole review workflow

| Candidate                                                                   | Useful capability                                                                        | Important limit                                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Annotation Overlay MCP](https://github.com/cc10143/annotation-overlay-mcp) | DOM-aware annotations, drawing, screenshots through a Chrome extension, and MCP feedback | Separate extension/server. No verified Plan-linked version history or application-state replay. Requires integration and security review before adoption.         |
| [React Grab](https://github.com/aidenybai/react-grab)                       | Element selection with React component/source context                                    | A selection aid, not an established durable review and iteration workflow.                                                                                        |
| [Agentation](https://agentation.dev)                                        | Element feedback, structured context, and agent reply/resolution workflows               | Not an unrestricted open-source dependency. The license restricts competing uses; its website requires commercial licensing for redistribution in a sold product. |

Agentation's license is [PolyForm Shield](https://github.com/benjitaylor/agentation/blob/main/LICENSE). Do not treat it as
an MIT-style component or assume that internal-use permission covers RunWield distribution.

Replica remains a useful reference for design guidance, prototype review, and accepted learnings. Its Copilot-specific
canvas and separate Hub make it a less direct match for extending RunWield's existing review experience. See the
[earlier assessment](replica-integration-assessment.md) for sources and limits.

## Inference

**Reusing Plannotator's HTML review components is the strongest first candidate.** RunWield already uses this UI family,
and upstream explicitly separates the UI from server ownership. Adopting a second artifact platform may duplicate
Projects, identity, feedback delivery, and retention.

A focused RunWield extension still needs meaningful product work:

- Keep the reviewed prototype available with the relevant Plan revision.
- Preserve what the user saw: version, screen, relevant state, and visual evidence where needed.
- Keep comments understandable when a new version changes or removes their target.
- Return feedback to the correct planning conversation without treating comments as implementation approval.
- Run prototype code without exposing review credentials, unrelated project data, or production mutations.

An immutable file version does not preserve runtime state by itself. A comment on an empty cart must not be interpreted
as a comment on the same route after items were added.

## Recommendation

Evaluate the smallest embedded Plannotator path before adopting Artifact Server or Replica Hub. Use one realistic
multi-state prototype and two revision rounds to test annotation fidelity, user/Agent iteration, and retained review
context. No such trial has been performed.

Consider full Artifact Server if an independent shared artifact library is itself a product need. Consider an overlay
if users must annotate arbitrary running applications rather than prototypes shown within RunWield.

## Open Questions

- Does an accepted prototype define delivery requirements, or only illustrate written requirements?
- Must the first release support shared reviewers, or the owner and their Agent only?
- Are self-contained interactive examples enough, or must review cover existing running applications?
- What prototype states must remain reproducible after revision and handoff?

These are product choices, not gaps that a library can decide. Current upstream main was reviewed; release parity,
package compatibility, runtime behavior, security, and performance remain unverified.
