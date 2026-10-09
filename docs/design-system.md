# RunWield Design System

The RunWield Design System is the shared browser UI language for Workspace, Plan Review, Code Review, and future
RunWield web surfaces. Plan Review and Code Review are the visual blueprint. Their compact, tool-like density should
carry through the rest of Workspace.

The hierarchy, state meanings, and evidence presentation also guide the TUI. Browser CSS, fonts, and dimensions apply
only to web surfaces; [terminal adaptation](#terminal-adaptation) describes the corresponding terminal conventions.

## Principles

### Use the review surfaces as the blueprint

The visual direction is dark, focused, compact, and workflow-oriented. Keep the strongest parts of Plan Review and Code
Review as the baseline:

- dark page background with layered slate surfaces;
- mint sidebar brand rail, with blue for selected working context and primary intent;
- compact rectangular controls with 6px corners;
- squared-off cards and panels with 6–8px corners, subtle borders, and restrained shadows;
- 28px compact toolbar controls and 32px standard controls on desktop;
- 12–14px utility text with larger type reserved for document content and page headings;
- pill geometry only for statuses, counts, and short metadata badges;
- dense but readable spacing that keeps related controls and information in one view;
- direct language that names RunWield workflow concepts rather than generic product metaphors.

Do not copy the old Workspace habit of making every action a pill or every container a large soft card. Rounded corners
communicate containment; they are not decoration. When unsure, copy the density and shape of the review toolbars.

### Make the current work and its evidence clear

Compose workbenches around the user's current Session, Plan, review, or decision. Keep navigation and scope stable, then
show the relevant state, evidence, and a route to inspect details. Group evidence by what it helps explain, not by
equal-sized decorative panels. Object titles and the next action outrank timestamps and other metadata.

Use space and tonal separation before adding borders or elevation. Existing Plan Cards retain their documented border
and restrained shadow; timelines and evidence rows use their lighter shared patterns. Avoid decorative terminal styling,
neon telemetry, and animation that competes with changing output. Blue identifies action and selection, mint identifies
the brand, and status colors keep their established meanings. Do not add violet as a second action color or impose a
fixed percentage of accent color on every screen.

Live state must be distinguishable from saved evidence. Where a surface supports live, paused, or stale data, make that
distinction visible in text and keep the time context close to the evidence. Keep relevant commands, identifiers, and
output inspectable and copyable through existing controls.

### Prefer semantic UI language

Use semantic names that describe purpose, not raw appearance. Prefer `surface`, `accent`, `danger`, `warning`,
`metadata`, `card`, and `panel` over one-off color or layout names.

When a new pattern appears in multiple places, name it and add it here before it spreads as copied CSS.

### Design for agents as maintainers

Future UI work will often be produced by agents. Components, classes, and documentation should therefore make the
correct choice obvious:

- use stable pattern names;
- keep variants explicit;
- avoid clever styling that requires visual guessing;
- document when to use and not use a pattern;
- keep Workflow and Plan vocabulary aligned with `docs/domain-language.md`.

## Source of truth

### Printed documents

`src/ui/design-system/print.css` owns the paper layout shared by Plan Review and the Markdown artifact reader, in
standalone and Workspace views. Printing expands scrolling panes into normal document flow and omits navigation, review
controls, and annotations. Use `--rw-print-*` tokens for white paper, dark text, subtle code/table backgrounds, and
readable Mermaid shapes, labels, and arrows. `useDocumentPrintMode` restores diagram zoom after printing;
`printDocument` prints a static copy of the rendered article so application scrolling and popup layers cannot blank the
PDF. It waits for styles, fonts, and images. Edit and Changes modes provide the current document to this same path
without saving pending edits. Printing must not change the saved screen theme.

Use the current review interfaces as the primary visual reference:

- Plan Review: `src/ui/workspace/react/PlanReviewSurface.tsx` and the `/dev/plan-review` fixture;
- Code Review: `src/ui/workspace/react/CodeReviewSurface.tsx` and the `/dev/code-review` fixture;
- review layout and overrides: `src/ui/workspace/react/plannotator.css`;
- compact shared controls: `.rw-toolbar-button` and `.rw-segmented-toggle` in `src/ui/design-system/components.css`.

The rest of Workspace should reuse that language through these implementation layers:

- CSS baseline: `src/ui/design-system/tokens.css`, `src/ui/design-system/components.css`, and
  `src/ui/workspace/static/workspace.css` (ordered entry point for `static/workspace-styles/`; each section stays below
  1,000 lines). Keep import order stable to preserve overrides. Development loads the sections directly; the Workspace
  server and Plan Server packaging use `readWorkspaceStyles` to provide one complete production stylesheet.
- browser colors: `src/ui/design-system/themes/dark.ts`
- theme bridge: `src/ui/design-system/theme-bridge.ts`
- bundled website fonts: `src/ui/design-system/fonts.css`
- shell and navigation: `src/ui/workspace/layouts/WorkspaceLayout.astro`
- shared Plan Board page composition: `src/ui/workspace/components/PlanBoardPage.astro`
- board patterns: `src/ui/workspace/components/BoardColumn.tsx`, `PlanCard.tsx`, and `EpicCard.tsx`
- detail patterns: `src/ui/workspace/components/PlanDetail.jsx`
- editor and action islands: `src/ui/workspace/islands/`

When documentation and implementation disagree, inspect Plan Review and Code Review first, then update the shared system
and Workspace so they agree again.

### Canonical density examples

| Pattern                          | Reference                               | Desktop rule                                                  |
| -------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| Compact icon or segmented option | Review toolbar                          | 28px high, 6px radius, 11–12px label                          |
| Standard button, input, or tab   | Workspace navigation and review actions | 32px high, 6px radius, 12–14px label                          |
| Touch-critical control           | Session composer on narrow screens      | 44px minimum width and height; do not apply this desktop-wide |
| Card                             | Plan Card                               | 12px padding, 6px radius                                      |
| Board column                     | Workspace Plan Board                    | Square edges, separators only, 10–16px padding                |
| Status, count, or short metadata | Review state labels                     | pill radius; never use this shape for ordinary actions        |

These values are defaults, not a reason to add `!important`. A specialized interaction may differ when its content or
accessibility behavior requires it.

Attention Dashboard section headers reuse `.rw-toolbar-button` for newest/oldest sorting. Sections show five rows by
default, with a matching Read more/Show less button using `aria-expanded` and `aria-controls`. Refreshes preserve each
section's sort, expansion, and focused control.

Workspace brand, main, and Session context headers start at the top edge and share `--rw-shell-header-height` (52px).
Review title bars use the same minimum height. Sidebar controls remain vertically aligned when panels collapse; avoid
negative margins or extra top padding to simulate a shared row. The navigation brand row stays visible when its list
scrolls. Embedded workflow content uses its host's tab header and scroll area, with compact square rows and separators,
not a second heading or nested card stack.

## Component architecture

### Connection feedback

The online-only Workspace PWA uses `.rw-connection-notice` for a lost connection in an open page. Keep the current
surface and unsent text mounted; present one connection message and a Try again button. Retry checks reachability and
never resubmits actions. Use the shared surface, text, warning, and button tokens. If the app cannot load at all, use
`.rw-connection-page` and `.rw-connection-message`: a compact, self-contained explanation asking the user to check the
network, Workspace server, and Tailscale when applicable. Its Try again button reloads the requested destination. The
installed icon uses the existing W. brand mark, with safe padding for masked home-screen icons.

RunWield owns its browser UI components. Shared design-system CSS and primitives should live under
`src/ui/design-system/` so Workspace, Plannotator, and future browser surfaces can consume the same visual language. For
Workspace under `src/ui/workspace/`, the supported endpoint is Astro SSR, React islands, and Tailwind 4. Fresh, Preact,
and UnoCSS runtime code is retired for Workspace; remaining Preact/Zag components under
`src/ui/design-system/components/*.jsx` are legacy non-Workspace primitives until a dedicated design-system migration
replaces them.

Workspace surfaces must use RunWield semantic tokens for color, radius, spacing, and status intent. Tailwind utilities
and framework primitives are implementation tools; they should not introduce a competing visual language or bypass
`--rw-*` tokens.

RunWield components should preserve the compact review-surface aesthetic. React primitives may be added under explicit
React paths such as `src/ui/design-system/components/react/`, but RunWield still owns the shell, workflow vocabulary,
variants, and token bridge around them.

Primitive visual components such as buttons, cards, badges, notices, tabs, inputs, and textareas should be
RunWield-owned without a headless interaction dependency unless they require non-trivial keyboard, focus, portal, or
ARIA behavior.

Plan and Code Review share `ReviewCompletion` for successful decisions. Workspace reviews return to the originating
Session in the same tab; standalone reviews retain the completion overlay and its auto-close preference. Workspace must
never mount the standalone auto-close behavior.

### Delivery evidence card

Completed workflow evidence appears within the owning Session timeline as `.rw-delivery-report`, using semantic surface,
border, status and spacing tokens. Its shared data model also supplies the compact TUI text above continuation choices;
the TUI omits logos and breadcrumbs. Keep mechanical checks, semantic AI review, human code-review decisions, human
verification attestations, merge confirmation and Work Record state separate. Settings describe policies, not outcomes.
Show exact checked and delivered commits separately. Link recorded artifacts to the existing Markdown reader. Missing
history is unavailable; resettable retry counters must not be presented as lifetime totals. The count labels identify
recorded runs and repair cycles started. The card is saved completion evidence, not a live dashboard.

### Shared Markdown artifact reader

`ArtifactReadSurface` is the single read-only Markdown reader for Plans, PRDs, ADRs, Work Records, Epic artifacts, and
reports. Artifact kind changes labels and document metadata, never the reader implementation. All launches use its
full-window logo/title header, one Contents header, shared sidebar controls, and read-only document body.

Workspace Session links and Ideator PRD/ADR review prompts use the registered-artifact route. TUI artifact review
prompts, the Session artifact picker, `wld plans read`, and `wld wr read` use `startArtifactReadSurface`, which renders
the same component. Workspace launches return to the originating Session; local launches use Close. Feedback remains in
the owning Session interaction; opening or closing a reader does not approve a Plan. Surface Lab has one Read-only
Markdown fixture for the shared reader.

### Document callouts

Plan Review and the shared reader render Markdown alerts as callouts. Use them for the few points a reader must not
miss. Write the marker alone on its line, then a bold title, a quoted blank line, and a short explanation. Plannotator
shows the title in the alert header instead of the visible kind label; the kind remains accessible:

```md
> [!WARNING]
> **Saved links must keep working**
>
> Renaming a Plan must not break links that open it.
```

| Marker         | Meaning                          | Color token                                  |
| -------------- | -------------------------------- | -------------------------------------------- |
| `[!WARNING]`   | Risk or surprising behavior      | `--rw-callout-warning` (amber)               |
| `[!NOTE]`      | Constraint or context            | `--rw-callout-note` (blue)                   |
| `[!TIP]`       | Reason behind the approach       | `--rw-callout-tip` (brand teal, not success) |
| `[!CAUTION]`   | Existing kind in other artifacts | `--rw-callout-caution` (red)                 |
| `[!IMPORTANT]` | Existing kind in other artifacts | `--rw-callout-neutral`                       |

A callout has a tinted border, a muted fill, and card corners. Plannotator shows the authored title next to its icon, or
the kind label when there is no title. The kind remains accessible in both cases, so meaning does not depend on color.
Styles in `components.css` only change the box appearance; they do not move text or change block attributes. On paper,
`print.css` draws a gray box and keeps the header legible.

Do not wrap a whole section, a step list, or a verification list in a callout, and do not repeat its content outside the
box. A marker with text on the same line is an ordinary quote. The Changes view shows callouts as plain quotes with
their text intact; matching callout styling there is deferred.

### Phone review layout

Embedded reviews constrain the Workspace grid column to the viewport. At phone widths, header actions and document
controls wrap; every sidebar-state combination uses one document column, with open sidebars shown as overlays. The
document scroll area takes the remaining height below the header and controls. Only standalone reviews reserve space for
a fixed bottom action bar. Long prose and metadata wrap inside the document instead of widening the page.

### Shared loaders

Use `RunWieldThinkingDots` for every browser loading state: navigation, page startup, panels, thinking, and pending
button actions. It uses the TUI’s Braille dot sequence and 120 ms frame timing, with an accessible status label. Use
`showLabel={false}` in compact buttons. Astro islands use `LoadingSurface` in their `fallback` slot so the loader
appears before JavaScript finishes loading. Workspace also shows it while fetching the next page.

Workspace startup uses a plain `LoadingSurface` labeled “Workspace loading”, without a card or explanatory copy.

The shared `.rw-thinking-glyph` mask in `src/ui/design-system/components.css` is the single browser animation; static
server HTML and the plain browser shell use that same class. Imported review spinners (`.animate-spin`), including
portals, and image-loading skeletons receive this artwork through the shared stylesheet. Do not introduce another
spinner, pulsing dots, or animated loading skeleton. Reduced-motion mode shows a still frame. Labels use
`--rw-text-muted` by default.

### Agent mascots

The Core `mascot` setting hides the mascot on both TUI and Workspace surfaces when set to `false`.

`RunWieldMascot` adds the approved one-bit W character beside Workspace's composer Agent controls. TUI uses the same
source in `src/ui/mascot/frames.ts`, rendered as Unicode half blocks above the footer Agent identity in a reserved right
column. Full artwork is 20 × 18 pixels (20 columns × 9 terminal rows); short or narrow terminals use a static two-row
face. Workspace uses 60 × 54 pixels, or 40 × 36 on phones. Use `--rw-text` as the single foreground color.

Mascots complement the written identity and existing Thinking status; they do not replace generic loading indicators.
Animate only during live busy activity. Hold a still pose during answers, idle, or owner interaction; Ideator's full
bulb indicates observed answer text, never estimated completion. Browser motion stops offscreen, in hidden tabs, and
under reduced motion. Unmounting or closing a surface cancels its clock. Reserve dimensions across frame changes.

Init and Router use Base; Guide alone carries the direction sign; Slicer uses Planner; every Engineer variant shares
Engineer. Delegated agents inherit the parent's identity (pass the inherited ancestor for nested delegation). Recorder
and Tester have no mascot. Unknown named agents use Base. Operator uses the approved lever; the earlier gear remains
commented in the source for reference. These shared identity and activity requirements are owned by
[Core](prd/runwield-core-prd.md#agent-mascots).

### Session timeline and control patterns

Normal System, recovery, and interaction-result notices use a mint (`--rw-brand`) stripe and tint to identify RunWield.
Warnings and errors retain their amber and red stripes. User messages use blue.

Core’s `busy_changed` event drives a shared dots loader labelled “Thinking...” at the live end of the Session timeline,
including before the first assistant output. Idle removes it; saved history never restores it. Pause it while a live
interaction needs the owner’s answer, matching the TUI. Do not infer this indicator from Plan or activation state.

Session detail surfaces use one ordered timeline for committed history. Live Core waits appear as temporary items and
must look different from committed transcript entries. If the server process loses that wait, show the plain
interruption line: “The agent was interrupted. Ask it to continue.” Do not style it as transcript history.

Treat the Session as one continuous work surface. Use dividers, subtle intent rails, and background shifts to
distinguish timeline entries instead of wrapping every message, tool event, workflow stage, and status in a separate
card. The Session summary, stream, composer, and workflow rail should read as adjacent panes. The Session list follows
the same rule: one catalog with compact rows, not a grid of raised Session cards.

On mobile, the Session context sidebar covers the full conversation area below the Workspace header. Keep its tabs and
collapse control visible while the selected panel scrolls. Closing it reveals the conversation and composer in place.
Use the dynamic viewport height so browser controls do not push the bottom of the Session offscreen.

Mobile Session composers stay in the normal surface stack, preserve drafts, and keep the primary button touch-sized. The
New Session composer uses a visible screen heading and an empty text field; do not add helper copy or dev/API messages
inside the composer. Dev-only notices belong in a separate shell row above the Session surface.

The composer stays usable while a Session is working. **Steer** sends a message to the current agent; **Queue** saves a
follow-up in the current browser tab. Show pending steering and queued follow-ups above the input. Discover running
turns and questions by Session identity, including turns started in the TUI. A busy Session needs no takeover or
recovery control. If the running process is briefly unavailable, keep the draft and allow queuing. Agent and model
controls can accept one pending change when the current Workspace owns the operation; show **Applies after this
response** until it is applied. Thinking changes can show immediately when Core accepts them.

Composers accept images by paste, drag-and-drop, or **Attach image**, including a phone's file picker. Show the image
before sending with a Remove action, and preserve it in the conversation after sending and reloading. Use the shared
`.rw-image-previews` treatment. Save image drafts in IndexedDB; browser storage limits must never block Send.

On desktop and mobile, the composer starts collapsed and collapses when focus leaves it. Its compact row contains
Attach, a single line with Agent, provider/model and Thinking, and the primary action. Mark retained text or images as
Draft. Focusing the summary opens and focuses the textarea; moving focus among composer controls keeps it expanded.
Retain mounted text, images, pending messages and settings through collapse/expand. Show dropdowns, previews, queue and
command choices only while expanded. Animate composer height with the shared control duration and easing; reduced motion
switches immediately. As its height changes, preserve the bottom visible line of history, keeping live followers at the
bottom and readers at their current place.

Keep the expanded composer footer in one row, including on phones: a small **+** attachment button on the left, Agent,
provider/model, Thinking, and one primary icon button: Stop while work runs and the draft is empty, Send/Steer when text
or images are present. Queue remains a separate expanded-only action. Preserve accessible names and tooltips for icon
buttons; model options include their provider. Enabled settings use normal text contrast, a visible control background
and border, and a pointer cursor; only disabled controls look muted.

The TUI is the behavior reference for Session controls and commands. Agent selection loads that Agent's settings,
including the active model preset. Displaying these defaults does not create a manual override. Explicit model and
thinking choices apply to that Agent; selecting a different Agent resets them, including before the first message. Model
labels use `provider/model` so similarly named models remain distinct.

Typing `/` at the start of the input opens `.rw-command-menu`, an anchored, scrollable command list above the composer.
Filter as the user types; Up/Down selects, Enter/Tab completes, and Escape dismisses without stopping the Agent. Support
touch selection and keep keyboard focus in the input. Agent and model commands offer argument choices; prompt templates
and skills use the same catalog and Runtime expansion as the TUI. Browser actions open their corresponding Workspace
surface rather than sending commands as messages to the model. Standalone local question pages for ACP use the same
control hierarchy: clear heading, native form fields, primary submit, secondary cancel, visible focus, and semantic
`--rw-*` token intent.

Open conversations at the latest messages and offer **Load earlier messages** above the timeline. Loading old history
must not disable Send. Keep Session generations, locks, and request-delivery details out of the ordinary screen.

Completed contiguous technical entries can collapse into one chronological **Activity** group after the next Agent
message starts. Expansion must show the original tool names, thinking text, output, and errors. Running or trailing
technical entries stay visible as normal timeline rows.

Session scrolling follows new live content only while the reader is near the live edge. If the reader scrolls away, keep
the viewport stable and show a **Latest activity** action that returns to the live edge.

Messages submitted while another surface owns Session Control remain editable and sendable. Show the sending surface's
small in-memory queue directly above the composer input—not in transcript history—and remove each item when its turn is
accepted after Session Control becomes idle. Workspace keeps this array only in the current browser tab. The TUI uses
the same placement immediately above its editor.

Session and review workbenches constrain the outer shell to `100dvh` with no document scrolling. Only the transcript,
sidebar, and review panes scroll. Do not retain a `100vh` minimum on their shell or navigation pane: mobile browser
chrome can make that larger than the visible workspace and scroll header controls offscreen.

Workspace and review layouts request `interactive-widget=resizes-content` in their viewport metadata. On Android Chrome,
this lets the keyboard shrink the layout and its viewport units, keeping the composer and controls above the keyboard.
`100dvh` alone does not respond to the keyboard with Chrome's default viewport behavior. Preserve normal browser zoom.

### Compact Plan Review

At 980px and below, follow Plannotator's document-first mobile layout: both review sidebars start collapsed, a compact
header retains the title and approval action, and secondary execution/annotation controls use `RunWieldMenu`. Keep View,
Edit, Changes, Contents, and Annotations reachable in a single document toolbar. Use 44px touch targets for mobile
review navigation. Preserve the existing desktop layout.

An expanded review panel fills the workbench below the header, with square edges, its own scrolling content, and tabs
beside its close control. Show one panel at a time; closing it restores the document's position and focus. Choosing a
Contents entry or comparison version returns to the document. Resizing into the compact range collapses both panels;
manual reopening remains available until the next breakpoint change.

### Review panel defaults and diff layout

Plan and Code Review start with Annotations collapsed. Reveal the panel when the first annotation is added (or a saved
annotation draft is restored), or when the owner opens it from the toolbar. Later annotations respect a manual collapse.
Use the shared `useReviewAnnotations` hook for this behavior.

Code Review restores the browser's last Split/Unified selection after hydration, including choices made in Settings.
Diffs wrap to their container width in both normal and Guided Review. At 980px and below, collapse Files automatically;
the toolbar's Files button can reopen it. Compact panels overlay the workbench one at a time instead of stacking above
the diff. Preserve the chosen diff layout while resizing.

### Session context sidebar

Every persisted Session has one durable context sidebar beside its transcript. Do not show the sidebar for the
unsubmitted New Session composer. Use one `RunWieldPanelToggle` in the main Workspace header for collapse and restore,
matching the review sidebars. When open, the tabs sit beside it over the sidebar, with the same width and divider as the
pane below. When closed, the button moves to the right edge and reverses its icon without changing height. Keep the
header at one consistent height in both states. The open pane's background and divider extend to the viewport top; its
top padding stays inside that background, preserving the controls' vertical alignment. No horizontal divider separates
the tab rail from the sidebar content; the full header divider spans only the conversation. On phones, open tabs take
the title's space in the same row. Do not repeat tab titles as inner headings. Remember the desktop choice. At 900px or
narrower, hide the sidebar on entry and when crossing that breakpoint, regardless of the saved desktop choice. Allow
explicit reopening; restore the desktop choice when widening again. Narrow-screen toggles do not overwrite that choice.
The sidebar has three peer tabs: **Workflow**, **Session**, and **Artifacts**. Default to Workflow when the Session has
an active workflow; otherwise default to Session. Preserve the reader's selected tab while the same Session remains
open, except when a new Plan attaches and selects Workflow.

Workflow shows canonical workflow stages, the current step, blocker text, and the next action. It is not a second
transcript and not a separate progress page. When the active Plan explicitly belongs to an Epic, show **Epic** and its
name above **Plan** and the child Plan name; omit Epic for standalone Plans. Workspace and TUI use the same workflow
presentation facts and `sessionSidebarFields` list, including labels, precision, and unavailable values. Workspace adds
the current **Agent**, **Model** (`provider/model`), and **Thinking** at the top, omitting the name already in the
header. Use the active Session snapshot rather than staged composer selections. Live operation updates keep these fields
and the workflow association current before the turn finishes. Attaching a new Plan selects Workflow once; subsequent
updates preserve the chosen tab. Workflow progress refreshes independently of transcript streaming. Session shows
durable, user-facing facts such as its name, message and tool-call counts, compaction count, queued prompts, and context
composition. Context composition shows used versus model capacity and splits the used context into **System & setup**
(agent instructions, tools, instruction files, memories, skills, and Project state) versus **Conversation** (Session
chat and provider overhead). Do not expose storage generation or restate that the Session being viewed is active. In the
TUI, do not repeat agent, model, thinking, cost, folder, or branch details from the footer; the detailed context
breakdown may expand on the footer's compact context percentage. Artifacts lists only explicitly registered,
Project-relative Markdown artifacts; never infer an artifact by scraping transcript text. Each artifact opens in the
shared read-only artifact surface and returns to the owning Session.

Artifact readers replace the Workspace shell with the same full-window layout as standalone readers. Keep the W. logo,
artifact title, path, and Back to Session action in their own header. Standalone launches retain Close. The document
toolbar uses `RunWieldPanelToggle` for Contents, matching review controls. Contents starts collapsed at widths of 980 px
or less. On phones, opening it fills the document pane; selecting a heading returns to the document. The toolbar remains
reachable for collapsing or restoring Contents. Show one Contents header and collapse control; hide the imported
sidebar’s duplicate tab row.

Use the `.session-context-*` classes and `--rw-*` semantic tokens for the tab rail, fields, workflow rows, and artifact
links. The sidebar is a flat adjacent pane with dividers, not a stack of floating cards. At narrow browser widths it
overlays the conversation below the shared header without changing its information model.

**Sidebar motion**

Workspace navigation, Session context, review Contents/files and annotations, and artifact Contents share a short
horizontal slide and fade when opened or closed. Use `animateSidebarChange` from the shared design system (or
`animateSidebarUpdate` for React state) for user actions. Native view transitions preserve the outgoing panel image
without retaining hidden interactive content. The adjacent canvas follows the layout change; document text does not
scale. Motion uses `--rw-sidebar-motion-duration` (180ms) and `--rw-sidebar-motion-ease`, with a 12px edge offset and no
bounce. Initial state, responsive layout changes, unsupported browsers, and reduced-motion preferences stay instant.
Sidebar transitions are scoped separately from page navigation and do not animate panel resizing.

The TUI uses the same Session projection. Wide terminals show the context pane on the right, pinned to the top of the
visible terminal viewport while transcript blocks scroll independently, and cycle the three tabs with **Ctrl+]**. Its
two-line footer remains full width below both panes. Narrow terminals retain the existing transcript-only layout. If a
TUI user presses **Alt+]**, show a picker of registered Session artifacts and open the selection in the shared browser
reader through a token-protected local launch. Close stops that reader without changing the artifact or running turn.

