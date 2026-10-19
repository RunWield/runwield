---
kind: "work_record"
recordId: "f7fcd48d-0add-4368-9338-04dcdbe1577f"
status: "approved"
scope: "feature"
origin: "internal"
completionMode: "verified"
createdAt: "2026-07-17T04:41:59.980Z"
provenance:
    sourcePlans:
        - "accb15c0-92a5-4328-b755-a0534d844f2a"
    evidence:
        - path: "scripts/compile.js"
          note: "Defines the pinned Deno build, bundled/minified default-VFS executable, and complete passive-resource include set."
        - path: "scripts/build-workspace-runtime.js"
          note: "Produces the compact server bundle and opaque browser assets used by the standalone Workspace runtime."
        - path: "runtime-root.js"
          note: "Gives source runs and bundled executables one stable root for resolving embedded resources."
        - path: "src/ui/workspace/server.js"
          note: "Loads the standalone Astro server and browser assets from the embedded Workspace runtime."
        - path: "src/shared/workflow/review-launcher.js"
          note: "Keeps Workspace-hosted review as the production path without embedding the legacy compiled Plannotator package."
        - path: ".github/workflows/release.yml"
          note: "Reuses the pinned compile path across release targets and publishes Zstandard and gzip archives."
        - path: "install.sh"
          note: "Prefers the smaller Zstandard release archive and falls back to gzip when required for compatibility."
---

# Standalone Deno binary compilation and packaging

## Summary

The Deno-era local and release builds share a pinned pipeline that produces a bundled, minified RunWield executable using Deno's default virtual filesystem instead of extracting its dependency tree at startup. Static-resource compatibility handling preserves access to bundled Agent definitions, skills, prompts, UI assets, Snip filters, themes, and Plannotator review assets. Stable resource roots and an opaque Workspace runtime preserve Astro SSR and browser assets without tracing the full frontend dependency graph or embedding the obsolete compiled Plannotator payload. Releases offer Zstandard archives with a gzip compatibility fallback.
