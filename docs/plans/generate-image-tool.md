---
classification: "PROJECT"
complexity: "HIGH"
affectedPaths:
    - "src/tools/create-image.ts"
    - "src/shared/image-generation.ts"
    - "src/shared/image-generation/"
    - "src/shared/foreground-process.ts"
    - "src/shared/image-generation-settings.ts"
    - "src/shared/session/session.js"
    - "src/shared/session/backends/agy-cli/"
    - "src/shared/settings.js"
    - "src/cmd/settings/index.ts"
    - "scripts/compile.js"
    - "docs/settings.md"
createdAt: "2026-09-06"
status: "draft"
origin: "internal"
planId: "3fff46f4-f3d0-4247-8709-e03d80dfbdca"
---

# Create Image Tool

## Current scope

Updated 2026-10-03 after the user's explicit request to add OpenCode, Agy and Codex adapters. `create_image` now routes
through Pi 1.0's unified model runtime, Agy CLI, the official Codex App Server, or an experimental OpenCode Responses
adapter. Direct Google SDK integration remains deferred. No undocumented Codex endpoint is used.

The implementation is present with automated tests. Live Pi generation remains blocked by missing OpenRouter
credentials; it is not a prerequisite for the other routes. Historical Agy and Codex generation/editing passed on
September 6. Fresh checks require ordinary writable host storage unavailable in this sandbox. OpenCode's live Responses
probe returned HTTP 403 model-access denial, so its hosted image support remains unverified. The Plan remains open
rather than treating fixtures as live acceptance. See
[provider evidence](../research/image-generation-provider-proof.md) and the lasting
[Core image-generation requirements](../prd/runwield-core-prd.md#image-generation).

## Implementation decisions

- One `imageGeneration` setting follows global/project/active-preset scopes. It contains `model`, optional supported
  `thinkingLevel` and `temperature`, and optional `enabled`. Changing the model drops inherited model-specific options.
- The Pi route resolves through existing `ModelRuntime.getModelOfType("image", ...)` and `generateImages`. Pi 1.0 uses
  the same model collection for image and chat types. No new registry or credential store is introduced.
- `agy-cli/<model>` takes the same base model and effort mapping as RunWield's Agy conversation backend. Native image
  selection remains host-managed; there is no separate `agentModel` field or invented `agy-cli/default` image model.
- `codex-cli/<model>` and `openai-codex/<model>` use official local App Server RPC, the CLI's ChatGPT login, model
  catalog and supported efforts. The helper starts an ephemeral read-only thread, rejects additional approval/tool
  requests and requires a matching completed native image item with a fresh file in its owned temporary or host image
  storage. Cancellation attempts a bounded turn interrupt before terminating the owned process. No subscription token is
  read.
- `opencode/<model>` uses Pi's existing model registry and provider auth with the documented Responses endpoint and
  hosted `image_generation` tool. This is experimental pending live access and tool support, not a claim that a
  vision-capable chat model necessarily produces images. Error responses are preserved; no alternate provider is used.
- `create_image` accepts `prompt`, required `outputPath`, and optional `imageRefs`. The calling Agent cannot change the
  provider or billing route. The project file itself is the retained output and reusable image reference.
- The shared generation operation hides routing, references, validation, conversion and atomic no-overwrite save behind
  one tool factory. Photon converts actual raster bytes to PNG/JPEG/WebP when required by the filename.
- Pi reasoning/temperature controls use its payload hook only for the documented Gemini mappings in
  [settings](../user-documentation/settings.md#imagegeneration). Other models work without those optional controls.
  Unknown mappings fail clearly instead of sending speculative parameters.
- Agy uses direct argv, the existing owned foreground process, cached host authentication and a five-minute timeout.
  Native `generate_image` step success and a structured absolute path are both required. The path must resolve inside
  the helper's temporary directory or its reported Agy Session output directory. Host originals are not removed.
- The Agy helper does not install global agents, alter MCP configuration, or bypass permissions. Its prompt requests
  only native generation and forbids recursive MCP calls; prompting is not a sandbox or enforced tool allowlist.
- Configured file-writing Agents and Agents declaring `create_image` receive the tool. Read-only Agents do not gain it
  automatically. The existing MCP bridge exposes the same tool to Claude/Agy conversation backends, under a name that
  does not collide with Agy's native `generate_image`.
- Image-capable callers receive a bounded preview; text-only Pi callers receive metadata. No Markdown artifact lifecycle
  or new UI event type is introduced. Bounded remote Sessions remain unsupported.

## Completed implementation checks

- [x] Discover Codex on PATH first, then in the known macOS ChatGPT app bundle under user/system Applications. Keep
      discovery read-only and fail clearly when unavailable; do not install software or retry generation with another
      executable. Verified app discovery and `--version` with a restricted terminal-style PATH on 2026-10-05, plus
      fixture coverage of PATH precedence, invalid candidates, app-backed generation and inaccessible installations.
- [x] Preserve the custom setting through SettingsManager writes; resolve layers, preset overrides, explicit disable,
      model changes and misspelled fields.
- [x] Exercise the real Pi OpenRouter adapter against a local HTTP server, including exact reference bytes, reasoning,
      temperature, provider errors, image-free replies and cancellation.
- [x] Exercise the real Agy subprocess boundary with an executable fixture, shared model/effort mapping, native-tool
      false success, invalid output ownership and active cancellation.
- [x] Exercise official Codex RPC through an executable fixture: account/capability/catalog checks, selected effort,
      reference paths, matching item/turn completion, stale/outside files, approval refusal and cancellation.
- [x] Exercise OpenCode request construction, reference bytes, controls, model-access denial, malformed/image-free
      responses, cancellation and no-retry behavior against a local HTTP boundary fixture.
- [x] Decode and validate output raster data, enforce MIME consistency, convert JPEG/WebP output, preserve existing
      destinations, reject escaping/symlink paths and recheck paths after generation.
- [x] Exercise Claude's actual MCP bridge with the real tool, current-Session references, image results and saved files.
- [x] Verify registration policy, text-only result filtering, and no implicit retry on provider failure.
- [x] Include Photon's module-relative WASM assets in release compilation and exercise direct image conversion in the
      image-processing smoke check. A bundled/minified standalone build of that check also passed outside the checkout.
      Full release acceptance is still listed below.

## Remaining acceptance work

1. **Live Pi generation and editing.** Configure OpenRouter through ordinary RunWield auth or `OPENROUTER_API_KEY`.
   Invoke the actual `create_image` tool with `openrouter/google/gemini-3.1-flash-image`, then use the result as a
   reference for a second output. Inspect pixels, supported options, actual MIME/dimensions and usage. Record provider
   refusal or unsupported-control errors separately from missing setup. Do not add automatic paid CI requests.
2. **Live Agy structured output.** From an environment permitting ordinary Agy storage writes, invoke the actual tool
   with a supported `agy-cli/<model>`. Verify generation, reference editing, native events, schema path correlation,
   cancellation and output retention. Model listing and September's free-text-path proof do not close this item.
3. **Live Codex adapter.** With ordinary Codex state access, test generation, editing and cancellation through the
   actual tool. Check matching native items and retained outputs; September's proof and protocol fixtures alone do not
   close this item. Do not relocate credentials or disable permissions to bypass sandbox restrictions.
4. **Live OpenCode capability.** Resolve the account's model-access denial through its normal provider setup, then
   establish whether the hosted image tool is supported. Test generation and reference editing only with that access. If
   unsupported, keep the error explicit; a documented Responses endpoint alone is not a capability guarantee.
5. **Packaged and surface acceptance.** Run the compiled package smoke test outside the checkout, then inspect a real
   generated image in TUI and Workspace, reopen the Session, and inspect/edit the project file. The focused compiled
   image check is not proof that the complete release archive contains every runtime asset.
6. **Publication.** Run applicable repository gates, review the scoped diff alongside other work, and publish only when
   explicitly authorized. This task does not authorize a commit or push.

## Verification commands

All tests must use the repository's sandboxed runner. The focused implementation suite is:

```sh
deno run -A scripts/run-tests.js src/tools/create-image.test.ts
deno check src/tools/create-image.test.ts src/shared/session/session.js
deno run -A src/cmd/package-smoke/image-resize.ts
deno task seams:check
```

Also run the existing settings, image-attachments, session-tools-policy, Agy backend and compile tests through
`scripts/run-tests.js`. Run full CI before publication. Fixtures replace only network and executable boundaries; owned
settings, registry, storage, raster conversion, cancellation and bridge behavior remain real.

## Deferred scope

Direct Google SDK integration requires a separately authorized slice and current live acceptance. Graphical image-model
controls, extra rendering parameters, multiple-image output and bounded remote generation are also outside this slice.
Keep `see_image`, existing host-native image tools, user files and unrelated ongoing repository work intact.
