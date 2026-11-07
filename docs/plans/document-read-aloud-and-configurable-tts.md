---
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "MEDIUM"
affectedPaths:
    - "src/shared/settings.js"
    - "src/shared/session/session.js"
    - "src/tools/registry.ts"
    - "src/ui/review/review-launcher.ts"
    - "src/ui/workspace/server.js"
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/react/ArtifactReadSurface.tsx"
    - "docs/prd/runwield-core-prd.md"
    - "docs/prd/runwield-workspace-prd.md"
devServerCommand: "bun run workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev/"
devServerHmr: true
createdAt: "2026-11-05"
status: "draft"
executionAgent: "frontend-engineer"
collaborationRecommendation: "pair"
planId: "ec22a9b4-b726-443a-a6bf-e25435cdcc4a"
---

# Document read-aloud and configurable text-to-speech

## Context

The owner wants Agents to read produced documents or responses aloud, using an enabled, user-configured text-to-speech
(TTS) model and voice. The first browser entry points are Plan Review and the shared artifact reader. The owner chose
**built-in Kokoro, downloaded on first use and run locally**, rather than requiring a separately operated TTS server.

Today `PlanReviewSurface.tsx` and `ArtifactReadSurface.tsx` have no speech capability. Standalone readers and reviews
use the shared token-scoped review host; Workspace also embeds the reader. `artifact_written` registers documents but
does not speak. Existing image-generation settings and tool composition demonstrate a separate configured capability
that does not depend on the conversation model.

