---
planId: "9278ac3d-3788-40d1-8379-e857f4f77239"
classification: "PLANNED_CHANGE"
workKind: "MAINTENANCE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/models/model-registry.ts"
    - "src/shared/session/backends/agy-cli"
    - "src/shared/session/session-transcript-projection.ts"
    - "src/model-presets/agy.json"
    - "src/cmd/models"
    - "docs/prd/runwield-core-prd.md"
    - "docs/user-documentation/providers.md"
    - "docs/user-documentation/settings.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-11-17"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "1e0ba4c7624c0e9617c068869680bf777273a5be"
workRecord:
    status: "generated"
    recordId: "75fbe598-ec37-45af-8d43-51eba9a9fae3"
    path: "docs/work-records/2026-11-18-antigravity-cli-model-catalog-and-effort-mapping.md"
    lastAttemptAt: "2026-11-18T02:08:01.845Z"
status: "verified"
---

# Update Antigravity CLI Model Names

## Context

The user requests the new `agy-cli` model naming conventions. RunWield currently accepts only `gemini-3.8-flash` and `gemini-3.1-pro`. The installed Antigravity CLI 1.4.12 reports a different catalog through `agy models`:

| Family              | Available efforts        |
| ------------------- | ------------------------ |
| `gemini-4-argon`    | low, medium, high        |
| `gemini-4-hydrogen` | low, medium, high, xhigh |
| `gemini-3.8-flash`  | low, medium, high        |
| `claude-opus-5-5`   | low, medium, high        |
| `claude-sonnet-5-5` | low, medium, high        |
| `gpt-oss-120b`      | medium                   |

Each upstream model ID has an effort suffix. `gemini-3.1-pro` is absent from this account's catalog. This does not prove that all accounts have lost access.

The owner requests Argon, Hydrogen, and Carbon, including Carbon for users whose accounts have access. The release notes returned by `agy changelog` for version 1.5.8 name Gemini 4 Carbon with low, medium, and high effort. That is published CLI support evidence, not a successful local Carbon request; the installed CLI reports version 1.4.12.

