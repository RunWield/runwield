// @ts-nocheck: Workspace React islands compile TSX, but this module uses JSDoc-style JavaScript only.

import React from "react";
import { ArtifactReadSurface } from "./ArtifactReadSurface.tsx";
import { CodeReviewSurface } from "./CodeReviewSurface.tsx";
import { PlanReviewSurface } from "./PlanReviewSurface.tsx";

const PLAN_FRONT_MATTER = `---
classification: "FEATURE"
complexity: "MEDIUM"
summary: "Fixture test plan for exercising every Plan Review UI interaction"
affectedPaths:
    - "src/ui/workspace/react/PlanReviewSurface.tsx"
    - "src/ui/workspace/react/ReviewDevSurface.tsx"
    - "src/ui/workspace/react/plannotator.css"
executionAgent: "frontend-engineer"
collaborationRecommendation: "autonomous"
devServerCommand: "deno task workspace:dev"
devServerUrl: "http://127.0.0.1:5173/dev"
devServerHmr: true
worktreeBaseBranch: "fixture/plan-review-ui"
createdAt: "2026-07-13T14:00:00.000Z"
status: "draft"
---
`;

/** Shared by the concise and dense samples so both carry the same exact steps. */
const PLAN_STEPS = `## Implementation Steps

- [ ] Step 1: Renaming a Plan appends its old name to \`previousNames\` and leaves the body unchanged.
- [ ] Step 2: \`resolvePlan("old-name")\` returns the renamed Plan when no file matches the old name.
- [ ] Step 3: A Workspace request for an old name redirects to the current Plan URL.
- [ ] Step 4: Two Plans that list the same previous name resolve to neither, and the conflict is reported.
- [ ] Step 5: Plan lists and boards show only current names.
- [ ] Step 6: Plan Review shows the current name after following an old link.
- [ ] Step 7: \`plan-resolver.test.ts\` covers resolution, redirects, and the conflict case.
- [ ] Step 8: The Workspace PRD describes the redirect behavior.
`;

const PLAN_FIXTURE = `${PLAN_FRONT_MATTER}
# Keep Saved Plan Links Working After Rename

## Context

Renaming a Plan changes its file name. Links saved in Sessions, Work Records, and chat history then stop opening it, and
users search for the Plan by hand.

> [!NOTE]
> **The Plan file stays the source of truth**
>
> Do not add a database or a second copy of the Plan. Links resolve from files in \`docs/plans/\`.

## Objective

Old Plan links open the renamed Plan, and new links use the new name.

- A renamed Plan records its previous names in front matter.
- Opening an old name redirects to the current Plan.
- Lists and boards show only the current name.

## Approach

Record each previous name when a rename happens. Check those names only when a link matches no file.

\`\`\`mermaid
flowchart LR
    Open[Open Plan link] --> Match{File exists?}
    Match -->|Yes| Show[Show Plan]
    Match -->|No| Alias{Previous name matches?}
    Alias -->|Yes| Redirect[Redirect to current name]
    Alias -->|No| Missing[Show not found]
\`\`\`

> [!TIP]
> **Store previous names in the Plan itself**
>
> The name history moves with the file through branches, merges, and copies. A separate index would drift.

Set aside: a redirect table in the Workspace server. It fails for links opened from the CLI or another checkout.

## Expected Change Surface

- \`src/shared/plans/plan-rename.ts\` — records the previous name when a Plan is renamed.
- \`src/shared/plans/plan-resolver.ts\` — resolves an unknown name through previous names.
- \`src/ui/workspace/pages/projects/[projectId]/plans/[planId].astro\` — redirects old names to the current URL.
- \`src/ui/workspace/react/PlanReviewSurface.tsx\` — shows the current name after a redirect.

## Reuse Opportunities

- \`src/shared/plans/plan-front-matter.ts\` — reads and writes front matter without changing the body.
- \`third_party/plannotator/packages/ui/utils/parser.ts\` — existing Markdown parsing for the preview.

${PLAN_STEPS}
## Verification Plan

- Automated: \`deno run -A scripts/run-tests.js src/shared/plans/plan-resolver.test.ts\`.
- Manual: Rename a Plan, then open its old link from a Session.
- Expected: The old link opens the renamed Plan, and the address bar shows the new name.
- Headed browser: Open an old link at desktop and phone widths and confirm the redirect.

## Edge Cases & Considerations

> [!WARNING]
> **A new Plan can reuse an old name**
>
> A user renames Plan A to B, then creates a new Plan A. The old link opens the new Plan A, because an existing file
> always wins over a previous name.

- Two renamed Plans can list the same previous name. Report the conflict instead of guessing (Step 4).
- Long names such as \`docs/plans/archived/2026-07-13-keep-saved-plan-links-working-after-rename-and-archive.md\` wrap in lists and headers.

Callout syntax inside a code block stays code:

\`\`\`md
> [!WARNING]
> **This is an example, not a callout**
\`\`\`

> An ordinary quote stays a quote: "I lost the link after I renamed the Plan."
`;

