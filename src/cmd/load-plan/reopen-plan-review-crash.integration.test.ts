import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { ensurePlanIdentity, loadPlan, savePlan } from "../../plan-store.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { RuntimeInteractionTypes } from "../../shared/session/session-runtime-interactions.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createOwnerWorkspaceApp } from "../../ui/workspace/server.js";

type OwnerApp = ReturnType<typeof createOwnerWorkspaceApp> & { close(): Promise<void> };

type ReviewCrashLiveState = {
    state?: string;
    status?: string;
    interactionType?: string;
    hasReviewUrl: boolean;
};

test("a Session reopens the current saved Plan after its pending review process is killed", async () => {
    await withRuntimeCommandFixture(
        "reopen-review-crash-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nOriginal content.\n", {
                classification: "PLANNED_CHANGE",
                status: "approved",
                affectedPaths: [],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const plan = await ensurePlanIdentity(projectRoot, "target");
            const readyPath = join(homeDir, "review-pending.json");
            // This process creates the real Session and leaves its review unresolved. It
            // never closes the runtime or settles the operation before SIGKILL.
            const script = `
            import { writeFileSync, renameSync } from "node:fs";
            import { createSessionRuntime } from ${JSON.stringify(
                import.meta.resolve("../../shared/session/session-runtime.ts"),
            )};
            import { openOwnerCoordinationStore } from ${JSON.stringify(
                import.meta.resolve("../../shared/owner-coordination/index.js"),
            )};
            import { RuntimeInteractionTypes } from ${JSON.stringify(
                import.meta.resolve("../../shared/session/session-runtime-interactions.js"),
            )};
            const ownerStore = openOwnerCoordinationStore({ dbPath: ${JSON.stringify(
                join(homeDir, "owner.sqlite3"),
            )} });
            const runtime = createSessionRuntime({ sessionStore: ownerStore, ownerProcessKind: "test" });
            const { sessionId } = await runtime.createInteractiveSession({ cwd: ${JSON.stringify(
                projectRoot,
            )}, mode: "new" });
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction(request) {
                    if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) throw new Error("Unexpected interaction");
                    const persistentId = runtime.getSessionSnapshot(sessionId).managed.runwieldSessionId;
                    writeFileSync(${JSON.stringify(readyPath + ".tmp")}, JSON.stringify({ persistentId }));
                    renameSync(${JSON.stringify(readyPath + ".tmp")}, ${JSON.stringify(readyPath)});
                    return new Promise(() => {});
                },
            });
            void runtime.requestInteraction(sessionId, {
                type: RuntimeInteractionTypes.PLAN_REVIEW,
                prompt: "Review target",
                _meta: { planId: ${JSON.stringify(
                    plan.attrs.planId,
                )}, planName: "target", planningAgentName: "planner" },
            });
            setInterval(() => {}, 1000);
        `;
            const worker = spawnNativeProcess(process.execPath, {
                args: runtimeSourceArgs([
                    "eval",
                    "--config",
                    fromFileUrl(new URL("../../../deno.json", import.meta.url)),
                    script,
                ]),
                stdout: "null",
                stderr: "piped",
                cwd: getCwd(),
                stdin: "null",
            });
            try {
                const deadline = Date.now() + 15_000;
                let persistentId = "";
                while (Date.now() < deadline) {
                    try {
                        persistentId = JSON.parse(await fsReadFile(readyPath, "utf8")).persistentId;
                        if (persistentId) break;
                    } catch (error) {
                        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                if (!persistentId) {
                    try {
                        worker.kill("SIGKILL");
                    } catch {
                        /* Already stopped. */
                    }
                    const output = await collectProcessOutput(worker);
                    throw new Error(`Review did not become pending: ${new TextDecoder().decode(output.stderr)}`);
                }
                worker.kill("SIGKILL");
                const killed = await worker.status;
                assertEquals(killed.success, false);

                // A newer saved version, not the pending request's original text, must be reviewed.
                const savedBeforeEdit = await loadPlan(projectRoot, "target");
                assert(savedBeforeEdit);
                await savePlan(
                    projectRoot,
                    "target",
                    "# Target\n\n## Context\n\nUpdated after crash.\n",
                    {
                        ...savedBeforeEdit.attrs,
                        status: "approved",
                    },
                    { expectedRevision: savedBeforeEdit.revision },
                );
                let modelTurns = 0;
                setModelResponseFactory(() => {
                    modelTurns++;
                    return fauxAssistantMessage(fauxText("Unexpected model turn"));
                });
                const ownerStore = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
                const runtime = createSessionRuntime({ sessionStore: ownerStore, ownerProcessKind: "test" });
                try {
                    const resumed = await runtime.createInteractiveSession({
                        cwd: projectRoot,
                        mode: "continue",
                        resumeSessionId: persistentId,
                    });
                    let reviewedContent = "";
                    runtime.setInteractionAdapter(resumed.sessionId, {
                        async requestInteraction(request) {
                            if (request.type === RuntimeInteractionTypes.PLAN_REVIEW) {
                                assertEquals(request._meta?.planName, "target");
                                assertEquals(request._meta?.planningAgentName, "planner");
                                reviewedContent = await fsReadFile(String(request._meta?.planPath), "utf8");
                                return { outcome: "accepted", _meta: { approved: true, approvalAction: "later" } };
                            }
                            return { outcome: "canceled" };
                        },
                    });
                    const result = await runtime.reopenPlanReview(resumed.sessionId);
                    assertEquals(result.kind, "complete", result.message);
                    assertStringIncludes(reviewedContent, "Updated after crash.");
                    assertEquals(modelTurns, 0);
                    assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "ready_for_work");
                } finally {
                    await runtime.closeAllSessionsWhenIdle();
                    ownerStore.close();
                }
            } finally {
                try {
                    worker.kill("SIGKILL");
                } catch {
                    /* Already stopped. */
                }
                await worker.status;
            }
        },
    );
});

test("Workspace opens and approves a saved Plan review after its owner is SIGKILLed", async () => {
    await withRuntimeCommandFixture(
        "workspace-review-crash-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            await savePlan(projectRoot, "target", "# Target\n\n## Context\n\nOriginal content.\n", {
                classification: "PLANNED_CHANGE",
                status: "approved",
                affectedPaths: [],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const plan = await ensurePlanIdentity(projectRoot, "target");
            const readyPath = join(homeDir, "workspace-review-pending.json");
            const script = `
            import { writeFileSync, renameSync } from "node:fs";
            import { createSessionRuntime } from ${JSON.stringify(
                import.meta.resolve("../../shared/session/session-runtime.ts"),
            )};
            import { openOwnerCoordinationStore } from ${JSON.stringify(
                import.meta.resolve("../../shared/owner-coordination/index.js"),
            )};
            import { RuntimeInteractionTypes } from ${JSON.stringify(
                import.meta.resolve("../../shared/session/session-runtime-interactions.js"),
            )};
            const store = openOwnerCoordinationStore({ dbPath: ${JSON.stringify(join(homeDir, "owner.sqlite3"))} });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            const { sessionId } = await runtime.createInteractiveSession({ cwd: ${JSON.stringify(
                projectRoot,
            )}, mode: "new" });
            const persistentId = runtime.getSessionSnapshot(sessionId).managed.runwieldSessionId;
            const projectId = store.getSessionById(persistentId).projectId;
            store.registerProject({ root: ${JSON.stringify(projectRoot)}, idFactory: () => projectId });
            const activation = store.inspectSessionActivation(persistentId);
            const proof = store.acquireSessionActivation({
                runwieldSessionId: persistentId, projectId: store.getSessionById(persistentId).projectId,
                ownerInstanceId: "review-setup", ownerProcessKind: "test",
                expectedGeneration: activation.generation.generation,
                expectedCurrentSegmentId: activation.generation.currentSegmentId,
            });
            store.recordLastPlanReview(proof, {
                planId: ${JSON.stringify(plan.attrs.planId)}, planName: "target", planningAgentName: "planner",
            });
            store.releaseUnchangedActivation(proof);
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction(request) {
                    if (request.type !== RuntimeInteractionTypes.PLAN_REVIEW) throw new Error("Unexpected interaction");
                    writeFileSync(${JSON.stringify(readyPath + ".tmp")}, JSON.stringify({ persistentId }));
                    renameSync(${JSON.stringify(readyPath + ".tmp")}, ${JSON.stringify(readyPath)});
                    return new Promise(() => {});
                },
            });
            void runtime.reopenPlanReview(sessionId);
            setInterval(() => {}, 1000);
        `;
            const worker = spawnNativeProcess(process.execPath, {
                args: runtimeSourceArgs([
                    "eval",
                    "--config",
                    fromFileUrl(new URL("../../../deno.json", import.meta.url)),
                    script,
                ]),
                stdout: "null",
                stderr: "piped",
                cwd: getCwd(),
                stdin: "null",
            });
            try {
                let persistentId = "";
                const deadline = Date.now() + 15_000;
                while (Date.now() < deadline) {
                    try {
                        persistentId = JSON.parse(await fsReadFile(readyPath, "utf8")).persistentId;
                        if (persistentId) break;
                    } catch (error) {
                        // A read can race with the signal file being written.
                        if (
                            !(error instanceof Error && "code" in error && error.code === "ENOENT") &&
                            !(error instanceof SyntaxError)
                        )
                            throw error;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                if (!persistentId) {
                    worker.kill("SIGKILL");
                    const output = await collectProcessOutput(worker);
                    throw new Error(`Review did not become pending: ${new TextDecoder().decode(output.stderr)}`);
                }
                worker.kill("SIGKILL");
                assertEquals((await worker.status).success, false);

                const previous = await loadPlan(projectRoot, "target");
                assert(previous);
                await savePlan(
                    projectRoot,
                    "target",
                    "# Target\n\n## Context\n\nUpdated after crash.\n",
                    {
                        ...previous.attrs,
                        status: "approved",
                    },
                    { expectedRevision: previous.revision },
                );
                const updated = await loadPlan(projectRoot, "target");
                assert(updated);
                let modelTurns = 0;
                setModelResponseFactory(() => {
                    modelTurns++;
                    return fauxAssistantMessage(fauxText("Unexpected model turn"));
                });
                const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
                let app: OwnerApp | undefined;
                let phase = "inspect recovered Session";
                let cleanupOperationId = "";
                let cleanupBase = "";
                let cleanupHeaders: Record<string, string> = {};
                let latestLive: ReviewCrashLiveState | undefined;
                let latestOperationStatus: string | undefined;
                try {
                    const session = store.getSessionById(persistentId);
                    assert(session);
                    const projectId = session.projectId;
                    const activation = store.inspectSessionActivation(persistentId);
                    assert(["idle", "reconcile_required"].includes(activation.activation?.state || ""));
                    assert(activation.generation);
                    const pairing = store.createPairingRequest({
                        codeFactory: () => "KIL123",
                        proofFactory: () => "killed-proof",
                    });
                    store.approvePairingRequest(pairing.code);
                    const device = store.claimPairingRequest(pairing.proof, {
                        credentialFactory: () => "killed-credential",
                        csrfFactory: () => "killed-csrf",
                    });
                    phase = "create Workspace app";
                    app = createOwnerWorkspaceApp({
                        mode: "owner",
                        publicOrigin: "http://127.0.0.1:8787",
                        store,
                    }) as OwnerApp;
                    const base = `http://127.0.0.1:8787/api/owner/projects/${projectId}`;
                    const sessionBase = `${base}/sessions/${persistentId}`;
                    const cookie = `rw_owner_device=${device.credential}; rw_owner_csrf=killed-csrf`;
                    const headers = { origin: "http://127.0.0.1:8787", cookie, "x-runwield-csrf": "killed-csrf" };
                    cleanupBase = "http://127.0.0.1:8787/api/owner/session-operations";
                    cleanupHeaders = headers;
                    phase = "POST reopened review";
                    // Do not call the manual recovery route or resume the Runtime in the test.
                    const opened = await app.handler()(
                        new Request(`${sessionBase}/plan-review`, {
                            method: "POST",
                            headers,
                            body: JSON.stringify({
                                requestId: "reopen-killed-review",
                                expectedGeneration: activation.generation.generation,
                            }),
                        }),
                    );
                    assertEquals(opened.status, 202, await opened.clone().text());
                    const { operationId, kind } = await opened.json();
                    cleanupOperationId = operationId;
                    assertEquals(kind, "starting");
                    phase = "wait for live review";
                    let review;
                    for (let index = 0; index < 300; index++) {
                        const response = await app.handler()(
                            new Request(`${sessionBase}/live`, { headers: { cookie } }),
                        );
                        assertEquals(response.status, 200, await response.clone().text());
                        const live = await response.json();
                        review = live.operation?.liveInteraction?.request;
                        latestLive = {
                            state: live.state,
                            status: live.operation?.status,
                            interactionType: review?.type,
                            hasReviewUrl: Boolean(review?.reviewUrl),
                        };
                        if (review?.reviewUrl) break;
                        if (live.operation?.status === "failed") throw new Error(live.operation.error);
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    assert(review?.reviewUrl, "Workspace did not reopen the killed review");
                    assertEquals(review.type, "plan_review");
                    assertStringIncludes(review.reviewUrl, `/projects/${projectId}/plans/${plan.attrs.planId}?`);
                    assertEquals(review.planReview.expectedRevision, updated.revision);
                    phase = "POST review answer";
                    const answer = await app.handler()(
                        new Request(`${base}/session-operations/${operationId}/interactions/${review.id}/answer`, {
                            method: "POST",
                            headers,
                            body: JSON.stringify({
                                runwieldSessionId: persistentId,
                                requestId: "approve-killed-review",
                                response: {
                                    approved: true,
                                    approvalAction: "later",
                                    executionAgent: "engineer",
                                    collaborationRecommendation: "autonomous",
                                },
                            }),
                        }),
                    );
                    assertEquals(answer.status, 202, await answer.clone().text());
                    phase = "wait for review completion";
                    let completed = false;
                    // Approval returns before readiness persistence and the managed
                    // Session checkpoint finish, especially on native Windows ARM64.
                    const completionDeadline = Date.now() + 15_000;
                    while (Date.now() < completionDeadline) {
                        const operation = await (
                            await app.handler()(
                                new Request(`http://127.0.0.1:8787/api/owner/session-operations/${operationId}`, {
                                    headers: { cookie },
                                }),
                            )
                        ).json();
                        latestOperationStatus = operation.status;
                        if (operation.status === "completed") {
                            completed = true;
                            break;
                        }
                        if (operation.status === "failed") throw new Error(operation.error);
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    if (!completed) {
                        const live = await (
                            await app.handler()(new Request(`${sessionBase}/live`, { headers: { cookie } }))
                        ).json();
                        latestLive = {
                            state: live.state,
                            status: live.operation?.status,
                            interactionType: live.operation?.liveInteraction?.request?.type,
                            hasReviewUrl: Boolean(live.operation?.liveInteraction?.request?.reviewUrl),
                        };
                        const currentActivation = store.inspectSessionActivation(persistentId);
                        console.error(
                            "[reopen-review-crash] completion state",
                            JSON.stringify({
                                activationState: currentActivation.activation?.state,
                                generation: currentActivation.generation?.generation,
                                planStatus: (await loadPlan(projectRoot, "target"))?.attrs.status,
                            }),
                        );
                    }
                    assert(completed, "Workspace review did not complete");
                    phase = "verify approved Plan";
                    assertEquals((await loadPlan(projectRoot, "target"))?.attrs.status, "ready_for_work");
                    assertEquals(modelTurns, 0);
                } catch (error) {
                    // Report before shutdown: a failed poll may leave a review awaiting
                    // an answer, and app.close() waits for that managed operation.
                    // Record only state summaries; never headers, cookies, or review URLs.
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(
                        "[reopen-review-crash]",
                        JSON.stringify({
                            phase,
                            latestLive,
                            latestOperationStatus,
                            error: message
                                .replaceAll("killed-credential", "[credential]")
                                .replaceAll("killed-csrf", "[csrf]")
                                .replaceAll("killed-proof", "[proof]"),
                        }),
                    );
                    if (app && cleanupOperationId && latestOperationStatus !== "completed") {
                        try {
                            const canceled = await app.handler()(
                                new Request(`${cleanupBase}/${cleanupOperationId}/cancel`, {
                                    method: "POST",
                                    headers: cleanupHeaders,
                                }),
                            );
                            console.error(
                                "[reopen-review-crash]",
                                JSON.stringify({
                                    phase: "cancel failed review before shutdown",
                                    status: canceled.status,
                                }),
                            );
                        } catch (cancelError) {
                            console.error(
                                "[reopen-review-crash]",
                                JSON.stringify({
                                    phase: "cancel failed review before shutdown",
                                    errorName: cancelError instanceof Error ? cancelError.name : "non-Error rejection",
                                }),
                            );
                        }
                    }
                    throw error;
                } finally {
                    console.error("[reopen-review-crash]", JSON.stringify({ phase: "Workspace shutdown started" }));
                    await app?.close();
                    store.close();
                    console.error("[reopen-review-crash]", JSON.stringify({ phase: "Workspace shutdown finished" }));
                }
            } finally {
                try {
                    worker.kill("SIGKILL");
                } catch {
                    /* Already stopped. */
                }
                await worker.status;
            }
        },
    );
});
