# Rich Interview Questions with A2UI

## Background

The **User-Interview Tool** (`user_interview`) lets an Agent ask the user structured questions. Today it supports three
question types: yes/no, free text, and one pick from a list. Google's [A2UI](https://a2ui.org) protocol lets an agent
describe a small user interface as declarative JSON. The client then draws it with its own native widgets. This proposal
lets Agents compose **one-shot question surfaces** in A2UI, so they can ask richer questions than the three types allow.

**Status: Proposed. Written 2026-11-24.** The requirements below are agreed target behavior, not claims of delivery. The
User-Interview Tool's lasting owners are Core's interaction requirements and the
[ACP protocol PRD](runwield-acp-protocol-prd.md#protocol-negotiation-and-interactions). This proposal adds to them. It
does not replace them.

## Problem Description

**Agents can only ask the questions the tool allows.** A question that needs several picks, a number on a scale, a
date, an image to choose from, or a few related fields must be forced into text, or split into several separate
questions.

**Nobody knows yet what Agents would ask with a richer tool.** The owner has not hit a limit because Agents are not told
they can do more. Agent use of a new capability is emergent and hard to predict. So the goal is to give Agents the
capability and watch what they do, not to design a fixed list of new question types.

**Surfaces differ in what they can draw.** One interview can reach four places:

```text
user_interview
  ├─ Workspace (browser)      can draw anything
  ├─ TUI (pi-tui)             can draw layout and inputs in terminal style
  ├─ ACP client with forms    flat form only: text, number, boolean, enum, date
  └─ ACP chat / Telegram      typed replies only
```

A Session can start in one surface and continue in another. The Agent cannot know which surface the user will answer
from.

Goals:

- Agents compose rich, one-shot question surfaces from a standard component set.
- Each surface draws the richest version it can. A stronger surface is never held back by a weaker one.
- Every question can be answered on every surface, and the answer has the same shape on all of them.
- Simple questions cost no more tokens than today.

Non-goals:

- **Live surfaces.** The surface does not change while the user works with it, and the Agent does not take part until
  the user submits. Deferred; see Delivery.
- **Custom components.** Agents use only a subset of the A2UI Basic Catalog. No RunWield-only components.
- **Plan Questions** (`wld-question` blocks in Plans) do not change.
- **Agent-side surface detection.** The Agent is not told which surface the user is on.

## Why Are We Building It?

- **Better questions, fewer turns.** A related set of choices can be one surface instead of a chain of interviews.
- **Learn from emergent use.** A standard component set with logging shows what Agents actually build, before more
  investment.
- **Standard alignment.** A2UI is Apache-2.0, at spec v1.0, actively maintained, and has official renderers. Strict
  Basic Catalog use keeps RunWield interoperable with other A2UI clients and renderers.

## Audience

Primary: RunWield users answering Agent questions in the Workspace and the TUI. Secondary: users on ACP clients and
Telegram, who must keep a working, if plainer, experience. Agents (Ideator, Planner, Architect, Guide, Operator) are the
authors of the surfaces.

## Product Fit, Prototypes, and Descriptions

### The rule: presentation may degrade, the answer may not

The Agent writes one surface-neutral question. Each surface draws it at its own level:

| Agent composes           | Workspace            | TUI                               | ACP form               | ACP chat / Telegram          |
| ------------------------ | -------------------- | --------------------------------- | ---------------------- | ---------------------------- |
| Option cards with images | Cards with images    | Bordered list, image placeholders | Enum with descriptions | Numbered list with links     |
| Slider 1–10              | Slider               | Slider or number prompt           | Number with min/max    | "Type a number from 1 to 10" |
| Date                     | Date picker          | Date field                        | Date field             | Typed date                   |
| Several related fields   | One card with fields | One bordered form                 | One flat form          | One prompt per field         |

The user submits once. The tool returns one answer object, the same on every surface.

### Composition

Agents compose from this subset of the A2UI v1.0 Basic Catalog:

- **Display and layout:** Text, Image, Row, Column, List, Card, Divider.
- **Input:** TextField, CheckBox, ChoicePicker (one or many), Slider, DateTimeInput, Button (submit).

Video, AudioPlayer, Icon, Tabs and Modal are left out. A one-shot question rarely needs them, and they degrade worst.

The three current types stay as **shorthand**. The tool expands them into a one-input surface, so a yes/no question still
costs about 50 tokens and uses the same rendering path.

### Terminal rendering reference

[`charmbracelet/a2tea`](https://github.com/charmbracelet/a2tea) (Go, Bubble Tea) renders the full Basic Catalog in a
terminal, and [`muncus/a2term`](https://github.com/muncus/a2term) builds a client on it. They show the TUI can draw rich
surfaces without looking awkward. Patterns to adopt (inspiration, not dependencies; the RunWield TUI is TypeScript on
pi-tui):

- monochrome chrome (borders, bold, faint, reverse-video focus), so the host theme wins;
- the renderer is an embedded component; the host owns focus and exit;
- Tab / Shift+Tab move between controls; Enter activates or submits;
- media draws as a one-line placeholder with its alt text;
- a large surface may get its own pane beside the chat, so it does not flood the transcript.

## Capability Requirements

### Rich question surfaces

**Scope and maturity:** Target.

**Requirement: Agents can compose a question surface.** An Agent can send a one-shot surface built from the allowed
Basic Catalog subset in a `user_interview` call. The user fills it and submits once. The tool returns every input's value
in one answer object.

**Requirement: Shorthand questions keep working.** Existing yes/no, text and multiple-choice questions work as today,
at about today's token cost.

**Requirement: Invalid surfaces get a clear correction.** When a surface uses a component outside the subset, has a
broken structure, or has no input to answer, the tool refuses it before it reaches the user. The tool tells the Agent
what to fix.

**Requirement: Low tool-definition cost.** The tool definition teaches composition with a compact guide and an example,
not the full catalog JSON Schema (about 7k tokens). The target is about 2k tokens or less.

**Acceptance scenarios:**

- Given an Agent needs a database choice, a pool size and a launch date, when it sends one surface with a ChoicePicker,
  a Slider and a DateTimeInput, then the user answers all three in one step and the Agent gets all three values in one
  result.
- Given an Agent sends a yes/no shorthand question, then the user sees the same question as today and the result keeps
  today's shape.
- Given an Agent sends a surface with a Video component, then the user sees nothing and the Agent gets an error that
  names the component and lists the allowed ones.
- Given the user cancels a surface, then the result is canceled, the same as a canceled interview today.

### Surface-adaptive rendering

**Scope and maturity:** Target.

**Requirement: Each surface draws the richest version it supports.** The Workspace and the TUI draw the composed layout
and inputs natively. An ACP client with form support gets a flat form of the inputs. An ACP client without forms, and
Telegram, get the inputs as typed prompts.

**Requirement: Same answer on every surface.** An answer from any surface has the same shape and passes the same
validation.

**Requirement: Display-only content degrades without loss of meaning.** Layout may flatten. An image becomes a link or
a placeholder with alt text. Text a choice depends on (labels, descriptions, the prompt) is never dropped.

**Requirement: A pending surface follows the Session.** When the user opens a Session with a pending surface on another
surface, that surface draws the same question at its own level.

**Acceptance scenarios:**

- Given a surface with option cards that have images, when it is answered in the Workspace, then the cards show images;
  when the same surface is answered in the TUI, then the user sees a bordered list with image placeholders and can pick
  with the keyboard.
- Given a surface with a Slider and a ChoicePicker, when it reaches a no-form ACP client, then the user gets one typed
  prompt per input, in order, and the Agent gets the same answer shape as in the Workspace.
- Given a surface pending in the TUI, when the user opens the Session in the Workspace, then the Workspace shows the
  same surface, and an answer there settles the wait.

### Images in questions

**Scope and maturity:** Target.

**Requirement: Images come only from safe sources.** Image sources are limited to `https` and `data` URLs, per A2UI's
scheme allowlist. When an Agent names a local file, the tool inlines it as a `data` URL.

**Acceptance scenarios:**

- Given an Agent offers two screenshots from the Project as choices, then the Workspace shows both images and the TUI
  shows each as a placeholder with its alt text.
- Given an image with a `file:` or `javascript:` URL that the tool cannot inline, then the tool refuses the surface with
  a clear error.

**Shared requirements:** [Protocol negotiation and interactions](runwield-acp-protocol-prd.md#protocol-negotiation-and-interactions)
owns ACP form and chat fallback rules; this proposal adds new input kinds to them.

## Success Metrics

The first release is an experiment. Success means learning what Agents compose, and confirming every surface can answer.

- **Composition use:** the share of interviews that use a composed surface instead of shorthand, and which components
  appear. Baseline: 0. No target; the point is to observe.
- **Answer completion by surface:** the share of surfaces answered rather than canceled, for each surface. A surface
  with clearly lower completion signals a poor fallback.
- **Correction rate:** how often Agents get a validation error, and whether the retry succeeds. A high rate means the
  compact guide is not enough.
- **Observation period:** a few weeks of the owner's own use. Then decide on live surfaces and hand-tuned fallbacks.

## Delivery

1. **First release:** composed surfaces with the catalog subset, Workspace and TUI native rendering, ACP form and chat
   fallbacks, shorthand compatibility, and usage logging.
2. **After observation:** fallbacks tuned by hand for the patterns Agents actually use.
3. **Deferred: live surfaces.** The surface stays open, and the Agent updates it as the user interacts (A2UI
   `updateComponents`, `callAgentFunction`). Trigger: Agents chaining interviews where each one depends on the last.

Planning handoff: `/agent planner`, or `/agent architect` if the Workspace, TUI and ACP work needs several coordinated
Plans.

## Attached Research and Other Evidence

- [A2UI v1.0 specification](https://a2ui.org/specification/v1.0-a2ui/): message model (`createSurface`,
  `updateComponents`, `updateDataModel`), flat component list with ID references, JSON Pointer data binding, actions
  that return bound values.
- [A2UI v1.0 Basic Catalog guide](https://a2ui.org/specification/v1.0-basic-catalog-implementation-guide/): component
  list and rendering guidance. The catalog JSON Schema (`catalogs/basic/v1/catalog.json`) is about 27.6 KB minified;
  measured on 2026-11-24.
- [A2UI renderers](https://a2ui.org/concepts/sdks/): official React (`@a2ui/react` 0.15, still 0.x), Lit, Angular,
  Flutter, SwiftUI, Compose.
- Open A2UI issues relevant to adoption: React basic catalog loads Lit (#4238), stylesheet always injected (#4279), zod
  CVEs (#4147, #4192), ReDoS in validation (#4236), breaking renames across v0.8, v0.9 and v1.0.
- [MCP elicitation, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation): the flat
  primitive form that ACP form fallbacks must map to.
- [a2tea](https://github.com/charmbracelet/a2tea) and [a2term](https://github.com/muncus/a2term): evidence that the
  full Basic Catalog renders well in a terminal.
- Owner input (this interview): emergent use cannot be predicted up front; stronger surfaces should not be held back;
  one-shot first; strict Basic Catalog; token cost must stay low.

## Risks and Mitigations

| Risk                                                           | Impact                          | Mitigation                                                                                  |
| -------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| A2UI spec churn (three breaking versions in about a year)      | Rework of the renderers         | Pin to v1.0; keep the subset small; own the validation                                      |
| `@a2ui/react` immaturity (0.x, Lit leak, stylesheet injection) | Workspace bugs or style clashes | The Plan decides between the official renderer and our own; the PRD does not require either |
| Agents compose over-complex surfaces                           | Poor fallbacks, user fatigue    | Compact guide favours small surfaces; observe through logging                               |
| Generic fallbacks read badly on ACP chat                       | Lower completion there          | Measure completion by surface; tune by hand after observation                               |
| Tool definition grows the context on every turn                | Higher cost for every Agent     | Compact guide, about 2k token target                                                        |
| Agents lose ranking (no Basic Catalog widget)                  | Ranking asked as typed text     | Accepted for strict interoperability; revisit if it proves common                           |

## Open Questions

- **Workspace renderer:** official `@a2ui/react` or a RunWield renderer? Resolved in planning, after checking the open
  issues. Affects delivery, not scope.
- **Large surfaces in the TUI:** inline in the transcript or in a separate pane? Resolved with a prototype during
  planning.

## Proposed Domain Language

**Question Surface** (proposed): a one-shot A2UI surface that an Agent composes in a User-Interview Tool call, built
only from the allowed Basic Catalog subset and answered in a single submit. _Avoid_: form, widget, A2UI page.
Relationship: a User-Interview Tool call holds shorthand questions or one Question Surface. Each surface draws a Question
Surface at its own capability; the answer shape does not depend on the surface.

**Shorthand Question** (proposed): a yes/no, text or multiple-choice User-Interview question, expanded by the tool into a
one-input Question Surface. Affects the existing **User-Interview Tool** definition.