/** The same requirements as PLAN_FIXTURE, written as dense prose without callouts, for readability comparison. */
const DENSE_PLAN_FIXTURE = `${PLAN_FRONT_MATTER}
# Keep Saved Plan Links Working After Rename

## Context

This plan addresses the problem that when a Plan is renamed its file name changes, which means that links that were
previously saved in Sessions, Work Records, and chat history no longer open it, and as a result users have to search for
the Plan by hand. It is important to note that the Plan file must remain the source of truth, so we should not introduce
a database or a second copy of the Plan, and links should continue to resolve from the files in \`docs/plans/\`.

## Objective

The objective is essentially to make sure that old Plan links open the renamed Plan while new links use the new name,
which involves having a renamed Plan record its previous names in its front matter, having the opening of an old name
redirect to the current Plan, and making sure that lists and boards show only the current name.

## Approach

The approach is to record each previous name at the time a rename happens and then, when a link does not match any
file, check those previous names; if a previous name matches, we redirect to the current name, and otherwise we show
not found. We store the previous names in the Plan itself because the name history then moves with the file through
branches, merges, and copies, whereas a separate index would drift over time. We considered a redirect table in the
Workspace server but set it aside because it fails for links opened from the CLI or another checkout.

## Expected Change Surface

The change touches \`src/shared/plans/plan-rename.ts\` to record the previous name when a Plan is renamed,
\`src/shared/plans/plan-resolver.ts\` to resolve an unknown name through previous names,
\`src/ui/workspace/pages/projects/[projectId]/plans/[planId].astro\` to redirect old names to the current URL, and
\`src/ui/workspace/react/PlanReviewSurface.tsx\` to show the current name after a redirect.

## Reuse Opportunities

We can reuse \`src/shared/plans/plan-front-matter.ts\`, which reads and writes front matter without changing the body,
and \`third_party/plannotator/packages/ui/utils/parser.ts\` for the existing Markdown parsing in the preview.

${PLAN_STEPS}
## Verification Plan

- Automated: \`deno run -A scripts/run-tests.js src/shared/plans/plan-resolver.test.ts\`.
- Manual: Rename a Plan, then open its old link from a Session.
- Expected: The old link opens the renamed Plan, and the address bar shows the new name.
- Headed browser: Open an old link at desktop and phone widths and confirm the redirect.

## Edge Cases & Considerations

There are various edge cases to consider. If a user renames Plan A to B and then creates a new Plan A, the old link opens
the new Plan A, because an existing file always wins over a previous name. In addition, two renamed Plans can list the
same previous name, in which case we report the conflict instead of guessing (Step 4), and long names such as
\`docs/plans/archived/2026-07-13-keep-saved-plan-links-working-after-rename-and-archive.md\` need to wrap in lists and
headers.
`;

const INITIAL_PLAN_FIXTURE = DENSE_PLAN_FIXTURE.replace(
    'summary: "Fixture test plan for exercising every Plan Review UI interaction"',
    'summary: "Initial fixture plan before review feedback"',
);

const SECOND_PLAN_FIXTURE = PLAN_FIXTURE
    .replace(
        'summary: "Fixture test plan for exercising every Plan Review UI interaction"',
        'summary: "Second fixture Plan revision after the first review round"',
    )
    .replace(
        "- [ ] Step 6: Plan Review shows the current name after following an old link.",
        "- [ ] Step 6: Verify the redirect in a browser.",
    )
    .replace(
        `> [!WARNING]
> **A new Plan can reuse an old name**
>
> A user renames Plan A to B, then creates a new Plan A. The old link opens the new Plan A, because an existing file
> always wins over a previous name.

`,
        "",
    );

const PLANNER_REVISED_PLAN_FIXTURE = PLAN_FIXTURE
    .replace(
        "- Manual: Rename a Plan, then open its old link from a Session.",
        "- Manual: Rename a Plan twice, then open both old links from a Session.",
    )
    .replace(
        "- Expected: The old link opens the renamed Plan, and the address bar shows the new name.",
        "- Expected: Both old links open the renamed Plan, and the address bar shows the current name.",
    );

