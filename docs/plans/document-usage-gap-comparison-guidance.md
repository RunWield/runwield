---
planId: "b9e10a41-c3f6-4f10-bc35-10f5bcf69423"
classification: "PLANNED_CHANGE"
workKind: "DOCUMENTATION"
complexity: "LOW"
affectedPaths:
    - "docs/user-documentation/settings.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-24T00:00:00-04:00"
origin: "user"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
userVerifiedAt: null
deliveryBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
status: "reviewed"
validatedCommit: "9a6f6c160931ee76c7ad1b9302928fd1185e1534"
workRecord:
    status: "generated"
    recordId: "9741e9b0-dfce-4561-be51-f55ee1f7600a"
    path: "docs/work-records/2026-10-24-clarified-usage-gaps-versus-zero-activity.md"
    lastAttemptAt: "2026-10-24T20:19:07.689Z"
---

# Document Usage Gap Comparison Guidance

## Context

The Epic [Reliable Usage, Workspace Dashboard, and Langfuse Export](./reliable-usage-dashboard-and-langfuse-export.md) has added a ## Usage paragraph to `docs/user-documentation/settings.md` in prior deliveries. This paragraph explains how to compare Usage totals on paired devices.

The clarification "A gap is not zero activity" belongs in that paragraph to explain that when measurement is disabled or unavailable, the gap is recorded distinctly from a day with actual zero usage. This prevents confusion when users read the usage documentation.

## Objective

Add one sentence to the existing ## Usage paragraph in `docs/user-documentation/settings.md`: "A gap is not zero activity."

The sentence clarifies the distinction between a recorded gap (disabled period, unavailable measurement) and an actual zero usage day, supporting the Epic's requirement that gaps remain disclosed rather than papered over as zeros.

## Approach

Open `docs/user-documentation/settings.md`, locate the existing ## Usage paragraph, and add the sentence "A gap is not zero activity." to the paragraph. Keep all other content, structure, code examples, tests, and configuration unchanged.

## Expected Change Surface

- `docs/user-documentation/settings.md` — add the sentence to the existing ## Usage paragraph.

Outside normal workflow Plan and delivery artifacts, no other files change. Tests, CI configuration, and all other source remain unchanged.

## Implementation Steps

1. Open `docs/user-documentation/settings.md`.
2. Locate the existing `## Usage` heading and paragraph added in prior Epic deliveries.
3. Add the sentence "A gap is not zero activity." to that paragraph.
4. Verify the file reads clearly with the new sentence in context.

## Verification Plan

- `bun run install:locked` — install dependencies.
- `bun run ci` — run the full project verification suite, which includes documentation link checking and the existing project gates.
- If CI identifies a non-documentation defect, report it and do not change source code to work around it.
- After CI passes, complete normal review and confirmed publication to the approved target.

### Expected to remain unchanged

- All code, tests, dependencies, and configuration files.
- All other documentation content, structure, and formatting.
- The browser review process and normal worktree isolation.
- Validation, repair, and confirmed-publication workflow.
