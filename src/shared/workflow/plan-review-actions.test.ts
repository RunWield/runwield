import { readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    getPlanRevisionForText,
    getStoredPlanPath,
    injectFrontMatter,
    loadPlan,
    parsePlanFrontMatter,
    savePlan,
} from "../../plan-store.js";
import { addEntry as addRegistryEntry, findById as findRegistryEntryById } from "../worktree-registry.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { applySharedPlanReviewDecision, reviewSourceStillMatches } from "./plan-review-actions.ts";
import type { PlanFrontMatter } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { startActiveExecutionWorkflow } from "./workflow.js";
import { createExecutionStartPorts } from "./execution-start.ts";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { listEntries, updateEntry } from "../worktree-registry.js";
import { findReusableWorktree } from "../worktree.js";

interface PlanReviewFixture {
    dir: string;
    planPath: string;
    attrs: PlanFrontMatter;
    markdown: string;
    revision: string;
}

const gitFixture = defineCommittedGitFixture({ ".gitignore": ".wld/\nwt-prior/\n" });

async function makePlanFile(attrs: Partial<PlanFrontMatter> = {}): Promise<PlanReviewFixture> {
    const dir = await gitFixture.checkout();
    await savePlan(dir, "plan", "# Plan\n\nDo the thing.\n", {
        classification: "PLANNED_CHANGE",
        status: "draft",
        summary: "Do the thing",
        affectedPaths: [],
        ...attrs,
    });
    const planPath = getStoredPlanPath(dir, "plan");
    const markdown = await fsReadFile(planPath, "utf8");
    return {
        dir,
        planPath,
        markdown,
        attrs: parsePlanFrontMatter(markdown).attrs,
        revision: await getPlanRevisionForText(markdown),
    };
}

async function addActiveWorktree(dir: string): Promise<string> {
    await git(dir, ["add", "docs"]);
    await git(dir, ["commit", "-m", "Save review Plan"]);
    const path = join(dir, "wt-prior");
    await git(dir, ["worktree", "add", "-b", "worktree/plan", path]);
    await addRegistryEntry(dir, {
        id: "wt-prior",
        planName: "plan",
        planId: "plan-id",
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit: await git(dir, ["rev-parse", "HEAD"]),
        baseTree: await git(dir, ["rev-parse", "HEAD^{tree}"]),
        branch: "worktree/plan",
        path,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    });
    return path;
}

