# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is an experienced developer making meaningful code changes with AI. Personal Workspace serves one owner
moving between a terminal and a browser, including a phone.

## Product Purpose

RunWield Workspace is the browser environment for reviewing planned work, following its execution and validation, and
returning to the same Session across screens. The Plan Board makes Plans, Epics, their state, and the next action
visible. The user can review intent before code changes, inspect evidence afterward, and keep decisions in durable
records.

Current Workspace includes personal Sessions, registered Projects, Plan Boards, and browser review surfaces. The
[Workspace PRD](docs/prd/runwield-workspace-prd.md) distinguishes the delivered first iteration from remaining continuity
and browser requirements; this product record does not claim every target is complete.

## Positioning

Workspace centers on Plans and their lifecycle, not generic AI chat, an agent dashboard, an issue tracker, or a browser
IDE. It connects human review of intent with local execution, validation, and durable records. The local Core workflow
remains free and independently useful.

## Operating Context

A developer works in a Project repository, starts or resumes a Session, reviews a Plan, chooses whether to approve or
execute it, follows validation and recovery, and returns to saved artifacts later. Workspace displays Plans, PRDs, ADRs,
and Work Records; repository markdown remains authoritative for those artifacts. Sessions can span TUI and browser
surfaces.

## Capabilities and Constraints

- The scope of this product record is the Workspace browser experience, including the Plan Board and browser review
  surfaces. It does not define TUI visual design or RunWield Connect.
- The existing local Workspace supports Plan and Epic boards, detail views, body editing, lifecycle actions, and Plan
  and code review.
- A Plan is the durable center of planned-work review, execution, validation, recovery, and associated Sessions.
  Approval does not automatically authorize execution.
- Personal Workspace serves one owner across screens. Shared Plan review uses separate capability links.
- Project roots are explicit trust boundaries. The browser must not silently broaden access to other local paths.
- Private Session history is for continuation; Plans, PRDs, ADRs, and Work Records carry durable project knowledge.

## Brand Commitments

Use the public names RunWield and RunWield Workspace. Use Plan, Session, Project, and Work Record with the meanings in
[docs/domain-language.md](docs/domain-language.md). Existing browser interfaces follow the
[RunWield Design System](docs/design-system.md); this product record does not set colors, type, or layouts.

## Evidence on Hand

- [RunWield Workspace PRD](docs/prd/runwield-workspace-prd.md) distinguishes current capabilities from planned personal
  work.
- [RunWield PRD](docs/prd/runwield.md) defines the product family and positioning.
- [Design system](docs/design-system.md) and `src/ui/workspace/` document the incumbent browser implementation.
- [Demo video](brand/runwield-demo.mp4) and [poster](brand/runwield-demo-poster.jpg) show a real workflow. Do not invent
  customer proof or claim that planned capabilities have shipped.

## Product Principles

- Show the current Plan, decision, and evidence before secondary metadata.
- Preserve continuity for one owner moving between screens.
- Keep review, approval, execution, and validation distinct and understandable.
- Keep repository artifacts authoritative and private working conversations private.
- Preserve a useful local workflow without requiring hosted services.