const DEV_LINKED_FILES = {
    "src/ui/workspace/react/PlanReviewSurface.tsx": `export function PlanReviewSurface({ payload }) {
    return <main aria-label="Plan review">{payload.plan}</main>;
}
`,
    "src/ui/workspace/react/ReviewDevSurface.tsx": `export const reviewFixture = {
    mode: "dev",
    supportsLinkedFiles: true,
};
`,
    "src/ui/workspace/react/plannotator.css": `.rw-plan-review {
    display: flex;
    min-height: 100dvh;
}
`,
};

const PROJECT_PLAN_FIXTURE = PLAN_FIXTURE
    .replace('classification: "FEATURE"', 'classification: "PROJECT"')
    .replace(
        'summary: "Fixture test plan for exercising every Plan Review UI interaction"',
        'summary: "Fixture PROJECT Epic for exercising approval and Slicer review actions"',
    )
    .replace('executionAgent: "frontend-engineer"\ncollaborationRecommendation: "autonomous"\n', "")
    .replace("# Keep Saved Plan Links Working After Rename", "# Epic: Keep Saved Plan Links Working");

const MARKDOWN_READER_FIXTURE = `---
title: "Markdown reader"
---

# Markdown reader

## Overview

One read-only view for Plans, PRDs, ADRs, Work Records, Epic artifacts, and reports.

## Contents

Use the Contents sidebar to navigate headings. It starts collapsed on phones.

## Progress

- [x] Shared document layout
- [ ] Review the remaining details

## Results

| Entry point | Reader |
| --- | --- |
| Workspace Session | Shared Markdown reader |
| TUI Session | Shared Markdown reader |

## Notes

Opening or closing this document does not approve a Plan or change its contents.

> [!NOTE]
> **Reading never changes the document**
>
> Opening, closing, or printing this report leaves its Markdown unchanged.

> [!TIP]
> **Use Contents on long reports**
>
> Each heading in the Contents sidebar jumps to its section, including on phones.

> [!WARNING]
> **Very long paths wrap instead of widening the page**
>
> \`docs/work-records/2026-09-26-keep-saved-plan-links-working-after-rename-with-a-deliberately-long-file-name.md\`
> stays inside the document column.

> [!CAUTION]
> **Existing caution callouts keep their meaning**
>
> Other artifacts can already use this kind.

> [!IMPORTANT]
> **Existing important callouts stay readable**
>
> This kind uses a neutral color.

> A plain quote remains a plain quote.
`;

