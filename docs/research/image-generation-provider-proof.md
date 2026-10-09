# Image generation provider proof

## Current status — 2026-10-06

The owner confirmed that `create_image` works with **OpenRouter, Codex, and Antigravity CLI**. These are the user-facing
image generation backend names. Pi is the implementation library behind OpenRouter, not a separate backend.

The September and October 3 observations below remain historical evidence of those specific runs. Missing credentials
and sandbox restrictions in those environments must not be presented as current product limitations or as a pending
acceptance gate for these three working backends. This update records owner confirmation, not a new automated test run.
The separate OpenCode adapter remains experimental; the confirmation does not include it.

Historical live tests on 2026-09-06; current implementation checks below are dated 2026-10-03. September scope: Pi's
existing image provider, Antigravity CLI, the official Codex App Server with subscription authentication, and Google's
`@google/genai` library. No requests were made directly to undocumented Codex backend endpoints. No RunWield
implementation or dependency changes were made during that September proof.

## Pi 1 0 implementation checks on 2026-10-03

The initial implementation scope was `create_image` through Pi or `agy-cli/<model>`, with required output path and
optional supported `thinkingLevel`/`temperature`. The later request for OpenCode and Codex adapters is recorded below.
Direct Google SDK integration remains deferred. The September results are not fresh October runs.

- Installed Pi 1.0.0 exposes image models through the same `ModelRuntime`/`Models` as chat, using
  `getModelOfType("image", provider, id)` and `generateImages`. The previous separate image registry design is obsolete.
- The installed catalog has 57 image entries, all through its built-in OpenRouter provider. The adapter calls chat
  completions and parses image data URLs. OpenRouter documents continuing support for existing image models on that
  surface; newer image-API-only models must not be assumed to work through this installed adapter.
- `ImagesOptions` does not expose first-class temperature or thinking. Pi's `onPayload` hook supports the narrow,
  explicit mappings used by this implementation. Public OpenRouter endpoint metadata advertises temperature and
  reasoning for Gemini 3.1 Flash Image, and temperature without reasoning for Gemini 2.5 Flash Image. Google's image
  documentation specifies minimal/high thinking for Gemini 3.1 Flash Image. These are documentation/metadata checks, not
  paid live option acceptance.
- No OpenRouter credential was configured in the checked environment. No live Pi generation or edit succeeded in this
  run. Credentials were inspected only for presence, never printed or copied into repository files.
- `agy models` returned available models through cached login, but its ordinary log/crash storage writes were denied by
  this sandbox. A new live image request was not run. The structured final-path contract still needs live proof.
- Seventeen focused automated tests passed through the real Pi adapter/local HTTP fixture, real Agy process/executable
  fixture, real Photon decoding/conversion, and actual Claude MCP bridge. They cover settings/presets, reference bytes,
  output formats, existing/escaping/symlink paths, MIME mismatch, false success, unsupported controls, both in-flight
  cancellations, Pi Session registration, image results and Session references. Fixtures are not evidence that remote
  providers generated images.
- Type checking, lint, formatting, the zero-injection-seam gate and eight relevant test files passed. The source
  image-processing smoke check and a bundled/minified standalone build of that check both passed; the executable ran
  outside the checkout and exercised Photon JPEG/WebP conversion and Pi's resize worker. Full release and real surface
  acceptance remain separate checks in the [revised Plan](../plans/generate-image-tool.md).

Sources for the October 3 checks:

