---
planId: "9b5aa734-1af1-40b6-bfe6-468978c989d9"
classification: "PLANNED_CHANGE"
workKind: "DOCUMENTATION"
complexity: "LOW"
affectedPaths:
    - "docs/user-documentation/settings.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-24T05:05:17+00:00"
origin: "internal"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
userVerifiedAt: null
deliveryBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
status: "reviewed"
---

# Document Usage report comparison guidance for paired devices

## Context

Users who access the Usage report in RunWield settings on multiple paired devices (desktop, laptop, phone via Workspace) may see different totals or measurements. Usage report calculations depend on which Project is open, the selected date range, the host machine's time zone setting, and the completeness of reported usage coverage.

This plan adds guidance to the settings reference documentation so users understand which parameters to align when comparing the same Usage report across devices.

## Objective

Add a new section to `docs/user-documentation/settings.md` that guides users to select the same Project, date range, and host time zone when comparing Usage measurements across different paired devices. Include a link to the existing Workspace pairing setup guide.

## Approach

Insert a new `## Usage` section into settings.md between the Example section and the Agent Model Overrides section. The section contains one paragraph explaining that to compare Usage reports across devices, readers must:

- Open the same Project
- Select the same date range
- Confirm the displayed host time zone matches, then use Apply range on each device
- Check coverage notices for consistency

A single relative link directs readers to the Workspace browser-pairing guide for multi-device setup details.

## Expected Change Surface

- `docs/user-documentation/settings.md` — add one new `## Usage` section (placed between the Example code fence closing and the Agent Model Overrides heading). No existing content is modified or removed.

## Reuse Opportunities

- Existing relative Markdown link patterns from other user documentation files to reference workspace.md

## Implementation Steps

- `docs/user-documentation/settings.md` contains a new `## Usage` section positioned after line 109 (after the Example section code fence closes) and before the `## Agent Model Overrides` heading.
- The section includes:
    - Heading `## Usage`
    - One paragraph advising users to open the same Project and select the same date range before comparing Usage report totals across devices; confirm the displayed host time zone and coverage notices match, then use Apply range on each device.
    - A Markdown link with text "Pair your browser" and relative href workspace.md#pair-your-browser pointing to the Workspace browser-pairing setup guide.
    - No other text, sections, examples, or settings content is modified.
- Application code, tests, CI configuration, dependencies, verification command, worktree setup command, global settings, and all other files remain unchanged.

## Approval Confirmation

No external tickets identified. No Work Records superseded. Plan scope is documentation guidance addition only.

## Verification Plan

**Manual checkpoint before CI validation:**

Pair reviews the rendered section in settings.md:

- Verify the paragraph mentions the same Project filter, same date range, displayed host time zone, coverage notices, and Apply range on each device.
- Verify the section heading is `## Usage`.
- Click the relative link (text "Pair your browser" with href workspace.md#pair-your-browser) and confirm it navigates to the "Pair your browser" section in workspace.md.
- Confirm no other content in settings.md has been modified or removed.
- Verify the section is placed between the Example section and the Agent Model Overrides heading.

**Expected result:**

Settings.md clearly guides multidevice users to align parameters (Project, date range, time zone, coverage) when comparing Usage reports across paired devices, with a direct link to Workspace pairing setup.

**CI validation:**

Run `bun run ci` to confirm:

- No TypeScript compilation errors.
- No linting failures.
- No broken documentation links (the workspace.md#pair-your-browser anchor must resolve).
- All existing tests remain passing.

If CI exposes a non-documentation source defect, stop and report it; do not modify source code or weaken CI validation.

## Edge Cases & Considerations

- The relative link from settings.md to workspace.md#pair-your-browser must resolve correctly. Both files are in docs/user-documentation/, so the relative path is workspace.md#pair-your-browser. The Markdown anchor will be auto-generated from the heading "### Pair your browser" as #pair-your-browser.
- This is documentation guidance only; no application behavior, settings structure, CLI behavior, or data model changes.
- bun run ci, CI policy, verification_command, and worktree_setup_command (bun run install:locked) remain unchanged.
- Existing user Sessions, Settings files, and Project data remain unaffected.
- Normal review approval, isolated worktree execution, validation, repair cycles, and confirmed publication are required.
