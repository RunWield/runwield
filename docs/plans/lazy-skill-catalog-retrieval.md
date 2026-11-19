---
planId: "2bcd7c70-b93d-4b15-af50-79b552d1ca9c"
classification: "PLANNED_CHANGE"
complexity: "MEDIUM"
summary: "Keep skill names and mandatory triggers resident while retrieving relevant descriptions and bodies through a deterministic skill catalog."
affectedPaths:
    - "src/shared/session/session.ts"
    - "src/shared/session/SYSTEM_PROMPT_TEMPLATE.md"
    - "src/shared/session/session-context-report.js"
    - "src/tools/registry.js"
    - "src/agent-definitions/"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-08-08T01:08:52-04:00"
updatedAt: "2026-08-08T01:08:52-04:00"
status: "draft"
origin: "internal"
---

# Lazy Skill Catalog Retrieval

## Context

The full visible skill catalog is resident in every applicable Agent prompt. Engineer currently spends about 1.8K tokens
on 19 descriptions, while the same skill names alone are about 70 tokens. Keyword-only retrieval could miss a mandatory
skill, and a stale semantic index must not override current skill files.

## Direction

- Keep all visible skill names and critical mandatory triggers in resident context.
- Add exact lookup, listing, and hybrid search across names, trigger tags, and descriptions.
- Load the authoritative SKILL.md through the catalog and record what was loaded.
- Preserve local, home, bundled, and external precedence plus `disable-model-invocation`.
- Treat filesystem skill metadata as truth; use Mnemoteca-like selective retrieval, not normal project memories as the
  authority.
- Return safe fallback candidates or the full name list when search confidence is low.

## Questions for Planner

- Should search and load be one tool or separate operations?
- Which skill triggers must remain resident or gain mechanical enforcement?
- Should semantic ranking be local and optional after deterministic exact/tag/lexical matching?
- What telemetry and evaluation corpus prove that retrieval does not miss applicable skills?

## Later Planning Work

Define the catalog record and invalidation rules, mandatory-skill safeguards, explicit-user invocation behavior,
search/load UX, evaluation cases, and an acceptable false-negative threshold before removing resident descriptions.

[Mnemoteca]: https://github.com/gandazgul/mnemoteca