for (
    const { status, reopenFirst } of [
        { status: "implemented", reopenFirst: false },
        { status: "implemented", reopenFirst: true },
        { status: "in_progress", reopenFirst: false },
        { status: "in_progress", reopenFirst: true },
    ] as const
) {
    test(`reapproval reuses ${status} commits and dirty files (reopen first: ${reopenFirst})`, async () => {
        const fixture = await makePlanFile({
            status,
            planId: "plan-id",
            executionMode: "worktree",
            executionAgent: "engineer",
            targetBranch: "main",
        });
        const executionDir = await addActiveWorktree(fixture.dir);
        const hostedSession = new HostedSession({ id: "reapproval", cwd: fixture.dir });
        try {
            await fsWriteFile(join(executionDir, "implementation.ts"), "export const done = true;\n");
            await git(executionDir, ["add", "implementation.ts"]);
            await git(executionDir, ["commit", "-m", "First implementation"]);
            const implementationCommit = await git(executionDir, ["rev-parse", "HEAD"]);
            await fsWriteFile(join(executionDir, "implementation.ts"), "export const done = 'repair';\n");
            await fsWriteFile(join(executionDir, "pending.ts"), "// untracked repair\n");
            await fsWriteFile(join(executionDir, "staged.ts"), "// staged repair\n");
            await git(executionDir, ["add", "staged.ts"]);
            const stagedDiff = await git(executionDir, ["diff", "--cached"]);
            await updateEntry(fixture.dir, "wt-prior", { status: "completed" });
            const primaryBytes = await fsReadFile(fixture.planPath, "utf8");
            if (reopenFirst) {
                await recordPlanEvent({
                    cwd: fixture.dir,
                    planName: "plan",
                    event: "review_reopened",
                    currentStatus: status,
                });
            }
            const reviewed = await loadPlan(executionDir, "plan");
            assert(reviewed);
            const revision = reviewed.markdown.replace(
                "Do the thing.",
                "Continue the existing implementation and fix review findings.",
            );
            const result = await applySharedPlanReviewDecision({
                cwd: fixture.dir,
                planName: "plan",
                planPath: reviewed.path,
                planWithFrontMatter: reviewed.markdown,
                planRevision: reviewed.revision,
                originalAttrs: reviewed.attrs,
                trustedClassification: "PLANNED_CHANGE",
                decision: {
                    approved: true,
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    plan: revision,
                },
            });
            assertEquals(result.approved, true);
            assertEquals((await findRegistryEntryById(fixture.dir, "wt-prior"))?.status, "completed");
            await recordPlanEvent({
                cwd: fixture.dir,
                planName: "plan",
                event: "readiness_passed",
                currentStatus: "approved",
            });
            const approved = await loadPlan(executionDir, "plan");
            assert(approved);
            const workflow = await startActiveExecutionWorkflow({
                planName: "plan",
                triageMeta: approved.attrs,
                currentStatus: "ready_for_work",
                hostedSession,
                ports: createExecutionStartPorts(),
            });
            assertEquals(workflow.worktreeId, "wt-prior");
            assertEquals(workflow.executionCwd, executionDir);
            assertEquals((await listEntries(fixture.dir)).length, 1);
            assertEquals(await git(executionDir, ["rev-parse", "HEAD"]), implementationCommit);
            assertEquals(
                await fsReadFile(join(executionDir, "implementation.ts"), "utf8"),
                "export const done = 'repair';\n",
            );
            assertEquals(await fsReadFile(join(executionDir, "pending.ts"), "utf8"), "// untracked repair\n");
            assertEquals(await git(executionDir, ["diff", "--cached"]), stagedDiff);
            assertStringIncludes(
                (await loadPlan(executionDir, "plan"))?.body || "",
                "Continue the existing implementation",
            );
            assertEquals(await fsReadFile(fixture.planPath, "utf8"), primaryBytes);
            await updateEntry(fixture.dir, "wt-prior", { status: "abandoned" });
            assertEquals(
                await findReusableWorktree({ projectRoot: fixture.dir, planName: "plan", planId: "plan-id" }),
                null,
            );
            assertEquals(await fsReadFile(join(executionDir, "pending.ts"), "utf8"), "// untracked repair\n");
        } finally {
            hostedSession.dispose();
            await fsRm(fixture.dir, { recursive: true });
        }
    });
}