Workspace navigation uses a draggable `.rw-panel-resize-handle` on its right edge. Keep the sidebar between 220 and
480px while reserving at least 420px for the main pane. Remember its width separately from its collapsed state. The
handle is a focusable separator: arrow keys adjust width, Home/End select the limits, and double-click restores 280px.
Hide the handle in the narrow-screen overlay layout. Project navigation lists active Plans before standalone Sessions.
Nest up to two proven associated Sessions below each Plan, exclude those Sessions from the standalone list, and expand
Plan or nested-Session overflow in place so focus stays in the sidebar. Muted On-Hold Plans appear after active work.
Session lists use saved names (including rename entries), never the first prompt. Omit unnamed, empty Sessions by
default; keep named, nonempty, and unreadable Sessions accessible.

Workspace-wide actions live in the hamburger menu to the left of the Workspace logo. Browser notification permission,
its enabled/blocked state, and the public Documentation link belong inside that menu, not among Session or review header
actions. Use the shared `RunWieldMenu` popover and `.rw-menu-*` styles: semantic tokens, keyboard focus, Escape and
outside-click dismissal, and a portal so the navigation pane cannot clip it. Plan and Code Review options use the same
menu and `RunWieldMenuItem` rows. All hamburger and sidebar collapse/restore controls use `RunWieldIconButton`
(`.rw-icon-button` for the imperative Workspace shell): transparent and borderless, muted hover/open fill, visible
keyboard focus, and a fixed compact 28px height at every viewport width. Menu navigation links use the same
`.rw-menu-item` row as actions. Optional text labels may extend the width.

