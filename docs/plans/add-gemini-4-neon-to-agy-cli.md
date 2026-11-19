---
planId: "c77d1133-5fe2-4e87-9b72-0813f050b50a"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "LOW"
affectedPaths:
    - "src/shared/models/agy-cli-catalog.ts"
    - "src/shared/session/backends/agy-cli/model-options.ts"
    - "src/cmd/models/index.test.ts"
    - "src/shared/session/agy-cli-execution.test.ts"
    - "src/model-presets/agy.json"
    - "src/shared/models/agy-cli-models.test.ts"
    - "docs/prd/runwield-core-prd.md"
    - "docs/user-documentation/providers.md"
    - "docs-site/src/content/docs/providers.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-19"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
sessionName: "Gemini Agi CLI Support"
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
validatedCommit: "5dce76bcd7377a03bf9d80b0156d9b350bc0d829"
workRecord:
    status: "generated"
    recordId: "617f16b3-0df9-48ec-8904-2c7f2221c4bc"
    path: "docs/work-records/2026-11-19-gemini-4-neon-support-for-antigravity-cli.md"
    lastAttemptAt: "2026-11-19T20:54:06.899Z"
---

# Add Gemini 4 Neon to the Antigravity CLI Backend

## Context

Antigravity CLI 1.5.12 adds Gemini 4 Neon. The local `agy models` output lists four concrete IDs:

| Concrete ID            | Effort |
| ---------------------- | ------ |
| `gemini-4-neon-low`    | low    |
| `gemini-4-neon-medium` | medium |
| `gemini-4-neon-high`   | high   |
| `gemini-4-neon-xhigh`  | xhigh  |

