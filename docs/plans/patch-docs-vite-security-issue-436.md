---
planId: "70735c5a-511a-4dd9-a01c-a248a4f0d002"
classification: "PLANNED_CHANGE"
workKind: "BUG_FIX"
complexity: "LOW"
affectedPaths:
    - "docs-site/bun.lock"
    - "bun.lock"
    - "package.json"
tickets:
    - url: "https://github.com/RunWield/runwield/issues/436"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-30"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
status: "implemented"
---

# Complete the Vite Security Patch for Issue 436

## Context

Issue [#436](https://github.com/RunWield/runwield/issues/436) requests patched Vite dependencies in both independent Bun graphs. The root graph is already patched by merged [PR #437](https://github.com/RunWield/runwield/pull/437). The docs graph still needs the fix.

Current evidence:

- `package.json` and `bun.lock` use Vite **8.3.3**.
- `docs-site/bun.lock` uses Vite **8.3.1**, through Astro's compatible `^8.0.13` dependency.
- The [upstream advisory](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm) lists Vite 8.3.3 as patched. The [release notes](https://github.com/vitejs/vite/releases/tag/v8.3.3) confirm bundled launch-editor 2.14.2.
- The two-lock version check below passes for root and fails for docs before this change. Windows exploitation in RunWield has not been reproduced.

**Requirements preserved:** [Public documentation](../prd/runwield.md#public-documentation), especially “Find usable instructions” and “Read documentation for the latest Stable release.” The manual must still build, exclude internal records, and retain its release identity. [Workspace project access and navigation](../prd/runwield-workspace-prd.md#project-access-and-navigation) retains packaged browser dependency support. No product requirement, acceptance scenario, domain term, or architectural decision changes; PRD and glossary edits are not needed for this dependency-only fix.

## Objective

Both independently installed Bun graphs use Vite 8.3.3. Publish a focused follow-up PR with `Closes #436` in its body. Preserve the root fix and the legacy Deno graph.

## Approach

Refresh only the docs graph's Vite resolution and dependencies required by that patch, using Bun 1.4.3 with lifecycle scripts disabled. Keep Vite transitive in the docs graph; Astro's existing range accepts the patched version.

Do not add a direct docs dependency or permanent override merely to update the lock. Do not use a broad dependency refresh. Reuse the already patched root graph rather than repeat PR #437.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `docs-site/bun.lock` — resolve Vite 8.3.3 and its required dependency changes with valid package integrity data.
- `docs-site/package.json` — inspect the compatible Astro dependency; no final manifest change is expected.
- `package.json`, `bun.lock` — verify and preserve the completed root fix; no final changes are expected.
- PR description — record the two-graph evidence, checks, upstream advisory, and issue-closing reference.

Source code, release automation, the legacy Deno graph, and unrelated security alerts are outside this fix.

## Reuse Opportunities

- `package.json` → `install:locked` installs root and docs from separate frozen locks with scripts disabled.
- `docs:check` stages public docs, runs Astro checks and the docs build, and checks the resulting public manual.
- `workspace:check`, `workspace:build`, and `workspace:test` protect the existing Workspace integration.
- `scripts/run-ci.ts` supplies the full project gate, including the Golden portfolio; no new verification framework is needed.

## Implementation Steps

1. `docs-site/bun.lock` resolves every Vite package entry to 8.3.3. Bun generates the lock data; package integrity is not invented or disabled. The final docs manifest retains its existing direct dependency set and versions. Any other changed lock entry is required by this Vite patch and explained in the PR.
2. The root manifest and lock retain Vite 8.3.3. Both graphs install with `bun run install:locked` on Bun 1.4.3 without further lock changes. No Deno manifest or lock is changed or regenerated.
3. The checks below pass against the final change. The PR reports actual results and any unresolved limits without claiming a Windows exploit reproduction.
4. A published PR contains `Closes #436`, links PR #437 as the completed root fix, and explains that this change completes the separate docs graph. Report the PR URL. Do not manually close the issue before merge or claim Dependabot alert closure from a version check alone.

## Verification Plan

**Decisive dependency check:** run this before and after the patch. It currently fails for docs. It rejects a root-only fix, a missing Vite entry, and any remaining older or nested Vite resolution.

```sh
python3 - <<'PY'
import pathlib, re
failed = False
for name in ('bun.lock', 'docs-site/bun.lock'):
    versions = re.findall(r'\["vite@([^"\s]+)"', pathlib.Path(name).read_text())
    ok = bool(versions) and all(v == '8.3.3' for v in versions)
    print(f'{name}: {versions} — {"PASS" if ok else "FAIL"}')
    failed |= not ok
raise SystemExit(1 if failed else 0)
PY
```

**Installation and compatibility:**

- Confirm `bun --version` is `1.4.3`; run `bun run install:locked` before checks. Compare lock contents before and after this command; neither may change.
- Run `bun -e 'for (const p of ["./node_modules/vite/package.json", "./docs-site/node_modules/vite/package.json"]) { const v = (await Bun.file(p).json()).version; console.log(p, v); if (v !== "8.3.3") process.exit(1); }'` to confirm the installed packages match both locks.
- Run `bun run docs:check`. It must pass Astro checking, the public docs build, and public-document checks. Preserve manual navigation, public-only content, and release identity; no deployment is part of this PR.
- Run `bun run workspace:check`, `bun run workspace:build`, and `bun run workspace:test`. Existing Workspace behavior remains covered; no tests or behaviors are retired.
- Inspect the final diff: only the intended docs dependency update and its required lock changes remain. No direct docs Vite dependency, unrelated upgrades, root downgrade, or Deno graph changes are present.
- Verify the published PR body has the closing reference. After merge, check issue #436 and related Dependabot alerts #9, #11, #12, #14, #15, and #16 if access permits. Report pending scans or unavailable access rather than assume closure. Alert #13 remains outside scope.

RunWield runs the full project verification command separately after implementation. A package-version check proves the dependency remediation, not exploit reproduction or a general security audit.

## Edge Cases & Considerations

- Vite bundles launch-editor; a missing standalone launch-editor lock entry does not mean the patch is absent. Use the upstream Vite release evidence.
- Bun may refresh unrelated packages during lock generation. Use a targeted update and review the dependency diff; do not accept broad churn.
- The docs graph is independent. A successful root install or build cannot prove that the docs graph is patched.
- GitHub closes the issue when a correctly linked PR merges into the appropriate default branch. PR publication alone is not issue closure.
