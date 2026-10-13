---
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX|FEATURE|REFACTOR|MAINTENANCE|DOCUMENTATION"
complexity: "LOW|MEDIUM|HIGH"
# High-signal paths you have evidence for. RunWield uses these for drift warnings and Plan presentation; they are not
# an exhaustive list and never limit what the executing Engineer may change.
affectedPaths:
    - "path/to/file1"
    - "path/to/file2"
# Optional: only when the user identifies external demand URLs as Tickets.
# tickets:
#     - url: "https://example.com/tickets/ABC-123"
# Optional: Work Record IDs this Plan will materially replace. Include only after user confirmation during approval.
# supersedes:
#     - "<work-record-id>"
devServerCommand: null
devServerUrl: null
devServerHmr: null
# Optional: source branch and intended onward destination when explicitly requested by the user.
# targetBranch: "feature/base-branch"
# RunWield records the actual landing as deliveryBranch during execution preparation; do not author it here.
# Standalone Plans default to a separate plan/<plan-name> landing unless auto-merge into target is enabled.
createdAt: "<ISO-8601 date or timestamp>"
status: "draft"
---

# <Plan Title>

## Context

What problem/request this plan addresses and the intended outcome.

When a PRD informs the work, link the owning capability headings and name the requirements being added, changed, or
removed, plus relevant behavior that must survive. Do not copy the whole PRD or imply proposed behavior already shipped.

## Objective

What will be built/changed and why.

## Approach

Recommended implementation approach (focused, practical, no long alternatives section).

Show it where showing reads faster than describing: the call path the change travels, a few lines of pseudo code for a
new interface or a tricky branch, a small `mermaid` diagram for a flow or a state change, or a diff when the shape
already exists and only part of it moves. Add one line for the main option you set aside and what it would have cost.
Skip all of it when a sentence is clearer.

Optionally mark a key point with a callout next to the text it supports: `[!WARNING]` for a risk, `[!NOTE]` for a
constraint, `[!TIP]` for the reason behind the approach. The marker stays alone on its line; a bold title becomes the
alert header, followed by a quoted blank line and a short explanation. Without a title, the reader shows the kind label.

> [!TIP]
> **Reuse the existing reader**
>
> One reader keeps navigation and printing the same everywhere Plans are read.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `path/to/file` — what changes here and why
- `path/to/another-file` — what changes here and why

When the implementation makes proposed domain language true, include the applicable domain-language file:
`docs/domain-language.md`, or the applicable glossary identified by `docs/domain-language-map.md` when glossaries are
separate.

## Reuse Opportunities

Existing functions, modules, or patterns to reuse:

- `path/to/existing/module.ts` — what to reuse
- `path/to/utility.ts` — what to reuse

## Implementation Steps

State each step as an outcome that is either true or false when the step is done, never as an action that is satisfied
by attempting it. An empty file, a placeholder module, an alias, or a pass-through wrapper must not be able to satisfy
any step.

These are the Engineer's instructions, so they stay exact prose naming real files, symbols, and behavior. Do not
compress a step into a tree, a diagram, or a diff, and do not leave a detail out because a sketch in Approach implied
it.

- `src/parser/tokens.ts` owns and exports `tokenize` and `TokenKind`; those declarations no longer exist in
  `src/parser/index.ts`, which imports them from `tokens.ts`.
- `src/parser/index.ts` is under 400 lines and contains no `@ts-nocheck`.
- `src/parser/tokens.test.ts` covers <named behavior> against the real tokenizer and fails if `tokenize` returns a
  pass-through result.

When applicable, include an explicit step that updates the applicable domain-language file in the same change as the
behavior it describes.

When behavior changes a PRD capability, include an outcome that its owning requirements, acceptance scenarios, and
affected references match the delivered behavior, with unmet intent still labeled target or deferred. Keep the update in
the same implementation change; follow the project's document lifecycle policy.

## Approval Confirmation

Before approval, show each proposed `supersedes` Work Record ID and explain why this Plan will materially replace that
record rather than only overlap it. Ask the user to confirm the list. Do not write a `supersedes` value until the user
confirms it. An existing declared value is already confirmed; preserve it unless the user changes it.

## Verification Plan

- Automated: exact command (s) to run. Only add focused tests or validation steps here, not the project's full CI;
  RunWield will run the full CI always after plan implementation.
- Manual: precise user flows / checks
- Expected results for key scenarios
- For browser UI work: the exact headed-browser checks a Frontend Engineer must perform, and the dev-server command and
  URL if known.
- When existing tests cover code this Plan reshapes: which behavior must still be protected afterwards, and which
  behavior is expected to stop existing. Without that split, a test that no longer compiles gets deleted and the suite
  still passes.
- When applicable: confirm the glossary describes implemented behavior and does not promote unimplemented proposals.
- When a PRD applies: turn relevant capability scenarios into concrete checks, preserve unaffected behavior, and verify
  the owning PRD and references are synchronized without falsely claiming unmet targets were delivered.

## Edge Cases & Considerations

- One per line, Risk plus mitigation
- Compatibility or migration concerns
- Open assumptions (if any)