The owning capability is [Core Models and providers](../prd/runwield-core-prd.md#models-and-providers). This change targets **Flexible model configuration**, **Curated model presets**, and the Antigravity scenarios under **CLI Execution Backends**. It preserves **Change models without losing Session or workflow context**.

[Image generation](../prd/runwield-core-prd.md#image-generation) shares the model-effort mapping. Preserve **Generate images with a user-selected model** without claiming that every newly listed chat model supports image generation. [Usage measurement and export](../prd/runwield-core-prd.md#usage-measurement-and-export) requires exact catalog evidence for calculated cost; renamed models must not inherit guessed prices.

## Objective

Users can select Argon, Hydrogen, and Carbon through `agy-cli`, alongside the existing Flash and Pro choices. The bundled preset uses Argon instead of Pro. Commands use supported effort names, and saved Session evidence stays truthful. Older CLI/account combinations can still use Pro where upstream supports it; no model is silently substituted.

## Approach

Keep the existing `agy-cli/<family>` selection format and the separate RunWield thinking control. Update the existing registry and backend model-options owner. Do not add live catalog discovery or version-dependent presets for this bounded update; either would add discovery and compatibility policy beyond the requested additions.

Use `thinkingLevelToEffort` as the shared mapping for command generation and transcript validation. Remove the duplicate effort switch in `expectedAgyBackendEffort` without weakening its invalid-input handling. Keep model membership in the registry's catalog definition and derive supported-model error choices from that catalog. Passive transcript validation must not initialize auth or model runtime state.

```text
model selection / bundled preset
  -> model registry: supported family
  -> model-options: map thinking to available effort
  -> chat command / image command
  -> verified backend evidence
  -> saved Session display
```

### Model scope

**Owner decision:** Add `agy-cli/gemini-4-argon`, `agy-cli/gemini-4-hydrogen`, and `agy-cli/gemini-4-carbon`. Keep Flash. Do not add the Claude or GPT-OSS families. Carbon must be selectable without access on the developer's account; model availability remains subject to the user's CLI version and account.

The supported set is exactly `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-4-carbon`, `gemini-3.8-flash`, and `gemini-3.1-pro`. Use the documented Carbon family/effort contract in automated executable fixtures. Do not change authentication methods or claim a live Carbon pass without an entitled account.

**Reviewable mapping assumption:** Apply the existing clamping convention to the new families. Hydrogen uses its advertised xhigh effort for RunWield xhigh/max. Keep the original RunWield thinking value in Session state.

| RunWield thinking   | Argon / Carbon / Flash | Hydrogen | Pro  |
| ------------------- | ---------------------- | -------- | ---- |
| off / minimal / low | low                    | low      | low  |
| medium              | medium                 | medium   | high |
| high                | high                   | high     | high |
| xhigh / max         | high                   | xhigh    | high |

An omitted thinking level retains the existing off-to-low default. Invalid thinking values remain errors during execution and invalid evidence during projection.

### Preset and saved selections

**Owner decision:** Replace Pro with Argon in the bundled `agy` preset. Keep Flash assignments and all configured Agent thinking levels. Argon medium now executes at medium, unlike Pro's medium-to-high mapping.

**Owner-confirmed compatibility policy:** Keep `agy-cli/gemini-3.1-pro` as an explicit selectable family with its existing effort mapping. Leave saved personal and project selections intact. Users whose CLI/account cannot run Argon can select Pro or use a personal preset. The updated bundled preset requires Argon access; do not add version-dependent presets, automatic fallback, or silent aliases. Keeping Pro selectable does not guarantee that the upstream service continues to offer it.

Historical transcript facts remain readable with their original model names; a saved execution fact is not an alias for a new model.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/models/model-registry.ts` — current selectable family IDs and display names; preserve exact-price lookup.
- `src/shared/session/backends/agy-cli/model-options.ts`, `command.ts`, and `execution-session.ts` — valid family-specific effort mapping, command types, and verified returned model identity.
- `src/shared/session/backends/agy-cli/image-generation.ts` — shared mapping must still produce a valid concrete supervising-model ID.
- `src/shared/session/session-transcript-projection.ts` — accept new verified evidence and preserve valid historical Pro facts.
- `src/cmd/models/index.ts`, `src/shared/session/model-readiness.ts`, `session.ts`, and `runtime/agent-settings.ts` — actionable supported-model errors through each selection path.
- `src/model-presets/agy.json` and `src/shared/model-presets.test.ts` — replace bundled Pro assignments with Argon and verify resolved Agent settings.
- Existing model, command, execution, projection, image, pricing, and preset tests — prove current selections and preserve historical coverage.
- Core PRD and user provider/settings guides — synchronize supported families, effort behavior, preset roles, and compatibility guidance.

No new domain term or Execution Backend is proposed. No glossary update or unrelated provider rename is needed. Historical research and captured older CLI streams retain their original IDs.

## Reuse Opportunities

- `thinkingLevelToEffort` and `concreteAgyModel` already serve chat and image generation; extend this owner rather than adding mappings to callers.
- `RunWieldModelRegistry` supplies selectable models and lookup to the existing controls; no browser component redesign is needed.
- Existing fake executable fixtures exercise real command construction and parsed backend evidence without external model calls.
- Existing transcript projection tests distinguish complete verified backend facts from incomplete or conflicting claims.

## Implementation Steps

1. `model-registry.ts` exposes exactly the five base families listed in Model scope with matching Antigravity CLI display names. Model completions, direct selection, Agent settings, and template resolution accept each family. Existing Pro settings still resolve to Pro. Unsupported IDs, including new effort-suffixed public selections and excluded vendor families, fail before backend side effects. The four existing supported-model error sites derive choices from this same catalog without copying the five-name list.
2. `model-options.ts::thinkingLevelToEffort` implements the table in Model scope and owns an exported effort type that includes `xhigh`. `concreteAgyModel`, `AgyCliRunRequest`, and execution evidence use this type. Chat still sends the base family plus `--effort`; image generation still sends `${family}-${effort}` plus `--effort`. Both use the same mapping. Existing Flash and Pro mappings remain unchanged.
3. `execution-session.ts::classifyTurnFailure` accepts only the requested base family or its expected concrete effort-specific ID. Wrong families and wrong concrete effort IDs still fail selection verification. New family names and Hydrogen xhigh survive command creation, stream parsing, and committed backend evidence without changing selected Session identity.
4. `session-transcript-projection.ts::readAgyExecutionBackendFact` recognizes complete verified facts for all five families, including Hydrogen xhigh. Its effort validation reuses the pure mapping rather than a second switch. Agy family membership comes from the same pure catalog definition used by the registry, without constructing a registry during replay. Preserve existing strict concrete-model checks: incomplete, base-only, or inconsistent backend facts remain excluded. Existing Pro facts retain their old mapping, including medium thinking to high effort. No transcript or historical usage row is rewritten.
5. The bundled preset uses `agy-cli/gemini-4-argon` for Router, Slicer, Architect, Planner, Ideator, and Reviewer, with existing thinking levels. Other Agents retain Flash. Personal and project presets remain unchanged. All supported-model errors and active documentation reflect the approved catalog.
6. Tests prove the new selection-to-command-to-evidence path, retained Pro settings, historical replay, and unchanged image/pricing safeguards. Update **Flexible model configuration** and **Curated model presets** in Core Models and providers with the five families, Argon preset assignments, account/version limits, and no-fallback behavior. Add acceptance scenarios for new model selection, Carbon catalog inclusion without local entitlement, Hydrogen xhigh, and retained Pro selection/history. Synchronize provider/settings guides and affected references in the same change. Preserve the existing Image generation and Usage measurement requirements; leave unrelated target scope labeled as target.

## Approval Confirmation

No Work Record supersession is proposed. The owner confirmed the three additions, Argon preset replacement, and explicit Pro compatibility without automatic fallback. The effort table is a labeled reviewable assumption based on upstream supported efforts and the existing mapping convention.

## Verification Plan

Use the Bun version in the checkout’s root `.bun-version` and run `bun run install:locked` before checks. Focused commands:

- `bun scripts/run-tests.ts src/shared/models/agy-cli-models.test.ts src/shared/models/model-price-catalog.test.ts src/cmd/models/index.test.ts`
- `bun scripts/run-tests.ts src/shared/session/agy-cli-model-selection.test.ts src/shared/session/agy-cli-execution.test.ts src/shared/session/backends/agy-cli/agy-cli-backend.test.ts src/shared/session/session-transcript-projection.test.ts`
- `bun scripts/run-tests.ts src/tools/create-image.test.ts src/shared/model-presets.test.ts src/shared/session/backends/cli-usage.test.ts src/cmd/resume/index.test.ts`

Use the existing isolated fixtures. Tests that change HOME or cwd use `withProcessGlobalTestLock`; source and tests remain TypeScript with specific types.

Required behavior checks:

- Each of the five families resolves through the real registry and command boundary. Assert exact `--model` and `--effort` arguments for every supported RunWield thinking level, plus omitted and invalid thinking. Use literal expected values independent of the production mapping. These tests must fail with the old two-family registry or a mapping that always returns high. Test all three Carbon concrete IDs and Hydrogen xhigh explicitly.
- A fake upstream stream reports the expected concrete model; Session evidence and replay show the selected family, original thinking level, and mapped effort. A different family or incorrect concrete effort fails.
- Existing historical Pro facts still project correctly. Invalid facts remain invalid. Keep historical fixtures unchanged where they prove an older stream contract.
- Load saved Pro settings and resume a Pro Session through the existing selection path. The next fake CLI request still targets Pro; its old transcript evidence is unchanged. A fixture that rejects Argon must produce a visible failure and no second request for Flash or Pro. An unsupported public model ID must not start an Agy process or overwrite the active model.
- Image-generation command assertions use the current naming contract and retain output-file validation. Model selection alone must not be treated as proof of image support.
- New names without an exact built-in Google price match retain unavailable calculated cost; descriptors with zero prices do not count as price evidence. Keep Flash's exact-price coverage and Pro's rejection of preview-name price aliases. Preserve existing token accounting and measured-zero distinctions.
- Inspect the bundled preset through its normal loader and confirm every Agent assignment resolves. Confirm user/project override precedence remains unchanged.
- Manual: compare accessible families with `agy models`. Select Argon and Hydrogen in RunWield, execute a short turn, resume, and confirm the displayed model and backend evidence; exercise Hydrogen at xhigh. Record the actual CLI version and result.
- Carbon: the registry and real subprocess-fixture tests must cover low, medium, and high without local entitlement. Check the CLI's published Carbon contract against the version used. Run a live turn only where access exists; record unavailable local access as untested, not a failure of catalog inclusion or a claimed live pass. Do not hide Carbon based on the developer's account.
- Verify that Core PRD scenarios and user guides describe the delivered catalog and compatibility behavior. No old research, saved Session, or Work Record should be rewritten to imply it used a new model.

## Edge Cases & Considerations

- `agy models` is account- and version-dependent evidence. This Plan records the observed catalog, not a promise that every account can access it.
- Hydrogen supports `xhigh`; Argon, Carbon, and Flash stop at high. The effort table caps higher RunWield levels at the highest supported effort. Unsupported account access must not silently switch to another family.
- Pro remains available in RunWield for old CLI/account combinations. This does not prove upstream access; an access failure must stay visible rather than select a different model.
- The old two-model-only inventory and Pro-based bundled preset expectations are intentionally replaced. Retain their coverage for CLI-owned auth, unsupported IDs, absent executable/sign-in, native tools, cancellation, model mismatch, replay, and preserved Session/workflow identity.
- Preserve the `agy-cli` provider and existing sign-in, tool permissions, replay ownership, and remote-backend restrictions.
- Reviewable assumption: retain the existing public base-family selection format and fixed bundled catalog. Dynamic discovery and unrelated CLI feature updates are outside this request.