Proposed requirements belong to a new **Read aloud** capability in the [Core PRD](../prd/runwield-core-prd.md), with
browser entry points added to [Document reader](../prd/runwield-workspace-prd.md#document-reader) and
[Browser Plan review](../prd/runwield-workspace-prd.md#browser-plan-review-and-workflow). Preserve the existing
[Plan review](../prd/runwield-core-prd.md#plan-review) decisions, document return actions, annotations, editing, printing,
and lifecycle authority. No requirement is removed.

## Objective

Users can enable speech, choose a model and voice, preview it, and hear the current Plan or artifact through a Read aloud
button. Agents gain a `read_aloud` tool for a project Markdown document or supplied response text. The built-in route
works without a paid service or a user-managed server and keeps synthesis on the listening device.

## Approach

### One capability, three entry points

```text
Plan Review / artifact reader / read_aloud Agent tool
    -> one speech request and Markdown-to-text policy
    -> selected synthesis route
       - built-in Kokoro: browser worker, locally cached model assets
       - compatible endpoint: Core sends text to the configured server
    -> shared browser playback controls and truthful playback status
```

The browser owns playback; Core owns personal configuration, local model assets, endpoint credentials, and authenticated
request delivery. This keeps audio on the device the user is listening on, including a phone, rather than playing on
an SSH server. Use the existing review host and browser-opening capability for Agent requests. Do not introduce native
OS audio players, a second background daemon, or an independent workflow state machine.

### Settings and first use

Add personal `textToSpeech` settings through the existing global settings reader/writer. Proposed fields are `enabled`,
`provider` (`kokoro` or `openai-compatible`), `model`, `voice`, and endpoint-only `baseUrl` and `apiKeyEnv`. Validate a
named TypeScript shape; never use the conversation-model registry as a speech-model catalog. The graphical settings
expose enablement, model, voice, and a short Preview action. Endpoint mode also exposes the URL and optional credential
environment-variable name. Secret values stay on the Core host and never enter browser payloads or logs.

**Reviewable defaults:** speech is off initially; enabling selects built-in Kokoro v1.0 and Heart (`af_heart`). Adam
(`am_adam`) remains selectable. Settings are personal/global in this first slice; repository settings and model presets
cannot silently change the destination or enable speech. A model/provider change resets incompatible voice and
endpoint fields. A settings change takes effect on the next request and stops any current preview.

Both document surfaces expose Read aloud even when unconfigured; its first use opens the same compact setup panel.
The panel explains the one-time model download before Enable/Preview starts it, shows byte progress and retryable
failure, and labels the built-in route **On this device**. The optional endpoint route explicitly names its destination
and explains that document text is sent there. There is no automatic fallback between routes.

### Built-in model and packaging

Use a pinned browser release of `kokoro-js`, with WASM/q8 as the initial portable inference route in a Web Worker.
Lazy-load speech code after the user enables or invokes it. WebGPU optimization is optional implementation work only
if it preserves the same verified fallback; do not make GPU support a prerequisite.

The durable asset cache belongs to Core under a dedicated personal cache directory derived with `getHomeDir()`, outside
the repository. Pin the ONNX model revision and a finite manifest of model, tokenizer, selected voice, and required
runtime assets. Download lazily, validate expected size/digest, publish complete files atomically, deduplicate concurrent
downloads, and automatically discard/retry corrupt partial entries. New voices may download their own small asset.
The cache contains public model assets, never document text or generated speech.

Serve those files through the existing host with safe, manifest-bound paths. Configure Transformers model loading,
Kokoro voice loading, ONNX runtime assets, and the phonemizer to use bundled or same-origin assets. Prefer supported
upstream configuration such as `setVoiceDataUrl`; verify its export in the pinned package. Any necessary adapter stays
inside the speech integration and does not become a broad fork or application-wide fetch replacement.

This host cache is necessary: `review-host.ts` uses random ports, so browser-origin caches alone would repeatedly
download the model after restarting RunWield. A warmed cache must work with upstream networking disabled and a newly
allocated review port. Inference still runs in the browser. For Remote SSH, the existing serving host may cache assets;
do not describe that as host-side synthesis or add a new laptop filesystem bridge.

### Configured endpoint

Offer an optional OpenAI-compatible speech endpoint for users choosing another model or an existing local service.
Core sends bounded requests to the configured base URL's speech route using `model`, `voice`, `input`, and an explicitly
supported audio format. Use WAV initially to keep decoding and validation concrete. Support manual model and voice
identifiers instead of assuming every compatible server implements model/voice discovery. Validate errors, audio MIME
and bytes, timeouts, cancellation, and output size; never treat a successful HTTP status containing JSON as audio.

The browser sends neither a destination nor credentials with synthesis requests. Core resolves them from the owner's
settings, permits HTTP for explicitly configured loopback endpoints and HTTPS for others, and does not follow a redirect
that changes the configured destination. Shared capability-link visitors cannot use the owner's settings, credentials,
or synthesis endpoint; they retain normal reading. This slice serves personal owner/standalone surfaces.

### What is read and how playback behaves

Use one pure Markdown-to-speech conversion, based on the existing Markdown parser dependency. Speak headings, prose,
lists, table content in reading order, link labels, inline code, and callout title/body. Omit YAML, markup syntax, link
destinations, HTML scripts/styles, and UI controls. Announce fenced code or diagrams as skipped rather than reciting
source. Render Plan Questions as their prompt and choices, never raw JSON. These are reviewable reading defaults,
not a summary: do not invoke an LLM to rewrite the document.

Plan Review reads the currently selected document and current draft body, including unsaved edits, without saving it.
Changes view reads that current body rather than diff syntax. Sequence tab/version switches, edits, or a new review
revision stop old playback; a new click reads the updated text. The artifact reader uses exactly its displayed payload.

Split at sentence/paragraph boundaries, then enforce the selected engine's actual token limit before generation.
Long sentences must split further without truncation or omission. Bound total input and reject oversize input clearly
instead of silently clipping it. Generate/play ordered chunks with bounded lookahead so a long Plan need not finish
synthesizing before playback starts. Stop cancels outstanding work, ignores late results, clears queued audio, and
releases worker/audio resources. Pause preserves position; Resume continues; Stop resets to the start.

Place a shared Read aloud control with the document actions, secondary to approval. While active it shows Preparing
(or download progress), Pause/Resume, and Stop. Expose Settings and Preview from the same control in both surfaces.
Use existing tokens, buttons, waiting dots, focus treatment, and responsive toolbar patterns. Controls remain reachable
on phones, have accessible names and status announcements, and disappear in print. Report errors inline with Retry.
Keep one playback request per page, replacing it on a new request; stop on navigation, close, approval, or unmount.

### Agent tool

`read_aloud` accepts exactly one of project-relative Markdown `path` or response `text`, plus an optional title. It uses
the configured model and voice; model credentials and route overrides are not tool arguments. Path reads resolve
real paths within the current Project, reject symlink escapes, and enforce the same input bound. Text can be Markdown.
It does not register a fabricated durable artifact, alter the document, or advance Plan lifecycle.

Expose the tool to user-facing root Agents when enabled, including the existing CLI capability bridge where applicable;
isolated delegates do not initiate surprise playback. Prompt guidance permits explicit requested speech and deliberate
use when speech is enabled, without automatically narrating every response or tool result.

Reuse/open a token-scoped browser playback surface containing the supplied text and shared controls. Keep the surface
alive through playback after the tool returns and release it on close, cancellation, or Session disposal. A bounded
initial acknowledgement distinguishes `playing`, `requires_play`, `opened`, `disabled`, and `failed`; `playing` requires
an actual browser playback acknowledgement. If browser opening fails, return the usable URL. If autoplay is blocked,
show Play and return `requires_play`. Do not wait for a whole document to finish or claim the user heard it. Arbitrary
external MCP hosts without a RunWield Session are outside this tool-registration slice; Connect's Plan Review button
works through the existing browser surface.

### Local-model research and recommendation

- **Kokoro is the selected built-in option.** It has 82 million parameters and Apache-2.0 model weights. Its official
  JavaScript package supports local browser inference and streamed chunks. This is a credible fit for document
  narration; quality and latency on the target devices still require listening tests.
  [Model card](https://huggingface.co/hexgrad/Kokoro-82M),
  [JavaScript documentation](https://github.com/hexgrad/kokoro/tree/main/kokoro.js).
- **Offer Adam, but preview other voices.** The author lists Adam with a lower training-quality estimate than Heart,
  Bella, Michael, Fenrir, and Puck. These grades are not a listening benchmark. The voice guide also cautions about
  very short and long utterances. [Voice guide](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).
- **Do not trust the default splitter to preserve long text.** Current upstream code explicitly truncates exceptionally
  long chunks. Voice assets have a separate loading path; configuration and offline tests must cover both.
  [Inference source](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/kokoro.js),
  [Voice source](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/voices.js).
- **A user-run local server remains optional.** Kokoro-FastAPI exposes compatible speech endpoints, but requiring its
  Python/container setup would contradict the owner's built-in choice.
  [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI).
- Transformers supports local asset paths and disabling remote model loads; browser playback can reject `play()`
  because user interaction is required. These constrain implementation, not the user's choice of voice.
  [Transformers configuration](https://huggingface.co/docs/transformers.js/api/env),
  [Browser playback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play).

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- New `src/shared/speech/` modules — typed settings, Markdown preparation, asset cache, and endpoint synthesis.
- `src/shared/settings.js` and `docs/user-documentation/settings.md` — integrate personal settings without bypassing
  existing locking or losing other custom keys; document enablement, voices, first-use storage, and endpoint setup.
- New `src/tools/read-aloud.ts`, `src/tools/registry.ts`, `src/shared/session/session.js`, and shared Agent guidance —
  expose the capability in native and bridged root turns, with correct lifetime and result reporting.
- `src/ui/review/review-launcher.ts`, `src/ui/workspace/server.js`, relevant owner/review routes, and
  `src/ui/workspace/server/review-host.ts` — deliver authorized speech requests, assets, settings, and acknowledgements
  across standalone, linked-document, and owner Workspace readers without changing review decisions.
- `src/ui/workspace/react/PlanReviewSurface.tsx`, `ArtifactReadSurface.tsx`, and new shared speech controls/worker —
  consistent settings and playback, browser-local inference, teardown, responsive and accessible states.
- `package.json`, `bun.lock`, Workspace build configuration and package-asset handling — pin and ship lazy browser
  runtime/phonemizer assets without Node-native inference entering the Bun executable.
- Core and Workspace PRDs, `docs/domain-language.md`, applicable settings schema and public references — describe only
  delivered behavior; add the `read_aloud` Custom Tool definition with its browser playback boundary.

## Reuse Opportunities

- `getCustomSetting` and existing custom-setting writers — personal configuration and safe persistence.
- `reviewHost`, `startArtifactReadSurface`, and `BrowserPort` — browser serving/opening and graceful URL fallback.
- `readSessionArtifact` and existing contained-file readers — real-path containment principles; do not require a
  registered artifact merely to read a newly produced project Markdown file.
- `create_image` composition in `session.js` — configured capability exposure and bridged-tool wiring patterns.
- Existing Markdown tokens, design-system controls, `WorkspaceHeaderActionsPortal`, and loading indicators — avoid
  duplicated parsing and separate toolbar designs.

## Implementation Steps

1. `src/shared/speech/` resolves and validates personal speech configuration and converts Markdown into ordered spoken
   content under the documented rules. Disabled settings cause no model downloads, synthesis, or tool exposure. Settings
   saves preserve unrelated keys; malformed settings return actionable errors and never select another provider.
2. The built-in integration loads the pinned Kokoro model in a browser worker and produces decodable nonempty audio.
   Core supplies a complete persistent asset cache, including voice and phonemizer/runtime dependencies, through bounded
   manifest paths. Cold-download progress, interrupted/corrupt download repair, same-model concurrent requests, and warm
   use after host-port changes work without downloading on every page load. The production bundle contains no required
   Node-native inference runtime.
3. Endpoint synthesis uses only the configured destination/model/voice, keeps credentials server-side, validates audio,
   honors cancellation and bounds, and returns specific errors for unavailable models/voices/authentication. Local mode
   makes no external text requests. Authorization applies to settings, synthesis, source text, and playback reports.
4. One shared playback implementation incrementally plays every prepared chunk in order, splits overlong sentences
   without dropping their tail, pauses/resumes at the correct position, stops immediately, and discards stale completions.
   Both document surfaces provide enable/configure/preview/read/pause/resume/stop/retry using the current displayed body;
   approval, editing, annotations, return navigation, and printing keep their existing behavior.
5. `read_aloud` accepts path or text, uses the same preparation/configuration/playback path, and is available in enabled
   root-Agent native and supported bridged turns. It reports actual playback acknowledgement separately from opening a
   page or needing a click. It rejects escaping files, cleans up on cancellation/disposal, and leaves documents, artifact
   registration, and Plan lifecycle unchanged.
6. Focused tests cover settings, conversion, asset/cache HTTP behavior, endpoint bytes, browser controls, and tool
   composition using real temporary files/servers. Fakes replace only external network/inference/audio/browser
   capabilities. No owned settings/cache/lifecycle injection seams or seam-baseline changes are introduced.
7. The owning Core capability and Workspace scenarios match the delivered settings, tool, browser playback, first-use
   download, and offline behavior. Settings documentation and glossary ship in the same change. Distinguish remaining
   targets such as automatic response narration, native audio, voice cloning, and arbitrary host-plugin exposure from
   current support. Do not advertise unsupported non-English voices merely because the underlying model has them.

## Approval Confirmation

No Work Record supersession is proposed. Approval accepts the explicitly labeled reading and settings defaults above;
the owner's built-in-download choice is already settled.

## Verification Plan

- Use Bun 1.4.3 and `bun run install:locked` before checks. Run focused tests with
  `bun scripts/run-tests.js src/shared/speech src/tools/read-aloud.test.ts` and the relevant modified Workspace/Session
  test files. Run `bun run workspace:check`, `bun run workspace:build`, `bun run seams:check`, and
  `bun run fmt:check <changed files>`. RunWield owns the full CI gate after implementation.
- Conversion fixtures include front matter, headings, tables, callouts, links, inline/fenced code, diagrams, HTML,
  embedded Plan Questions, Unicode, empty content, and a sentence over the model limit. Assert ordered meaningful text
  reaches synthesis exactly once, including a unique tail marker. A pass-through parser or truncating splitter must fail.
- Real temporary cache/server tests prove cold asset requests, concurrent download reuse, interruption recovery,
  digest failure repair, path rejection, and a warm restart on a different port with upstream disabled. Disabled speech
  issues zero upstream requests. Host origin changes must not invalidate the durable cache.
- A local compatible-provider fixture asserts the exact configured model/voice/input and returns a valid small WAV;
  verify successful playback decoding and distinguish HTTP errors, JSON masquerading as audio, oversize responses,
  timeout, cancellation, and disallowed redirects. Reject unauthorized/settings-overriding browser requests and prove
  shared-link visitors cannot invoke owner synthesis or retrieve credentials.
- Browser/component tests exercise start, pause, resume, stop during preparation/playback, voice preview, retry,
  document revision/tab/version changes, navigation, and late chunks. Mock only actual media/inference boundaries;
  verify Stop prevents audible/queued continuation. Autoplay rejection must show Play and never report `playing`.
- Tool integration tests exercise both text and a real Markdown file, path/symlink rejection, disabled state, root vs
  delegate exposure, native/bridged composition, no-browser URL fallback, bounded acknowledgement, and resource disposal.
  A tool that merely returns a success string without delivering text to the browser must fail.
- In a headed browser, use `bun run workspace:dev` at `http://127.0.0.1:5173/dev/` for deterministic UI fixtures, then
  exercise a production standalone Plan Review, an owner Workspace Plan/reader, a linked document, and an Agent request.
  Check desktop and phone widths, keyboard/focus/screen-reader labels, dark/light themes, and print exclusion. Confirm
  unsaved Plan edits are spoken without being saved and ordinary review decisions still work.
- Perform a real built-in synthesis/listening test with Adam and Heart plus one alternative male voice using a short
  response and a representative multi-page Plan. Record device/browser, cold download size/time, warm time to first
  audio, continuity, and pronunciation observations. After warming, restart on another port and block external network;
  repeat successfully. Capture that real audio is nonempty and decodable; a fake inference fixture alone cannot satisfy
  this check. Keep any audible limitations explicit instead of claiming a universal quality threshold.
- Preserve existing `artifact-read-close`, `review-launcher`, contained-file, Plan-review draft, and tool-policy coverage.
  None of their protected behavior is intentionally removed. Verify PRD/glossary/settings links and maturity statements
  against the tested behavior.

## Edge Cases & Considerations

- Browser-local inference uses the listener's CPU and memory. Bound the queue, terminate canceled workers when needed,
  and show a useful error on devices without adequate support; never silently upload text elsewhere.
- No network on first use prevents obtaining uncached model/voice assets. Keep reading/review fully usable and offer
  Retry. A previously cached model and voice must work offline while the RunWield host remains reachable.
- An open browser tab is not proof of playback; permission denial or tab closure must remain truthful to Agents.
- Endpoint loopback refers to the Core host, not automatically the user's laptop. Label this in settings, particularly
  for SSH use. Built-in synthesis always remains in the browser.
- Speech is ephemeral. Do not save audio or response text as repository artifacts, record it in model-cache metadata,
  or require a database schema for playback. Ordinary tool transcript behavior remains unchanged.
- Built-in English voice support is the verified baseline from current Kokoro JS; expand only to languages supported
  by the pinned runtime and verified with examples. Voice quality is a preview/listening choice.
- The new provider interface is a real external inference boundary. Keep configuration, chunking, downloads, and
  playback ownership cohesive; future providers should not require another Plan Review or artifact-reader integration.
