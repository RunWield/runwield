---
kind: "work_record"
recordId: "90b5fbc5-2c27-4d77-887d-2c13ccce30da"
status: "approved"
scope: "planned_change"
workKind: "BUG_FIX"
origin: "internal"
completionMode: "verified"
createdAt: "2026-11-19T15:27:44.426Z"
provenance:
    sourcePlans:
        - "170e8ab9-2e69-4558-989a-a8a5ed498194"
---
# Bun range compatibility and reproducible release pins

## Summary

RunWield's local commands, test suite, docs-site tooling, and Reviewer benchmark accept the supported Bun range, `^1.4.0`, without requiring the exact CI version. CI, release builds, and remote release qualification use Bun 1.4.4 as their exact pin for repeatable artifacts. The Reviewer benchmark records the running Bun version and refuses to resume a run with a different version, preserving runtime identity within each run. Release qualification still rejects binaries whose Bun identity differs from `.bun-version`, so local flexibility does not weaken release identity checks.

## Future Planning Notes

- Keep the supported local range in `package.json` and the exact CI/release pin in `.bun-version`. Keep explicit release and remote qualification pins aligned. PRDs describe runtime support behavior without version literals.
- Preserve benchmark runtime capture and resume checks. Hash-locked fixture runtime versions are fixture identity, not requirements for the running Bun; do not change them merely to follow a release pin.
- Release-test fixtures must use the running Bun version while retaining rejection of mismatched or missing runtime identity.
- Supervisor tests must allow supported Bun diagnostic and exit-status differences while keeping terminal restoration and RunWield open-file recovery guidance assertions strict.
