---
planId: "a8a32d37-78fc-4bf1-afd3-51cc9c3c7e77"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/cmd/install/"
    - "src/cmd/remove/"
    - "src/shared/extensions/wld-extension-manifest.js"
    - "src/shared/extensions/metrics-exporter.ts"
    - "src/shared/package-resources.ts"
    - "docs/plans/protect-new-package-extension-consent.md"
    - "docs/user-documentation/settings.md"
    - "docs/user-documentation/themes.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
planDeviations:
    - id: "call_569527187c2a49eab6bad8981331b265|fc_0abfbc5803202b36016ac936d599788197ac8259ce84911485"
      supersededRequirement: "The active Plan Context links to [Protect New Package Extension Consent](../protect-new-package-extension-consent.md) while the retirement step requires deleting that file and leaving no document links to it."
      replacementRequirement: "Replace only the active Plan Context's link to Protect New Package Extension Consent with plain text, keep its findings intact, delete the absorbed Plan, and require no remaining document links to it."
      reason: "The owner approved this narrow active Plan edit so deletion can pass doc-links:check."
      approvedAt: "2026-10-09T19:18:26.831Z"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-09-21T19:28:55.042Z"
origin: "internal"
parentPlan: "reliable-usage-dashboard-and-langfuse-export"
order: 6
dependencies:
    - "05-workspace-usage-page"
userVerifiedAt: null
targetBranch: "epic/reliable-usage-dashboard-and-langfuse-export"
validatedCommit: "061801f43001903ead918ae905c0b5818a580a8e"
status: "verified"
---

# Package Executable Approval and Metrics-Exporter Kind

## Context

This child has one rule: **no installed package's executable code runs until the host owner approves it and that
approval is saved.**

There are two gaps today.

**1. Code extensions are enabled before consent.** `runInstallCommand` (`src/cmd/install/index.ts`) calls
`installAndPersist`, which saves an unrestricted registration. Only after that does it ask. A refusal disables the
extensions later, but an interruption or a prompt failure leaves the unrestricted entry for the next Session. The Plan
Protect New Package Extension Consent (`ready_for_work`) describes this fix. The owner chose to absorb it here. Its
findings were checked again against the current pinned Pi 1.0.0:

- `SettingsManager.save()` still queues each snapshot separately (`enqueueWrite`). Disabling right after registration
  still leaves an unrestricted write in the queue.
- `installAndPersist` is still `install` followed by `addSourceToSettings`.
- `SettingsManager.inMemory`, `setPackages`, `flush`, `drainErrors`, `listConfiguredPackages`, `getInstalledPath` and
  `resolveExtensionSources` still exist with the same shape.

**2. There is no metrics exporter kind.** `isWldCompatibleExtensionManifest`
(`src/shared/extensions/wld-extension-manifest.js`) accepts only `pi.wld.kind === "code-extension"`. All package code
loads through Pi's resource loader during Session startup. A metrics exporter is not a Pi Agent extension. Child 07 runs
it in a bounded worker, so it must never load through `DefaultResourceLoader` or `buildAgentSession`.

> [!WARNING]
> **Project settings can replace user packages**
>
> Pi 1.0.0 `dedupePackages` keeps the Project entry when the same package identity is in both user and Project settings
> ("project wins"). An exporter lookup that uses `packageManager.resolve()` would let a Project swap the approved code.

### Owning requirements

