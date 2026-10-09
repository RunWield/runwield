---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/cmd/install/"
    - "src/shared/extensions/wld-extension-manifest.js"
    - "src/shared/package-resources.ts"
    - "docs/plans/protect-new-package-extension-consent.md"
    - "docs/settings.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
executionAgent: "engineer"
createdAt: "2026-09-21T19:28:55.042Z"
status: "draft"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 6
dependencies:
    - "05-workspace-usage-page"
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
planId: "a8a32d37-78fc-4bf1-afd3-51cc9c3c7e77"
---

# Package Executable Approval and Metrics-Exporter Kind

## Context

One theme owns this child: **no installed package's executable code runs until the host durably approved it.**

Today `runInstallCommand` (`src/cmd/install/index.ts`) calls `installAndPersist` before consent, so an unrestricted
package registration exists before the user is asked. Refusal later disables extensions, but interruption or prompt
failure can leave the unrestricted registration available to a subsequent Session. The sibling Plan
[Protect New Package Extension Consent](../protect-new-package-extension-consent.md) is `ready_for_work` with verified
findings and is absorbed here at the owner's direction.

Separately, `isWldCompatibleExtension` (`src/shared/extensions/wld-extension-manifest.js:35`) gates on
`wld.kind === "code-extension"`, and `resolveInstalledWldExtensionResources` (L137) loads through Pi's package manager.
A metrics exporter is not a Pi Agent extension and must not load through `DefaultResourceLoader` or `buildAgentSession`.

