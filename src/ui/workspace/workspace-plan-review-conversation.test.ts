import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { savePlan, loadPlan, ensurePlanIdentity } from "../../plan-store.js";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";
import { collectArtifactConversationReply } from "./react/artifact-conversation.ts";

for (const source of ["new", "saved"] as const)
    for (const fails of [false, true])
        test(`Workspace ${source} ${fails ? "failed Agent" : "text-only"} Plan conversation has a new live review and accepts approval once`, async () => {
            await withRuntimeCommandFixture(
                "workspace-plan-conversation-",
                async ({ homeDir, projectRoot, setModelResponseFactories }) => {
                    await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nKeep the reviewed scope.\n", {
                        classification: "PLANNED_CHANGE",
                        status: "ready_for_work",
                        affectedPaths: [],
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                    });
                    setModelResponseFactories([
                        ...(source === "new"
                            ? [() => fauxAssistantMessage(fauxToolCall("plan_written", { planName: "target" }))]
                            : []),
                        () => {
                            if (fails) throw new Error("The planning provider is unavailable.");
                            return fauxAssistantMessage(
                                fauxText("The scope is unchanged; this is an explanation only."),
                            );
                        },
                    ]);
                    const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
                    const service = new WorkspaceSessionContinuationService({ store });
                    try {
                        const project = store.registerProject({ root: projectRoot, displayName: "Conversation" });
                        const plan = await ensurePlanIdentity(projectRoot, "target");
                        assert(plan);
                        const created =
                            source === "saved"
                                ? await service.startSavedPlanReview({
                                      projectId: project.projectId,
                                      requestId: "saved-review",
                                      planName: "target",
                                      triageMeta: plan.attrs,
                                  })
                                : await service.createSession({
                                      projectId: project.projectId,
                                      requestId: "create",
                                      text: "Review the saved Plan.",
                                      agentName: "planner",
                                  });
                        for (let i = 0; i < 500 && !service.getOperation(created.operationId)?.liveInteraction; i++)
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        const first = service.getOperation(created.operationId);
                        assert(first.liveInteraction);
                        const before = await loadPlan(projectRoot, "target");
                        assert(before);
                        const eventStartIndex = first.events.length;
                        const request = {
                            projectId: project.projectId,
                            operationId: created.operationId,
                            interactionId: first.liveInteraction.interactionId,
                            runwieldSessionId: first.runwieldSessionId!,
                            requestId: "question",
                            response: { approved: false, conversationTurn: true, feedback: "Why this scope?" },
                        };
                        await service.answerInteraction(request);
                        for (let i = 0; i < 500; i++) {
                            const interaction = service.getOperation(created.operationId)?.liveInteraction;
                            if (interaction && interaction.interactionId !== first.liveInteraction.interactionId) break;
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        }
                        const second = service.getOperation(created.operationId);
                        assert(second.liveInteraction, JSON.stringify(second));
                        assert(second.liveInteraction.interactionId !== first.liveInteraction.interactionId);
                        assertEquals(second.liveInteraction.request.type, "plan_review");
                        const reply = collectArtifactConversationReply(second.events, eventStartIndex);
                        assertStringIncludes(
                            reply.text,
                            fails
                                ? "Agent error: The model service could not complete this request."
                                : "The scope is unchanged",
                        );
                        assertEquals(await readFile(before.path, "utf8"), before.markdown);
                        assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "ready_for_work");
                        await service.answerInteraction(request); // A repeated send must not close the new round.
                        assertEquals(
                            service.getOperation(created.operationId).liveInteraction?.interactionId,
                            second.liveInteraction.interactionId,
                        );
                        await service.answerInteraction({
                            ...request,
                            requestId: "approve",
                            interactionId: second.liveInteraction.interactionId,
                            response: { approved: true, approvalAction: "later" },
                        });
                        for (let i = 0; i < 500 && service.getOperation(created.operationId).status === "running"; i++)
                            await new Promise((resolve) => setTimeout(resolve, 10));
                        assertEquals(service.getOperation(created.operationId).status, "completed");
                        assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "ready_for_work");
                    } finally {
                        await service.close();
                        store.close();
                    }
                },
            );
        });