const CODE_REVIEW_FIXTURE = `diff --git a/src/review/feedback.js b/src/review/feedback.js
index 1111111..2222222 100644
--- a/src/review/feedback.js
+++ b/src/review/feedback.js
@@ -1,7 +1,16 @@
 export function createFeedback(annotations) {
-    return annotations.map((annotation) => annotation.text).join("\\n");
+    const sections = annotations.map((annotation) => {
+        const location = annotation.filePath
+            ? \`\${annotation.filePath}:\${annotation.lineStart}\`
+            : "Global comment";
+        return \`- \${location}: \${annotation.text}\`;
+    });
+    return sections.join("\\n");
 }
+export function collectImages(annotations) {
+    return annotations.flatMap((annotation) => annotation.images ?? []);
+}
 // Summary helper.
 export function getReviewSummary(count) {
     return count === 1 ? "1 annotation" : \`\${count} annotations\`;
 }
@@ -18,8 +27,14 @@ export function getReviewSummary(count) {
-export async function submitFeedback(client, annotations) {
+export async function submitFeedback(client, annotations, approved = false) {
     const feedback = createFeedback(annotations);
-    return client.post("/feedback", { feedback });
+    const images = collectImages(annotations);
+    return client.post("/feedback", {
+        annotations,
+        approved,
+        feedback,
+        images,
+    });
 }
 // Approval helper.
-export function canApprove(annotations) {
-    return annotations.length === 0;
+export function canApprove() {
+    return true;
 }
diff --git a/src/review/feedback.test.js b/src/review/feedback.test.js
index 3333333..4444444 100644
--- a/src/review/feedback.test.js
+++ b/src/review/feedback.test.js
@@ -1,8 +1,30 @@
 import { assertEquals } from "@std/assert";
-import { createFeedback } from "./feedback.js";
+import { canApprove, collectImages, createFeedback } from "./feedback.js";
 // Review feedback tests.
-Deno.test("createFeedback joins comments", () => {
-    const result = createFeedback([{ text: "Rename this" }, { text: "Add a test" }]);
-    assertEquals(result, "Rename this\\nAdd a test");
+Deno.test("createFeedback includes inline locations", () => {
+    const result = createFeedback([{
+        filePath: "src/review/feedback.js",
+        lineStart: 12,
+        text: "Rename this",
+    }]);
+    assertEquals(result, "- src/review/feedback.js:12: Rename this");
+});
+
+Deno.test("createFeedback identifies global comments", () => {
+    const result = createFeedback([{ text: "Add a test" }]);
+    assertEquals(result, "- Global comment: Add a test");
+});
+
+Deno.test("collectImages preserves every attachment", () => {
+    const images = collectImages([
+        { images: [{ name: "first.png", path: "/tmp/first.png" }] },
+        { images: [{ name: "second.jpg", path: "/tmp/second.jpg" }] },
+    ]);
+    assertEquals(images.map((image) => image.name), ["first.png", "second.jpg"]);
+});
+
+Deno.test("approval is always available", () => {
+    assertEquals(canApprove(), true);
 });
diff --git a/src/review/image-attachments.js b/src/review/image-attachments.js
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/src/review/image-attachments.js
@@ -0,0 +1,16 @@
+const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
+
+export async function loadReviewImage(image) {
+    const bytes = await Deno.readFile(image.path);
+    if (bytes.byteLength > MAX_IMAGE_BYTES) {
+        throw new Error(\`Image exceeds \${MAX_IMAGE_BYTES} bytes\`);
+    }
+
+    return {
+        data: bytes,
+        mimeType: image.mimeType ?? "image/png",
+        name: image.name,
+        path: image.path,
+    };
+}
diff --git a/src/ui/review.css b/src/ui/review.css
index 6666666..7777777 100644
--- a/src/ui/review.css
+++ b/src/ui/review.css
@@ -1,8 +1,12 @@
 .review-layout {
     display: grid;
-    grid-template-columns: 16rem 1fr 20rem;
-    gap: 1rem;
+    grid-template-columns: 18rem minmax(0, 1fr) 22rem;
+    gap: 0;
+    min-height: 0;
 }
 /* Review toolbar. */
 .review-toolbar {
+    position: sticky;
+    top: 0;
+    z-index: 10;
     border-bottom: 1px solid var(--rw-border);
@@ -18,8 +22,12 @@
 .review-plan {
     max-width: 52rem;
-    margin: 0;
+    margin: 1rem auto 0;
+    padding: 0 1rem 4rem;
 }
 /* Right annotations rail. */
 .review-sidebar {
-    right: 1rem;
+    align-self: stretch;
+    justify-self: stretch;
+    margin: 0;
+    right: 0;
 }
diff --git a/src/review/text-labels.js b/src/review/annotation-labels.js
similarity index 72%
rename from src/review/text-labels.js
rename to src/review/annotation-labels.js
index 8888888..9999999 100644
--- a/src/review/text-labels.js
+++ b/src/review/annotation-labels.js
@@ -1,4 +1,8 @@
 export const labels = [
     "comment",
+    "issue",
+    "nitpick",
+    "praise",
+    "question",
     "suggestion",
 ];
diff --git a/src/review/legacy-dialog.js b/src/review/legacy-dialog.js
deleted file mode 100644
index aaaaaaa..0000000
--- a/src/review/legacy-dialog.js
+++ /dev/null
@@ -1,7 +0,0 @@
-export function openApprovalDialog() {
-    return {
-        requiresComment: true,
-        showCloseButton: true,
-        showDecisionDropdown: true,
-    };
-}
diff --git a/docs/code-review-fixture.md b/docs/code-review-fixture.md
index bbbbbbb..ccccccc 100644
--- a/docs/code-review-fixture.md
+++ b/docs/code-review-fixture.md
@@ -1,7 +1,15 @@
 # Code review fixture
 <!-- Fixture purpose. -->
-This fixture covers one modified JavaScript file.
+This fixture covers a representative review across several kinds of changes.
 <!-- Fixture checklist. -->
-Use it to confirm that the diff renders.
+Verify the following interactions:
+
+- Browse committed, staged, unstaged, and untracked changes.
+- Switch between the Changes list and Files tree.
+- Add inline comments on additions and deletions.
+- Add a global comment with an annotated image.
+- Change diff display settings.
+- Send every annotation with feedback or approval.
 <!-- Fixture safety note. -->
 The fixture never submits to a running agent.
diff --git a/src/review/fixture-config.js b/src/review/fixture-config.js
new file mode 100644
index 0000000..ddddddd
--- /dev/null
+++ b/src/review/fixture-config.js
@@ -0,0 +1,12 @@
+export const fixtureConfig = {
+    title: "Fixture Code Review",
+    annotations: ["inline", "global", "image"],
+    decisionActions: ["feedback", "approve"],
+    diffStyles: ["split", "unified"],
+    fileStates: ["committed", "staged", "unstaged", "untracked"],
+    layout: "edge-aligned",
+    settings: ["general", "display", "labels", "shortcuts"],
+    theme: "runwield",
+};
diff --git a/src/ui/components/ReviewBadge.tsx b/src/ui/components/ReviewBadge.tsx
new file mode 100644
index 0000000..eeeeeee
--- /dev/null
+++ b/src/ui/components/ReviewBadge.tsx
@@ -0,0 +1,18 @@
+import React from "react";
+
+type ReviewBadgeProps = {
+    label: string;
+    count: number;
+    active: boolean;
+};
+
+export function ReviewBadge({ label, count, active }: ReviewBadgeProps) {
+    return (
+        <span className={active ? "review-badge active" : "review-badge"}>
+            <strong>{label}</strong>
+            <small>{count} open</small>
+        </span>
+    );
+}
+
diff --git a/src/ui/components/ReviewAction.jsx b/src/ui/components/ReviewAction.jsx
new file mode 100644
index 0000000..fffffff
--- /dev/null
+++ b/src/ui/components/ReviewAction.jsx
@@ -0,0 +1,17 @@
+import React from "react";
+
+export function ReviewAction({ children, disabled, onClick }) {
+    return (
+        <button
+            className="review-action"
+            disabled={disabled}
+            onClick={onClick}
+            type="button"
+        >
+            <span className="review-action-icon" aria-hidden="true">✓</span>
+            {children}
+        </button>
+    );
+}
+
diff --git a/src/review/ReviewSummary.java b/src/review/ReviewSummary.java
new file mode 100644
index 0000000..123abcd
--- /dev/null
+++ b/src/review/ReviewSummary.java
@@ -0,0 +1,14 @@
+package review;
+
+import java.util.List;
+
+public final class ReviewSummary {
+    public static String describe(List<String> labels) {
+        if (labels.isEmpty()) {
+            return "No annotations";
+        }
+        return String.join(", ", labels);
+    }
+}
diff --git a/src/review/review_summary.cpp b/src/review/review_summary.cpp
new file mode 100644
index 0000000..456abcd
--- /dev/null
+++ b/src/review/review_summary.cpp
@@ -0,0 +1,15 @@
+#include <string>
+#include <vector>
+
+std::string describe_review(const std::vector<std::string>& labels) {
+    if (labels.empty()) {
+        return "No annotations";
+    }
+
+    std::string output = labels.front();
+    for (size_t index = 1; index < labels.size(); ++index) {
+        output += ", " + labels[index];
+    }
+    return output;
+}
`;

