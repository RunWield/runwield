---
planId: "40069cce-7878-4a89-983a-bd488bb232ff"
classification: "PLANNED_CHANGE"
workKind: "DOCUMENTATION"
complexity: "LOW"
affectedPaths:
    - "docs/user-documentation/workspace.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-24T03:32:31.683Z"
origin: "internal"
title: "Add cross-device Usage comparison guidance to Workspace docs"
status: "ready_for_work"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
---

## Objective

Add a short, focused paragraph to the Workspace user documentation that guides readers to use consistent settings—same Project, date range, and host time zone—when comparing Usage metrics across desktop and phone devices.

## Context

Workspace users access Sessions from both desktop and phone. When viewing Usage metrics (token counts or costs), they may see different totals on each device if they forget to apply the same filters. This causes confusion about which data is correct.

The guidance prevents this by explaining upfront what must match across devices: same Project, same date range, and same host time zone. It also mentions comparing gap notices and known totals to see the full picture.

The existing `docs/user-documentation/workspace.md` covers starting Workspace, pairing browsers, and moving between screens. This fits naturally after that section.

## Approach

Add a new `### Compare Usage across devices` section immediately after the "Try moving between screens" section in workspace.md. Include one short, imperative paragraph (approximately 60–80 words) in STE style, covering the four key points:

- Select the same Project on both devices.
- Select the same date range on both devices.
- Verify the host time zone matches on both devices (the computer running Workspace controls this).
- Compare gap notices as well as known totals to see the full picture.

The paragraph will use active voice, short sentences, and the existing terminology from workspace.md.

## Expected Change Surface

- **`docs/user-documentation/workspace.md`** — adds a new level-3 heading and one paragraph explaining Usage comparison across devices, positioned after the "Try moving between screens" section.

## Restrictions

This change must not alter:

- Application code in `src/`, tests, or dependencies
- CI, worktree setup, settings, or verification commands
- Existing user Sessions or workspace state

## Implementation Steps

1. `docs/user-documentation/workspace.md` contains a new heading `### Compare Usage across devices` immediately after the "Try moving between screens" section.
2. Below the heading, one paragraph explains the requirement in STE style: active voice, imperative mood, short sentences.
3. The paragraph names all four items: same Project, same date range, host time zone verification, and comparison of gap notices and known totals.
4. No other changes to the file.

## Verification Plan

1. **Presence**: `docs/user-documentation/workspace.md` contains the new section with its heading and paragraph.
2. **Placement**: The section appears immediately after "Try moving between screens" and before "Stop and start again".
3. **Content**: The paragraph covers all four comparison items and matches the STE style and tone of the rest of the document.
4. **Document integrity**: The file parses cleanly as Markdown and produces no lint errors.
