import { fileURLToPath } from "node:url";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { mkdtemp as fsMkdtemp, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { getStoredPlanPath, loadPlan, parsePlanFrontMatter, savePlan } from "../../plan-store.js";
import type { PlanFrontMatter } from "../../plan-store.js";
import type { BrowserPort } from "../../shared/browser-port.ts";
import { submitPlanForReview } from "./plan-review.ts";
import { createScriptedReviewBrowser, type ReviewDecisionBody } from "./review-test-fixture.ts";
import { addEntry as addRegistryEntry, findById as findRegistryEntryById } from "../../shared/worktree-registry.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { prepareSequenceReview } from "../../shared/workflow/sequence-review.ts";

interface PlanReviewFixture {
    dir: string;
    planPath: string;
}

interface ExecutedPlanReviewFixture extends PlanReviewFixture {
    executionDir: string;
    primaryMarkdown: string;
}

const gitFixture = defineCommittedGitFixture({ ".gitignore": ".wld/\nwt-prior/\n" });

async function makePlanFile(): Promise<PlanReviewFixture> {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-plan-review-"));
    await savePlan(dir, "plan", "# Plan\n\nDo the thing.\n", {
        classification: "PLANNED_CHANGE",
        status: "draft",
        summary: "Do the thing",
        affectedPaths: [],
    });
    return { dir, planPath: getStoredPlanPath(dir, "plan") };
}

async function planStatus(dir: string): Promise<string | undefined> {
    return (await loadPlan(dir, "plan"))?.attrs.status;
}

function approvedDecision(overrides: ReviewDecisionBody = {}): ReviewDecisionBody {
    return {
        approved: true,
        feedback: "looks good",
        approvalAction: "run",
        executionAgent: "engineer",
        collaborationRecommendation: "autonomous",
        ...overrides,
    };
}

function decisionBrowserAfter(beforeDecision: () => Promise<void>, body: ReviewDecisionBody): BrowserPort {
    return {
        async open(url: string): Promise<boolean> {
            await beforeDecision();
            const reviewUrl = new URL(url);
            const token = reviewUrl.searchParams.get("token");
            if (!token) throw new Error("Review URL did not contain a token.");
            const response = await fetch(
                new URL(`/api/review/decision?token=${encodeURIComponent(token)}`, reviewUrl.origin),
                {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-runwield-review-token": token,
                    },
                    body: JSON.stringify(body),
                },
            );
            if (!response.ok) throw new Error(`Review decision failed: ${response.status}`);
            return true;
        },
    };
}

