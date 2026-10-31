import { test } from "node:test";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { NO_OPEN_BROWSER_PORT } from "../browser-port.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "./review-host.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows, writeAttachedWorkflowRecord } from "./record-store.ts";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { toDelivery } from "./delivery-test-fixture.ts";
import { stopActiveReviewSurfaces } from "../../ui/review/review-launcher.ts";
import {
    EVIDENCE,
    activateInput,
    pendingTriage,
    triageReportInput,
    planWrittenInput,
    runOperation,
    submitReview,
    withProject,
} from "./attached-test-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";

test("Codex browser review and restored chat identify the coordinating host", async () => {
    await withProject(async (root) => {
        const evidence = { ...EVIDENCE, host: "codex", hostVersion: "0.164.0-alpha.11.1" };
        try {
            const activated = await runOperation("activate", root, { ...activateInput(), evidence });
            const planned = await runOperation("triage_report", root, {
                ...triageReportInput(pendingTriage(activated)),
                evidence,
            });
            assert(planned.ok && planned.workflow.nextAction.kind === "plan");
            await mkdir(join(root, "docs/plans"), { recursive: true });
            await fsWriteFile(join(root, "docs/plans/dark-mode-toggle.md"), "# Toggle\n\nAdd a toggle.\n");
            const submitted = await runOperation("plan_written", root, {
                ...planWrittenInput({
                    workflowId: planned.workflow.workflowId,
                    actionId: planned.workflow.nextAction.actionId,
                    expectedRevision: planned.workflow.revision,
                }),
                evidence,
            });
            assert(submitted.ok);
            for (let round = 0; round < 2; round++) {
                const hosted = await ensureReviewHosted(
                    root,
                    submitted.workflow,
                    NO_OPEN_BROWSER_PORT,
                    undefined,
                    "codex",
                );
                assert(hosted);
                const url = new URL(hosted.url);
                const conversation = await (await fetch(new URL(`/api/review/conversation${url.search}`, url))).json();
                assertEquals(conversation.agentLabel, "Codex");
                assertStringIncludes(hosted.guidance, "$runwield:run implement");
                assertEquals(hosted.guidance.includes("/runwield:implement"), false);
                await stopHostedAttachedReviews();
            }
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("the production decision route acknowledges only a committed Attached outcome and reuses its page", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            assertEquals(await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT), hosted);
            const url = new URL(hosted.url);
            const revisionUrl = new URL(`/api/review/revision${url.search}`, url);
            assertEquals((await (await fetch(revisionUrl)).json()).revision, 0);
            const unauthorized = await fetch(new URL("/api/review/revision", url));
            assertEquals(unauthorized.status, 401);
            await unauthorized.text();
            const conversation = await fetch(new URL(`/api/review/conversation${url.search}`, url));
            assertEquals(conversation.status, 200);
            await conversation.text();
            const oldPlan = await loadPlan(root, "dark-mode-toggle");
            assert(oldPlan);
            const response = await fetch(new URL(`/api/review/deny${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({ feedback: "Revise the title.", reviewRevision: 0 }),
            });
            assertEquals(response.status, 200);
            assertEquals(await response.text(), '{"ok":true}');
            const saved = await loadAttachedWorkflowRecord(locateAttachedWorkflows(root), workflow.workflowId);
            assert(saved.status === "found");
            assertEquals(saved.record.review?.status, "applied");
            assertEquals(saved.record.review?.outcome?.feedback, "Revise the title.");
            const status = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(status.ok && status.workflow.nextAction.kind === "plan");
            await fsWriteFile(oldPlan.path, oldPlan.markdown.replace("Add a toggle.", "Add a selector."));
            const next = await runOperation(
                "plan_written",
                root,
                planWrittenInput({
                    workflowId: workflow.workflowId,
                    actionId: status.workflow.nextAction.actionId,
                    expectedRevision: status.workflow.revision,
                    operationId: "second-review",
                }),
            );
            assert(next.ok);
            const second = await ensureReviewHosted(root, next.workflow, NO_OPEN_BROWSER_PORT);
            assert(second);
            assertEquals(second.url, hosted.url);
            assertEquals(second.round, 2);
            assertEquals((await (await fetch(revisionUrl)).json()).revision, 1);
            const staleTab = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 0,
                    plan: oldPlan.markdown,
                }),
            });
            assertEquals(staleTab.status, 409);
            await staleTab.text();
            assertStringIncludes((await loadPlan(root, "dark-mode-toggle"))?.body ?? "", "Add a selector.");
            const approved = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 1,
                }),
            });
            assertEquals(approved.status, 200);
            await approved.text();
            assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("restoring hosting retains the durable round and does not invent cancellation", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const original = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(original);
            await stopHostedAttachedReviews();
            await assertRejects(() => fetch(original.url));
            const status = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(status.ok);
            assertEquals(status.workflow.review, workflow.review);
            const restored = await ensureReviewHosted(root, status.workflow, NO_OPEN_BROWSER_PORT);
            assert(restored);
            assertEquals(restored.round, original.round);
            assert(restored.url !== original.url);
            const url = new URL(restored.url);
            const canceled = await fetch(new URL(`/api/review/exit${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({ reviewRevision: 0 }),
            });
            assertEquals(canceled.status, 200);
            await canceled.text();
            const after = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(after.ok && after.workflow.nextAction.kind === "plan");
            assertStringIncludes(after.workflow.nextAction.note ?? "", "canceled");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("the production stale-review response preserves the pending durable round", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            const plan = await loadPlan(root, "dark-mode-toggle");
            assert(plan);
            await fsWriteFile(plan.path, plan.markdown.replace("Add a toggle.", "Delete the toggle."));
            const url = new URL(hosted.url);
            const rejected = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 0,
                }),
            });
            assertEquals(rejected.status, 409);
            assertEquals((await rejected.json()).error, "stale_sequence_review");
            const saved = await loadAttachedWorkflowRecord(locateAttachedWorkflows(root), workflow.workflowId);
            assert(saved.status === "found");
            assertEquals(saved.record.review?.status, "pending");
            const page = await fetch(hosted.url);
            assertEquals(page.status, 200);
            assertStringIncludes(await page.text(), "Delete the toggle.");
            assertEquals((await (await fetch(new URL(`/api/review/revision${url.search}`, url))).json()).revision, 1);
            for (let poll = 0; poll < 3; poll++) {
                const status = await runOperation("status", root, { workflowId: workflow.workflowId });
                assert(status.ok);
                await ensureReviewHosted(root, status.workflow, NO_OPEN_BROWSER_PORT);
                assertEquals(
                    (await (await fetch(new URL(`/api/review/revision${url.search}`, url))).json()).revision,
                    1,
                );
            }
            const accepted = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 1,
                }),
            });
            assertEquals(accepted.status, 200);
            await accepted.text();
            assertEquals((await loadPlan(root, "dark-mode-toggle"))?.attrs.status, "ready_for_work");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

