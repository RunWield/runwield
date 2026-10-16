---
planId: "aea351ca-eab5-44e0-94e2-daaa60d43a78"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/agent-definitions/planner.md"
    - "src/agent-definitions/document-formats/planner-plan-format.md"
    - "src/ui/design-system/components.css"
    - "src/ui/design-system/print.css"
    - "src/ui/workspace/react/ReviewDevSurface.tsx"
    - "docs/design-system.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/plan-review"
devServerHmr: true
createdAt: "2026-09-26T00:22:48-04:00"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
status: "validated"
validatedCommit: "c7cdea16e1e0d3cb714bb64f7bef64f4e580bcae"
workRecord:
    status: "generated"
    recordId: "a4624808-efe4-4057-9ee9-8c7322165022"
    path: "docs/work-records/2026-09-27-readable-plans-and-shared-callouts.md"
    lastAttemptAt: "2026-09-27T14:38:13.128Z"
archivedAt: "2026-09-28T00:50:18.153Z"
archivedFromStatus: "validated"
archivedFromPath: "docs/plans/improve-plan-readability.md"
---

# Make Plans Easier to Read

## Context

Plans need to support two tasks: finding important points quickly and reading the full explanation. Colored boxes help
with the first. Clearer writing is necessary for both.

The user approved short paragraphs, point-first explanations, selective icon callouts, and diagrams only where they
explain better than prose. Implementation and verification instructions must retain their exact requirements.

This Plan proposes additions to these existing capabilities:

