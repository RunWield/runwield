---
planId: "fd55996c-a04a-45b8-bc67-b24df82af0e2"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths:
    - "src/ui/workspace/react/CodeReviewSurface.tsx"
    - "src/ui/workspace/routes/api/review-agent-handlers.js"
    - "src/shared/standalone-review/ai-review.ts"
    - "src/cmd/ai-review/index.ts"
    - "src/cmd/guided-review/protocol.ts"
    - "src/cli.ts"
    - "src/cmd/registry.js"
    - "src/agent-definitions/ai-reviewer.md"
    - "src/constants.js"
    - "src/skills/review/SKILL.md"
    - "docs/prd/runwield-core-prd.md"
    - "docs/domain-language.md"
    - "docs/design-system.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-19"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
sessionName: "Guided Review Annotations"
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
validatedCommit: "b26023d01b8d9465cfccced8c15181241ef96638"
workRecord:
    status: "generated"
    recordId: "6127923c-9c2f-4fa3-8e58-eca6e7dcc09b"
    path: "docs/work-records/2026-10-21-ai-drafted-annotations-in-standalone-code-review.md"
    lastAttemptAt: "2026-10-21T16:09:47.355Z"
---

# Run AI Review in Standalone Code Review

## Context

**The owner wants the `wld review <subject>` page to draft review comments for them.** A new **Run AI Review** button
runs the bundled `review` skill over the reviewed changes. Its findings appear as real annotations on the diff. The
owner then edits them, deletes them, posts them to the PR, or sends them to Engineer.

Most of the page already exists:

- Annotations can be edited and deleted (`CodeReviewSurface.tsx` `editAnnotation`, `onDeleteAnnotation`).
- **Send to Engineer** sends annotations to the review's Engineer Session (`review-loop.ts`).
- In PR mode, **Post comments** and **Approve** send annotations to GitHub or GitLab (`forge-review.ts`
  `mapReviewAnnotations`).
- **Guided Review** already runs a background job: `POST /api/agents/jobs` starts a hidden `wld guided-review`
  subprocess, and the page shows its status, model, time, tokens, and cost.

What is missing:

- Nothing runs the `review` skill. The skill returns Markdown with three sections (`## Standards`, `## Spec`, `## Tests`).
  It does not return file and line positions.
- The Plannotator annotation type has `author`, `source`, and `severity` fields. RunWield never sets them, so the page
  cannot mark an annotation as written by the AI.
- Validation-time AI review (Semantic Review, `review_complete`) cannot be reused. Its findings have only free-text
  `evidence`, and its prompt needs an approved Plan and the Review Issue Ledger.