test("a Core-advanced browser reload returns its position without waiting on its own shutdown", async () => {
    await withProject(async (root) => {
        try {
            const workflow = await submitReview(root);
            const hosted = await ensureReviewHosted(root, workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            await recordPlanEvent({
                cwd: root,
                planName: "dark-mode-toggle",
                event: "review_approved",
                currentStatus: "draft",
            });
            const url = new URL(hosted.url);
            const rejected = await fetch(new URL(`/api/review/decision${url.search}`, url), {
                method: "POST",
                body: JSON.stringify({
                    approvalAction: "run",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                    reviewRevision: 0,
                }),
            });
            assertEquals(rejected.status, 409);
            await rejected.text();
            const reloaded = await fetch(hosted.url, { signal: AbortSignal.timeout(5000) });
            assertEquals(reloaded.status, 409);
            assertStringIncludes(await reloaded.text(), "advanced in Core");
            const status = await runOperation("status", root, { workflowId: workflow.workflowId });
            assert(status.ok);
            assertEquals(status.workflow.state, "plan_ready");
        } finally {
            await stopHostedAttachedReviews();
        }
    });
});

async function withinFiveSeconds<T>(task: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            task,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Review hosting exceeded five seconds")), 5000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

for (const pollOwnsOpening of [false, true]) {
    test(
        pollOwnsOpening
            ? "a Plan poll keeps its original browser port when it opens code review"
            : "a Plan conversation poll can overlap code-review hosting and both servers close with the host",
        async () => {
            const fixture = await attachedValidationFixture();
            const requests = new AbortController();
            const codeOpening = Promise.withResolvers<void>();
            const browserRelease = Promise.withResolvers<void>();
            const browser = pollOwnsOpening
                ? {
                      async open(url: string): Promise<boolean> {
                          if (new URL(url).pathname === "/review/code") {
                              codeOpening.resolve();
                              await browserRelease.promise;
                          }
                          return false;
                      },
                  }
                : NO_OPEN_BROWSER_PORT;
            try {
                // Keep the real implemented Plan and worktree intact while seeding the preceding browser round.
                await savePlan(fixture.root, "previous-plan", "# Previous Plan\n\nImplement the value.\n", {
                    planId: "previous-plan",
                    classification: "PLANNED_CHANGE",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                });
                const location = locateAttachedWorkflows(fixture.root);
                const original = await loadAttachedWorkflowRecord(location, fixture.workflowId);
                assert(original.status === "found");
                assertEquals(
                    (
                        await writeAttachedWorkflowRecord(
                            location,
                            {
                                ...original.record,
                                revision: original.record.revision + 1,
                                state: "awaiting_review",
                                plan: { planId: "previous-plan", planName: "previous-plan" },
                                review: {
                                    round: 1,
                                    actionId: "previous-plan-review",
                                    planRevision: "",
                                    controllerRevision: 0,
                                    waitingReason: "user_decision",
                                    status: "pending",
                                },
                            },
                            original.record.revision,
                        )
                    ).status,
                    "written",
                );
                const planReview = await ensureReviewHosted(fixture.root, await fixture.status(), browser);
                assert(planReview);
                const opened = await loadAttachedWorkflowRecord(location, fixture.workflowId);
                assert(opened.status === "found");
                assertEquals(
                    (
                        await writeAttachedWorkflowRecord(
                            location,
                            { ...original.record, revision: opened.record.revision + 1 },
                            opened.record.revision,
                        )
                    ).status,
                    "written",
                );
                const started = await toDelivery(fixture);
                assert(started.workflow.nextAction.kind === "code_review");
                const oldUrl = new URL(planReview.url);
                const polling = fetch(new URL(`/api/review/conversation${oldUrl.search}`, oldUrl), {
                    signal: requests.signal,
                }).then(async (response) => {
                    await response.text();
                    return response.status;
                });
                // Cleanup can abort this request before the browser-boundary wait completes.
                void polling.catch(() => undefined);
                if (pollOwnsOpening) await withinFiveSeconds(codeOpening.promise);
                const hosting = ensureReviewHosted(fixture.root, started.workflow, browser);
                browserRelease.resolve();
                const [status, codeReview] = await withinFiveSeconds(Promise.all([polling, hosting]));
                assertEquals(status, 200);
                assert(codeReview);
                assertEquals(new URL(codeReview.url).pathname, "/review/code");
                const page = await fetch(codeReview.url, { signal: requests.signal });
                assertEquals(page.status, 200);
                await page.text();
                await withinFiveSeconds(stopHostedAttachedReviews());
                await assertRejects(() => fetch(planReview.url, { signal: AbortSignal.timeout(5000) }));
                await assertRejects(() => fetch(codeReview.url, { signal: AbortSignal.timeout(5000) }));
            } finally {
                browserRelease.resolve();
                requests.abort();
                // A failing handover can leave an opening blocked and a new surface outside the host map.
                // Bound cleanup too, so that a regression reports failure instead of deadlocking the runner.
                await withinFiveSeconds(Promise.all([stopHostedAttachedReviews(), stopActiveReviewSurfaces()])).catch(
                    () => undefined,
                );
                await fixture.close();
            }
        },
    );
}
