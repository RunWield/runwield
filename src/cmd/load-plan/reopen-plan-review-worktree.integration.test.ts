import { assertEquals } from "../../testing/assertions.ts";
import { fileURLToPath } from "node:url";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { executePlan } from "../../shared/workflow/plan-executor.ts";
import { join } from "node:path";
import { defineGitFixture, git } from "../../shared/git-test-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { preparePlanningWorktreeForPlan } from "../../shared/workflow/planning-worktree.ts";
import { loadPlanActionEvidence } from "../../shared/workflow/plan-actions.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { WorkspaceSessionContinuationService } from "../../ui/workspace/server/session-continuation.js";
import {
    prepareSequenceReview,
    type SequenceReviewDocument,
    validateSequenceReviewDecision,
} from "../../shared/workflow/sequence-review.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { reopenSavedPlanReview } from "./reopen-plan-review.ts";

const repoFixture = defineGitFixture(async (repo) => {
    await fsWriteFile(join(repo, "README.md"), "base\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    await git(repo, ["switch", "-c", "review-target"]);
    await savePlan(repo, "sequence", "# Sequence\n\n## Context\n\nReview the set.\n", {
        planId: "sequence-id",
        classification: "PROJECT",
        type: "sequence",
        status: "draft",
        targetBranch: "review-target",
        affectedPaths: [],
    });
    await savePlan(repo, "sequence/first", "# First\n\n## Context\n\nReview this child.\n", {
        planId: "first-id",
        classification: "PLANNED_CHANGE",
        status: "draft",
        parentPlan: "sequence",
        order: 1,
        dependencies: [],
        affectedPaths: [],
        executionAgent: "engineer",
        collaborationRecommendation: "autonomous",
        targetBranch: "review-target",
    });
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "sequence"]);
    await git(repo, ["switch", "main"]);
});

test("reopened Sequence sends a complete group decision from its registered planning worktree", async () => {
    await withRuntimeCommandFixture("reopen-worktree-sequence-", async ({ homeDir }) => {
        const repo = await repoFixture.checkout();
        const planning = await preparePlanningWorktreeForPlan(repo, "sequence", {
            planId: "sequence-id",
            targetBranch: "review-target",
        });
        assertEquals(await loadPlan(repo, "sequence"), null);
        for (const id of ["sequence-id", "first-id"]) {
            const evidence = await loadPlanActionEvidence(planning.entry.path, id);
            assertEquals(evidence.kind, "success", JSON.stringify({ id, evidence }));
        }
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: repo, mode: "new" });
            runtime.setInteractionAdapter(sessionId, { requestInteraction: () => ({ outcome: "canceled" }) });
            await runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "First review",
                _meta: { planId: "sequence-id", planName: "sequence", planningAgentName: "planner" },
            });
            runtime.setInteractionAdapter(sessionId, {
                async requestInteraction(request) {
                    if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) return { outcome: "canceled" };
                    const documents = request._meta?.sequenceDocuments as SequenceReviewDocument[];
                    const decision = {
                        approved: true,
                        approvalAction: "later" as const,
                        documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                    };
                    await validateSequenceReviewDecision(String(request._meta?.cwd), documents, decision);
                    return { outcome: "accepted", _meta: { sequenceDecision: decision } };
                },
            });
            const result = await runtime.reopenPlanReview(sessionId);
            assertEquals(result.kind, "complete", result.message);
            assertEquals((await loadPlan(planning.entry.path, "sequence"))?.attrs.status, "ready_for_work");
            assertEquals((await loadPlan(planning.entry.path, "sequence/first"))?.attrs.status, "ready_for_work");
            assertEquals(await loadPlan(repo, "sequence"), null);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});

test("Approve & Run executes the first Sequence child saved only in its planning worktree", async () => {
    await withRuntimeCommandFixture("reopen-worktree-sequence-run-", async ({ homeDir, setModelMessages }) => {
        const repo = await repoFixture.checkout();
        const planning = await preparePlanningWorktreeForPlan(repo, "sequence", {
            planId: "sequence-id",
            targetBranch: "review-target",
        });
        assertEquals(await loadPlan(repo, "sequence/first"), null);
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: repo, mode: "new" });
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction(request) {
                    if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) return { outcome: "canceled" };
                    const documents = request._meta?.sequenceDocuments as SequenceReviewDocument[];
                    return {
                        outcome: "accepted",
                        _meta: {
                            sequenceDecision: {
                                approved: true,
                                approvalAction: "run",
                                documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                            },
                        },
                    };
                },
            });
            const result = await reopenSavedPlanReview(runtime, sessionId, {
                planId: "sequence-id",
                planName: "sequence",
                planningAgentName: "planner",
                requestedAt: "2026-01-01T00:00:00.000Z",
            }, () => {});
            assertEquals(result.kind, "complete", result.message);
            assertEquals(result.executionToStart?.options.planName, "sequence/first");
            assertEquals(result.executionToStart?.options.approvalEvidence?.planId, "first-id");
            assertEquals((await loadPlan(planning.entry.path, "sequence/first"))?.attrs.status, "ready_for_work");
            assertEquals(await loadPlan(repo, "sequence/first"), null);

            setModelMessages([
                fauxAssistantMessage(fauxToolCall("task_completed", { message: "- Child implemented." })),
            ]);
            const sessionManager = SessionManager.inMemory(repo);
            const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: repo });
            hostedSession.setRootSessionManager(sessionManager);
            const execution = await executePlan({
                planName: "sequence/first",
                triageMeta: result.executionToStart?.options.triageMeta,
                approvalEvidence: result.executionToStart?.options.approvalEvidence,
                sessionManager,
                hostedSession,
            });
            assertEquals(execution.executionComplete, true, execution.error);
            const executionCwd = execution.executionContext?.executionCwd;
            assert(executionCwd && executionCwd !== repo);
            assertEquals((await loadPlan(executionCwd, "sequence/first"))?.attrs.status, "implemented");
            assertEquals((await loadPlan(executionCwd, "sequence"))?.attrs.planId, "sequence-id");
            assertEquals(await loadPlan(repo, "sequence/first"), null);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            store.close();
        }
    });
});

