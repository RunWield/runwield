# ADR Format

ADRs live in `docs/adr/` and use sequential numbering: `001-slug.md`,
`002-slug.md`, etc.

Create the `docs/adr/` directory lazily — only when the first ADR is needed.

## Purpose

An ADR explains an architectural choice and why it fits. It guides future
decisions by recording:

- the problem and architectural context;
- the user's decisions and constraints that shape the available choices;
- the selected approach and why it fits this system;
- alternatives evaluated and why they were rejected;
- relevant options excluded before evaluation and the constraint or reason that
  excluded them;
- implications, costs, trade-offs, and limits introduced by the choice.

Do not invent alternatives, research, or user decisions. Distinguish an option
actually evaluated from one ruled out by an existing constraint. Include only
comparisons that help explain the decision.

Implementation gaps, bugs, task lists, rollout steps, and completion status
belong in Plans. An ADR is neither a code inventory nor a progress report.
Include technical detail when it explains the architecture, not to narrate
functions or list unfinished work.

## Template

```md
---
status: proposed|accepted
---

# {Short title of the decision; do not include an ADR number}

## Context and Constraints

{Problem, existing architecture, and relevant decisions or constraints set by
the user.}

## Decision and Rationale

{What was chosen, why it fits, and the important alternatives evaluated or
excluded.}

## Implications

{Benefits, costs, trade-offs, and consequences for the rest of the system.}
```

Scale the detail to the decision. A short paragraph can cover these points; the
headings are not a requirement to pad simple decisions.

## Status and Current Guidance

This policy applies to every RunWield user's project. Accepted ADRs in the
current tree describe current architectural decisions; proposed ADRs remain
clearly separate from accepted guidance.

Every ADR includes one machine-readable status:

- `proposed` — an unaccepted architectural proposal, clearly distinguished from
  current guidance;
- `accepted` — the current authoritative architectural decision.

Update an accepted ADR when the decision changes, or remove it when a
replacement takes its place. Update current references in the same change. Do
not keep obsolete ADRs as superseded or deprecated rules alongside the current
decision. Git history preserves previous reasoning. Status records whether a
decision was accepted, not whether its implementation is complete.

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and
   wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you
   picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not
surprising, nobody will wonder why. If there was no real alternative, there's
nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is
  event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate
  via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth
  provider, deployment target. Not every library — just the ones that would take
  a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer
  context; other contexts reference it by ID only." The explicit no-s are as
  valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL
  instead of an ORM because X." Anything where a reasonable reader would assume
  the opposite. These stop the next engineer from "fixing" something that was
  deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of
  compliance requirements." "Response times must be under 200ms because of the
  partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered
  GraphQL and picked REST for subtle reasons, record it — otherwise someone will
  suggest GraphQL again in six months.
