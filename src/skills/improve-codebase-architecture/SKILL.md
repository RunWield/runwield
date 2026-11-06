---
name: improve-codebase-architecture
description: Scan a codebase for deepening opportunities, present them as a visual HTML report, then grill through whichever one the user picks. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make the codebase more testable and AI-navigable.
license: MIT; complete terms in LICENSE
license_details:
    This complete `src/skills/improve-codebase-architecture/` Skill package is licensed under MIT; see `LICENSE`. It is
    adapted from Matt Pocock's skills repository at `https://github.com/mattpocock/skills/`. This nested license
    covers only this Skill package and does not change the root RunWield license or any other repository path.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep
ones. The aim is testability and AI-navigability.

This skill uses the shared [codebase-design](../codebase-design/SKILL.md) vocabulary: **module**, **interface**,
**implementation**, **depth**, **deep**, **shallow**, **seam**, **adapter**, **leverage**, and **locality**. Use those
terms exactly in every suggestion.

This skill is _informed_ by the project's domain model. The domain language gives names to good seams; ADRs record
decisions the skill should not re-litigate.

## Process

### 1. Explore

Read the project's `docs/domain-language.md` if it exists and any ADRs in the area you're touching first. Then read
[codebase-design](../codebase-design/SKILL.md) and its [DEEPENING.md](../codebase-design/DEEPENING.md) reference.

Then use `delegate_agent` with `mode: "read"` to walk the codebase in a bounded Delegated Agent Session. Don't follow
rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no
  **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move
it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as an HTML report

Write a self-contained HTML report to the OS temp directory; do not write it into the repo. Resolve the temp directory
from `$TMPDIR`, then `/tmp`, then `%TEMP%` on Windows, and write to:

```text
<tmpdir>/architecture-review-<timestamp>.html
```

Open it for the user when the environment allows it. If opening the file requires approval or is unavailable, report the
absolute path.

The report uses Tailwind via CDN for layout and Mermaid via CDN for graph-shaped diagrams. Use hand-built HTML/CSS/SVG
when a custom before/after visual better communicates the architecture. See [HTML-REPORT.md](HTML-REPORT.md) for the
scaffold, diagram patterns, and style rules.

For each candidate, render a card with:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality, leverage, and how tests would improve
- **Before / After diagram** — side-by-side, custom-drawn or Mermaid
- **Recommendation strength** — `Strong`, `Worth exploring`, or `Speculative`

End the report with a **Top recommendation** section: which candidate to tackle first and why.

**Use docs/domain-language.md vocabulary for the domain and [codebase-design](../codebase-design/SKILL.md) vocabulary
for the architecture.** If `docs/domain-language.md` defines "Order," talk about "the Order intake module" — not "the
FooBarHandler," and not "the Order service."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to
warrant revisiting the ADR. Mark it clearly (e.g. _"contradicts ADR-006 — but worth reopening because…"_). Don't list
every theoretical refactor an ADR forbids.

Do NOT propose interfaces yet. After the report is written, ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, drop into a grilling conversation. Walk the design tree with them — constraints,
dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Side effects happen inline as decisions crystallize:

- **Naming a deepened module after a domain concept not in `docs/domain-language.md`?** Ask the user whether that term
  should become canonical. If they confirm, update `docs/domain-language.md` using the canonical
  domain-language-format.md bundled in `agent-definitions/document-formats/`.
- **Sharpening a fuzzy domain term during the conversation?** Ask the user to confirm the canonical term, avoided
  aliases, and any stable domain relationship or durable flagged ambiguity before updating `docs/domain-language.md`.
- **Architecture vocabulary is not domain language.** Do not add terms such as **module**, **interface**, **seam**,
  **adapter**, **depth**, **leverage**, or **locality** to `docs/domain-language.md`.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR only when future architecture reviews would
  otherwise re-suggest the same candidate. Skip ephemeral reasons like "not worth it right now."
- **Want to explore alternative interfaces for the deepened module?** Use the design-it-twice process in
  [codebase-design/DESIGN-IT-TWICE.md](../codebase-design/DESIGN-IT-TWICE.md).
