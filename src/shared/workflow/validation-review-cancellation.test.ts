import { test } from "node:test";
import { assertEquals, assertExists, assertStringIncludes } from "../../testing/assertions.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { defineGitFixture } from "../git-test-fixture.ts";
import { SessionHost } from "../session/session-host.ts";
import { SessionRuntime } from "../session/session-runtime.ts";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";
import type { RuntimeValidationProgress } from "../session/session-runtime-events.js";
import { createTuiInteractionAdapter } from "../../ui/tui/runtime-interaction-adapter.js";
import { readDeliveryEvidence } from "./delivery-evidence.ts";
import { normalizeHumanReview } from "./validation-human-review.ts";
import {
    attachRecorder,
    git,
    runValidationLoop,
    makeUi,
    makeValidationProjectRoot,
    NO_ISOLATED_AGENT_PORT,
    runValidationPhase,
} from "./validation-test-helpers.js";

interface ReviewProgressObservation {
    type: string;
    validationProgress?: RuntimeValidationProgress;
}

for (const response of [
    { outcome: "canceled", message: "Interaction canceled." },
    {
        outcome: "selected",
        _meta: {
            canceled: true,
            approved: true,
            feedback: "Unsubmitted draft",
            images: [{ base64: "ZHJhZnQ=", mimeType: "image/png" }],
            conversationTurn: true,
        },
    },
    { outcome: "selected", _meta: { exit: true, feedback: "Unsubmitted draft", annotations: [{ text: "draft" }] } },
] as const) {
    test(`Code Review cancellation overrides decision data: ${JSON.stringify(response)}`, () => {
        const review = normalizeHumanReview(response);
        assertEquals(review.approved, false);
        assertEquals(review.feedback, "");
        assertEquals(review.annotations, []);
        assertEquals(review.images, []);
        assertEquals(review.canceled, true);
        assertEquals(review.conversationTurn, false);
    });
}