test("grouped Sequence chat preserves intermediate-round intent with its decision", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-sequence-chat-"));
    try {
        await savePlan(dir, "sequence", "# Sequence\n", {
            classification: "PROJECT",
            type: "sequence",
            status: "draft",
        });
        await savePlan(dir, "sequence/child", "# Child\n", {
            classification: "PLANNED_CHANGE",
            status: "draft",
            parentPlan: "sequence",
            order: 1,
        });
        const documents = await prepareSequenceReview(dir, "sequence");
        const scripted = createScriptedReviewBrowser("deny", {
            approved: false,
            feedback: "Revise the group.",
            conversationTurn: true,
            documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
        });
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "sequence",
            planPath: getStoredPlanPath(dir, "sequence"),
            sequenceDocuments: documents,
            browser: scripted.browser,
        });
        assertEquals(result.conversationTurn, true);
        assertEquals(result.sequenceDecision?.feedback, "Revise the group.");
        assertEquals((await loadPlan(dir, "sequence"))?.attrs.status, "draft");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview serves a real review and records approval metadata", async () => {
    const { dir, planPath } = await makePlanFile();
    const scriptedBrowser = createScriptedReviewBrowser("decision", approvedDecision());
    try {
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            triageMeta: {
                classification: "FEATURE",
                workKind: "DOCUMENTATION",
                complexity: "MEDIUM",
                summary: "Add the thing",
                affectedPaths: ["src/a.js"],
            },
            browser: scriptedBrowser.browser,
        });

        const savedPlan = await loadPlan(dir, "plan");
        assertEquals(result.approved, true);
        assertEquals(result.feedback, "looks good");
        assertEquals(result.approvalAction, "run");
        assertEquals(result.revision, savedPlan?.revision);
        assertEquals(savedPlan?.attrs.status, "approved");
        assertEquals(savedPlan?.attrs.classification, "PLANNED_CHANGE");
        assertEquals(savedPlan?.attrs.workKind, "DOCUMENTATION");
        assertStringIncludes(scriptedBrowser.urls[0], "/review/plan?token=");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview accepts approval after a formatting-only Plan rewrite", async () => {
    const { dir, planPath } = await makePlanFile();
    const browser = decisionBrowserAfter(async () => {
        const before = await fsReadFile(planPath, "utf8");
        const reformatted = before.replace('status: "draft"', "status: draft");
        if (reformatted === before) throw new Error("Fixture did not contain quoted draft status.");
        await fsWriteFile(planPath, reformatted);
    }, approvedDecision());
    try {
        const result = await submitPlanForReview({ cwd: dir, planName: "plan", planPath, browser });

        assertEquals(result.approved, true);
        assertEquals(result.cancellationReason, undefined);
        assertEquals((await loadPlan(dir, "plan"))?.attrs.status, "approved");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview accepts approval after Markdown body formatting", async () => {
    const { dir, planPath } = await makePlanFile();
    const before = (await fsReadFile(planPath, "utf8")).replace(
        "Do the thing.",
        "Load every dashboard card independently while retaining verified rows and showing clear loading states.\n\n" +
            "- Keep the existing dashboard rows visible while unrelated projects are still loading their data.\n\n" +
            "| State | Display |\n| --- | --- |\n| Pending | Loading |\n",
    );
    await fsWriteFile(planPath, before);
    const browser = decisionBrowserAfter(async () => {
        const formatted = await captureForegroundProcess(process.execPath, {
            args: [
                "run",
                "--no-install",
                fileURLToPath(new URL("../../../node_modules/prettier/bin/prettier.cjs", import.meta.url)),
                "--parser",
                "markdown",
                "--prose-wrap",
                "always",
                "--print-width",
                "50",
                "--write",
                planPath,
            ],
            cwd: getCwd(),
        });
        assertEquals(formatted.success, true);
        assertEquals((await fsReadFile(planPath, "utf8")) === before, false);
    }, approvedDecision());
    try {
        const result = await submitPlanForReview({ cwd: dir, planName: "plan", planPath, browser });

        assertEquals(result.approved, true);
        assertEquals(result.cancellationReason, undefined);
        assertEquals((await loadPlan(dir, "plan"))?.attrs.status, "approved");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview still rejects a substantive Plan edit made during review", async () => {
    const { dir, planPath } = await makePlanFile();
    const browser = decisionBrowserAfter(async () => {
        const before = await fsReadFile(planPath, "utf8");
        await fsWriteFile(planPath, before.replace("Do the thing.", "Do a different thing."));
    }, approvedDecision());
    try {
        const result = await submitPlanForReview({ cwd: dir, planName: "plan", planPath, browser });

        assertEquals(result.approved, false);
        assertEquals(result.cancellationReason, "stale_plan_review");
        assertEquals((await loadPlan(dir, "plan"))?.attrs.status, "draft");
        assertStringIncludes(await fsReadFile(planPath, "utf8"), "Do a different thing.");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview persists approved execution policy and preserves custom front matter", async () => {
    const { dir, planPath } = await makePlanFile();
    await fsWriteFile(
        planPath,
        `---
classification: FEATURE
frontend: true
customField: keep-me
---
# Plan
`,
    );
    const scriptedBrowser = createScriptedReviewBrowser("decision", approvedDecision({ approvalAction: "later" }));
    try {
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            browser: scriptedBrowser.browser,
        });
        const markdown = await fsReadFile(planPath, "utf8");
        const parsed = parsePlanFrontMatter(markdown);

        assertEquals(parsed.attrs.executionAgent, "engineer");
        assertEquals(parsed.attrs.collaborationRecommendation, "autonomous");
        assertEquals(parsed.attrs.frontend, undefined);
        assertStringIncludes(markdown, 'customField: "keep-me"');
        assertEquals(result.approvalAction, "later");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview restores trusted PROJECT policy boundaries", async () => {
    const { dir, planPath } = await makePlanFile();
    const scriptedBrowser = createScriptedReviewBrowser("decision", {
        approved: true,
        feedback: "decompose",
        approvalAction: "decompose",
        plan: `---
classification: FEATURE
executionAgent: frontend-engineer
collaborationRecommendation: pair
---
# Edited Project
`,
    });
    try {
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            triageMeta: { classification: "PROJECT", complexity: "HIGH", summary: "Epic", affectedPaths: [] },
            browser: scriptedBrowser.browser,
        });
        const attrs = (await loadPlan(dir, "plan"))?.attrs;

        assertEquals(result.approved, true);
        assertEquals(attrs?.classification, "PROJECT");
        assertEquals(attrs?.executionAgent, undefined);
        assertEquals(attrs?.collaborationRecommendation, undefined);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview restores trusted planned-change classification before approved policy", async () => {
    const { dir, planPath } = await makePlanFile();
    const scriptedBrowser = createScriptedReviewBrowser(
        "decision",
        approvedDecision({
            plan: `---
classification: PROJECT
---
# Edited Feature
`,
            executionAgent: "frontend-engineer",
            collaborationRecommendation: "pair",
        }),
    );
    try {
        await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            triageMeta: { classification: "FEATURE", complexity: "MEDIUM", summary: "Feature", affectedPaths: [] },
            browser: scriptedBrowser.browser,
        });
        const attrs = (await loadPlan(dir, "plan"))?.attrs;

        assertEquals(attrs?.classification, "PLANNED_CHANGE");
        assertEquals(attrs?.executionAgent, "frontend-engineer");
        assertEquals(attrs?.collaborationRecommendation, "pair");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview feedback writes the edited Plan without applying approval policy", async () => {
    const { dir, planPath } = await makePlanFile();
    const scriptedBrowser = createScriptedReviewBrowser("deny", {
        feedback: "revise",
        plan: `---
classification: FEATURE
executionAgent: frontend-engineer
collaborationRecommendation: pair
---
# Plan
`,
    });
    try {
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            browser: scriptedBrowser.browser,
        });
        const attrs = (await loadPlan(dir, "plan"))?.attrs;

        assertEquals(result.approved, false);
        assertEquals(attrs?.executionAgent, "frontend-engineer");
        assertEquals(attrs?.collaborationRecommendation, "pair");
        assertEquals(attrs?.status, "feedback");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview rejects malformed empty feedback without writing the Plan", async () => {
    const { dir, planPath } = await makePlanFile();
    const originalPlan = await fsReadFile(planPath, "utf8");
    const scriptedBrowser = createScriptedReviewBrowser("deny", { feedback: "" });
    try {
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            browser: scriptedBrowser.browser,
        });

        assertEquals(result.cancellationReason, "malformed_review_response");
        assertEquals(await fsReadFile(planPath, "utf8"), originalPlan);
        assertEquals(await planStatus(dir), "draft");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview loads image bytes from real feedback transport", async () => {
    const { dir, planPath } = await makePlanFile();
    const imagePath = join(dir, "reference.png");
    await fsWriteFile(imagePath, new Uint8Array([137, 80, 78, 71]));
    const scriptedBrowser = createScriptedReviewBrowser("deny", {
        feedback: "change this",
        globalAttachments: [{ path: imagePath, name: "reference" }],
    });
    try {
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            browser: scriptedBrowser.browser,
        });

        assertEquals(result.images, [{ base64: "iVBORw==", mimeType: "image/png", name: "reference" }]);
        assertEquals(await planStatus(dir), "feedback");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview exit does not write the Plan", async () => {
    const { dir, planPath } = await makePlanFile();
    const originalPlan = await fsReadFile(planPath, "utf8");
    const scriptedBrowser = createScriptedReviewBrowser("exit", { reviewType: "plan" });
    try {
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            browser: scriptedBrowser.browser,
        });

        assertEquals(result.canceled, true);
        assertEquals(result.cancellationReason, "review_exit");
        assertEquals(await fsReadFile(planPath, "utf8"), originalPlan);
        assertEquals(await planStatus(dir), "draft");
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview cancellation stops the real review surface without writing", async () => {
    const { dir, planPath } = await makePlanFile();
    const originalPlan = await fsReadFile(planPath, "utf8");
    const controller = new AbortController();
    let openedUrl = "";
    let markOpened: () => void = () => {};
    const opened = new Promise<void>((resolveOpened) => (markOpened = resolveOpened));
    const browser: BrowserPort = {
        open: (url: string) => {
            openedUrl = url;
            markOpened();
            return Promise.resolve(true);
        },
    };
    try {
        const pending = submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            signal: controller.signal,
            browser,
        });
        await opened;
        controller.abort();

        assertEquals(await pending, {
            approved: false,
            canceled: true,
            feedback: "Cancelled by user (Esc)",
            cancellationReason: "abort_signal",
        });
        assertStringIncludes(openedUrl, "/review/plan?token=");
        assertEquals(await fsReadFile(planPath, "utf8"), originalPlan);
        await assertRejects(() => fetch(openedUrl));
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