### Settings and devices

Projects and Devices are peer Workspace-level views in `SettingsLayout.astro`. Their shared underline tabs sit in the
Workspace header; content has matching panel spacing on both sides with a 64rem maximum width. Cards and Project rows on
Projects, Project Settings, and Devices use square corners. Project rows open that Project’s settings as a child page.
Its header replaces the tabs with a **Back to Projects** control and **Project settings** title. Keep the Project name
and root status as compact context inside the content. Do not repeat Plan Board or New Session actions here. Devices
lists Workspace-wide paired browsers and never inherits a Project-specific scope. Device rows place the shared `badge`
for **Current** beside the device name and the Revoke action at the trailing edge; narrow screens wrap the action
beneath the metadata without stretching the badge.

Project disclosure triangles and settings gears use explicit 16px SVGs, matching the sidebar controls rather than
font-dependent text glyphs. The triangle rotates between right and down; the gear keeps a compact 28px hit area.

## Token model

Workspace already exposes semantic CSS custom properties using the `--rw-*` prefix. Keep this as the public browser UI
token namespace.

### Narrow Code Review

Below 980px, Code Review stacks its file list, diff, and annotations. The file list is bounded; the diff retains a
readable scroll area instead of shrinking to its toolbar. Diff controls wrap when space is limited. Session context tabs
and Workspace navigation rows use 44px touch targets on phones.

