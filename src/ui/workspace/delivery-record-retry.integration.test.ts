import { assertEquals } from "@std/assert";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { WorkspaceSessionContinuationService } from "./server/session-continuation.js";
import { ownerSessionPlanWorkflowApi } from "./routes/owner-session-api.js";
import { createPublicationAttempt } from "../../shared/workflow/publication-attempt.ts";
import { retainPublishedWorkRecordSource } from "../../shared/work-records/published-source.ts";

const repository = defineCommittedGitFixture({ ".gitignore": ".wld/internal/\n" });
for (const missing of [false, true]) {
    Deno.test(`Work Record retry resolves retained publication with ${missing ? "missing" : "stale"} primary Plan`, async () => {
        await withRuntimeCommandFixture("delivery-record-retry-", async ({ setModelResponseFactory }) => {
            const root = await repository.checkout();
            const store = openOwnerCoordinationStore();
            const project = store.registerProject({ root });
            const runtime = createSessionRuntime({ sessionStore: store });
            const service = new WorkspaceSessionContinuationService({ store });
            let turns = 0;
            setModelResponseFactory(() => {
                turns++;
                throw new Error("Ineligible Quick Fix must not invoke a model");
            });
            try {
                await savePlan(root, "delivered", "# Delivered\n", {
                    planId: "delivered-id",
                    classification: "QUICK_FIX",
                    status: "verified",
                });
                await git(root, ["add", "docs"]);
                await git(root, ["commit", "-m", "sealed delivery"]);
                const commit = await git(root, ["rev-parse", "HEAD"]);
                await retainPublishedWorkRecordSource(root, {
                    ...createPublicationAttempt({
                        attemptId: "receipt",
                        planId: "delivered-id",
                        planName: "delivered",
                        targetBranch: "main",
                        executionBranch: "feature",
                        executionCwd: root,
                        publicationRoot: root,
                        validatedCommit: commit,
                        targetHeadAtSeal: commit,
                    }),
                    phase: "publication_verified",
                    artifactCommit: commit,
                    publishedCommit: commit,
                    verifiedAt: "2026-10-08T10:00:00Z",
                });
                const created = await runtime.createInteractiveSession({ cwd: root });
                const sessionId = runtime.getSessionSnapshot(created.sessionId)?.managed?.runwieldSessionId || "";
                await runtime.closeAllSessionsWhenIdle();
                if (missing) await Deno.remove(`${root}/docs/plans/delivered.md`);
                else {await Deno.writeTextFile(
                        `${root}/docs/plans/delivered.md`,
                        "---\nplanId: delivered-id\nclassification: QUICK_FIX\nstatus: ready_for_work\n---\n# Primary edit\n",
                    );}
                const generation = store.inspectSessionActivation(sessionId).generation?.generation;
                const response = await ownerSessionPlanWorkflowApi({
                    req: new Request("http://workspace.local/plan-workflow", {
                        method: "POST",
                        body: JSON.stringify({
                            requestId: crypto.randomUUID(),
                            action: "retry_work_record",
                            planId: "delivered-id",
                            expectedGeneration: generation,
                        }),
                    }),
                    params: { projectId: project.projectId, runwieldSessionId: sessionId },
                    state: { store, sessionContinuation: service },
                });
                const body = await response.json();
                assertEquals(response.status, 202, JSON.stringify(body));
                for (let i = 0; i < 500 && service.getOperation(body.operationId)?.status === "running"; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                assertEquals(
                    service.getOperation(body.operationId)?.status,
                    "completed",
                    JSON.stringify(service.getOperation(body.operationId)),
                );
                assertEquals(turns, 0);
                assertEquals(await git(root, ["rev-parse", "HEAD"]), commit);
                if (!missing) assertEquals((await loadPlan(root, "delivered"))?.body.trim(), "# Primary edit");
            } finally {
                await service.runtime.closeAllSessions();
                service.close();
                await runtime.closeAllSessionsWhenIdle();
                store.close();
                await Deno.remove(root, { recursive: true });
            }
        });
    });
}