const GUIDED_REVIEW_FIXTURE = {
    schemaVersion: "1.0",
    title: "Review feedback flow explainer",
    intent:
        "Review feedback previously flattened annotations into text, losing their context. This change preserves inline locations, approval state, and images through the feedback handoff.",
    sections: [
        {
            title: "Core implementation",
            role: "core",
            blocks: [
                {
                    type: "prose",
                    markdown:
                        "The **feedback path** now preserves richer annotation context in `createFeedback` instead of flattening comments into unstructured text.",
                },
                {
                    type: "callout",
                    tone: "review",
                    title: "Review focus",
                    markdown: "Check that image attachments and approval state survive the feedback handoff.",
                },
                {
                    type: "mermaid",
                    title: "Feedback data flow",
                    description: "How annotations move into the review payload.",
                    source:
                        "flowchart TD\n    A[Annotations] --> B[createFeedback]\n    A --> C[collectImages]\n    B --> D[submitFeedback payload]\n    C --> D",
                },
                {
                    type: "diff",
                    file: "src/review/feedback.js",
                    summary:
                        "Core payload construction now includes annotations, approval state, feedback text, and images.",
                },
            ],
        },
        {
            title: "Consequences and visual check",
            role: "ui_behavior",
            blocks: [
                {
                    type: "prose",
                    markdown:
                        "The review UI layout shifts to a more edge-aligned surface, so a quick visual model helps explain the changed spatial relationship.",
                },
                {
                    type: "widget",
                    id: "layout-widget",
                    entry: "index.html",
                    title: "Toolbar layout sandbox",
                    reason: "A tiny local-only widget demonstrates why the sticky toolbar needs more breathing room.",
                    html:
                        '<!doctype html><link rel="stylesheet" href="widget.css"><section class="demo"><button id="toggle">Toggle cramped state</button><div id="panel">Toolbar has room for review actions.</div></section><script src="widget.js"></script>',
                    assets: [
                        {
                            name: "widget.css",
                            contentType: "text/css",
                            content:
                                ".demo{font:14px system-ui;padding:16px;color:#e2e8f0;background:#0f172a}.demo.cramped #panel{max-width:140px;color:#fecaca}button{border:1px solid #38bdf8;background:#082f49;color:#e0f2fe;border-radius:8px;padding:8px}",
                        },
                        {
                            name: "widget.js",
                            contentType: "application/javascript",
                            content:
                                "document.getElementById('toggle').addEventListener('click',()=>document.querySelector('.demo').classList.toggle('cramped'));",
                        },
                    ],
                },
                {
                    type: "diff",
                    file: "src/ui/review.css",
                    summary: "Layout columns and sticky toolbar behavior changed.",
                },
            ],
        },
        {
            title: "Support tests",
            role: "support",
            blocks: [
                {
                    type: "reviewCheckpoint",
                    markdown:
                        "Confirm tests cover inline locations, global comments, image preservation, and approval availability.",
                },
                {
                    type: "diff",
                    file: "src/review/feedback.test.js",
                    summary: "Regression tests for the new feedback payload shape.",
                },
                {
                    type: "diff",
                    file: "src/ui/components/ReviewBadge.tsx",
                    summary: "TSX fixture verifies React TypeScript highlighting in guided blocks.",
                },
                {
                    type: "diff",
                    file: "src/ui/components/ReviewAction.jsx",
                    summary: "JSX fixture verifies JavaScript React highlighting in guided blocks.",
                },
                {
                    type: "diff",
                    file: "src/review/ReviewSummary.java",
                    summary: "Java fixture verifies a real lazy-loaded language outside the old preload set.",
                },
                {
                    type: "diff",
                    file: "src/review/review_summary.cpp",
                    summary: "C++ fixture verifies another real lazy-loaded language outside the old preload set.",
                },
            ],
        },
    ],
    everythingElse: [
        { file: "src/review/image-attachments.js" },
        { file: "docs/code-review-fixture.md" },
    ],
    widgetAssets: [],
};