### Browser themes

Browser surfaces currently use the approved dark identity from `brand/` and the sibling `../runwield.dev/` website,
regardless of OS color preference or the selected TUI theme. TUI settings and appearance remain independent.

`src/ui/design-system/themes/dark.ts` exports `DARK_BROWSER_THEME` with `name`, `colorScheme`, and semantic `colors`.
`renderRunWieldThemeCss(theme = DARK_BROWSER_THEME)` in `theme-bridge.ts` is a pure browser renderer. It keeps the Radix
and Plannotator aliases without reading TUI settings. Both browser `/theme.css` endpoints call it without arguments. The
old `loadRunWieldThemeCss` loader and unused Workspace `server/theme-css.js` module are removed.

Keep browser theme support: a future light or custom theme supplies a separate token set to the same renderer, without
restyling components or changing spacing and typography. No light theme, theme picker, or OS-following mode is shipped.
See [Workspace browser appearance requirements](prd/runwield-workspace-prd.md#browser-appearance-and-themes).

### Color tokens

Use existing tokens before adding new ones. Literal browser colors belong in the theme module, not component CSS.

| Token                    | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `--rw-page-bg`           | App background.                                              |
| `--rw-surface`           | Default panel, board column, and nested surface background.  |
| `--rw-surface-raised`    | Cards and prominent panels.                                  |
| `--rw-surface-muted`     | Selected states, counters, badges, and lower-emphasis fills. |
| `--rw-surface-strong`    | Hover states and stronger nested surfaces.                   |
| `--rw-text`              | Default text.                                                |
| `--rw-text-strong`       | Highest-emphasis text.                                       |
| `--rw-text-muted`        | Supporting text.                                             |
| `--rw-text-dim`          | Metadata labels, descriptions, and low-emphasis text.        |
| `--rw-accent`            | Primary accent, focus, active tab underline, primary border. |
| `--rw-accent-strong`     | Strong accent and secondary accent status.                   |
| `--rw-accent-text`       | Accent-colored readable text, links, and titles.             |
| `--rw-border`            | Default border.                                              |
| `--rw-border-strong`     | Stronger border and hover border.                            |
| `--rw-success`           | Successful, verified, or done-enough state.                  |
| `--rw-warning`           | In-progress, implemented, blocked, or caution state.         |
| `--rw-error`             | Failed, missing, denied, or destructive state.               |
| `--rw-code`              | Code and editor accent.                                      |
| `--rw-brand`             | Brand mark and sidebar rail; not an action color.            |
| `--rw-on-accent`         | Text on accent-filled controls.                              |
| `--rw-complexity-low`    | LOW Complexity label.                                        |
| `--rw-complexity-medium` | MEDIUM Complexity label.                                     |
| `--rw-complexity-high`   | HIGH Complexity label.                                       |

Filled colors have separate text roles: `--rw-on-accent-strong`, `--rw-on-success`, `--rw-on-warning`, `--rw-on-error`,
and `--rw-on-brand`. A theme must supply these roles. Do not assume the page background is readable on every filled
control. Primary controls retain contrasting text on hover and keyboard focus.

### Shape, control, and spacing tokens

| Token                                           | Purpose                                              |
| ----------------------------------------------- | ---------------------------------------------------- |
| `--rw-radius-control`                           | Buttons, inputs, tabs, and other ordinary controls.  |
| `--rw-radius-card`                              | Cards and nested content blocks.                     |
| `--rw-radius-panel`                             | Dialogs and enclosed panels; not flat board columns. |
| `--rw-radius-pill`                              | Statuses, counts, and short metadata only.           |
| `--rw-control-height-compact`                   | Review-style compact toolbar controls.               |
| `--rw-control-height`                           | Standard desktop controls.                           |
| `--rw-space-control-x` / `--rw-space-control-y` | Standard control padding.                            |
| `--rw-space-card`                               | Card padding.                                        |
| `--rw-space-panel`                              | Page-edge and panel padding.                         |

Shared CSS owns a border-box reset so declared control heights include borders and padding. Without it, a nominal 32px
control can render much taller. Do not override this reset locally.

Shared CSS should be split by responsibility rather than kept as one broad `styles.css` file:

- `themes/dark.ts` for the current browser color set; future themes use separate modules with the same semantic roles;
- `theme-bridge.ts` for browser color variables and shared review aliases;
- `tokens.css` for non-color typography, geometry, spacing, resets, and derived Complexity intent;
- `fonts.css` for locally bundled Outfit Variable and IBM Plex Mono, matching the website;
- `components.css` for reusable design-system primitives such as actions, cards, badges, notices, forms, metadata,
  dialogs, and editor/markdown surfaces;
- surface-specific CSS, such as `workspace.css`, for layouts and patterns that are not yet shared across browser
  surfaces.

### Typography and grouping

Use `--rw-font-sans` for browser UI and explanatory copy, and `--rw-font-mono` for code, commands, identifiers, logs,
and aligned technical values. Preserve existing compact metadata treatments such as `.eyebrow` and `.card-kicker`; they
are not a reason to set whole panels in monospace. Use tabular numerals when changing numbers must align, such as
durations, costs, and comparable metrics.

Keep the compact control sizes above separate from document reading sizes. Aim for a readable 50–75-character measure
for ordinary prose where the document layout permits; diffs, tables, and the established wide review canvas retain their
working width. Group related content with smaller internal gaps and larger gaps between groups, using the existing
spacing tokens. Do not introduce a competing spacing scale from a preset.

Match neighboring SVG icon size, stroke, and fill treatment. Icons explain an action or state; use visible labels or
accessible names and avoid emoji as new browser navigation or control decoration.

### External palette integration

External palettes are reference material, not an additional runtime theme. Map their roles to the existing tokens before
considering new CSS:

| External role                                     | RunWield equivalent                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| Background / surface / chrome                     | `--rw-page-bg`, `--rw-surface`, appropriate existing surface level       |
| Foreground / muted foreground / chrome foreground | `--rw-text`, `--rw-text-muted`, `--rw-text`                              |
| Primary / primary foreground                      | `--rw-accent`, `--rw-on-accent`                                          |
| Focus / border                                    | `--rw-accent`, `--rw-border`                                             |
| Success / warning / danger and their foregrounds  | `--rw-success`, `--rw-warning`, `--rw-error` and their `--rw-on-*` roles |
| Secondary accent or raw color ramps               | No automatic mapping; require a real semantic use before adding a token  |

The evaluated StyleSeed palette supplied only role declarations and unused blue/violet ramps, with no component or
layout CSS to reuse. Its roles are already covered above. Keep the approved values in `themes/dark.ts` and the aliases
in `theme-bridge.ts`; do not copy its generated colors or introduce `--ss-*` variables. Contrast results for an external
palette do not validate RunWield's actual combinations, mixed backgrounds, or interaction states.

### Adding tokens

Only add a token when an existing semantic token cannot describe the intended use. New tokens should be:

- prefixed with `--rw-`;
- semantic rather than literal;
- documented in this file;
- defined in each browser theme when they represent colors; keep review aliases in `theme-bridge.ts`;
- used by at least one real pattern.

Avoid component-specific tokens until a component genuinely needs stable customization across surfaces.

## Layout patterns

### Workspace shell

Use the shell pattern for full-page browser surfaces:

- centered wide container that lets workflow boards use the viewport;
- 16px desktop page padding, reduced only when a full-bleed review surface owns the viewport;
- top-left RunWield brand link;
- tabbed or action-based navigation below the header;
- main content below navigation.

The shell should feel like a local tool, not a marketing site. Avoid large hero sections, decorative imagery, and sparse
SaaS-dashboard layouts.

### Tabs

Use tabs for peer workspace views, such as active, closed, and on-hold Plan groupings.

Tab rules:

- use the shared `.rw-underline-tabs` rail for Plan Board views, Session context, and both review sidebars;
- in every standalone and Workspace Plan/Code Review, put the Annotations/chat tabs in the right sidebar header beside
  its collapse control. Do not add a separate Annotations heading above them. Without chat, retain the simple heading;
- use the same tabs for Plan Contents/Versions and Code Files/Changes in the left sidebar header; keep both labels
  visible and the collapse control beside the rail;
- keep the rail and its links/buttons square, with no enclosing box; a thin baseline runs under the tabs;
- active tabs use strong text and a thicker 3px accent underline; links use `aria-current`, buttons use `aria-selected`;
- hover states use `--rw-surface-muted`; keyboard focus has a visible inset outline;
- use compact 32px controls by default, with the Session header's compact/touch size overrides;
- tabs may include a trailing utility slot, such as search, when it filters the current view.

Do not use tabs for one-off actions. Use action buttons instead.

### Segmented controls

Use `RunWieldSegmentedControl` for compact selectors. Imported controls use its shared `attachSegmentedSelection`
adapter. Both reserve enough width for the longest selected label, keeping the toolbar's footprint steady. Labels and
button sizes switch immediately; only the selection highlight slides for 180ms. Never animate button width, padding, or
gaps. Use `--rw-control-motion-duration` and `--rw-control-motion-ease`, including for imported controls. Reduced-motion
preferences disable the transition. Selection and tool behavior update immediately.

### Action controls

Use `.primary-action`, `.secondary-action`, and `.danger-action` for ordinary actions across Workspace and review
surfaces. These classes are defined only in `src/ui/design-system/components.css`; feature stylesheets may add layout
classes but must not redefine their shape, color, type, hover, or focus behavior. Do not introduce reversed aliases such
as `.action-primary`; one vocabulary keeps markup and visual behavior searchable.

React surfaces should use `RunWieldButton` for state-changing actions and `RunWieldLink` for navigation styled as an
action. `RunWieldButton` defaults to `type="button"`; submit controls must opt into `type="submit"`. Do not turn an
anchor into a button handler or use placeholder fragment URLs for actions that do not exist.

### Toolbar controls

Use `.rw-toolbar-button` for compact actions inside Workspace toolbars. This class is shared in
`src/ui/design-system/components.css` so related actions keep the same size, border, text color, hover state, and
disabled state. Use it for toolbar actions that open side panels, switch helper views, or add comments. Do not make
one-off local button styles for those actions.

Use `.rw-toolbar-select` for native dropdowns alongside toolbar buttons. It shares the toolbar surface and text tokens,
with explicit hover, keyboard focus, and disabled states. On New Session, use the labeled native Project select above
the composer. Match the composer's width and keep it visible when the composer collapses. Use the compact select style
on desktop and a 44px touch target on phones; long Project names must not widen the page. Disable it while a draft or
create request locks Project choice.

Use `.rw-segmented-toggle` for compact toolbar choices such as `Changes` / `Files`, `Side by side` / `Unified`, Plan
mode choices, and settings choices. Each option must include an icon, a label in a `<span>`, and a `title` that matches
the label. Active buttons can use `.active`, `aria-pressed="true"`, or `aria-selected="true"`. The active option shows
its label. Inactive options stay icon-only. Hover changes the icon/button color and the browser tooltip shows the label;
hover must not expand labels.

Use the Plan comment modal as the canonical modal composer style. Use `.rw-modal-primary-button` for the main action.
Put keyboard help such as `⌘↵` or `Ctrl+Enter` to the left of that button with `.rw-modal-submit-hint` when the action
has a keyboard shortcut. Use `.rw-modal-textarea` for modal/composer textareas that must match the shared comment input
size, blue border, focus ring, and surface.

Use the **Review action button** pattern for a prominent safe action in Plan Review, Code Review, and read-only review
surfaces. The CSS hooks are `.rw-review-action` for wrappers around Plannotator buttons and `.rw-review-action-button`
for native buttons. Use it for actions such as **Send Annotations** or **Close** when the action must stay easy to find
inside the review surface. Do not use it for destructive outcomes or low-emphasis toolbar controls.

Use the **Artifact conversation** pattern when the active workflow agent can discuss and revise the artifact without
leaving its review surface. Render `ArtifactConversationSidebar` inside an existing review sidebar, keep its message and
operation wiring in the owning surface, and use the shared `.rw-artifact-conversation-*` classes. Review context is
attached explicitly as a removable chip; attaching review notes enables Send without requiring message text. Removing
the attachment disables Send again if the message is empty. Only one agent turn may be active at a time. Code Review's
Send Annotations action uses this same repair conversation when available; approval remains explicit. When a revised
Plan arrives, replace the readable artifact in place and open a before/after diff automatically. Code Review refreshes
its existing diff while retaining the transcript, selected file, diff collapse choices, active Guided Review/diff view,
and collapsed guide sections. Mark retained guide prose as belonging to an earlier revision and offer regeneration; do
not replace the owner's navigation state during a repair. The component is artifact-neutral so Plan Review, Code Review,
and later review surfaces can share the same transcript, composer, working, and error states.

### Boards and columns

Use board columns for status-grouped workflow objects.

A board column contains:

- a bordered `--rw-surface` panel;
- a header with label, description, and count pill;
- a vertical stack of cards;
- a dashed empty state when no cards are present.

Use horizontal overflow when the number of workflow statuses is large. Preserve status order from workflow semantics,
not from visual convenience.

## Surface patterns

### Cards

Cards are the default representation for selectable workflow objects. Use the Plan Card as the canonical card pattern.

A card should include:

- a kicker naming the object role, such as Feature or Epic;
- the object title as accent text;
- a short summary or fallback text;
- badges for important health or dependency states;
- whole-card click affordance when the card opens detail;
- optional drag grip only when drag is allowed;
- 12px default padding and the card radius.

Use the raised surface, small corners, border, and restrained shadow from Workspace. Hover may accent the border; avoid
large lifts or shadows that make dense boards visually unstable. Do not create flat, borderless workflow cards.

### Epic cards

Epic Cards are a specialized Plan Card variant. They should remain visibly related to Plan Cards while signaling that an
Epic is a container:

- use the accent-tinted gradient treatment;
- include child progress;
- show child health badges;
- open Epic detail rather than flattening child FEATURE Plans by default.

### Detail panels

Use detail panels for object inspection and editing. A detail view should have:

- a close or back affordance;
- a title row with status or Complexity labels when relevant;
- primary content in the main column;
- metadata and lifecycle actions in a side column when space allows;
- responsive collapse to one column on narrow screens.

Do not make workflow-critical Front Matter or lifecycle state editable only through raw text. Use structured actions for
workflow-critical changes.

### Dialogs

Dialog is a general modal primitive for browser surfaces that need focused confirmation, short forms, or blocking
workflow decisions. Workspace does not currently provide a source pattern for dialogs, so new dialogs should preserve
the Workspace visual language while using Radix-compatible React behavior for accessibility and interaction behavior.

Dialog should be flexible rather than confirmation-only:

- support yes/no confirmation flows;
- support arbitrary body content for short forms or explanations;
- support flexible footer actions using primary, secondary, danger, or disabled action patterns;
- keep one visually dominant primary or danger action when a decision is required;
- make dismissal behavior explicit when closing the dialog could lose input or skip a workflow decision;
- remain ephemeral by default: opening a dialog should not change the browser URL, and refresh may close it unless a
  future use case explicitly requires a route-backed dialog.

### Pairing code panels

Owner Workspace pairing uses one compact, flat authorization panel. Present it as a two-step sequence: identify the
device and copy the short code, then run the copyable CLI command. Use horizontal dividers and aligned rows rather than
nested cards. The timer belongs directly under the code so its expiration scope is unambiguous.

Use the existing form, primary/secondary action, and status text patterns. The copy command should look like a real
action button, not a plain text link. Never style a pairing code as a long-lived secret; the surrounding copy should
make clear that it is short-lived and replaced automatically.

### Markdown and editor surfaces

Markdown and editor content should sit on the shared document canvas. In a workbench, the canvas may use one quiet
document boundary, but do not place additional rounded containers around each section. Markdown headings use accent
text. Code and editor affordances should follow Workspace editor styling rather than browser defaults.

## Action patterns

### Primary action

Use primary actions for the main safe progression on a surface, such as saving or approving when approval is the normal
next step. Primary actions use the accent fill and dark text.

A page should usually have one dominant primary action.

### Secondary action

Use secondary actions for safe alternatives, navigation, and non-final workflow operations. Secondary actions use the
surface fill, border, and accent text.

### Danger action

Use danger actions for destructive, rejecting, failing, or denial-oriented operations. Danger actions use the error
color family and should not be visually confused with primary progression.

### Disabled action

Disabled actions should remain visible when their absence would hide workflow state. Pair disabled actions with nearby
text that explains why the action is unavailable.

## Status and feedback patterns

### Status pills and badges

Use pill-shaped labels for statuses, health markers, and compact metadata. Status labels and badges should use the same
shape language. Pills are a deliberate exception to the rectangular control language. Do not apply pill geometry to
buttons, links styled as actions, inputs, tabs, search fields, cards, or panels.

Status color intent:

- draft and feedback: muted/default;
- approved, ready for decomposition, ready for work: accent;
- in progress and implemented: warning;
- verified: success;
- failed: error;
- closed without verification and on hold: secondary accent.

Badges should be short. Prefer `Blocked by dependency`, `Missing parent Epic`, `Done enough`, or `Failed child` over
long explanatory text. Put detailed explanations in nearby body copy, metadata, or notices.

### Notices

Use notices for local outcomes and important contextual messages. A notice may be success, muted, warning, or danger,
but the message should explain the consequence in plain language.

## Workspace search

The global Search action uses the compact rectangular control language and stays in the Workspace header. `Cmd+K` or
`Ctrl+K` opens the same centered quick-search dialog. The query receives focus; Up and Down move the active result,
Enter opens it, and Escape closes the dialog and restores focus. Project and content-type filters, Refresh, and View all
results remain normal touch-capable controls.

Quick search and the full Search page use the `.rw-workspace-search-*` pattern in `src/ui/design-system/components.css`
for one result list. Each result has one title, a content-type badge, Project name, and a short current-source excerpt.
Selected rows use a surface change, not color alone. Loading uses `RunWieldThinkingDots`. Blank input gives a query
prompt; no-match and Project indexing failures keep the query and filters visible. At phone widths, filters wrap and use
44px controls without horizontal overflow.

## Forms and inputs

Inputs should use dark nested backgrounds, the 6px control radius, 32px desktop height, and explicit focus rings derived
from `--rw-accent`. Search fields use the same geometry as other controls; being inside navigation does not make a field
a pill.

Form labels and helper text should be visible. Do not rely on placeholder text as the only label.

## Metadata patterns

Metadata belongs in grouped definition lists when inspecting a Plan, Epic, review, or workflow object.

Rules:

- group metadata by user task or workflow concept;
- use dim labels and normal text values;
- preserve RunWield vocabulary from `docs/domain-language.md`;
- hide implementation-only values unless they help the user make a workflow decision;
- show unknown or missing metadata only when that absence matters.

Use `.metadata-reference-list` for metadata whose value is an external reference, such as Plan Ticket References. Render
one semantic link per safe `http`/`https` URL, use `target="_blank"` with `rel="noreferrer noopener"`, preserve visible
focus with `--rw-accent`, and allow long unbroken URLs to wrap inside the sidebar. Unsafe or non-HTTP values may be
shown as muted text but must not become clickable.

## Review-surface guidance

RunWield's Plan Review and Code Review surfaces are now the design reference. Preserve their compact toolbar, segmented
controls, thin dividers, full-height working layout, and clear three-pane hierarchy while replacing remaining imported
details with RunWield-owned components over time.

Plan Detail, Plan Review, and read-only Plan are modes of the same Plan workbench. They must share the full-height
review shell, compact title toolbar, document canvas, and pane boundaries. Change the available controls and side-rail
content for each mode; do not give one mode a separate dashboard-detail layout.

Workspace Plan Review and Code Review replace the entire owner shell with `ReviewLayout.astro`, the same full-window
layout used by standalone reviews. Their own compact toolbar contains branding, options, and decision controls; only the
review's Contents/Files and Annotations sidebars are present. Do not mount the Workspace Project/Session sidebar, its
restore control, or a second header on review routes. Workspace Plan Review keeps its wide document canvas. Read-only
artifact readers use that full-window shell too, with their own logo/title header and Back to Session.

Plannotator-specific mapping:

- plan review page: use the shell plus a detail-panel layout;
- Plan title, summary, Front Matter, and markdown body: follow Plan Detail and MarkdownView patterns;
- annotation submission: label the action **Send Annotations** and place it directly below the annotation sidebar
  heading, above the annotation list, using the Review action button pattern so it remains visible;
- approve/save: primary action when it is the normal forward path;
- request changes or deny: danger action when it sends Feedback back to the planning Agent;
- comments and annotations: use badge, notice, and metadata patterns before inventing a separate comment aesthetic;
- code review diffs: use markdown/editor surface rules with strong file and hunk hierarchy;
- review outcome messages: use notices with clear workflow consequences.

Review surfaces share tokens with Workspace. If a review interaction requires a new pattern, add the pattern here first
or in the same change, then consider whether Workspace should reuse it.

## Accessibility and interaction rules

- Preserve visible focus states for all interactive elements.
- Do not encode status by color alone; pair color with text labels.
- Use real links for navigation and buttons for state-changing actions.
- Keep whole-card links accessible with descriptive labels.
- Use `aria-label` or visible headings for board columns and important panels.
- Preserve responsive behavior for narrow screens.
- Avoid hover-only information; keyboard and touch users need the same workflow context.

Use WCAG AA contrast for browser text: at least 4.5:1 for ordinary text and 3:1 for qualifying large text. Meaningful
control and graphical boundaries need 3:1 against adjacent colors where required; decorative separators do not all need
that contrast. Check the rendered background and hover/focus states, not just a palette swatch. See W3C's
[text contrast](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum) and
[non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) guidance.

Use the shared control/sidebar duration and easing tokens for functional transitions. An action or important status must
not wait for animation to finish. Preserve the complete final state with reduced motion, including the shared loader's
still frame.

### Terminal adaptation

Use `src/ui/theme/theme.js` and its semantic theme helpers for terminal colors and Markdown, selection, and editor
styling. Preserve the user's selected terminal theme; do not impose browser hex colors or CSS variables on ANSI output.
See [Themes](user-documentation/themes.md). Shared intent does not require identical color values across renderers.

Terminal fonts and cell sizes belong to the terminal. Express hierarchy through order, spacing, emphasis, labels, and
selection markers rather than browser font sizes, radii, shadows, or pixel target sizes. Keep status understandable
without color. Reuse the existing TUI symbols and loaders instead of importing a browser icon family.

At Session completion, reuse `PromptSelectBlock` in the active prompt area for the outcome and next-step choices. Its
selected surface, spacing, and keyboard focus keep the decision visible above the footer even after long scrollback. Use
an explicit completion heading and “What would you like to do next?” with Start a new session, Load a Plan, and Quit.
Explain that Load a Plan starts a fresh Session. Clear the pinned review/publishing panel on confirmed success; keep the
outcome and reports in conversation history. Escape dismisses the selection and restores the composer.

Check narrow and wide terminal layouts with real long paths, identifiers, multiline content, and live updates. Preserve
readable wrapping, keyboard selection, input focus, and scroll position. Browser motion preferences do not configure
terminal animation; follow the TUI's own rendering and settings behavior. This guidance introduces no new terminal theme
or motion setting.

## Extension checklist

Before adding or changing browser UI, check:

1. Does Plan Review, Code Review, or an existing shared pattern already cover this?
2. Are all colors expressed through `--rw-*` tokens?
3. Are radius, control height, and padding expressed through the shared density tokens?
4. Is pill geometry limited to statuses, counts, or short metadata?
5. Is the pattern named in RunWield domain language?
6. Does the UI preserve the compact review-surface look and feel?
7. Are statuses and workflow consequences visible in text, not just color?
8. Would a future agent know which pattern to copy from this document?

For visual changes, run the relevant project checks and inspect the actual changed routes at narrow and wide widths when
both are supported. Exercise the states the surface owns, including loading, empty, error, success, disabled, permission
restrictions, keyboard focus, and reduced motion. Palette checks and source review cannot establish font loading, visual
hierarchy, overflow, or usability. Record the routes, states, viewport sizes, and any unverified cases; a passing
automated score does not establish visual acceptance.

## Non-goals for v1

- No marketing-page layouts or effects; brand colors and website typography are shared.
- No large-radius, oversized SaaS-dashboard component language.
- No requirement to extract a full component library immediately.
- No generated palette replacing the approved brand or browser theme modules.
- No browser theme picker or light theme in the current scope; keep future themes easy to swap.
- No commitment to W3C Design Tokens file format until a real integration needs it.

## Plannotator component reuse exception

Workspace may temporarily host imported upstream Plannotator React/TypeScript components while RunWield validates deeper
collaboration with the Plannotator ecosystem. This exception is scoped to `src/ui/workspace/` and does not by itself
change the rest of RunWield's JS/JSDoc convention.

When imported Plannotator components are used:

- prefer package-style imports such as `@plannotator/ui/components/RenderedMarkdown` through Vite aliases that point at
  a pinned checkout under `third_party/plannotator/`;
- pin and review the upstream commit before updating it;
- preserve RunWield Plan vocabulary, Plan Lifecycle controls, and canonical markdown storage;
- bridge Plannotator/Tailwind-style tokens to RunWield `--rw-*` variables instead of replacing the Workspace visual
  identity in one step;
- use Radix primitives from Plannotator when needed for shared React surfaces, but keep RunWield-owned semantics and
  workflow language around them.

The Plan Board, Plan Review, and Code Review each have one surface body. Shells are explicit presentation concerns:

- `PlanBoardPage.astro` renders the same board, filters, tabs, cards, and empty states with either the compact local
  `wld plans ui` shell or the owner Workspace sidebar shell. Both place view tabs and trailing search in the header row.
  Only the local shell shows the W. logo and RunWield Plans heading; the owner shell does not repeat Project title or
  checkout health above the board. Narrow screens may wrap search below the tabs. Columns have square edges and only
  separators between them, with one empty message per column and no duplicate whole-board empty notice. Keep the drag
  feedback region hidden until there is an actual move or rejection to report; omit the default instruction card;
- `PlanReviewSurface` and `CodeReviewSurface` use their default full-window presentation in `ReviewLayout.astro` for
  both TUI-launched browser windows and Workspace review routes. `ArtifactReadSurface` uses this same full-window shell
  for Session artifacts, with its own title and return action. Workspace payloads retain their own APIs and navigation;
- behavior, payload interpretation, annotations, and decision controls stay in the shared surface. Do not fork a
  Workspace-only copy of either review.

Astro development entrypoints:

- `deno task workspace:dev` starts the development server and opens `/dev`, the catalog for every paired presentation;
- `/` and `/projects/dev-project/plans` compare the local and Workspace Plan Board shells;
- `/dev/plan-review` and `/dev/workspace/plan-review` exercise standalone and Workspace-launched full-window Plan
  Review;
- `/dev/code-review` and `/dev/workspace/code-review` exercise standalone and Workspace-launched full-window Code
  Review;
- `/projects/dev-project/sessions/choose-terraform-folder-name` exercises the Session shell and timeline: user and Agent
  messages, collapsed Activity, individual tool states, thinking, Plan and Code Review prompts, every special workflow
  tool (including triage, completion, and QA), and system notices.

Plan Review fixture variants are linked from `/dev`; fixture pages do not render an additional variant switcher above
the review surface.

The `/dev` routes are fixture-only and return 404 in production. The standalone `/review/plan` and `/review/code` routes
remain the real token-protected TUI launch targets. Live Workspace Plan and Code Review decisions return to the same
Session interaction through owner Workspace endpoints.

Linked source-file dialogs keep code rows at their natural line height, even for short files in tall dialogs. The shared
review stylesheet gives the imported reader a content-sized grid track; its surrounding pane scrolls long files. Keep
this rule shared by standalone and Workspace reviews.

## Guided Review Explainer blocks

Guided Review Explainers use the same dark RunWield/Plannotator surface language as the code-review UI, but they read as
one scrollable document organized into conceptual chapters. Reuse Plannotator's `GuideView`, `GuideSectionCard`,
`GuideFileCard`, Markdown renderers, and viewport manager through its guide host provider. Each chapter has a numbered,
collapsible overview and file list beside its live diffs; narrow guide panes (including space reduced by sidebars) stack
the overview above the diffs. The **Reviewed** control marks and collapses a chapter. Chapter progress stays with the
open review when switching to Diff. Opening Guided Review collapses the file sidebar; reviewers can reopen it with
**Files**. Omit the generated guide title, since the review shell already supplies context. Show the problem-and-outcome
summary above the chapter count. Beside the count, show **generated by provider/model (thinking level)** using metadata
from the generating Session; omit unavailable fields rather than guessing. Keep review progress visible.

Put the core behavior first, its consequences next, and incidental changes last. Group related files across directories
and keep tests with their implementation. Prose blocks form each chapter overview; the optional `sectionNotes` slot
preserves RunWield callouts, diagrams, checkpoints, and widgets below it. Every changed file appears once, with an
**Everything else** chapter for files the guide did not place. File chips reveal their diff, including in a collapsed
chapter. Shared `.rw-guide-*` block styles live in `src/ui/design-system/components.css` and use RunWield tokens.

- **Prose** is the default block and should use normal readable line height.
- **Callouts** are bordered cards for definitions, edge cases, risks, or reviewer checkpoints. Do not use color alone to
  communicate severity.
- **Mermaid diagrams** live in bordered diagram cards with a title and optional description. Rendering failures should
  show a local error inside the card without breaking the document.
- **Diff blocks** embed Plannotator's annotatable diff viewer and inherit existing annotation behavior.
- **Widgets** are exceptional. Render generated HTML/CSS/JavaScript in sandboxed iframes with no external network access
  and only explicitly allowlisted local assets. Widgets should explain visual or interactive behavior that prose,
  Mermaid, and diffs cannot explain clearly.

Guided Review generation controls must disclose that generation can use an additional LLM call. When auto-generation
finishes, show a non-stealing **Guided Review ready** affordance instead of switching the reviewer away from plain Diff.

### User Verified status intent

Use the explicit label **User Verified** for `user_verified`. It is a closed/successful lifecycle outcome, but not
proof-bearing RunWield Verified. Badges, buttons, and metadata should reuse existing RunWield semantic tokens for
closed/success states and pair the label with explanatory text such as “verified by the user; Workflow Validation was
not claimed.” Do not add a separate theme or token for this status.

### Plan home, Dashboard rows, and workflow progress

Dashboard, Sessions, and Plan home share the persistent Workspace navigation sidebar for switching Plans and Sessions.
The shared artifact reader uses the Workspace title header and action slot, without a duplicate header or logo. Contents
starts collapsed; Contents and Workflow pane controls share one aligned row and the shared sidebar motion. On narrow
screens both panes start collapsed and open over the document. Keep Plan home usable when workflow evidence is
unavailable.

The owner Dashboard uses compact category rows for **Needs You**, **Ready to Continue**, **In Progress**, and **Recently
Finished**. Rows are links to the repair destination, Plan, or Session. Long names shrink and truncate inside the row;
the action label must remain reachable on phones.

Use the workflow progress pattern when Plan home or a Session Workflow sidebar must show an ordered RunWield workflow
such as Execution, Tests and CI, AI review, repair, Code Review, Publication, and Completion.

- Render stages as plain ordered rows without decorative connector ticks. Omit Current/Upcoming labels; retain
  meaningful completed, blocked, and paused states. Descriptions explain purpose, recorded progress, errors, or user
  actions rather than repeating the step state.
- Mark the current stage with `aria-current="step"` and an accent rail.
- Put blocker text and the next action near the diagram. The action must route to the existing review, prompt, Session,
  continuation, or recovery flow.
- Use `--rw-*` semantic tokens for borders, surfaces, success, warning, error, and accent states.
- Use links for navigation actions and buttons for existing continuation or recovery actions. Do not add a second
  workflow mutation path.
- Long failure text must wrap inside the card and must not create whole-page horizontal overflow.

## Grouped Plan review

Sequence review uses controlled `RunWieldTabs` above the existing review workbench: an overview followed by numbered
child tabs. Mounted inactive panels preserve per-Plan editing, comments, scroll and execution controls. The shared
approval actions state their complete scope (for example, “Sequence and 2 Plans”) on every tab. Only child tabs show
execution policy. Keep the tab strip horizontally scrollable and keyboard accessible; use the same semantic tokens and
header controls as single-Plan review. Surface Lab includes standalone and embedded `sequence` variants.

### Workflow transitions in Session history

Only tools that advance the workflow or record its decisions and completed steps belong in `WORKFLOW_TOOL_NAMES` and
render as expanded `.rw-workflow-block` entries. Inspection tools such as `review_diff` stay collapsed with routine
activity. Every special tool block has square corners, including completion and QA blocks. Its title and left rail use
RunWield mint (`--rw-brand`) to distinguish it from blue user messages; failures use red status text. All timeline rails
are 2px inset stripes. Draw the special block's frame separately so its stripe has square ends, without diagonal border
joins. Each workflow entry has one outer container; its Markdown body has no separate border, background, or padding.
Show its name, running/completed/failed state, full report or decision, and available artifact/review actions. Keep
routing intent, complexity, plan outcomes, completion summaries, review findings, and checklists visible. Accepted
workflow records close the block even when a tool stops its own turn before a provider tool result is persisted. Live
events and reloaded history show the same information once per call. Do not infer acceptance from tool arguments.

Message images open in the shared dialog styling with an explicit Close action and Escape support.

Activity groups retain their open/closed state as events arrive; group identity must not depend on the event count.
Opening or closing Activity also opens or closes its Thinking rows. New Thinking rows inherit the group's current state.
Tool rows keep their own disclosure state. Individual Thinking rows remain independently toggleable between group
toggles.

Session history and live activity form one chronological timeline. Reconcile workflow/tool copies by call identity
before grouping; accepted report times survive delayed tool results. Activity contains only consecutive completed tools
and Thinking, ending at every message, special block, or system notice. Never move activity across a user message.

Artifact links sit beside the corresponding evidence row (and the approved Plan beside the title), without a detached
button group or “in browser” suffix. TUI mouse links open the same registered artifact reader; Esc then Alt+] remains
the keyboard path. An explicitly skipped Code Review replaces its selection controls with the ordinary RunWield status
“Code Review skipped”. Dismissed offers remain pending and do not claim a decision.