/**
 * Build a Plan that already ran, together with the registry entry recording the
 * execution generation it owns.
 */
async function makeExecutedPlanWithWorktree(status: PlanFrontMatter["status"]): Promise<ExecutedPlanReviewFixture> {
    const dir = await gitFixture.checkout();
    await savePlan(dir, "plan", "# Plan\n\nDo the thing.\n", {
        classification: "PLANNED_CHANGE",
        status,
        summary: "Do the thing",
        affectedPaths: [],
        planId: "plan-executed-id",
    });
    await git(dir, ["add", "docs"]);
    await git(dir, ["commit", "-m", "Save review Plan"]);
    const executionDir = join(dir, "wt-prior");
    await git(dir, ["worktree", "add", "-b", "worktree/plan", executionDir]);
    await addRegistryEntry(dir, {
        id: "wt-prior",
        planName: "plan",
        planId: "plan-executed-id",
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit: await git(dir, ["rev-parse", "HEAD"]),
        baseTree: await git(dir, ["rev-parse", "HEAD^{tree}"]),
        branch: "worktree/plan",
        path: executionDir,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
    });
    return {
        dir,
        executionDir,
        planPath: getStoredPlanPath(executionDir, "plan"),
        primaryMarkdown: await fsReadFile(getStoredPlanPath(dir, "plan"), "utf8"),
    };
}