test("Workspace accepts a live Sequence group decision from a registered planning worktree", async () => {
    await withRuntimeCommandFixture("workspace-worktree-sequence-", async ({ homeDir }) => {
        const repo = await repoFixture.checkout();
        const planning = await preparePlanningWorktreeForPlan(repo, "sequence", {
            planId: "sequence-id",
            targetBranch: "review-target",
        });
        const documents = await prepareSequenceReview(planning.entry.path, "sequence");
        assertEquals(await loadPlan(repo, "sequence"), null);
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot: repo });
        const store = fixture.openStore();
        const service = new WorkspaceSessionContinuationService({ store });
        const storeUrl = new URL("../../shared/owner-coordination/index.js", import.meta.url).href;
        const runtimeUrl = new URL("../../shared/session/session-runtime.ts", import.meta.url).href;
        const code = `
            import { openOwnerCoordinationStore } from ${JSON.stringify(storeUrl)};
            import { createSessionRuntime } from ${JSON.stringify(runtimeUrl)};
            const store = openOwnerCoordinationStore({ dbPath: ${JSON.stringify(fixture.dbPath)} });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "tui" });
            const session = store.getSessionById(${JSON.stringify(fixture.session.runwieldSessionId)});
            const adopted = runtime.adoptManagedSession({ session, generation: 0 });
            runtime.setInteractionAdapter(adopted.sessionId, {
                supportsInteraction: () => true,
                requestInteraction: (_request, signal) => new Promise(resolve => {
                    signal.addEventListener("abort", () => resolve({ outcome: "canceled" }), { once: true });
                }),
            });
            try {
                const answer = await runtime.requestInteraction(adopted.sessionId, {
                    type: "plan_review", prompt: "Review Sequence",
                    _meta: { planId: "sequence-id", planName: "sequence", planningAgentName: "planner",
                        sequenceDocuments: ${JSON.stringify(documents)} },
                });
                console.log(JSON.stringify(answer));
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        `;
        const child = spawnNativeProcess(process.execPath, {
            args: runtimeSourceArgs([
                "eval",
                "--config",
                fileURLToPath(new URL("../../../deno.json", import.meta.url)),
                code,
            ]),
            cwd: repo,
            stdout: "piped",
            stderr: "piped",
            stdin: "null",
        });
        const outputPromise = collectProcessOutput(child);
        let finished = false;
        try {
            let operation: Awaited<ReturnType<typeof service.liveSession>>["operation"] = null;
            for (let index = 0; index < 400; index++) {
                operation =
                    (await service.liveSession(fixture.project.projectId, fixture.session.runwieldSessionId)).operation;
                if (operation?.liveInteraction?.request?.reviewUrl) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert(operation?.liveInteraction?.request?.reviewUrl, "The Sequence review must appear in Workspace");
            const decision = {
                approved: true,
                approvalAction: "later" as const,
                documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
            };
            const response = await service.answerInteraction({
                projectId: fixture.project.projectId,
                runwieldSessionId: fixture.session.runwieldSessionId,
                operationId: operation.operationId,
                interactionId: operation.liveInteraction.interactionId,
                requestId: "group-decision",
                response: { outcome: "accepted", _meta: decision },
            });
            assertEquals(response.status, "accepted");
            const output = await outputPromise;
            finished = true;
            assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
            assertEquals(
                JSON.parse(new TextDecoder().decode(output.stdout).trim())._meta.sequenceDecision.approved,
                true,
            );
            assertEquals(await loadPlan(repo, "sequence"), null);
        } finally {
            if (!finished) {
                child.kill("SIGTERM");
                await outputPromise.catch(() => {});
            }
            service.close();
            store.close();
            await fixture.cleanup();
        }
    });
});