- [Pi 1.0 image API](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/README.md#image-generation).
- [OpenRouter image API transition](https://openrouter.ai/blog/announcements/image-api/) and
  [image generation guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).
- [Gemini 3.1 Flash Image endpoint metadata](https://openrouter.ai/api/v1/models/google/gemini-3.1-flash-image/endpoints)
  and [Gemini 2.5 Flash Image metadata](https://openrouter.ai/api/v1/models/google/gemini-2.5-flash-image/endpoints).
- [Google image thinking controls](https://ai.google.dev/gemini-api/docs/image-generation).
- [Agy structured headless output](https://antigravity.google/docs/cli/headless/).
- [Photon Node usage](https://silvia-odwyer.github.io/photon/guide/using-photon-node/).

## Additional adapter checks on 2026-10-03

The user explicitly requested adapters for OpenCode, Agy and Codex using existing authentication. The implementation
retains Agy and Pi routing and adds `codex-cli/<model>` (alias `openai-codex/<model>`) through the official App Server,
plus experimental `opencode/<model>` through its Responses endpoint. No undocumented Codex endpoint or extracted
subscription token is used.

- **Codex protocol:** Generated the experimental JSON schema from the installed CLI and checked account, capabilities,
  catalog, thread/turn parameters and native image-completion items. The live App Server preflight exited before
  initialization because its SQLite runtime could not initialize under `~/.codex` in this sandbox. No new image was
  generated. The adapter requires the CLI's own ChatGPT login; Pi's OAuth entry is not used as a substitute.
- **OpenCode live request:** Used the existing RunWield OpenCode credential against the documented
  `https://opencode.ai/zen/v1/responses` endpoint with supervising model `gpt-5.6-sol` and the hosted `image_generation`
  tool. The single request returned HTTP 403 with `Upstream request failed: Model access is disabled`. No image was
  returned, and there was no automatic retry or fallback. Public catalog presence does not establish account access.
  This denial happens before successful image output and does not establish whether OpenCode supports the hosted tool.
  The adapter is experimental until that capability is demonstrated; Responses compatibility alone is insufficient.
- **Agy:** Retains the previously implemented native-tool adapter. The cached login can list models, but ordinary Agy
  storage writes remain sandbox-restricted. This is not evidence that the login is invalid or that image generation is
  unavailable. No fresh structured-output generation/editing proof is claimed.
- **Automated verification:** All 23 image-tool tests passed, including real HTTP boundary fixtures for Pi/OpenCode and
  executable subprocess fixtures for Agy/Codex. Codex cases cover ChatGPT-only auth, capabilities, catalog/effort,
  references, matching image/turn events, permission refusal, stale/outside files, malformed output and cancellation.
  OpenCode cases cover reference bytes, settings, HTTP denial, no-image/invalid results and cancellation without retry.
  Nine relevant test files passed, including interactive-stdin ownership/cleanup, existing vision, settings, session
  policy, Agy and compile tests. Type checking, scoped lint and the zero-injection-seam gate passed. These fixtures
  prove local behavior, not live provider image output.

Sources for the additional routes:

- [Official Codex App Server](https://learn.chatgpt.com/docs/app-server) and
  [native Codex image generation](https://learn.chatgpt.com/docs/image-generation).
- [OpenCode Zen endpoint documentation](https://opencode.ai/docs/zen) documents the Responses endpoint, not a guarantee
  of hosted image-tool support for this account/model.
- [OpenAI hosted image-generation tool](https://developers.openai.com/api/docs/guides/tools-image-generation) defines
  the Responses tool request/result shape used by the experimental OpenCode adapter; this does not prove OpenCode
  forwards or implements that tool.

## Historical results on 2026-09-06

| Route                                  | Generate                                     | Edit using reference | Evidence                                                                                                                                  |
| -------------------------------------- | -------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Pi / OpenRouter                        | Blocked: missing credential                  | Not attempted        | Pi 0.84.2 discovers image models; `generateImages()` returns `stopReason: "error"`, `No API key for provider: openrouter`, and no output. |
| Agy subscription                       | Passed after one earlier failed request      | Passed               | Native `generate_image` events, actual JPEG files, and visual inspection.                                                                 |
| Official Codex App Server subscription | Passed after correcting agent tool arguments | Passed               | ChatGPT account type, image capability, completed `imageGeneration` items with `savedPath`, actual PNG files, and visual inspection.      |
| Google Gen AI SDK                      | Blocked: missing credential                  | Not attempted        | Installed SDK 1.52.0 loads, but reports that an API key is required. Client construction alone does not prove generation.                 |

At the time of this September probe, this was partial confirmation, not four successful live integrations. OpenRouter
and Google still needed a configured key and a live generation/edit test in that environment. See the current status
above for the later owner confirmation of OpenRouter. The API-key OpenAI SDK was not tested; the official OpenAI route
tested here is Codex App Server, using its existing ChatGPT login.

## Agy

The first request asked for flat geometric shapes. The native tool emitted a tool-step error:
`no image generated in response`. The CLI nevertheless exited successfully with final `status: "SUCCESS"`, because the
agent successfully explained the failure. There was no image. This must become an adapter regression case.

A second, separate request asked for a red ceramic mug on white. It succeeded:

- CLI: installed `/Users/gandazgul/.local/bin/agy`.
- Arguments: `-p`, `--output-format stream-json`, `--print-timeout 3m`, `--effort low`.
- Native image-tool duration: 10.27 seconds; total turn duration: 18.54 seconds.
- Generated image: JPEG, 1024 × 1024.
- A fresh process then edited that reference, changing the glaze from red to cobalt blue.
- Edit tool duration: 8.57 seconds; total turn duration: 12.51 seconds.
- Edited image: JPEG, 1024 × 1024. Visual inspection confirmed the color change and retained composition.
- The edit's host transcript records `ImagePaths` with the exact input file. The public stream's abbreviated
  `tool_info.parameters` omitted that array, so absence from that abbreviated object does not prove absence from the
  actual call.

Successful native tool steps did not include the saved path in their public stream payload in these runs. The final
agent response supplied it. Production must validate a requested structured final path against the current run,
successful native tool event, filesystem metadata, and decoded image bytes. Do not depend on private host transcript
files for production path discovery; those files were inspected only to establish reference use during this proof.

No dangerous permission bypass, global custom-agent install, or MCP configuration change was used. Agy created its
ordinary conversations and image files in its own storage. Test copies are in the temporary proof directory below.

## Codex

Used `codex-cli 0.153.3`, installed with the desktop app. The probe spawned `codex app-server` and exchanged JSON-RPC
through stdio. Its sequence was `initialize`, `initialized`, `account/read`, `modelProvider/capabilities/read`,
`model/list`, `thread/start`, `turn/start`, then item and turn completion notifications.

- `account/read` returned account type `chatgpt`; the probe rejected API-key account fallback.
- Provider capabilities reported `imageGeneration: true`.
- The first generation attempt used `gpt-5.4-mini`. It completed without an image and reported an invalid
  reference-image-count argument. This is an agent/tool invocation failure, not evidence of a subscription API failure.
- The successful generation and edit used supervising model `gpt-5.6-sol`, reasoning effort `low`.
- For generation the prompt explicitly required only the `prompt` argument and omission of both optional reference
  selectors. Passing zero as a reference-image count is invalid.
- For editing the prompt supplied `referenced_image_paths` and required omission of `num_last_images_to_include`.
- Each operation used a fresh ephemeral thread in the temporary working directory.
- Generation completed in 32.9 seconds; editing completed in 27.2 seconds.
- Both produced `imageGeneration` items with `status: "completed"`, `failure: null`, and an actual `savedPath`.
- Both files are PNG, 1254 × 1254. These observed dimensions are not a configurable size guarantee.
- Visual inspection confirmed a red mug, then a blue version retaining the original composition.

The host saved images under its `generated_images` directory; the probe copied the files into the proof directory. It
did not extract or forward the Codex access token. Only official local App Server methods were called by the probe. The
App Server itself owns authentication and its network calls.

The native tool's image model and rendering options are host-managed. Model/effort selection in this proof controls the
supervising Codex agent. It is not an image-model thinking setting or a demonstrated quality/size API.

## Local evidence

Temporary proof directory: `/private/tmp/runwield-image-proof.ozh5hM`. This directory is local evidence, not a durable
dependency or a CI fixture. No credentials are embedded in its probe scripts or summaries.

| File                   | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| `agy-generation.jpg`   | `5b073b26adc797ca0558e592d6d47c89d950217cdf95d159985a46a0d934ca88` |
| `agy-edit.jpg`         | `9ff328ff1a194e4e488276a82c7963a8119b45abd11e6dd90533d789a124b4b5` |
| `codex-generation.png` | `a0e7042e81e866df5414d4cf93cf9c72629a9e9cf2e08a420167576274907e96` |
| `codex-edit.png`       | `0280ebc1a4600b03d451a21a3d278026e07e789db617ce323d300711780df8a6` |

The directory also contains `codex-app-server.mjs`, separate first-attempt/retry/edit result summaries, `check-auth.ts`,
and `api-auth-probes.ts`. Do not rerun successful generations just to verify documentation.

## Historical four-route follow-ups

The current adapter acceptance checklist is in the [revised Plan](../plans/generate-image-tool.md). The following
September list is retained as historical follow-up context; its old Pi API name is not the Pi 1.0 implementation.

1. Configure OpenRouter through RunWield's existing credential setup or `OPENROUTER_API_KEY`. Generate a mug through
   Pi's `builtinImagesModels().generateImages()`, save and inspect the image block, then submit it as an image input for
   an edit. Record model ID, actual MIME type, size, usage when provided, and reference-edit behavior.
2. Configure Google's existing API credential or `GEMINI_API_KEY`. Use the official `@google/genai` library to generate
   and edit an image. Validate actual response parts, image model ID, and the chosen thinking option. Do not substitute
   an Agy login for Gemini API credentials.
3. Record failures separately from missing prerequisites. Never call a fixture response or SDK constructor success a
   completed live generation test.

## Sources

- [Pi image API](https://unpkg.com/@earendil-works/pi-ai@0.84.2/README.md) — version 0.84.2 image-generation section.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) — official local client protocol.
- [Codex image generation](https://learn.chatgpt.com/docs/image-generation) — subscription usage and host behavior.
- [Antigravity headless mode](https://antigravity.google/docs/cli/headless/) — cached login, public stream, and output
  schema.
- [Antigravity models](https://antigravity.google/docs/models/) — supervising model versus host-managed image model.
- [Google image generation](https://ai.google.dev/gemini-api/docs/image-generation) — official image models and
  controls.
- [Google Gen AI SDK](https://github.com/googleapis/js-genai) — official SDK.