- [Agent and skill customization](../../prd/runwield-core-prd.md#agent-and-skill-customization) — **add** a requirement
  for the metrics-exporter kind and its approval scenarios (Epic decision).
- [Theme selection](../../prd/runwield-core-prd.md#theme-selection) — **preserve** "Preview safely and retain the
  confirmed theme", including not enabling accompanying executable extensions. **Add** the scenarios for interrupted,
  refused, and accepted first installs.
- [Work protection](../../prd/runwield-core-prd.md#work-protection) — **preserve** "Preserve user work and require
  deliberate destructive actions". Approving executable code is a deliberate trust-granting action.
- [Usage measurement and export](../../prd/runwield-core-prd.md#usage-measurement-and-export) — link to the approval
  requirement. Do not copy it. Export delivery stays target behavior and belongs to child 07.

### Decisions from planning

| Decision                       | Choice                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| What approval binds to         | Exporter ID, user-scope configured source, installed path, and package `version`. A change to any of them makes the exporter unapproved again. |
| Where the declaration lives    | A top-level `wld.metricsExporter` block in `package.json`, next to `pi` (if present), not inside it. Pi never reads it.                        |
| How to approve later or revoke | `wld install <source>` asks again whenever an installed exporter is unapproved. `wld remove <source>` deletes its approval. No new command.    |
| Existing package choices       | Kept (from the absorbed Plan). No forced re-consent and no inferred historical consent.                                                        |

## Objective

- A newly registered package is never saved with code extensions enabled before the user says yes. Every pre-consent
  write already carries `extensions: []`.
- A `wld.metricsExporter` declaration is its own kind. Approval is host-global, saved only in global settings, and bound
  to `{ id, source, installedPath, version }`.
- Core can list installed exporters with their approval state. Core can resolve the entry file of each approved
  exporter. Only user-scope packages count, and nothing is imported during that work.
- Session startup never loads an exporter entry.
- The absorbed Plan is retired, and its findings are kept in this Plan.

## Approach

### Install command order

```text
wld install <source>
  existing = matching user-scope registration (Pi source match / installed path)
  packageManager.install(source)                     # physical install, no registration
  if not existing
    entry = normalize via addSourceToSettings on SettingsManager.inMemory(copy of global packages)
    real settings.setPackages([...current, { ...entry, extensions: [] }])   # first and only pre-consent write
  flush(); drainErrors() must be empty               # else report failure, stop
  candidates = resolveExtensionSources([configuredSource]) + compatibility check (no loading)
  if new registration and candidates > 0
    ask code-extension consent
      yes -> set extensions filter to the compatible candidates, flush, drainErrors, then report enabled
      no / empty / EOF / throw -> keep extensions: []
  exporter = read wld.metricsExporter from installedPath (user scope)
  if exporter and not approved for its current identity
    ask exporter approval (separate question)
      yes -> write approval record, re-read it, then report approved
      no / empty / EOF / throw -> stay unapproved
```

> [!NOTE]
> **Flush before the approval write**
>
> `setCustomSetting` writes the file directly and then calls `reload()` on the Pi settings manager. The install command
> must finish `flush()` and the `drainErrors()` check for the package registration first. Otherwise the reload and the
> queued Pi write race.

### Declaration shape (public, used by child 08)

```json
{
    "name": "@runwield/langfuse-exporter",
    "version": "1.0.0",
    "wld": {
        "metricsExporter": { "contract": 1, "id": "langfuse", "entry": "./dist/exporter.js" }
    }
}
```

A declaration is valid only when all of these are true:

- `contract === 1`.
- `id` is a non-empty string.
- `entry` is a relative path. After `realPath`, it stays inside the package's real installed path.
- `entry` is not one of the package's Pi extension resources.

The last rule matters for a package that also declares `pi.wld.kind: "code-extension"`. Without it, a file could be both
a Session extension and an exporter.

### Approval record and lookup

The approval list is stored in **global** settings under the RunWield custom key `metricsExporterApprovals`. It is read
with `getCustomSetting(key, "global")` only. A Project settings file with the same key is ignored.

```ts
type MetricsExporterApproval = {
    id: string;
    source: string; // user-scope configured source
    installedPath: string; // real path
    version: string; // package.json version, "" when absent
    approvedAt: string; // ISO timestamp
};
```

The new module `src/shared/extensions/metrics-exporter.ts` owns the declaration format, the approval record, and the
lookup. Nothing else parses `wld.metricsExporter`.

```text
metrics-exporter.ts
  readMetricsExporterDeclaration(packageRoot)  -> declaration | null
  listInstalledMetricsExporters(options)       -> [{ id, source, installedPath, version, entryPath, approved }]
      uses listConfiguredPackages() filtered to scope === "user" with an installedPath
      never calls packageManager.resolve(), so Project precedence cannot apply
  resolveApprovedMetricsExporters(options)     -> approved entries only (identity re-checked against disk now)
  approveMetricsExporter(exporter)             -> write record, re-read, throw if not saved
  removeMetricsExporterApprovals(source)       -> delete records for that source
```

`listInstalledMetricsExporters` gives child 09 its three states: no entries means "not installed", `approved: false`
means "installed unapproved", and `approved: true` means "approved". Child 07 imports only `entryPath` from
`resolveApprovedMetricsExporters`, inside its worker.

Set aside: adding `"metrics-exporter"` as a second value of `pi.wld.kind`. It would put exporters on Pi's resource path
and tie export permission to Session construction, which the Epic forbids.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/cmd/install/index.ts` — consent-first registration, existing-registration preservation, non-loading candidate
  inspection, separate exporter approval prompt, and truthful output. `disablePackageExtensions` is no longer needed on
  the new-install path.
- `src/cmd/install/index.test.ts` — real local fixtures, saved state before consent, interruption, both prompts, and
  fresh loading.
- `src/cmd/remove/index.ts` and its test — delete approvals for the removed source.
- `src/shared/extensions/metrics-exporter.ts` (new, TypeScript per the JS-to-TS ratchet) and its test — declaration,
  approval record, user-scope lookup.
- `src/shared/extensions/wld-extension-manifest.js` — a small change for candidate inspection of disabled resources is
  acceptable. `isWldCompatibleExtensionManifest` and the runtime enabled-only gate do not get weaker or wider.
- `src/shared/package-resources.ts` — only if a shared helper for user-scope installed packages belongs there.
- `src/shared/session/session.js` and the existing resource-loader tests — these are the check that Session startup
  loads no exporter. They are not a redesign.
- `docs/user-documentation/settings.md` (Package Sources, settings table), `docs/user-documentation/themes.md` (the
  install note) — consent order, the exporter declaration, approval scope, and that Project settings cannot replace an
  approved exporter.
- `docs/prd/runwield-core-prd.md` — the requirement and scenarios listed in Context.
- `docs/domain-language.md` — add **Metrics exporter**.
- `docs/plans/protect-new-package-extension-consent.md` — removed. Its link in the Epic
  (`../reliable-usage-dashboard-and-langfuse-export.md`) points to this child instead.

Deliberately out of scope: exporter execution, workers, destinations, and delivery (child 07); the Langfuse package
(child 08); the Workspace status display (child 09).

## Reuse Opportunities

- Pi `DefaultPackageManager.install`, `addSourceToSettings` on `SettingsManager.inMemory(...)`,
  `listConfiguredPackages`, `getInstalledPath`, and `resolveExtensionSources` — install, normalize, match, and inspect
  without loading.
- `SettingsManager.setPackages`, `flush`, and `drainErrors` — `flush()` does not throw recorded write errors. Check
  `drainErrors()` before treating a save as successful.
- `resolveConfiguredSource` in `src/cmd/install/index.ts` — existing match by source or installed path.
- `getCustomSetting` / `setCustomSetting` with scope `"global"` (`src/shared/settings.js`) — locked direct writes. The
  remote-mode global path is already handled.
- `filterWldCompatibleExtensionResources` / `isWldCompatibleExtensionManifest` — the current code-extension contract. Do
  not pass disabled candidates through the enabled-only filter and then conclude that there are none.
- The fixture helpers in `src/cmd/install/index.test.ts` (`writeFixturePackage`, temporary HOME/cwd,
  `withProcessGlobalTestLock`).

## Implementation Steps

- `src/cmd/install/index.test.ts` has a fixture with a compatible code extension that writes a marker file when loaded,
  plus a passive theme and prompt. A test reads the real global settings file from disk at the consent prompt. It
  requires `extensions: []` on the new source, and it fails against today's command.
- For a new package, `runInstallCommand` never calls `installAndPersist` or a real-settings `addSourceToSettings`. The
  first real `setPackages` call for the source already contains `extensions: []`. Unrelated packages, other filters, and
  other settings are kept. A failed physical install creates no registration.
- After `flush()`, a non-empty `drainErrors()` makes the command report failure and exit non-zero. It never prints an
  enabled or approved success line.
- Candidate inspection finds compatible extensions while they are disabled, through `resolveExtensionSources` plus the
  manifest check. It does not import them. Refusal, empty input, `null`/EOF, and a thrown prompt leave `extensions: []`
  saved. A fresh loader started the same way as Session startup produces no marker, and themes and prompts are still
  available.
- Acceptance saves an `extensions` filter that enables exactly the compatible candidates. It flushes and checks errors
  before printing the enabled count. A fresh loader then produces the marker. An implementation that always disables
  fails this test.
- Reinstalling an already registered source (the same source, or an equivalent relative or absolute path) keeps its
  saved enabled, disabled, and filter choices. It adds no duplicate entry and does not ask for code-extension consent
  again.
- `src/shared/extensions/metrics-exporter.ts` exports `readMetricsExporterDeclaration`, `listInstalledMetricsExporters`,
  `resolveApprovedMetricsExporters`, `approveMetricsExporter`, and `removeMetricsExporterApprovals`, with named types
  for the declaration, the approval record, and an installed exporter. It rejects a declaration with a wrong `contract`,
  an empty `id`, an absolute `entry`, an `entry` that escapes the package after `realPath`, or an `entry` that is also a
  Pi extension resource of the package.
- `listInstalledMetricsExporters` reads only user-scope configured packages. A Project-scope package with the same
  identity and a different `entry` does not change the result. A Project settings file with `metricsExporterApprovals`
  does not approve anything.
- `resolveApprovedMetricsExporters` returns an exporter only when a saved record matches its current `id`, `source`,
  real `installedPath`, and `version`. A changed version on disk makes it unapproved without any write.
- `runInstallCommand` asks a separate exporter approval question when the installed package declares a valid exporter
  that is not approved for its current identity. This applies to new and existing registrations. Only `y`/`yes` writes
  the record. The command re-reads the record before it prints that the exporter is approved. All other outcomes,
  including interruption before the write, leave it unapproved. Code-extension consent and exporter approval never grant
  each other.
- `runRemoveCommand` deletes the approval records for the removed configured source after a successful
  `removeAndPersist`.
- No code under `src/shared/session/` or `wld-extension-manifest.js` imports or resolves `wld.metricsExporter` entries.
  A package that declares only an exporter, with its entry in an `extensions/` directory that Pi auto-discovers,
  contributes nothing to `resolveInstalledWldExtensionResources`.
- `docs/domain-language.md` defines **Metrics exporter**: an optional, destination-specific package entry point that
  receives approved Core observations, approved host-globally and bound to its installed identity. _Avoid_: model
  Provider, Pi Agent extension, RunWield Connect plugin. It also adds the relationship to host approval. It does not
  mention Langfuse as delivered.
- `docs/prd/runwield-core-prd.md` matches the delivered behavior: the metrics-exporter requirement and its scenarios
  under **Agent and skill customization**, the first-install scenarios under **Theme selection**, and a link from
  **Usage measurement and export**. Export delivery is still labeled target. Package update trust policy and historical
  consent stay labeled deferred.
- `docs/user-documentation/settings.md` and `themes.md` describe consent-first install, the `wld.metricsExporter`
  declaration, `metricsExporterApprovals`, re-approval after a version change, and removal on `wld remove`.
- `docs/plans/protect-new-package-extension-consent.md` no longer exists. No document links to it.
  `deno task doc-links:check` passes.

## Approval Confirmation

No Work Record supersession is proposed. The absorbed consent Plan never ran, so it has no Work Record.

## Verification Plan

Use real local packages, temporary HOME and settings, and fresh loaders or child processes. Fake only the human prompt
(`globalThis.prompt`) or a real subprocess boundary. Do not fake package registration, settings persistence, approval
storage, or extension policy.

Automated:

```sh
deno run -A scripts/run-tests.js src/cmd/install src/cmd/remove src/shared/extensions
deno task seams:check
deno task doc-links:check
```

Scenarios that must pass:

1. **Saved state before consent.** At the code-extension prompt, the global settings file on disk has `extensions: []`
   for the new source. This test fails on today's code.
2. **Interruption.** Spawn the real install command as a child process with a temporary HOME. Kill it when it reaches
   the consent prompt. A fresh settings manager and loader produce no marker, and the theme and prompt still resolve.
   Repeat with the kill at the exporter approval prompt: `listInstalledMetricsExporters` reports `approved: false`.
3. **Refusal outcomes.** `n`, empty input, `null`, and a thrown prompt each leave no marker and no approval record.
4. **Acceptance.** A fresh loader produces the marker only after the saved filter. The exporter record exists and
   `resolveApprovedMetricsExporters` returns it.
5. **Persistence failure.** A read-only settings directory makes the command report failure, with no enabled or approved
   success line. Restore the permissions in the test.
6. **Existing choices.** An enabled entry, a denied entry, a filtered entry, and an unrelated package survive a
   reinstall unchanged, with no duplicate. A relative and an absolute path to the same package count as one.
7. **Exporter isolation.** A package that declares only an exporter, with an entry that writes a marker when imported,
   produces no marker through `resolveInstalledWldExtensionResources` and the Session resource loader, even when the
   entry is in `extensions/`.
8. **Both kinds.** In a package that declares both kinds, saying yes to one prompt does not grant the other.
9. **Project precedence.** A Project-scope package with the same name and a different exporter `entry`, and a Project
   `metricsExporterApprovals`, do not change what `resolveApprovedMetricsExporters` returns.
10. **Identity change.** After an approval, changing the installed `version` makes the exporter unapproved. Re-running
    `wld install` asks again.
11. **Three empty states.** No exporter installed, an exporter installed but unapproved, and an invalid declaration each
    make `resolveApprovedMetricsExporters` return `[]`.
12. **Remove.** `wld remove` deletes the record, and a later reinstall asks again.

Behavior that must still work:

- Theme preview and selection.
- Prompt templates are available after any answer.
- The existing acceptance and refusal tests for compatible code extensions, rewritten against fresh saved state.
- Incompatible extensions stay unloaded.
- Package Skills stay ignored, as today.

Behavior that is expected to stop:

- `installAndPersist` before consent.
- A refusal that depends on `disablePackageExtensions` after an unrestricted write.
- The absorbed Plan as an active `ready_for_work` Plan.

Documents:

- The glossary defines **Metrics exporter** only as delivered here.
- The PRD scenarios above match the tests.
- Export delivery and Langfuse stay labeled target behavior.

Manual: use a disposable HOME and a local fixture. Install once and decline both prompts, then do a clean install and
accept both. Check the command output, the settings file, and the next Session. Never install an untrusted external
package to demonstrate this.

## Edge Cases & Considerations

- **npm lifecycle scripts are outside approval.** Approval controls what RunWield loads, not scripts that npm runs
  during installation. Approval is not a sandbox. Trusted exporter code can still do anything once child 07 runs it.
- **Legacy unrestricted entries stay as they are.** A saved unrestricted entry is existing configuration, not proof of
  consent. Do not relabel or migrate it. Package update trust policy and reconciling historical consent stay deferred.
- **Version-only binding.** Editing files in a local package without changing `version` keeps the approval. This is
  accepted for owner-controlled local packages. A content hash was set aside.
- **Failed candidate discovery leaves the new package disabled.** Never fall back to unrestricted loading to recover a
  count.
- **Source syntax.** `local:<path>` in the current help text may not match Pi's parser. Tests use supported real paths.
  Correct the help text only where an example would be wrong.
- **Remote mode.** In remote mode, the global approval write goes through the existing remote path in
  `setCustomSetting`. Exporter lookup reads the laptop-verified package inventory. Check this with the existing remote
  settings tests and do not design new remote behavior.
- **Atomic storage is not added.** This change guarantees that no unrestricted write happens before consent. It does not
  make settings files crash-atomic.
- **Assumption — key and file names.** The names `metricsExporterApprovals` and `metrics-exporter.ts`, and the
  `version: ""` fallback, are proposals. The Engineer can rename them, but there must still be exactly one owner of the
  format.