Neon access depends on the Google plan. The [Antigravity model docs](https://antigravity.google/docs/models?surface=cli) list Neon for Google AI Ultra, Google AI Pro (paid, or trial on eligible premium devices), and Gemini Enterprise. Free and Plus plans do not include it. The 1.5.12 changelog also enables it for `GEMINI_API_KEY` sign-in. The owner sees Neon with a regular Pro subscription. The catalog also lists `gemini-pro-orchestrator-neon`. That is an orchestrator entry, not a chat family. This Plan does not add it.

RunWield accepts five fixed `agy-cli` families today (Argon, Hydrogen, Carbon, Flash, Pro). The previous change, [update-agy-cli-model-names](update-agy-cli-model-names.md), set up this catalog and the shared effort mapping.

The owning capability is [Core Models and providers](../prd/runwield-core-prd.md#models-and-providers). This change extends **Flexible model configuration** and the Antigravity scenarios under **CLI Execution Backends**. It must preserve **Change models without losing Session or workflow context**, the [Image generation](../prd/runwield-core-prd.md#image-generation) mapping, and the exact-price rule in [Usage measurement and export](../prd/runwield-core-prd.md#usage-measurement-and-export).

## Objective

Users can select `agy-cli/gemini-4-neon`. RunWield sends the correct effort, including `xhigh`, verifies the returned concrete model, and replays Neon Session evidence. The bundled `agy` preset uses Neon for most Agents, Hydrogen for Operator, and Argon for planning and review. Other families keep their current behavior.

## Approach

Add Neon to the existing catalog. Move the "which families support xhigh" fact into the catalog, next to family membership.

Today `thinkingLevelToEffort` hard-codes `modelId === "gemini-4-hydrogen"`. Neon is a second xhigh family. A second `||` condition would put one catalog fact in two modules. Instead, the catalog exports the xhigh-capable set, and the mapping reads it:

```diff
 // agy-cli-catalog.ts
 export const AGY_CLI_MODEL_IDS = [
+    "gemini-4-neon",
     "gemini-4-argon",
     ...
 ] as const;
+export const AGY_CLI_XHIGH_MODEL_IDS: ReadonlySet<AgyCliModelId> = new Set(["gemini-4-neon", "gemini-4-hydrogen"]);

 // model-options.ts
 case "xhigh":
 case "max":
-    return modelId === "gemini-4-hydrogen" ? "xhigh" : "high";
+    return isXhighAgyModel(modelId) ? "xhigh" : "high";
```

The registry, supported-model error messages, transcript projection, and image generation already derive from these two owners. They need no separate edits.

Neon effort mapping (same as Hydrogen):

| RunWield thinking   | Neon effort |
| ------------------- | ----------- |
| off / minimal / low | low         |
| medium              | medium      |
| high                | high        |
| xhigh / max         | xhigh       |

> [!NOTE]
> **No price is invented**
>
> Neon has no exact built-in Google price. Calculated cost stays unavailable, the same as Argon and Carbon.

### Bundled preset

**Owner decision:** Change the bundled `agy` preset. Keep every Agent's current thinking level.

| Family   | Agents                                                   |
| -------- | -------------------------------------------------------- |
| Argon    | Planner, Ideator, Architect, Reviewer                    |
| Hydrogen | Operator                                                 |
| Neon     | Router, Slicer, Guide, Engineer, Frontend Engineer, Init |

Flash is no longer used by the bundled preset; it stays selectable.

> [!WARNING]
> **The bundled preset now needs Neon and Hydrogen access**
>
> Free and Plus plans do not include Neon. Users without access see a visible CLI error and can pick another model or a personal preset. RunWield does not fall back.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/models/agy-cli-catalog.ts` — add Neon ID and display name; own the xhigh-capable family set.
- `src/shared/session/backends/agy-cli/model-options.ts` — read the xhigh set from the catalog instead of the Hydrogen literal.
- `src/cmd/models/index.test.ts` and other tests with the literal supported-model error text — the error list now includes Neon.
- `src/shared/models/agy-cli-models.test.ts`, `src/shared/session/agy-cli-execution.test.ts`, `src/shared/session/agy-cli-model-selection.test.ts`, `src/shared/session/session-transcript-projection.test.ts`, `src/tools/create-image.test.ts`, `src/shared/models/model-price-catalog.test.ts` — Neon coverage beside the existing Hydrogen cases.
- `src/model-presets/agy.json` and `src/shared/model-presets.test.ts` — new preset assignments.
- `docs/prd/runwield-core-prd.md`, `docs/user-documentation/providers.md`, `docs/user-documentation/settings.md` if it describes the preset, and the mirrored `docs-site/src/content/docs/` copies — six families, Neon access note.

No new domain term. No glossary change. No change to the `agy-cli` provider, sign-in, or tool permissions.

## Reuse Opportunities

- `AGY_CLI_MODEL_IDS`, `AGY_CLI_DISPLAY_NAMES`, `AGY_CLI_MODEL_CHOICES` — every selection path and error message already derives from them.
- `thinkingLevelToEffort` and `concreteAgyModel` — shared by chat, image generation, and transcript validation.
- Existing fake `agy` executable fixtures and Hydrogen xhigh test cases — copy their pattern for Neon.

## Implementation Steps

1. `agy-cli-catalog.ts` lists exactly six families: `gemini-4-neon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-4-carbon`, `gemini-3.8-flash`, `gemini-3.1-pro`. `AGY_CLI_DISPLAY_NAMES["gemini-4-neon"]` is `"Antigravity CLI Gemini 4 Neon"`. `gemini-pro-orchestrator-neon` and effort-suffixed IDs such as `gemini-4-neon-high` stay unsupported.
2. `agy-cli-catalog.ts` exports the set of families that support xhigh, containing exactly Neon and Hydrogen. `thinkingLevelToEffort` in `model-options.ts` uses that set and contains no family-name literal for xhigh. Mapping results for Argon, Carbon, Flash, Pro, and Hydrogen do not change.
3. Selecting `agy-cli/gemini-4-neon` through `wld models`, Agent settings, and Session model change succeeds. The chat command sends `--model gemini-4-neon --effort <mapped>`. Image generation sends `gemini-4-neon-<effort>` plus `--effort`. A returned concrete model of another family or another effort fails selection verification.
4. Transcript projection accepts verified Neon facts for all four efforts, including xhigh, and rejects inconsistent Neon facts. No historical transcript changes.
5. `src/model-presets/agy.json` assigns `agy-cli/gemini-4-argon` to planner, ideator, architect, reviewer; `agy-cli/gemini-4-hydrogen` to operator; `agy-cli/gemini-4-neon` to router, slicer, guide, engineer, frontend-engineer, init. Every `thinkingLevel` is unchanged. The preset `description` names this split. `src/shared/model-presets.test.ts` asserts each Agent's resolved model and thinking level.
6. The Core PRD **Flexible model configuration** requirement lists six families, and **Curated model presets** describes the new `agy` preset split (replacing the current Argon/Flash text). Add an acceptance scenario: a user selects Neon at xhigh and the CLI request uses `gemini-4-neon` with `--effort xhigh`. State that Neon needs Google AI Ultra, paid Google AI Pro, Gemini Enterprise, or `GEMINI_API_KEY` sign-in, and is not on Free or Plus plans. `providers.md` and its docs-site copy list Neon.

## Approval Confirmation

No Work Record supersession. This Plan extends the catalog from `update-agy-cli-model-names`; it does not replace that record.

## Verification Plan

Run `bun run install:locked` first. Focused tests:

- `bun scripts/run-tests.ts src/shared/models/agy-cli-models.test.ts src/shared/models/model-price-catalog.test.ts src/cmd/models/index.test.ts`
- `bun scripts/run-tests.ts src/shared/session/agy-cli-model-selection.test.ts src/shared/session/agy-cli-execution.test.ts src/shared/session/backends/agy-cli/agy-cli-backend.test.ts src/shared/session/session-transcript-projection.test.ts`
- `bun scripts/run-tests.ts src/tools/create-image.test.ts src/shared/model-presets.test.ts`

Required checks:

- Through the real registry and command boundary, Neon produces literal `--model`/`--effort` pairs for off, minimal, low, medium, high, xhigh, max, omitted, and invalid thinking. Expected values are literals, not calls to the production mapping. The xhigh and max cases fail if Neon is added to the catalog without the xhigh set change.
- Hydrogen still maps xhigh/max to xhigh. Argon, Carbon, and Flash still cap at high. Pro still maps medium to high.
- A fake stream reporting `gemini-4-neon-xhigh` produces Session evidence with family Neon, the original thinking level, and effort xhigh. A stream reporting `gemini-4-hydrogen-xhigh` or `gemini-4-neon-high` for an xhigh request fails.
- `wld models agy-cli/gemini-4-neon-high` and `agy-cli/gemini-pro-orchestrator-neon` are rejected; the error lists all six families. No `agy` process starts.
- Neon has no calculated cost.
- Load the bundled `agy` preset through its normal loader. Each of the 11 Agents resolves to the family and thinking level in the preset table. User and project overrides still take precedence.
- Manual: with Antigravity CLI 1.5.12, run `agy models` and confirm the four Neon IDs. Select `agy-cli/gemini-4-neon` in RunWield, run a short turn at xhigh, resume, and confirm the displayed model and backend evidence. Record the CLI version and plan. If the account has no Neon access, record it as untested, not as a failure.
- The PRD scenario and provider guides list the six families and the access note.

## Edge Cases & Considerations

- Free and Plus plans do not include Neon. An access failure must stay visible. RunWield must not fall back to another family.
- Older CLI versions do not know Neon. The CLI error stays visible; RunWield does not check CLI versions.
- The orchestrator entry and the Claude/GPT-OSS families in `agy models` stay out of scope.
