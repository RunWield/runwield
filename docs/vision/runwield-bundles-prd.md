# Product Requirements Document: RunWield Bundles

Last updated: 2026-07-16 16:16 EDT

Working draft. This PRD describes a future packaging and distribution capability inspired by Spec Kit's extensions,
presets, and bundles, adapted for RunWield's layered customization model, protected workflow tools, skills, Agents, and
Workspace direction.

## Objective

Add **RunWield Bundles**: installable, versioned packages that provision a coherent set of RunWield customization for a
role, team, domain, or workflow style.

A bundle should make it easy to say:

> Set this project up for enterprise compliance planning.

or:

> Set this project up for frontend-heavy product work.

without requiring the user to manually copy agent definitions, skills, prompt templates, settings, review rubrics, and
document templates one by one.

## Problem Statement

RunWield already supports layered customization:

```text
local `.hns/` > home `~/.hns/` > bundled defaults
```

Agent definitions, prompt templates, skills, and protected workflow tools are customizable but guarded. This gives users
control, but packaging remains manual. As RunWield grows, users will want repeatable setups for different teams and
workflows:

- a product manager bundle with stronger Ideator/Planner behavior
- a security-sensitive bundle with threat-modeling and review rubrics
- a frontend bundle with browser testing and design-system emphasis
- a regulated-enterprise bundle with stricter PRDs, ADRs, traceability, and approval gates
- a library-maintainer bundle with API compatibility and release discipline

Without bundles, these setups become undocumented local drift or fragile copy/paste instructions.

## Target Users

- Individual users who want a curated RunWield setup for a project type.
- Teams standardizing how RunWield plans and reviews work.
- Skill authors and workflow authors who want to distribute reusable capability packs.
- Future Workspace users who want team-level defaults without losing local-first portability.

## Product Principles

- **Package customization, not core invariants.** Bundles must not bypass protected workflow tools or Plan Lifecycle
  safety.
- **Layer cleanly.** Bundles should fit the existing local/home/bundled precedence model instead of inventing a parallel
  override system.
- **Be inspectable.** Users should be able to see exactly what a bundle installs or changes.
- **Be removable.** Removing a bundle should not destroy unrelated local customization.
- **Support personal surfaces.** Bundle metadata should work across the CLI, TUI, and personal Workspace.

## Proposed Experience

A user can discover, inspect, install, update, and remove bundles.

Example conceptual flow:

```text
wld bundles search frontend
wld bundles info frontend-product
wld bundles install frontend-product
wld bundles list
wld bundles remove frontend-product
```

The exact command names are not committed by this PRD. The product requirement is the lifecycle:

1. **Search/discover** available bundles from trusted or configured catalogs.
2. **Inspect** bundle contents, version, compatibility, permissions, and installed files.
3. **Install** into project-local customization paths by default.
4. **Update** safely with preview and conflict reporting.
5. **Remove** only files owned by the bundle, preserving user edits and other bundles.

## Bundle Contents

Potential bundle components:

- Agent definition additions or prompt overlays
- skill recommendations or installed skills
- prompt templates and slash-command templates
- PRD, Plan, ADR, Work Record, or review templates
- domain-specific verification guidance
- Reviewer guidance or domain-specific review checklists
- Workspace view presets or board filters
- settings defaults that are safe to apply locally
- documentation explaining the bundle's intended workflow

Bundles should declare:

- id, name, version, author, license, repository
- compatible RunWield version range
- components installed
- target layer: project-local by default, optionally home-level with explicit user choice
- risk level: read-only prompt/template customization vs tool/action capability
- protected-tool interaction, if any
- uninstall ownership metadata

## Functional Requirements

- RunWield should define a manifest format for bundles.
- RunWield should be able to install bundle-owned files into project-local customization paths.
- RunWield should track installed bundle ownership so update/remove operations are safe.
- RunWield should preview bundle contents before installation.
- RunWield should detect conflicts with existing local overrides and ask before overwriting.
- Bundles should not be able to grant tools outside the effective protected-tool policy.
- Bundles should support offline/local installation before any hosted catalog exists.
- Bundle discovery should eventually support catalogs, but v1 can start with local paths or git URLs.

## Technical Approach

This is a packaging layer over existing customization surfaces.

Likely components:

- bundle manifest schema
- project-local bundle registry under `.wld/` or another RunWield-owned local state path
- installer that writes to existing customization locations instead of changing core defaults
- ownership metadata for update/remove
- compatibility checks against RunWield version and available skills/tools
- inspect/dry-run output for transparency
- optional catalog support later for hosted or community distribution

The system should deliberately reuse RunWield's existing layered customization model instead of adding another runtime
resolution path.

## Out of Scope

- Allowing bundles to bypass protected workflow tools.
- Building a marketplace as part of v1.
- Supporting arbitrary executable installer scripts without a separate security model.
- Replacing project-specific `docs/domain-language.md`, PRDs, ADRs, or Plans with generic bundle content.
- Guaranteeing compatibility across every external Agent or editor integration.

## Success Criteria

- Users can install a coherent RunWield setup with one operation and inspect what changed.
- Teams can standardize planning/review behavior without forking RunWield.
- Bundle removal is safe and does not delete unrelated customization.
- Bundles increase customization reuse without weakening Plan Lifecycle or protected-tool guarantees.

## Open Questions

- Should bundles install into `.hns/`, `.wld/`, or a future renamed customization directory?
- Should RunWield distinguish bundles, presets, and extensions as separate product concepts, or use one broader package
  model with component types?
- How should bundle trust be represented before there is a signed catalog?
- Should home-level bundles be allowed, or should v1 remain project-local only?