Owning PRD: [Agent and skill customization](../../prd/runwield-core-prd.md#agent-and-skill-customization) gains a
narrow, separately approved metrics-exporter kind. **Work protection** keeps its requirement that destructive or
trust-granting actions are deliberate.

## Objective

A newly registered package is never persisted as executable-enabled before affirmative consent that is durably saved. A
versioned `metrics-exporter` declaration exists as its own kind, approved host-globally and bound to the resolved
package identity, and is never loadable through Pi session construction. The sibling consent Plan is retired with its
findings preserved here.

## Approach

```text
new package
  install / normalize without an unrestricted registration in real settings
  first real registration: source plus extensions: [] plus exporter: not approved
  flush and check persistence errors
  inspect compatible candidates without loading them
  ask consent
    no / EOF / failure / interruption -> stays disabled and unapproved
    yes -> save the enabled/approved choice, flush, check errors, then report enabled
```

Pi 0.85.1 queues each settings snapshot separately, so registration and its restriction must land in the **same** first
settings update — disabling immediately after registration still leaves an unrestricted write in the queue.
`SettingsManager.inMemory(...)` and `DefaultPackageManager.addSourceToSettings(...)` prepare normalized entries without
touching real settings; `install(...)` performs physical installation without registration.

Approval is host-global and bound to the resolved package identity:

```text
approved(identity(pkg)) -> exporter may load
Project configuration cannot substitute different exporter code through package precedence
```

Set aside: extending `wld.kind === "code-extension"` to cover exporters. It would have reused the Pi loading path and
tied export permission to Agent-session construction, which the Epic forbids.

## Expected Change Surface

Boundaries with evidence, not an allowlist. Verify the real footprint during implementation.

- `src/cmd/install/` — consent-first registration and exporter approval ordering; interruption and prompt failure leave
  nothing enabled.
- `src/shared/extensions/wld-extension-manifest.js` — a versioned `metrics-exporter` declaration recognized separately
  from `code-extension`, with exporter identity and entry point.
- `src/shared/package-resources.ts` and the installed-resource lookup path — exporters resolve without
  `DefaultResourceLoader` or `buildAgentSession`.
- `docs/plans/protect-new-package-extension-consent.md` — retired per the project's document lifecycle policy after its
  behavior and Pi-interface findings are preserved in this Plan.
- `docs/settings.md` and `docs/themes.md` — approval semantics, host-global scope, and the fact that Project
  configuration cannot override approved exporter code.
- `docs/prd/runwield-core-prd.md` — metrics-exporter kind under **Agent and skill customization**.
- `docs/domain-language.md` — add **Metrics exporter**.

## Reuse Opportunities

- The sibling Plan's verified findings: Pi 0.85.1 snapshot queueing, `SettingsManager.inMemory`,
  `DefaultPackageManager.addSourceToSettings`, `install` versus `installAndPersist`, and copying only the intended
  normalized package update into the current real package list.
- The existing package manager, installed-resource lookup, and trust UI — reuse distribution without inheriting Pi-only
  loading.
- `filterWldCompatibleExtensionResources` — ordinary Pi extensions keep their current contract untouched.
- `src/cmd/install/index.test.ts` — existing installer coverage to extend.

## Implementation Steps

- A newly registered package is never persisted as extension-enabled or exporter-approved before affirmative consent;
  refusal, empty input, EOF, prompt failure, and interruption all leave its executable code unavailable to a fresh
  Session.
- Registration and its restriction land in the same first settings update, so no unrestricted intermediate write is
  queued.
- Themes and supported passive resources remain available regardless of the executable-consent answer.
- Explicit acceptance enables only the compatible extensions named in that choice, and only after the choice is saved
  and the flush is verified.
- Existing user package enabled/disabled choices are preserved; no fresh consent is demanded on reinstall and no
  historical consent is inferred from an unrestricted legacy entry.
- A versioned `metrics-exporter` declaration is recognized with exporter identity and entry point, distinct from
  `pi.wld.kind: code-extension`.
- Exporter approval is host-global and bound to the resolved package identity; Project configuration cannot replace
  approved exporter code through package precedence.
- Exporter loading is disabled until explicit approval is durably saved, including after an interrupted installation.
- Exporters are not loaded through `DefaultResourceLoader` or `buildAgentSession`.
- Ordinary Pi extensions retain their current contract and loading path unchanged.
- `docs/domain-language.md` defines **Metrics exporter** as an optional destination-specific plugin consuming approved
  Core observations, with avoided aliases (model Provider, Pi Agent extension, RunWield Connect plugin) and its
  relationship to host approval.
- `docs/prd/runwield-core-prd.md` names the metrics-exporter kind requirement and its approval scenarios.
- `docs/plans/protect-new-package-extension-consent.md` is archived or removed per the project's document lifecycle
  policy, with its consent behavior and verified Pi-interface findings already carried in this Plan.

## Verification Plan

- Automated: `deno run -A scripts/run-tests.js src/cmd/install` plus extension-manifest tests; then `deno task ci` and
  `deno task doc-links:check`.
- A real installation followed by simulated interruption at each point — before consent, during the prompt, after
  refusal, during the enable flush — leaves executable code unavailable to a fresh Session.
- Acceptance enables exactly the approved extensions and no others, and only after persistence is confirmed.
- A pre-existing enabled/disabled selection survives reinstall unchanged.
- A package declaring only `metrics-exporter` is not loaded through `buildAgentSession` and is not visible to ordinary
  Pi extension resolution.
- A package declaring both kinds has each handled by its own approval path.
- A Project-scoped configuration attempt cannot substitute different exporter code for a host-approved identity.
- With no exporter installed, no exporter approved, and an exporter installed but unapproved, nothing loads in any of
  the three states.
- Existing protected behavior: theme selection, passive resource availability, and current `code-extension` loading all
  still pass. Expected to stop existing: `installAndPersist` before consent, and the sibling Plan as an active
  `ready_for_work` Plan.
- `deno task seams:check` passes; the package manager boundary stays a genuine external seam and no conditional seam is
  introduced.
- Confirm the glossary describes implemented behavior and does not promote the Langfuse package, which child 08
  delivers.

## Edge Cases & Considerations

- Package update trust policy and historical consent reconciliation stay deferred, as the sibling Plan already scoped
  them; do not claim them solved here.
- Confirm the actual supported local package source syntax rather than trusting current CLI help alone; a clean install
  from a supported local source must prove the package boundary.
- Trusted exporter code is not a security sandbox. Narrow payloads, explicit executable approval, and later worker
  isolation prevent accidental exposure, not arbitrary malicious installed-code behavior.
- This child creates the kind and its approval. It does not implement delivery, scheduling, or any destination; child 07
  owns those.
- No npm workspace or external repository is introduced; `packages/langfuse-exporter/` arrives in child 08.