Owning capability: [Core Standalone code review](../prd/runwield-core-prd.md#standalone-code-review).

- **Proposed addition:** a requirement "Draft annotations with AI review", with acceptance scenarios.
- **Must survive:** the three review sources, Guided Review, Engineer chat, source-specific actions (Post comments,
  Approve, Approve & Commit, Send to Engineer), clearing annotations when the patch changes, and review-work protection.

> [!NOTE]
> **Overlap with the Conversational Review Sequence**
>
> The draft `conversational-review` Sequence also edits `CodeReviewSurface.tsx`. Its slice 2 keeps Standalone Code
> Review out of scope. Nothing moves between the Plans; whichever lands second merges the shared file.

## Objective

In Standalone Code Review, **Run AI Review** produces annotations that:

- sit on the right file, line range, and side when the finding has a position in the diff;
- show that the AI wrote them, and show their axis (Standards, Spec, or Tests) and severity (blocking or advisory);
- behave like the owner's own annotations: editable, deletable, posted by Post comments or Approve, and sent by Send
  to Engineer.

The button appears only in Standalone Code Review. Validation-time Code Review already runs AI review before the owner
sees the diff.

### Decisions

- **Surface:** only `wld review`. Validation-time Code Review and Workspace owner sessions do not show the button.
- **Button label:** **Run AI Review** (owner's choice).
- **Spec source:** automatic and non-interactive. The skill climbs its spec ladder (PR description, linked
  documents and tickets, matching files under `docs/`, `specs/`, `.scratch/`). It never asks. With no spec, the
  Spec axis reports that no spec is available (skill rung 7) and grades nothing against invented requirements.
- **No acceptance step:** generated annotations are normal annotations at once. The owner removes the ones they do not
  want.

### Domain language

Today **AI review** is the progress-copy name for Semantic Review. Standalone Code Review has no Semantic Review, so
"Run AI Review" there is not ambiguous. The recommendation is **no new glossary term**: extend the existing entries
with one sentence each (see Implementation Steps).

> **Question (ai-review-term):** Do we need a new domain term for the Run AI Review result in Standalone Code Review?
>
> **Answer:** No. Extend the 'Semantic Review' and 'Standalone Code Review' glossary entries: in Standalone Code Review, Run AI Review runs the bundled review skill and adds its findings as annotations; it is not Semantic Review. (Recommended) (answered in review)

## Approach

### Copy the Guided Review job pattern

The new job travels the same path as Guided Review. New code enters at the marked lines:

```text
CodeReviewSurface  [Run AI Review] (standalone only)
  POST /api/agents/jobs { provider: "ai-review" }          # review-agent-handlers.js
+   buildAiReviewPrompt(...)                               # src/shared/standalone-review/ai-review.ts
    runWldJobCommand("ai-review", prompt)                  # generalized from runConfiguredGuideCommand
+     wld ai-review                                        # src/cmd/ai-review/index.ts
+       SessionRuntime, agent "ai-reviewer" (read-only, workflow-only)
        stderr: usage + metadata frames (guided-review protocol.ts)
        stdout: findings JSON
+   validateAiReviewResult(raw, rawPatch)                  # ai-review.ts → annotations
  poll /api/agents/jobs, then GET /api/ai-review/:id
  merge annotations into page state
```

`ai-review.ts` is the one owner of the AI review contract. It builds the prompt, defines the findings JSON, and turns
findings into annotations. The handler and the CLI command only move bytes.

### The prompt

`buildAiReviewPrompt` expands the `review` skill through the normal skill catalog (`expandSkill("review", …, { cwd })`),
so a project override of the skill applies. It adds these run rules:

- Review this target: the mode, the git ref, the base label, and `reviewContext` (PR title and description).
- Read head files in the checkout for uncommitted or worktree reviews. Otherwise use `git show <ref>:<path>`, the same
  rule as `buildGuidedReviewPrompt`.
- Run the three axes as three sequential passes. Do not use sub-agents.
- Never ask the user. Never post to a Forge. Never edit files.
- Return only JSON with this shape:

```ts
type AiReviewResult = {
    schemaVersion: 1;
    specSource: string | null; // where the spec came from, or null for "no spec"
    findings: AiReviewFinding[];
};
type AiReviewFinding = {
    axis: "standards" | "spec" | "tests";
    severity: "issue" | "advisory";
    file: string | null; // null = a finding about the whole change
    side: "new" | "old";
    lineStart: number | null;
    lineEnd: number | null;
    title: string;
    body: string; // includes the cited rule or spec line, per the skill
};
```

The full patch goes in the prompt, as Guided Review does today.

### From findings to annotations

`validateAiReviewResult` parses the output with the same tolerant JSON extraction as Guided Review. It **places** a
finding instead of rejecting it:

```text
for each finding
  if file is a changed file and the line range is inside a diff hunk on that side
    line annotation (filePath, lineStart, lineEnd, side)
  else if file is a changed file
    file annotation; the text names the cited line
  else
    general annotation; the text names the file and line
  text = "**<Axis> · blocking|advisory** — <title>\n\n<body>"
  author = "AI review", source = "ai-review", severity = issue|advisory
```

Axis and severity go in `text` because `mapReviewAnnotations` posts only `text` to the Forge, and
`formatCodeReviewAnnotations` sends only `text` to Engineer. This way the label survives every destination and every
owner edit.

A line inside a hunk is required because GitHub and GitLab reject inline comments outside the diff.

Malformed JSON or a wrong `schemaVersion` fails the job with a clear error. The owner can run it again.

### Page behavior

```tsx
<CodeReviewSurface> (src/ui/workspace/react/CodeReviewSurface.tsx)
  <DiffStyleToggle>
    <div.rw-guide-actions>
      [Generate guided review]  status
+     [Run AI Review | Cancel]  status    # standalone only; elapsed · model · tokens · cost
  <ReviewSidebar annotations>             # AI annotations show "AI review" as author
```

- The button is shown only when `standaloneReview` is present and the capabilities report `ai-review` as available.
- It never starts automatically. Its title says it uses an additional LLM call.
- While the job runs, the button becomes **Cancel**, which calls `DELETE /api/agents/jobs/:id`. There is no 120-second
  limit as in `waitForGuideJob`. A skill review takes longer than a guide.
- On success, the status shows counts per axis and the spec source, for example "AI review · Standards 0 · Spec 2 ·
  Tests 1 · spec: PR description". With zero findings it says that AI review found no issues.
- **Rerun** replaces AI annotations that the owner has not edited. It keeps the owner's own annotations and every
  AI annotation the owner edited. `editAnnotation` marks an edited AI annotation.
- **Stale results are dropped.** The page records the raw patch at launch. When a result arrives after the patch
  changed, the page shows "AI review results are for an older diff" and adds nothing. The existing clear-on-patch-change
  code already removes earlier AI annotations with the others.

### The agent

A new workflow-only agent `ai-reviewer` (display name "AI Reviewer") runs the job. It follows the `recorder.md`
pattern:

- `workflowOnly: true`, so it is not in `/agent` listings;
- `sharedPractice: [user-authority]`;
- read tools only: `read`, `grep`, `find`, `ls`, the `code_*` read tools, `web_fetch` for linked tickets;
- `bash` with `bashAllowedCommands` limited to read-only git commands (the list from
  `delegated-read-agent-prompt.md` without any `gh` or `glab` command).

The Guide agent (used by `wld guided-review`) was set aside: it has `write_docs`, `edit_docs`, `user_interview`, and
unrestricted `bash`. A headless review must not ask questions or post to a PR.

**Option set aside:** a structured submission tool (like `work_record_completed` through
`runValidationAgentUntilEvent`). It would let the agent correct bad arguments, but it needs new tool registration and
usage plumbing that the Guided Review subprocess already solves. Placing findings server-side handles the common
failure (bad line numbers) without a retry loop.

## Expected Change Surface

The boundaries this change is expected to touch. This list is guidance, not an allowlist: verify the real footprint
during implementation and change whatever the Implementation Steps need, including files not named here. Stop and report
only when discovery changes approved intent — the change reaches another subsystem, public behavior or architecture
shifts, migration or compatibility risk grows, or the Verification Plan no longer proves the objective.

- `src/shared/standalone-review/ai-review.ts` (new) — the prompt, the findings contract, and placement into
  annotations.
- `src/cmd/ai-review/index.ts` (new) — the hidden `wld ai-review` command. It mirrors `src/cmd/guided-review/index.ts`
  with agent `ai-reviewer`.
- `src/cmd/guided-review/protocol.ts` — reused for usage and metadata frames. Change it only if a shared encoder needs
  a neutral export. Renaming the `RUNWIELD_GUIDED_REVIEW_*` prefixes is out of scope.
- `src/cli.ts`, `src/cmd/registry.js` — dispatch `ai-review` and give it the same project-directory consent rule as
  `guided-review` (`registry.js:908`).
- `src/agent-definitions/ai-reviewer.md` (new), `src/constants.js` — the workflow-only agent and its `AGENTS` key.
- `src/ui/workspace/routes/api/review-agent-handlers.js` — `ai-review` provider in capabilities and job creation,
  `GET /api/ai-review/:id`, and `runConfiguredGuideCommand` generalized to take the subcommand and override variable.
- `src/ui/workspace/react/CodeReviewSurface.tsx` — the button, status, cancel, merge, rerun, and stale-result rules.
- `src/skills/review/SKILL.md` — only if the skill needs a short "when run headless" note. The run rules belong in the
  prompt, not the skill. Keep `skills/review/SKILL.md` in step if that copy is the published mirror.
- `docs/prd/runwield-core-prd.md` — the new requirement and scenarios under Standalone code review.
- `docs/domain-language.md` — the one-sentence extensions (or the new term, per the open question).
- `docs/design-system.md` — the Run AI Review control next to Guided Review and the AI annotation author label.
- `scripts/bun-test-files.json` — lists the new test files so `bun run test:bun` runs them.

Not touched: validation-time Code Review (`validation-human-review.ts`), the Workspace owner server, Semantic Review,
and `forge-review.ts`, whose mapping already posts `text` with the right scope.

## Reuse Opportunities

- `src/cmd/guided-review/index.ts` and `protocol.ts` — the subprocess shape, usage frames, and metadata frames.
- `review-agent-handlers.js` — `createGuideJob`, `runGuideJob`, the jobs `Map`, SSE broadcast, `withElapsed`,
  `readGuideStderr`, `parseJsonFromModel`, `resolveRunWieldGuideCommand`, and the job metric pattern
  (`recordGuideJobMetric`).
- `parseDiffFiles` (already used by `createGuideJob`) — changed files for placement. Hunk ranges come from the same
  parsed patch.
- `buildGuidedReviewPrompt` (`src/shared/workflow/guided-review.js`) — the rule for reading head files by mode.
- `expandSkill` (`src/shared/session/skill-catalog.ts`) — inlines the `review` skill.
- `src/agent-definitions/recorder.md` — the workflow-only read-only agent pattern.
- `withRuntimeCommandFixture` (`src/cmd/testing/runtime-command-fixture.ts`) and `src/cmd/guided-review/index.test.ts` —
  faux-model command tests.
- `src/ui/workspace/workspace-review.test.js` and `standalone-review-refresh.test.tsx` — route and page test setups.

## Implementation Steps

- `src/shared/standalone-review/ai-review.ts` exports `buildAiReviewPrompt` and `validateAiReviewResult`.
    - `buildAiReviewPrompt({ mode, gitRef, baseLabel, reviewContext, diffText, cwd })` returns a prompt that contains
      the expanded `review` skill text from `expandSkill`, the run rules from Approach (sequential axes, no
      questions, no posting, no edits, the spec ladder without asking, the head-file reading rule), the JSON shape,
      and the diff.
    - `validateAiReviewResult(raw, { rawPatch })` returns either an error or `{ specSource, counts, annotations }`.
      Each annotation has `id`, `type: "comment"`, `scope`, `filePath`, `lineStart`, `lineEnd`, `side`, `text`,
      `author: "AI review"`, `source: "ai-review"`, `severity`, and `createdAt`. Placement follows the rule in Approach:
      line scope only when the range is inside a hunk on the given side; otherwise file scope, then general scope, with
      the cited location kept in `text`.
    - `text` starts with `**<Standards|Spec|Tests> · <blocking|advisory>** — <title>` and keeps `body` in full.
- `wld ai-review` reads a prompt from stdin and runs agent `ai-reviewer` through `SessionRuntime`, as
  `runGuidedReviewCommand` does. It writes usage and metadata frames to stderr in the `protocol.ts` format and the
  final assistant text to stdout. An empty prompt exits 1.
    - `src/cli.ts` dispatches it, and `src/cmd/registry.js` gives it the same consent rule as `guided-review`.
- `src/agent-definitions/ai-reviewer.md` defines a workflow-only agent with `sharedPractice: [user-authority]`, the read
  tools listed in Approach, and `bash` limited by `bashAllowedCommands` to read-only git commands. It has no write,
  edit, question, delegation, or Forge tools. `AGENTS.AI_REVIEWER` is `"ai-reviewer"`. `/agent` does not list it, and
  the agent registry tests still pass with it present.
- `review-agent-handlers.js`:
    - `GET /api/agents/capabilities` reports an `ai-review` provider, available only when
      `state.reviewPayload.standaloneReview` is present.
    - `POST /api/agents/jobs` accepts `provider: "ai-review"` only in Standalone Code Review. It returns 400 elsewhere
      and still returns 400 for unknown providers.
    - The job snapshots `rawPatch` at launch, builds the prompt with `buildAiReviewPrompt`, runs `wld ai-review`
      through the generalized command runner, validates with `validateAiReviewResult`, and records usage, cost, model,
      elapsed time, and a metric event like the guide job.
    - `GET /api/ai-review/:id` returns 202 while running, 422 with the error on failure, and the result on success.
      `DELETE /api/agents/jobs/:id` cancels it.
    - The command runner accepts the subcommand and an override variable. Guided Review keeps
      `RUNWIELD_GUIDED_REVIEW_COMMAND`. AI review uses `RUNWIELD_AI_REVIEW_COMMAND`. Guided Review behavior is unchanged.
- `CodeReviewSurface.tsx`:
    - Shows **Run AI Review** beside the Guided Review control only in Standalone Code Review with the provider
      available. It never auto-starts. Its title discloses the additional LLM call.
    - While running, shows **Cancel** and a status with elapsed time, model, tokens, and cost. There is no fixed client
      deadline.
    - On success, adds the annotations, opens the Annotations sidebar, and shows the per-axis counts and spec source.
      With zero findings, shows that AI review found no issues.
    - On rerun, removes only AI annotations that the owner has not edited. `editAnnotation` marks an AI annotation as
      edited.
    - Drops a result whose launch patch differs from the current patch, and says so in the status.
    - AI annotations are edited, deleted, posted, and sent through the existing paths with no special case.
- `docs/prd/runwield-core-prd.md`, Standalone code review, has a requirement **Draft annotations with AI review** that
  matches the delivered behavior, and acceptance scenarios for: placement on a changed line, file-level fallback,
  posting and sending AI annotations, delete, rerun keeping edited annotations, stale results, no spec, and the button's
  absence in validation-time Code Review.
- `docs/domain-language.md` matches the answer to the open question. With the recommended answer, the **Semantic
  Review** entry says that "Run AI Review" in Standalone Code Review is not Semantic Review, and the **Standalone Code
  Review** entry says that Run AI Review runs the bundled `review` skill and adds its findings as annotations.
- `docs/design-system.md` documents the Run AI Review control in the Guided Review area and the "AI review" author label
  on annotations, using existing toolbar and annotation styles.

## Verification Plan

Automated (focused):

```sh
bun scripts/run-tests.js src/shared/standalone-review/ai-review.test.ts src/cmd/ai-review/index.test.ts src/ui/workspace/workspace-review.test.js src/ui/workspace/standalone-review-refresh.test.tsx src/cmd/guided-review/index.test.ts
bun run seams:check
```

- `src/shared/standalone-review/ai-review.test.ts` (new), against a real multi-file patch:
    - A finding on an added line becomes a line annotation with the right `filePath`, range, and `side: "new"`.
    - A finding on a deleted line keeps `side: "old"`.
    - A finding outside every hunk becomes a file annotation whose text names the line.
    - A finding on an unchanged file becomes a general annotation that names the file.
    - Every annotation has `source: "ai-review"` and text that starts with the axis and severity.
    - Malformed JSON and a wrong `schemaVersion` return an error.
    - The prompt contains the expanded skill text, "never ask", "never post", and the diff.
    - A pass-through that returns raw findings without placement fails the outside-hunk and unchanged-file cases.
- `src/cmd/ai-review/index.test.ts` (new), with `withRuntimeCommandFixture` and a faux model: the command runs agent
  `ai-reviewer`, writes the final text to stdout, writes usage and metadata frames to stderr, and exits 1 on an empty
  prompt.
- Route tests in `workspace-review.test.js`, with `RUNWIELD_AI_REVIEW_COMMAND` pointing to a script that prints fixed
  findings JSON:
    - Standalone payload: capabilities list `ai-review`; the job completes; `GET /api/ai-review/:id` returns placed
      annotations.
    - Validation payload (no `standaloneReview`): capabilities do not list it, and `POST` returns 400.
    - A failing script returns 422 with its error. `DELETE` cancels a running job.
- Page test in `standalone-review-refresh.test.tsx` (or a new sibling):
    - The button renders in standalone mode and not in validation mode.
    - A completed job adds annotations that show the "AI review" author.
    - Rerun keeps an edited AI annotation and the owner's own annotation, and replaces the unedited ones.
    - A result for an older patch adds nothing.
    - **Post comments** sends AI annotation text through `postForgeReview` with its line and side.

Behavior that must still be protected: the Guided Review job, capabilities, usage, and the
`RUNWIELD_GUIDED_REVIEW_COMMAND` override (`workspace-review.test.js`, `guided-review/index.test.ts`); standalone
refresh and annotation clearing (`standalone-review-refresh.test.tsx`); forge posting (`forge-review.test.ts`); and
the standalone review loop (`review-loop.test.ts`). No existing behavior is expected to stop.

Manual:

1. On a branch with a small change, run `wld review`. Expected: **Run AI Review** is beside Guided Review, and nothing
   runs until clicked.
2. Click it. Expected: Cancel appears, then the status shows model, time, tokens, cost, per-axis counts, and the spec
   source. Annotations appear on the diff with the "AI review" author.
3. Edit one, delete one, and click **Send to Engineer**. Expected: Engineer receives the remaining annotations with the
   edited text.
4. Run `wld review <PR URL>` on a test PR and run AI review. Click **Post comments**. Expected: inline comments land on
   the cited lines. File-level and general findings land as file comments and the review body.
5. Click **Run AI Review** again after editing one annotation. Expected: the edited one stays, and unedited AI ones are
   replaced.
6. Start a Plan validation with Code Review enabled. Expected: no Run AI Review button.

PRD and glossary: the Core PRD requirement and scenarios describe exactly what steps 1–6 show, and the glossary
describes Run AI Review without claiming a new Semantic Review capability.

## Edge Cases & Considerations

- **Large patches** — the full patch goes in the prompt, as Guided Review does. A very large patch can exceed the
  context window; the job then fails with the model error, and the owner can still review by hand. Chunking is out of
  scope.
- **The agent tries to post or edit** — it has no Forge CLI, no write tools, and bash allows only read-only git
  commands. The prompt also forbids it.
- **PR head moves during the run** — the stale-result rule drops the result. The existing refresh clears earlier
  annotations.
- **Project overrides the `review` skill** — the catalog lookup uses the project's version. If no `review` skill
  resolves, the job fails with "Unknown skill: review".
- **Authorship on the Forge** — posted comments go out under the owner's account with no AI disclosure line. The owner
  sees and can edit every comment before posting. _Reviewable assumption._
- **Rerun rule** — replacing only unedited AI annotations is a reviewable assumption. The alternative (always append)
  creates duplicates.
- **No code suggestions** — the skill does not produce suggested code, so AI annotations carry no `suggestedCode`.
  _Reviewable assumption._
- **Cost** — the run is always manual and disclosed. Guided Review's `auto` policy does not apply to AI review.