test("submitPlanForReview approval preserves the prior execution attempt", async () => {
    const { dir, executionDir, planPath, primaryMarkdown } = await makeExecutedPlanWithWorktree("ready_for_work");
    const scriptedBrowser = createScriptedReviewBrowser("decision", approvedDecision());
    try {
        const result = await submitPlanForReview({
            cwd: dir,
            planName: "plan",
            planPath,
            browser: scriptedBrowser.browser,
        });

        assertEquals(result.approved, true);
        const savedPlan = await loadPlan(executionDir, "plan");
        assertEquals(savedPlan?.attrs.status, "approved");
        assertEquals(savedPlan?.attrs.worktreeId, "wt-prior", "review must retain the implementation attempt");
        assertEquals(savedPlan?.attrs.worktreeStatus, "active");
        assertEquals((await findRegistryEntryById(dir, "wt-prior"))?.status, "active");
        assertEquals(await fsReadFile(getStoredPlanPath(dir, "plan"), "utf8"), primaryMarkdown);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("submitPlanForReview leaves the execution generation alone when no reopen is needed", async () => {
    const { dir, executionDir, planPath, primaryMarkdown } = await makeExecutedPlanWithWorktree("draft");
    const scriptedBrowser = createScriptedReviewBrowser("decision", approvedDecision());
    try {
        await submitPlanForReview({ cwd: dir, planName: "plan", planPath, browser: scriptedBrowser.browser });

        // A draft is reviewable as-is, so there is no generation to detach and the
        // registry entry must be left exactly as it was.
        assertEquals(await planStatus(executionDir), "approved");
        assertEquals((await findRegistryEntryById(dir, "wt-prior"))?.status, "active");
        assertEquals((await loadPlan(executionDir, "plan"))?.attrs.worktreeId, "wt-prior");
        assertEquals(await fsReadFile(getStoredPlanPath(dir, "plan"), "utf8"), primaryMarkdown);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});
