---
planId: "a2c5b256-aeb6-42a5-b372-ea1d97ce5145"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "MEDIUM"
affectedPaths:
    - "src/cmd/install/index.ts"
    - "src/cmd/install/index.test.ts"
    - "src/shared/extensions/wld-extension-manifest.js"
    - "src/shared/package-resources.ts"
    - "docs/themes.md"
    - "docs/settings.md"
    - "docs/prd/runwield-core-prd.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-12T18:33:00-04:00"
status: "ready_for_work"
origin: "internal"
userVerifiedAt: null
---

# Protect New Package Extension Consent

## Context

The [Core gap audit](../reports/core-prd-gap-audit.md#3-package-extension-consent) found that `wld install` persists an
unrestricted package before asking whether its compatible executable extensions may load. Refusal later disables them,
but interruption or prompt failure can leave the unrestricted registration available to a subsequent Session.

Source inspection confirms `runInstallCommand` calls `installAndPersist` before consent. Pi 0.85.1 queues each settings
snapshot separately, so disabling immediately after registration would still leave an unrestricted write in the queue.
No runtime interruption test was run during planning.

Owning requirements: Core [Theme selection](../prd/runwield-core-prd.md#theme-selection), **Preview safely and retain
the confirmed theme**, including not activating accompanying executable extensions; and
[Work protection](../prd/runwield-core-prd.md#work-protection), **Preserve user work and require deliberate destructive
actions**. This Plan implements safe first registration; it does not remove existing user control.

**User decision:** Protect new registrations and preserve existing package enabled/disabled choices. Do not require
fresh consent on reinstall, infer historical consent from an unrestricted legacy entry, or migrate existing selections.
Package update trust policy and historical consent reconciliation are deferred, not claimed solved.

## Objective

A newly registered package is never persisted as extension-enabled before affirmative consent. Refusal, empty input,
EOF, prompt failure, and interruption leave its extensions unavailable to a fresh Session. Themes and supported passive
resources remain available. Explicit acceptance enables compatible extensions only after that choice is saved.

## Approach

Use the current Pi PackageManager and SettingsManager interfaces. Keep registration and its extension restriction in the
same first settings update; do not build a new consent store or patch the dependency.

```text
new package
  install / normalize without unrestricted registration in real settings
  first real registration: source plus extensions: []
  flush and check persistence errors
  inspect compatible extension candidates without loading them
  ask for consent
    no / EOF / failure / interruption -> keep disabled
    yes -> save enabled choice, flush, check errors, then report enabled
```

Pi's public `SettingsManager.inMemory(...)` and `DefaultPackageManager.addSourceToSettings(...)` can prepare normalized
entries without writing real settings. `install(...)` performs physical installation without registration; alternatively
`installAndPersist(...)` can operate against the in-memory manager. Copy only the intended normalized package update
into the current real package list, with `extensions: []` already present. Preserve other package resource filters and
unrelated settings. Do not copy Pi's source parser or write an unfiltered intermediate registration.

Identify an existing registration using Pi's source matching and installed-path conventions, including equivalent local
paths and version updates. Existing registrations retain saved enabled/disabled and resource-filter choices; this change
adds no mandatory consent cycle for them. A saved unrestricted entry is existing configuration, not proof of how its
consent was obtained. New registrations start restricted regardless of source form.

`flush()` completes queued writes but does not throw recorded write errors; inspect `drainErrors()` before treating
persistence as successful. Failures must not print an enabled-success claim. Do not assert crash-atomic settings
storage: current RunWield storage uses direct file writes. This fix guarantees no pre-consent unrestricted registration
is queued, not a new crash-recovery guarantee for all settings.

Normal extension filtering excludes disabled resources. Candidate inspection after restricted registration must
therefore use non-loading discovery, such as Pi's `resolveExtensionSources`, followed by existing compatibility checks.
Keep the runtime enabled-resource gate intact. Refused resources must not be loaded merely to count them or inspect
compatibility.

The smaller-looking alternative—disable after `installAndPersist`—was rejected because it retains the interruption
window. A consent ledger and legacy migration were also set aside by the user as unnecessary scope for this correction.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/install/index.ts` — first-registration ordering, existing-registration preservation, candidate inspection,
  saved consent, and truthful command output.
- `src/cmd/install/index.test.ts` — real local package fixtures, pre-consent disk state, interruption, and fresh
  loading.
- `src/shared/extensions/wld-extension-manifest.js` and `src/shared/package-resources.ts` — reuse compatibility and
  enabled resource rules; a small candidate-inspection adjustment is acceptable, but runtime restrictions must not
  weaken.
- `src/shared/session/session.js` and existing resource-loader tests — verification boundary for actual subsequent
  extension loading, not a proposed Session startup redesign.
- `docs/themes.md`, `docs/settings.md` — accurate passive-resource and compatible-extension behavior. The theme
  reference currently says prompts/extensions are ignored, which conflicts with the implementation and settings
  reference.
- `docs/prd/runwield-core-prd.md` — first-install interruption/refusal/acceptance scenarios; explicitly preserve the
  limited scope of legacy entries and existing package choices.

## Reuse Opportunities

- Pinned Pi 0.85.1 `PackageSource` supports `{ source, extensions: [] }`; disabled resources remain discoverable with
  `enabled: false`. Inspect the current pinned contract again if the dependency changes before execution.
- `DefaultPackageManager.install`, `addSourceToSettings`, `listConfiguredPackages`, `getInstalledPath`, and
  `resolveExtensionSources` — existing installation, normalization, matching, and non-loading discovery.
- `SettingsManager.inMemory`, `setPackages`, `flush`, and `drainErrors` — prepare and persist a complete restricted
  entry.
- `filterWldCompatibleExtensionResources` and `resolveInstalledWldExtensionResources` — current compatibility and
  startup loading policy. Do not pass disabled candidates through an enabled-only filter and conclude none exist.
- Existing install tests use temporary HOME/cwd and real packages. Keep `withProcessGlobalTestLock` around
  process-global changes, or use isolated child processes. No fake owned settings or registration seam is needed.

## Implementation Steps

- [ ] A regression fixture exposes a compatible extension with an observable load effect and a passive theme/prompt. The
      pre-consent check fails against today's command because its saved registration allows extensions.
- [ ] For a new package, every real settings snapshot queued before affirmative consent restricts its extensions. First
      registration preserves source normalization, passive resource behavior, and unrelated settings. Physical
      installation failure does not create a newly enabled registration.
- [ ] Candidate inspection can identify compatible extensions while the package is disabled and cannot execute them.
      Refusal, empty/EOF input, prompt exceptions, and interruption leave the saved restriction intact.
- [ ] Affirmative consent is persisted and checked before reporting enabled extensions. A fresh Session loader executes
      the compatible extension only after that saved choice. Persistence failure reports failure, not enabled success.
- [ ] Existing enabled/disabled registrations retain their selection and other filters across reinstall and equivalent
      source references. No forced re-consent, legacy migration, or broad enabling of previously denied resources is
      added.
- [ ] Tests prove real restarted loading and passive resource availability. Theme/settings references and Core
      capability scenarios match this delivered behavior; broader historical-consent and package lifecycle-script policy
      remains explicitly outside this fix.

## Approval Confirmation

No Work Record supersession is proposed. The user selected new-registration protection with existing selections
preserved. This is a draft for later approval. Execution owner: Engineer; autonomous execution is appropriate.

## Verification Plan

Use real local packages, temporary settings, and fresh processes/loaders. Mock only the human prompt or genuine external
process boundary when needed. Do not replace package registration, settings persistence, or extension policy with fakes.

1. At the consent prompt, read the actual saved settings from disk and confirm the new source has `extensions: []`.
   Inspect the production registration call path as well: no real `addSourceToSettings` or `setPackages` call queues an
   unrestricted intermediate entry before consent. This catches disable-after-registration fixes that can pass the
   prompt snapshot. Restart-before-consent testing proves the saved restriction affects actual loading.
2. Spawn the actual install command in a child with a temporary HOME and a compatible local extension that writes a
   marker on load. Wait until the child reaches consent, terminate it, then start a fresh settings manager and actual
   resource loader using the same gates as Session startup. The theme/prompt is available; the marker is absent.
3. Repeat refusal, null/EOF, empty answer, and thrown prompt cases. Acceptance must produce the marker with a fresh
   loader. An implementation that always disables packages must fail the acceptance case.
4. Exercise missing local package/install failure and a real settings persistence error. There is no newly enabled entry
   or false enabled-success message. Restore permissions and verify saved state without editing real user configuration.
5. Cover existing enabled entries, denied entries, filtered entries, unrelated packages, and relative/absolute
   references to the same package. Preserve existing choices; no duplicate registration or required new consent cycle.
6. Incompatible extensions remain unloaded; supported passive resources retain their current behavior. Package skills
   remain subject to existing RunWield policy, not silently enabled by this change.

```sh
deno run -A scripts/run-tests.js src/cmd/install/index.test.ts
deno task seams:check
deno task ci
```

Include any existing extension-resource tests affected by discovery changes in the focused run. Existing acceptance and
refusal tests must survive but use fresh saved state where needed; the unrestricted-before-consent behavior must stop.

Manual check: use a disposable HOME and local fixture, decline once and accept once in separate clean installations.
Confirm command output and next-Session behavior. Never install an untrusted external package to demonstrate this bug.

## Edge Cases & Considerations

- Consent governs RunWield loading extensions, not npm lifecycle scripts executed by the package manager. This Plan does
  not claim to sandbox package installation or prevent all executable package content.
- Preserve user resource filters. A plain legacy entry can have several origins; do not relabel it as verified consent.
- Failed candidate discovery leaves a new package disabled. Do not fall back to unrestricted loading to recover counts.
- Current `local:<path>` help text may not match Pi parsing. Tests should use supported real paths; repairing all source
  syntax documentation or package-manager support is outside this bounded change unless needed for an accurate example.
- Do not widen this into atomic settings-file storage or recovery of historical interrupted installs. Those remain
  separate work, with no claim this Plan fixes them.