- [Core Plan authoring](../../prd/runwield-core-prd.md#plan-authoring-and-external-adoption): readable generated Plans,
  without imposing a new body format on user-authored Plans.
- [Workspace browser appearance](../../prd/runwield-workspace-prd.md#browser-appearance-and-themes): callouts that use
  the existing browser colors.
- [Workspace artifact reading](../../prd/runwield-workspace-prd.md#browser-sessions): readable callouts on desktop,
  phone, and paper through the shared reader.

User ownership of Plan text, review annotations, explicit saves, and existing lifecycle behavior must remain unchanged.
These additions are proposed, not shipped.

## Objective

Make newly written Plans easier to understand and give selected risks, constraints, and reasoning a clear visual
treatment in Plan Review and the shared read-only reader.

Success means the reader can identify the change, approach, and risks without searching through dense paragraphs, then
read complete implementation and verification instructions.

## Approach

**Improve writing before adding decoration.** Extend the Planner's existing readability guidance rather than add a
competing writing standard. Keep the current Plan headings and front matter.

Use three optional callouts:

| Markdown marker | Purpose                         | Presentation            |
| --------------- | ------------------------------- | ----------------------- |
| `[!WARNING]`    | Risk or surprising behavior     | Amber, warning triangle |
| `[!NOTE]`       | Important constraint or context | Blue, information icon  |
| `[!TIP]`        | Reason behind the approach      | Teal, light bulb        |

The marker occupies its own quoted line. A bold, descriptive title follows, then a quoted blank line and a short
explanation. Plannotator shows the title in its alert header instead of the visible kind label; the kind remains in the
accessible name. An alert without a title shows its kind label. Keep this built-in behavior.

> [!TIP]
> **Use the callouts the reader already understands**
>
> Plan Review and the artifact reader already share Plannotator's alert parser and renderer. Reuse them without
> introducing new syntax or changing saved Markdown.

Put each callout near the related explanation. Do not repeat its content outside the box. Callouts are optional: no
required count, no boxes around whole sections, and no replacement for exact steps.

Shared RunWield styles provide muted backgrounds, compact corners, clear text, and spacing. The existing icons and
visible header text (kind or descriptive title) preserve meaning without color. Browser styling stays dark under both OS
color preferences; printing uses the existing light paper palette.

**Agreed scope:** Changes remains a plain comparison with authored titles and text intact. Matching its callout styling
is deferred. This avoids changing the external Plannotator checkout for this release. The Markdown editor also keeps its
existing presentation.

No new renderer, parser, dependency, body validation gate, lifecycle rule, or automatic rewrite of existing Plans is
needed.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/agent-definitions/planner.md` and `document-formats/planner-plan-format.md` — writing guidance and one compact,
  valid callout example.
- `src/ui/design-system/components.css` and `tokens.css` — shared document-callout styling and any necessary semantic
  color aliases.
- `src/ui/design-system/print.css` — legible callout boundaries, titles, and bodies on paper.
- `src/ui/workspace/react/plannotator.css` — only integration adjustments needed for shared rules to take precedence
  over upstream alert styles.
- `src/ui/workspace/react/ReviewDevSurface.tsx` — realistic Plan and reader fixtures, preserving review interactions and
  revision comparisons.
- `src/shared/session/agents-shared-practice.test.ts`, `src/ui/design-system/design-system.test.ts`, and
  `src/ui/workspace/workspace-plan-review-ux.test.tsx` — focused guidance and integration regressions.
- `docs/design-system.md` and the owning Core/Workspace PRD capabilities — usage rules and delivered acceptance
  scenarios.

`third_party/plannotator/`, its revision pin, Plan lifecycle code, and the Changes renderer remain unchanged. No new
domain term requires a glossary change.

## Reuse Opportunities

- `src/agent-definitions/shared-practice/show-the-work.md` already defines short paragraphs, point-first writing, lists,
  and selective diagrams. Keep that shared practice intact; add only Planner-specific guidance.
- `third_party/plannotator/packages/ui/utils/parser.ts` already recognizes marker-only alert lines and preserves source
  locations.
- `third_party/plannotator/packages/ui/components/blocks/AlertBlock.tsx` already provides icons, labels, body rendering,
  and annotation block attributes.
- `PlanReviewSurface.tsx` and `ArtifactReadSurface.tsx` already use the same `Viewer`; they need no separate callout
  implementations.
- Existing `--rw-*` colors, spacing, radius, and `--rw-print-*` tokens provide the visual baseline. `.rw-guide-callout`
  is a related Code Review reference, not a component to replace in this change.

## Implementation Steps

- **Writing guidance:** The loaded Planner instructions require point-first sections, one idea per short paragraph,
  lists for separate points, and removal of repetition without losing requirements. Exact implementation outcomes and
  verification instructions remain mandatory.
- **Authoring example:** `planner-plan-format.md` shows marker-only syntax with a descriptive bold title and explains
  selective WARNING/NOTE/TIP use. These are authoring instructions, not runtime restrictions on Plan bodies.
- **Shared colors:** Styles in `src/ui/design-system/` target existing document alert attributes within RunWield
  review/reader hosts. WARNING is amber, NOTE blue, and TIP teal. Use semantic `--rw-*` tokens, with named callout
  aliases if needed; TIP must not imply successful completion.
- **Readable boxes:** Those styles give callouts muted fills, compact corners, readable padding, wrapping text, and body
  text at the document's reading size. Keep Plannotator's alert header intact: it shows the descriptive title instead of
  the kind label when one is authored, and the kind label otherwise. Keep the existing SVG icon and accessible kind.
  Ordinary quotes and CAUTION/IMPORTANT alerts remain usable. Annotation DOM text, block IDs, and source content do not
  change for styling.
- **Paper layout:** `print.css` gives callouts readable boundaries, labels, titles, and bodies. Short callouts stay
  together where practical; long ones can span pages without clipping. Printing from View, Edit, or Changes uses the
  current document without saving edits or changing screen appearance.
- **Meaningful fixtures:** `ReviewDevSurface.tsx` replaces the primary Plan's placeholder prose with concise
  explanations, all three callout types, exact outcome-based steps, and verification items. Its derived revision
  replacements are updated together; initial, revised, Planner-revised, and PROJECT flows remain distinct and working.
- **Boundary examples:** The read-only fixture includes the same callout cases. Suitable fixture content also covers
  ordinary quotes, long text, and literal marker examples. Retain a dense version of the meaningful sample for
  comparison with the concise version; both carry the same requirements.
- **Regression coverage:** Tests load the Planner through `loadAgentDef` and check guidance composition. The separately
  read format retains required headings and supported syntax. Design-system and review tests cover semantic color
  mappings, shared style ownership, print treatment, and fixture paths. Existing review, direct-edit, feedback, and
  annotation coverage stays intact; browser checks below prove the visual result.
- **Documentation:** `docs/design-system.md` documents callout syntax, meaning, and restraint. Core adds readable
  generated Plan requirements while preserving user body ownership. Workspace adds reading and printing scenarios and
  links Core's authoring rule. Changes styling stays deferred; light/custom browser themes are not claimed as delivered.

## Approval Confirmation

No Work Records are proposed for replacement. No `supersedes` confirmation is needed.

## Verification Plan

**Focused automated checks**

- Run
  `deno run -A scripts/run-tests.js src/shared/session/agents-shared-practice.test.ts src/ui/design-system/design-system.test.ts src/ui/workspace/workspace-plan-review-ux.test.tsx src/ui/workspace/react/plan-review-direct-edits.test.ts src/ui/workspace/react/plan-review-feedback.test.ts`.
- Run `deno task workspace:check` and `deno task workspace:build` to confirm the imported renderer and shared styles
  still build together.
- Inspect the composed Planner instructions and template together: the exact-step rules and current headings remain;
  callouts are optional; no lifecycle or approval gate was added. Passing instruction tests proves delivery of guidance,
  not that an AI always follows it.

**Headed-browser proof**

Start `deno task workspace:dev` in the execution worktree. Use `agent-browser` in a named, worktree-specific headed
session. Check these routes at 1440×1000 and 390×844:

- `/dev/plan-review`
- `/dev/plan-review?variant=read-only`
- `/dev/workspace/plan-review`

Verify these observable results:

- WARNING, NOTE, and TIP show their respective icon, descriptive title in the header, short body, and muted
  amber/blue/teal box. A callout without an authored title shows its kind label instead. Check that the kind remains
  accessible with an authored title. Check actual computed colors and text contrast, not just class names. Ordinary text
  meets 4.5:1 contrast. OS light and dark preferences do not switch the browser palette.
- Long titles, paths, and body text wrap without horizontal page overflow or clipped content. Ordinary quotes, code
  examples containing markers, and existing CAUTION/IMPORTANT alerts retain their meaning. Contents navigation still
  reaches the correct headings.
- Select text in a callout title and body, add annotations, and switch between View and Edit. Highlights and annotation
  text remain attached to the intended text. Send annotations through the fixture's existing feedback path and inspect
  the selected text and source range. Verify one saved/reloaded annotation through a local Plan Review in a temporary
  test Project, since a development fixture alone does not prove persistence. Do not use the active execution Plan for
  this check.
- Open Edit and return to View without changing text: the Markdown remains identical. Make one deliberate callout text
  edit and save: only the intended content changes. Clean and raw Changes retain the authored title/body and distinguish
  revisions; colored boxes in Changes are not required.
- Print / Save PDF from View, read-only, Edit with an unsaved callout edit, and Changes. The current title/body appears
  on light paper without clipping or application controls; a callout without a title keeps its visible kind label. The
  unsaved edit prints without being saved. Check a callout near a page boundary and a callout longer than a page.

**Readability review**

- Show the user the dense and concise versions of the same meaningful sample, then the styled Plan and read-only view.
  Ask them to locate the objective, chosen approach, and main risk, then inspect the exact steps. Confirm that callouts
  help rather than dominate the document. Capture desktop, phone, and print evidence at the pair checkpoint.
- Check content preservation against a short list of the fixture's intended requirements: explanations can shrink, but
  no step, verification condition, constraint, or risk disappears. This distinguishes improved writing from merely
  adding boxes to dense prose.
- Confirm the owning PRD scenarios match the delivered behavior and keep Changes styling deferred. No existing Plan
  migration or new text-format requirement is introduced.

## Edge Cases & Considerations

> [!WARNING]
> **Styling must not move review annotations**
>
> Annotation offsets depend on rendered text. Keep Plannotator's existing title row, accessible kind, and block
> attributes intact. Do not duplicate the kind label or move the title back into the body.

- The existing parser requires the alert marker alone on its line. Teach that syntax instead of extending it for
  same-line titles.
- Colors cannot carry the only meaning. Keep Plannotator's icon and header text visible, including on monochrome paper;
  the kind stays accessible when an authored title replaces its visible label.
- The shared reader serves other Markdown artifacts too. Existing alerts there receive the same style; this Plan changes
  authoring guidance only for the Planner.
- The current browser theme is dark. Reuse replaceable semantic tokens, but do not add a theme picker or claim a light
  screen theme.
- Dirty unrelated repository files existed during planning. Preserve them; this Plan does not require changes to the
  Workspace server, Astro configuration, landing page, or branding assets.
