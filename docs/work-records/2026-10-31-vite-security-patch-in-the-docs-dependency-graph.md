---
kind: "work_record"
recordId: "81f2f344-e11a-4fd6-9f3f-e64c676b1ac8"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-10-31T02:12:46.505Z"
tickets:
    - url: "https://github.com/RunWield/runwield/issues/436"
provenance:
    sourcePlans:
        - "70735c5a-511a-4dd9-a01c-a248a4f0d002"
---

# Vite security patch in the docs dependency graph

## Summary

RunWield's docs dependency graph resolves Vite 8.3.3, which includes the patch for GHSA-587h-7wmj-h5pm. This aligns the docs graph with the separately patched root Bun graph. Vite remains a transitive Astro dependency, without a direct docs dependency or permanent override.

## Out of Scope

This work does not include product code changes, release automation, the legacy Deno graph, unrelated security alerts, or Windows exploit reproduction.

## Future Planning Notes

The root and docs Bun graphs are independent; dependency remediation must account for both locks and installed resolutions. A successful root install or build does not establish the docs graph's dependency version.