test("real broker cancellation twice preserves review for a fresh Session and HTTP approval", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "always",
        humanReviewDecision: null,
    });
    const urls: string[] = [];
    for (let round = 0; round < 3; round++) {
        const ui = makeUi();
        const host = new SessionHost();
        const session = attachRecorder(host.createSession({ cwd: projectRoot }), ui);
        const runtime = new SessionRuntime({
            sessionHost: host,
            sessionStore: null,
            ownerProcessKind: "test",
            ownerInstanceId: crypto.randomUUID(),
        });
        const plan = await loadPlan(projectRoot, "p");
        assertExists(plan);
        session.setActiveExecutionWorkflow({
            planName: "p",
            triageMeta: plan.attrs,
            executionAgent: "engineer",
            projectRoot,
            executionCwd: projectRoot,
            nonGitInPlace: true,
        });
        const events: Array<{ type: string; outcome?: string; message?: string }> = [];
        const unsubscribe = session.subscribeRuntimeEvents((event) => {
            events.push({
                type: event.type,
                message: "message" in event && typeof event.message === "string" ? event.message : undefined,
            });
        });
        const opened = Promise.withResolvers<string>();
        const adapter = createTuiInteractionAdapter(ui, {
            browser: {
                open: (url) => {
                    opened.resolve(url);
                    return Promise.resolve(false);
                },
            },
        });
        session.setInteractionAdapter(adapter);
        const phase = runValidationPhase({
            hostedSession: session,
            planName: "p",
            planContent: plan.body,
            triageMeta: plan.attrs,
            semanticReviewPort: NO_ISOLATED_AGENT_PORT,
        });
        const url = await opened.promise;
        urls.push(url);
        const parsed = new URL(url);
        const token = parsed.searchParams.get("token") || "";
        const live = await fetch(new URL(`/api/review/conversation?token=${token}`, parsed.origin));
        assertEquals(live.status, 200, "the reopened link must serve the real review surface");
        await live.text();
        assertEquals(runtime.getSessionSnapshot(session.id)?.workflowContext?.liveReviewUrl, url);
        assertStringIncludes(ui.toolOutputs.join("\n"), `Review Code: \x1b]8;;${url}`);
        if (round < 2) {
            assertEquals(session.cancelActiveInteractions(), true);
            assertEquals(runtime.getSessionSnapshot(session.id)?.workflowContext?.liveReviewUrl, undefined);
        } else {
            const approved = await fetch(new URL(`/api/review/decision?token=${token}`, parsed.origin), {
                method: "POST",
                headers: { "content-type": "application/json", "x-runwield-review-token": token },
                body: JSON.stringify({ approved: true }),
            });
            assertEquals(approved.ok, true);
            await approved.text();
        }
        const result = await phase;
        assertEquals(runtime.getSessionSnapshot(session.id)?.workflowContext?.liveReviewUrl, undefined);
        assertEquals(runtime.getSessionSnapshot(session.id)?.workflowContext?.liveCodeReview, false);
        unsubscribe();
        await runtime.closeSession(session.id);
        const saved = await loadPlan(projectRoot, "p");
        assertExists(saved);
        assertEquals(saved.attrs.status, "reviewed");
        const evidence = await readDeliveryEvidence(projectRoot, "p", "in-place");
        assertEquals(evidence.entries.filter((entry) => entry.kind === "human-revision").length, 0);
        if (round < 2) {
            assertEquals(saved.attrs.humanReviewDecision, null);
            assertEquals(evidence.entries.filter((entry) => entry.kind === "human").length, 0);
            assertEquals(
                events.some(
                    (event) => event.type === "interaction_canceled" && event.message === "Interaction canceled.",
                ),
                true,
            );
            assertStringIncludes(result.reason || "", "pending");
        } else {
            assertEquals(saved.attrs.humanReviewDecision, "approved");
            assertEquals(
                evidence.entries.filter((entry) => entry.kind === "human").map((entry) => entry.outcome),
                ["Approved"],
            );
        }
    }
    assertEquals(new Set(urls).size, 3, "resume must present each current live URL");
});