const GUIDE_DEV_VARIANTS = [
    { id: "ready", label: "Ready explainer + widget" },
    { id: "pending-usage", label: "Running + usage pending" },
    { id: "reported-usage", label: "Completed + reported usage" },
    { id: "no-provider", label: "No provider available" },
    { id: "failed", label: "Failed generation" },
    { id: "long-title", label: "Long title" },
];

const PLAN_DEV_VARIANTS = [
    "feature",
    "dense",
    "project",
    "sequence",
    "stale",
    "read-only",
];

function buildCodeReviewDevPayload(variant) {
    const base = {
        rawPatch: CODE_REVIEW_FIXTURE,
        agentConversation: {
            revisedRawPatch: CODE_REVIEW_FIXTURE.replace('+    "issue",', '+    "problem",'),
            reply: "I renamed the issue label to problem. The current diff is ready in this review.",
        },
        gitRef: "Fixture Code Review",
        agentCwd: "workspace-dev/fixture-code-review",
        planName: "fixture-code-review",
        planTitle: variant === "long-title"
            ? "Review a Very Long Code Review Plan Title That Must Stay Readable Without Pushing Approval Controls Out of the Toolbar"
            : "Fixture Code Review Plan",
        token: `dev-code-review-${variant}`,
        mode: "dev",
        guidedReview: { mode: "auto", autoStart: false, manualAvailable: true, reasons: ["dev fixture"] },
        reviewStatus: {
            stagedFiles: ["src/review/feedback.test.js", "src/review/image-attachments.js"],
            unstagedFiles: [
                "docs/code-review-fixture.md",
                "src/review/feedback.js",
                "src/ui/review.css",
            ],
            untrackedFiles: [
                "src/review/fixture-config.js",
                "src/ui/components/ReviewBadge.tsx",
                "src/ui/components/ReviewAction.jsx",
                "src/review/ReviewSummary.java",
                "src/review/review_summary.cpp",
            ],
        },
    };
    if (variant === "no-provider") {
        return {
            ...base,
            guidedReview: { ...base.guidedReview, reasons: ["dev fixture: no provider"] },
            devGuideCapabilities: { available: false, providers: [] },
        };
    }
    if (variant === "failed") {
        return {
            ...base,
            guidedReview: { ...base.guidedReview, reasons: ["dev fixture: failed generation"] },
            devGuideCapabilities: {
                available: true,
                providers: [{ id: "guide", provider: "fixture", model: "failure" }],
            },
            devGuideFailure: "Fixture provider failed while generating the Guided Review Explainer.",
        };
    }
    if (variant === "pending-usage") {
        return {
            ...base,
            devGuideCapabilities: {
                available: true,
                providers: [{ id: "guide", provider: "fixture", model: "pending" }],
            },
            devGuideJob: {
                id: "dev-guide-pending",
                provider: "guide",
                status: "running",
                engine: "wld",
                model: "wld",
                elapsedMs: 4200,
                usageState: "pending",
                tokens: null,
                cost: null,
            },
        };
    }
    if (variant === "reported-usage") {
        return {
            ...base,
            devGuideCapabilities: {
                available: true,
                providers: [{ id: "guide", provider: "fixture", model: "reported" }],
            },
            guidedReviewFixture: GUIDED_REVIEW_FIXTURE,
            devGuideJob: {
                id: "dev-guide-reported",
                provider: "guide",
                status: "done",
                engine: "wld",
                model: "wld",
                elapsedMs: 9800,
                usageState: "available",
                tokens: {
                    inputTokens: 1240,
                    outputTokens: 250,
                    cacheReadTokens: 800,
                    cacheWriteTokens: 0,
                    costUsd: 0.125,
                },
                cost: { usd: 0.125 },
            },
            devGuideJobDone: {
                id: "dev-guide-reported",
                provider: "guide",
                status: "done",
                engine: "wld",
                model: "wld",
                usageState: "available",
                tokens: {
                    inputTokens: 1240,
                    outputTokens: 250,
                    cacheReadTokens: 800,
                    cacheWriteTokens: 0,
                    costUsd: 0.125,
                },
                cost: { usd: 0.125 },
            },
        };
    }
    return {
        ...base,
        devGuideCapabilities: { available: true, providers: [{ id: "guide", provider: "fixture", model: "ready" }] },
        guidedReviewFixture: GUIDED_REVIEW_FIXTURE,
        devGuideJob: {
            id: "dev-guide",
            status: "done",
            providerName: "fixture",
            model: "dev-fixture",
            thinkingLevel: "high",
        },
    };
}

