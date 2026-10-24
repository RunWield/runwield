diffstat only, patch not produced. Full patch: git show -p <rev>
---

planId: "fd55996c-a04a-45b8-bc67-b24df82af0e2"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths: - "src/ui/workspace/react/CodeReviewSurface.tsx" - "src/ui/workspace/routes/api/review-agent-handlers.js" - "src/shared/standalone-review/ai-review.ts" - "src/cmd/ai-review/index.ts" - "src/cmd/guided-review/protocol.ts" - "src/cli.ts" - "src/cmd/registry.js" - "src/agent-definitions/ai-reviewer.md" - "src/constants.js" - "src/skills/review/SKILL.md" - "docs/prd/runwield-core-prd.md" - "docs/domain-language.md" - "docs/design-system.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-19"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
sessionName: "Guided Review Annotations"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "b26023d01b8d9465cfccced8c15181241ef96638"
workRecord:
status: "generated"
recordId: "6127923c-9c2f-4fa3-8e58-eca6e7dcc09b"
path: "docs/work-records/2026-10-21-ai-drafted-annotations-in-standalone-code-review.md"
lastAttemptAt: "2026-10-21T16:09:47.355Z"
status: "verified"
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
  ... more lines (truncated by snip)