const reopenFixture = defineGitFixture(async (root) => {
    await writeFile(join(root, "label.ts"), "export const label = 'base';\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "review reopen fixture"]);
});

for (const revise of [false, true]) {
    test(
        `Code Review reopen projects the same live URL through ${revise ? "revision and CI" : "conversation"} until approval`,
        { timeout: 10_000 },
        async () => {
            const projectRoot = await reopenFixture.checkout();
            await savePlan(projectRoot, "p", "# Review reopen\n\nKeep the exported label.", {
                classification: "QUICK_FIX",
                status: "reviewed",
                humanReviewMode: "always",
                humanReviewDecision: null,
            });
            const plan = await loadPlan(projectRoot, "p");
            assertExists(plan);
            await writeFile(join(projectRoot, "label.ts"), "export const label = 'first';\n");
            const host = new SessionHost();
            const session = attachRecorder(host.createSession({ cwd: projectRoot }), makeUi());
            const runtime = new SessionRuntime({
                sessionHost: host,
                sessionStore: null,
                ownerProcessKind: "test",
                ownerInstanceId: crypto.randomUUID(),
            });
            session.setActiveExecutionWorkflow({
                planName: "p",
                triageMeta: plan.attrs,
                executionAgent: "engineer",
                projectRoot,
                executionCwd: projectRoot,
                baselineTree: await git(projectRoot, ["rev-parse", "HEAD"]),
                worktreeBaseBranch: "main",
            });
            const opened = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
            const agentStarted = Promise.withResolvers<void>();
            const releaseAgent = Promise.withResolvers<void>();
            let rounds = 0;
            let ciRuns = 0;
            const ui = makeUi();
            let browserUrl = "";
            const unsubscribe = session.subscribeRuntimeEvents((event: ReviewProgressObservation) => {
                if (
                    event.type === "system_status" &&
                    event.validationProgress?.stage === "human_review" &&
                    event.validationProgress.checks.humanReview === "running" &&
                    browserUrl
                ) {
                    opened[rounds++]?.resolve(browserUrl);
                }
            });
            session.setInteractionAdapter(
                createTuiInteractionAdapter(ui, {
                    browser: {
                        open: (url) => {
                            browserUrl = url;
                            return Promise.resolve(false);
                        },
                    },
                }),
            );
            const snapshot = () => runtime.getSessionSnapshot(session.id)?.workflowContext;
            const running = runValidationLoop({
                hostedSession: session,
                planName: "p",
                planContent: plan.body,
                triageMeta: plan.attrs,
                localCI: {
                    run: () => {
                        ciRuns++;
                        assertEquals(snapshot()?.liveReviewUrl, firstUrl, "CI must retain the review link");
                        return Promise.resolve({ kind: "completed" as const, exitCode: 0, output: "ok" });
                    },
                },
                semanticReviewPort: {
                    runIsolatedAgentSession: async (options) => {
                        agentStarted.resolve();
                        await releaseAgent.promise;
                        if (revise) {
                            await writeFile(join(projectRoot, "label.ts"), "export const label = 'revised';\n");
                            await executeWorkflowTestTools(options, [
                                { name: "task_completed", arguments: { message: "Updated the label." } },
                            ]);
                            return [];
                        }
                        return [fauxAssistantMessage(fauxText("The label identifies this fixture."))];
                    },
                },
            });
            let firstUrl = "";
            try {
                firstUrl = await opened[0]!.promise;
                assertEquals(snapshot()?.liveReviewUrl, firstUrl, "Open Code Review must have the real ready URL");
                assertEquals(snapshot()?.liveCodeReview, true);
                const parsed = new URL(firstUrl);
                const token = parsed.searchParams.get("token")!;
                const respond = async (approved: boolean) => {
                    const statusResponse = await fetch(
                        new URL(`/api/review/conversation?token=${token}`, parsed.origin),
                    );
                    assertEquals(statusResponse.status, 200);
                    const { reviewRevision } = await statusResponse.json();
                    const response = await fetch(
                        new URL(`/api/review/${approved ? "decision" : "deny"}?token=${token}`, parsed.origin),
                        {
                            method: "POST",
                            headers: { "content-type": "application/json", "x-runwield-review-token": token },
                            body: JSON.stringify(
                                approved
                                    ? { approved: true, reviewRevision }
                                    : {
                                          approved: false,
                                          reviewRevision,
                                          conversationTurn: true,
                                          feedback: revise ? "Change the label." : "Why this label?",
                                      },
                            ),
                        },
                    );
                    assertEquals(response.status, 200, await response.text());
                };
                await respond(false);
                await agentStarted.promise;
                assertEquals(session.getActiveInteractions().size, 0, "the Agent turn runs between review requests");
                assertEquals(snapshot()?.liveReviewUrl, firstUrl, "the conversation must retain the reopen URL");
                assertEquals(snapshot()?.liveCodeReview, true);
                releaseAgent.resolve();
                assertEquals(await opened[1]!.promise, firstUrl, "the real browser surface must reuse its URL");
                assertEquals(snapshot()?.liveReviewUrl, firstUrl, "the revised review must still be reopenable");
                await respond(true);
                const result = await running;
                assertEquals(result.kind, "verified", JSON.stringify(result));
                assertEquals(ciRuns, revise ? 1 : 0);
                assertEquals(snapshot()?.liveReviewUrl, undefined, "approval must remove the live URL");
                assertEquals(snapshot()?.liveCodeReview, false);
            } finally {
                // A failed assertion must also cancel any review that the gated Agent has yet to rearm.
                session.setInteractionAdapter({ requestInteraction: () => ({ outcome: "canceled" }) });
                releaseAgent.resolve();
                session.cancelActiveInteractions();
                await running;
                unsubscribe();
                await runtime.closeSession(session.id);
            }
        },
    );
}
