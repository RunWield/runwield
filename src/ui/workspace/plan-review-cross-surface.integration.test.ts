import { fileURLToPath } from "node:url";
// @ts-nocheck: The live session and owner service expose JavaScript records.
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { test } from "node:test";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";

function stopChild(child) {
    try {
        child.kill("SIGTERM");
    } catch (error) {
        if (!(error instanceof TypeError && error.message === "Child process has already terminated")) {
            throw error;
        }
    }
}

async function withRemoteReview(changePlan, expectDecision) {
    await withRuntimeCommandFixture("workspace-cross-review-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        const plan = await savePlan(projectRoot, "saved", "# Saved\n\n## Context\n\nThe original review body.\n", {
            planId: "saved-id",
            classification: "PLANNED_CHANGE",
            status: "draft",
            affectedPaths: [],
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        });
        const serviceStore = fixture.openStore();
        const service = new WorkspaceSessionContinuationService({ store: serviceStore });
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
                    type: "plan_review", prompt: "Review saved Plan",
                    _meta: { planId: "saved-id", planName: "saved", planPath: ${JSON.stringify(plan)},
                        planningAgentName: "planner", triageMeta: { planId: "saved-id", classification: "PLANNED_CHANGE" } },
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
            cwd: projectRoot,
            stdout: "piped",
            stderr: "piped",
            stdin: "null",
        });
        const outputPromise = collectProcessOutput(child);
        let finished = false;
        try {
            let operation;
            for (let index = 0; index < 400; index++) {
                operation =
                    (await service.liveSession(fixture.project.projectId, fixture.session.runwieldSessionId)).operation;
                if (operation?.liveInteraction?.request?.reviewUrl) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert(operation?.liveInteraction?.request?.reviewUrl, "The live TUI review must appear in Workspace");
            assertEquals(operation.remote, true);
            await changePlan(projectRoot);
            const answer = () =>
                service.answerInteraction({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    operationId: operation.operationId,
                    interactionId: operation.liveInteraction.interactionId,
                    requestId: "review-decision",
                    response: {
                        outcome: "accepted",
                        _meta: {
                            approved: true,
                            approvalAction: "later",
                            executionAgent: "engineer",
                            collaborationRecommendation: "autonomous",
                        },
                    },
                });
            await expectDecision(answer, projectRoot);
            if (changePlan === unchanged) {
                const output = await outputPromise;
                finished = true;
                assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
                assertEquals(JSON.parse(new TextDecoder().decode(output.stdout).trim()).outcome, "accepted");
            }
        } finally {
            if (!finished) {
                stopChild(child);
                await outputPromise.catch(() => {});
            }
            service.close();
            serviceStore.close();
            await fixture.cleanup();
        }
    });
}

async function unchanged() {}

test("Workspace approves the original Plan from a live TUI review", async () => {
    await withRemoteReview(unchanged, async (answer, root) => {
        assertEquals((await answer()).status, "accepted");
        assertEquals((await loadPlan(root, "saved"))?.attrs.status, "approved");
    });
});

test("Workspace rejects a changed Plan from a live TUI review", async () => {
    await withRemoteReview(async (root) => {
        const current = await loadPlan(root, "saved");
        await savePlan(root, "saved", "# Saved\n\n## Context\n\nChanged after review opened.\n", current.attrs, {
            expectedRevision: current.revision,
        });
    }, async (answer, root) => {
        let error;
        try {
            await answer();
        } catch (cause) {
            error = cause;
        }
        assert(error, "The changed Plan must not be approved");
        assertStringIncludes((await loadPlan(root, "saved")).body, "Changed after review opened.");
    });
});