test("shared Plan review rejects stale revision status and worktree before mutation", async () => {
    const fixture = await makePlanFile({
        status: "ready_for_work",
        planId: "plan-id",
        worktreeId: "wt-prior",
        worktreeStatus: "completed",
    });
    const executionDir = await addActiveWorktree(fixture.dir);
    const executionPlanPath = getStoredPlanPath(executionDir, "plan");
    try {
        const currentPlan = injectFrontMatter(fixture.markdown, { status: "feedback", worktreeId: "other" });
        await fsWriteFile(executionPlanPath, currentPlan);

        const result = await applySharedPlanReviewDecision({
            cwd: fixture.dir,
            planName: "plan",
            planPath: executionPlanPath,
            planWithFrontMatter: fixture.markdown,
            planRevision: fixture.revision,
            originalAttrs: fixture.attrs,
            trustedClassification: "PLANNED_CHANGE",
            decision: {
                approved: true,
                feedback: "run it",
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        });

        assertEquals(result.cancellationReason, "stale_plan_review");
        assertEquals((await loadPlan(executionDir, "plan"))?.attrs.status, "feedback");
        assertEquals((await loadPlan(executionDir, "plan"))?.attrs.worktreeId, "wt-prior");
        assertEquals(await fsReadFile(executionPlanPath, "utf8"), currentPlan);
        assertEquals(await fsReadFile(fixture.planPath, "utf8"), fixture.markdown);
        assertEquals((await findRegistryEntryById(fixture.dir, "wt-prior"))?.status, "active");
    } finally {
        await fsRm(fixture.dir, { recursive: true });
    }
});

test("shared Plan review automatically applies an old primary review to the current workflow Plan", async () => {
    const fixture = await makePlanFile({
        status: "ready_for_work",
        planId: "plan-id",
        worktreeId: "wt-prior",
        worktreeStatus: "active",
    });
    const executionDir = await addActiveWorktree(fixture.dir);
    try {
        const result = await applySharedPlanReviewDecision({
            cwd: fixture.dir,
            planName: "plan",
            planPath: fixture.planPath,
            planWithFrontMatter: fixture.markdown,
            planRevision: fixture.revision,
            originalAttrs: fixture.attrs,
            trustedClassification: "PLANNED_CHANGE",
            decision: {
                approved: true,
                feedback: "run it",
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        });

        assertEquals(result.approved, true);
        assertEquals(result.cancellationReason, undefined);
        assertEquals((await loadPlan(executionDir, "plan"))?.attrs.status, "approved");
        assertEquals((await loadPlan(fixture.dir, "plan"))?.attrs.status, "ready_for_work");
    } finally {
        await fsRm(fixture.dir, { recursive: true });
    }
});

test("shared Plan review still rejects an old primary review when the current workflow Plan changed", async () => {
    const fixture = await makePlanFile({
        status: "ready_for_work",
        planId: "plan-id",
        worktreeId: "wt-prior",
        worktreeStatus: "active",
    });
    const executionDir = await addActiveWorktree(fixture.dir);
    try {
        const executionPlanPath = getStoredPlanPath(executionDir, "plan");
        await fsWriteFile(executionPlanPath, fixture.markdown.replace("Do the thing.", "Do another thing."));

        const result = await applySharedPlanReviewDecision({
            cwd: fixture.dir,
            planName: "plan",
            planPath: fixture.planPath,
            planWithFrontMatter: fixture.markdown,
            planRevision: fixture.revision,
            originalAttrs: fixture.attrs,
            trustedClassification: "PLANNED_CHANGE",
            decision: {
                approved: true,
                feedback: "run it",
                approvalAction: "run",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        });

        assertEquals(result.cancellationReason, "stale_plan_review");
        assertStringIncludes(result.feedback || "", "Reload this review");
        assertEquals((result.feedback || "").includes("execution Plan"), false);
        assertEquals((result.feedback || "").includes("editable copy"), false);
    } finally {
        await fsRm(fixture.dir, { recursive: true });
    }
});

test("shared Plan review approval accepts every execution policy combination", async () => {
    const combinations = [
        { executionAgent: "engineer", collaborationRecommendation: "autonomous" },
        { executionAgent: "engineer", collaborationRecommendation: "pair" },
        { executionAgent: "frontend-engineer", collaborationRecommendation: "autonomous" },
        { executionAgent: "frontend-engineer", collaborationRecommendation: "pair" },
    ] as const;

    for (const combination of combinations) {
        const fixture = await makePlanFile();
        try {
            const result = await applySharedPlanReviewDecision({
                cwd: fixture.dir,
                planName: "plan",
                planPath: fixture.planPath,
                planWithFrontMatter: fixture.markdown,
                planRevision: fixture.revision,
                originalAttrs: fixture.attrs,
                trustedClassification: "PLANNED_CHANGE",
                decision: {
                    approved: true,
                    approvalAction: "run",
                    executionAgent: combination.executionAgent,
                    collaborationRecommendation: combination.collaborationRecommendation,
                },
            });
            const attrs = (await loadPlan(fixture.dir, "plan"))?.attrs;

            assertEquals(result.approved, true);
            assertEquals(result.planAttrs?.executionAgent, combination.executionAgent);
            assertEquals(result.planAttrs?.collaborationRecommendation, combination.collaborationRecommendation);
            assertEquals(attrs?.executionAgent, combination.executionAgent);
            assertEquals(attrs?.collaborationRecommendation, combination.collaborationRecommendation);
        } finally {
            await fsRm(fixture.dir, { recursive: true });
        }
    }
});

test("shared Plan review commits edited Feedback and approval notes with classification-correct outcomes", async () => {
    const feedbackFixture = await makePlanFile();
    const approvalFixture = await makePlanFile({ classification: "PROJECT" });
    try {
        const feedback = await applySharedPlanReviewDecision({
            cwd: feedbackFixture.dir,
            planName: "plan",
            planPath: feedbackFixture.planPath,
            planWithFrontMatter: feedbackFixture.markdown,
            planRevision: feedbackFixture.revision,
            originalAttrs: feedbackFixture.attrs,
            trustedClassification: "PLANNED_CHANGE",
            decision: {
                approved: false,
                feedback: "Keep the note.",
                plan:
                    `---\nclassification: FEATURE\nexecutionAgent: frontend-engineer\ncollaborationRecommendation: pair\n---\n# Edited Feedback\n`,
            },
        });
        const feedbackMarkdown = await fsReadFile(feedbackFixture.planPath, "utf8");
        const feedbackAttrs = parsePlanFrontMatter(feedbackMarkdown).attrs;

        assertEquals(feedback.approved, false);
        assertStringIncludes(feedbackMarkdown, "# Edited Feedback");
        assertEquals(feedbackAttrs.status, "feedback");
        assertEquals(feedbackAttrs.classification, "PLANNED_CHANGE");
        assertEquals(feedbackAttrs.executionAgent, "frontend-engineer");

        const approval = await applySharedPlanReviewDecision({
            cwd: approvalFixture.dir,
            planName: "plan",
            planPath: approvalFixture.planPath,
            planWithFrontMatter: approvalFixture.markdown,
            planRevision: approvalFixture.revision,
            originalAttrs: approvalFixture.attrs,
            trustedClassification: "PROJECT",
            decision: {
                approved: true,
                feedback: "Approved.",
                approvalAction: "decompose",
                plan:
                    `---\nclassification: FEATURE\nexecutionAgent: frontend-engineer\ncollaborationRecommendation: pair\n---\n# Approved Project\n`,
            },
        });
        const approvalAttrs = (await loadPlan(approvalFixture.dir, "plan"))?.attrs;

        assertEquals(approval.approved, true);
        assertEquals(approval.planAttrs?.classification, "PROJECT");
        assertEquals(approvalAttrs?.status, "approved");
        assertEquals(approvalAttrs?.classification, "PROJECT");
        assertEquals(approvalAttrs?.executionAgent, undefined);
        assertEquals(approvalAttrs?.collaborationRecommendation, undefined);
    } finally {
        await fsRm(feedbackFixture.dir, { recursive: true });
        await fsRm(approvalFixture.dir, { recursive: true });
    }
});

for (
    const { name, original, current, matches } of [
        {
            name: "prose wrapping",
            original: "Review the saved Plan.\n",
            current: "Review the\nsaved Plan.\n",
            matches: true,
        },
        {
            name: "list wrapping",
            original: "- Review the saved Plan.\n",
            current: "- Review the\n  saved Plan.\n",
            matches: true,
        },
        {
            name: "table padding",
            original: "| A | B |\n| - | - |\n| x | y |\n",
            current: "| A   | B   |\n| --- | --- |\n| x   | y   |\n",
            matches: true,
        },
        { name: "changed prose", original: "Keep the data.\n", current: "Delete the data.\n", matches: false },
        { name: "hard breaks", original: "First  \nSecond\n", current: "First Second\n", matches: false },
        { name: "paragraph boundaries", original: "First\n\nSecond\n", current: "First Second\n", matches: false },
        { name: "code whitespace", original: "```text\na  b\n```\n", current: "```text\na b\n```\n", matches: false },
        { name: "code newlines", original: "```text\na\nb\n```\n", current: "```text\na b\n```\n", matches: false },
        { name: "inline code", original: "Run `a  b`.\n", current: "Run `a b`.\n", matches: false },
        {
            name: "raw HTML whitespace",
            original: "Before <pre>a\nb</pre> after.\n",
            current: "Before <pre>a b</pre> after.\n",
            matches: false,
        },
        { name: "link destinations", original: "[Plan](one.md)\n", current: "[Plan](two.md)\n", matches: false },
        { name: "list nesting", original: "- One\n  - Two\n", current: "- One\n- Two\n", matches: false },
        { name: "checkbox state", original: "- [ ] Pending\n", current: "- [x] Pending\n", matches: false },
        { name: "table content", original: "| A |\n| - |\n| x |\n", current: "| A |\n| - |\n| y |\n", matches: false },
    ]
) {
    test(`Plan review source comparison preserves ${name}`, () => {
        const attrs = parsePlanFrontMatter("# Plan\n").attrs;
        assertEquals(reviewSourceStillMatches({ attrs, body: current }, attrs, original), matches);
    });
}