export function ReviewDevSurface({ surface, presentation = "standalone", variant = "feature", returnHref = "" }) {
    const isPlan = surface === "plan";
    const [guideVariant, setGuideVariant] = React.useState("ready");
    const planVariant = PLAN_DEV_VARIANTS.includes(variant) ? variant : "feature";
    const planNotice = planVariant === "stale"
        ? {
            state: "stale",
            title: "Refresh Plan required",
            message: "The Plan changed while this review was open. Refresh the Plan before you submit a new decision.",
            actionLabel: "Refresh Plan",
            actionHref: "/dev/plan-review",
        }
        : null;
    const planPayload = planVariant === "project"
        ? {
            plan: PROJECT_PLAN_FIXTURE,
            token: `dev-plan-review-${planVariant}`,
            mode: "dev",
            agentLabel: "Architect",
            classification: "PROJECT",
            frontmatter: { classification: "PROJECT" },
            plannerConversation: {
                enabled: true,
                revisedPlan: PROJECT_PLAN_FIXTURE.replace(
                    "Old Plan links open the renamed Plan, and new links use the new name.",
                    "Old Plan links open the renamed Plan, and the Epic identifies which saved links need checking.",
                ),
                reply: "I clarified the saved-link checks in the Epic.",
            },
            reviewNotice: planNotice,
        }
        : {
            plan: planVariant === "dense" ? DENSE_PLAN_FIXTURE : PLAN_FIXTURE,
            previousPlan: SECOND_PLAN_FIXTURE,
            planVersions: [
                { plan: INITIAL_PLAN_FIXTURE, timestamp: "2026-07-13T14:00:00.000Z" },
                { plan: SECOND_PLAN_FIXTURE, timestamp: "2026-07-13T15:00:00.000Z" },
                { plan: PLAN_FIXTURE, timestamp: "2026-07-13T16:00:00.000Z" },
            ],
            linkedFiles: DEV_LINKED_FILES,
            token: `dev-plan-review-${planVariant}`,
            mode: "dev",
            agentLabel: "Planner",
            classification: "FEATURE",
            frontmatter: {
                classification: "FEATURE",
                executionAgent: "frontend-engineer",
                collaborationRecommendation: "autonomous",
            },
            executionPolicy: {
                executionAgent: "frontend-engineer",
                collaborationRecommendation: "autonomous",
                source: "canonical",
            },
            reviewContext: {
                projectLabel: "Personal Remote Workspace",
                sessionLabel: "Planner Session",
                sessionHref: "/projects/dev/sessions/planner-fixture",
                planLabel: "Keep Saved Plan Links Working After Rename",
                actingSession: "Planner Session",
                planStatus: "draft",
                live: true,
            },
            plannerConversation: {
                enabled: true,
                revisedPlan: PLANNER_REVISED_PLAN_FIXTURE,
                reply: "I made the manual check cover a Plan that was renamed twice.",
            },
            reviewNotice: planNotice,
        };
    if (planVariant === "sequence") {
        planPayload.sequenceDocuments = [
            {
                planId: "sequence-demo",
                planName: "review-improvements",
                planPath: "review-improvements.md",
                plan:
                    "# Review improvements\n\n## Context\n\nKeep related changes together.\n\n## Objective\n\nImprove review in two ordered Plans.\n\n## Children\n\n1. Build review controls.\n2. Connect feedback after the controls are ready.",
                frontmatter: { classification: "PROJECT", type: "sequence" },
            },
            {
                planId: "controls-demo",
                planName: "review-improvements/controls",
                planPath: "controls.md",
                plan: PLAN_FIXTURE,
                frontmatter: {
                    classification: "PLANNED_CHANGE",
                    executionAgent: "frontend-engineer",
                    collaborationRecommendation: "autonomous",
                },
            },
            {
                planId: "feedback-demo",
                planName: "review-improvements/feedback",
                planPath: "feedback.md",
                plan: SECOND_PLAN_FIXTURE,
                frontmatter: {
                    classification: "PLANNED_CHANGE",
                    executionAgent: "engineer",
                    collaborationRecommendation: "pair",
                },
            },
        ];
        delete planPayload.executionPolicy;
    }
    const readPayload = planVariant === "read-only" && {
        surface: "artifact-read",
        markdown: MARKDOWN_READER_FIXTURE,
        token: "dev-markdown-reader",
        returnHref,
        mode: "dev",
        artifactKind: "report",
        title: "Markdown reader",
        artifactPath: "docs/markdown-reader.md",
        notices: [],
    };
    const codePayload = buildCodeReviewDevPayload(guideVariant);
    const payload = isPlan ? planPayload : {
        ...codePayload,
        ...(presentation === "workspace" && {
            reviewContext: {
                projectLabel: "RunWield Dev Project",
                sessionHref: "/projects/dev-project/sessions/choose-terraform-folder-name",
                sessionLabel: "Choose Terraform folder name",
                actingSession: "Choose Terraform folder name",
                artifactLabel: codePayload.planTitle,
                statusLabel: "Human code review",
                live: true,
            },
        }),
    };

    if (isPlan) {
        return React.createElement(
            React.Fragment,
            null,
            readPayload
                ? React.createElement(ArtifactReadSurface, { key: planVariant, payload: readPayload })
                : React.createElement(PlanReviewSurface, {
                    key: planVariant,
                    payload,
                    presentation,
                }),
        );
    }

    return React.createElement(
        React.Fragment,
        null,
        React.createElement(
            "nav",
            { className: "rw-dev-fixture-switcher", "aria-label": "Guided Review dev fixtures" },
            GUIDE_DEV_VARIANTS.map((variant) =>
                React.createElement(
                    "button",
                    {
                        key: variant.id,
                        type: "button",
                        className: guideVariant === variant.id ? "active" : "",
                        onClick: () => setGuideVariant(variant.id),
                    },
                    variant.label,
                )
            ),
        ),
        React.createElement(CodeReviewSurface, { key: guideVariant, payload, presentation }),
    );
}
