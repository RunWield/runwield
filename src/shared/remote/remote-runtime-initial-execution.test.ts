import { test } from "node:test";
import { ok as assert, rejects } from "node:assert/strict";
import { readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { WORKFLOW_TOOL_EVENT_CUSTOM_TYPE } from "@runwield/workflow/events";
import {
    assertRemoteStorageAbsent,
    latch,
    within,
    withRemoteRuntimeFixture,
    withRetainedRemoteRuntimeFixture,
    type RuntimeFixture,
    type RuntimeProcess,
} from "./remote-runtime-test-fixture.ts";
import type { RuntimeClientReport } from "./remote-runtime-test-client.ts";
import {
    deliveryContextMarkdown,
    prepareDelivery,
    prepareDeliveryProject,
} from "./remote-runtime-workflows-fixture.ts";
import { ProjectStoreClient } from "./project-store-client.ts";
import type { ReviewPayload } from "../../ui/workspace/routes/api/review-handlers.ts";
import type { ProjectStoreBinding } from "../../plan-store/index.ts";

for (const planSource of ["managed-owner", "retained-checkout"] as const) {
    for (const agentName of ["planner", "router"]) {
        test(`Approve and Run from a remote ${agentName} turn starts execution for the ${planSource} Plan`, async () => {
            await withRemoteRuntimeFixture(
                async (f) => {
                    const canonical = planSource === "managed-owner";
                    if (canonical) await prepareDeliveryProject(f);
                    else await prepareDelivery(f);
                    const model = scriptInitialExecution(f, agentName, canonical ? deliveryContextMarkdown : undefined);
                    const client = await f.start();
                    try {
                        assertEquals((await client.read()).kind, "ready");
                        await client.send({
                            kind: "workflow-plan",
                            agentName,
                            text: "Plan the remote sentinel delivery.",
                        });
                        await approveAndRun(f, await client.read());
                        const completed = await client.read();
                        assertEquals(completed.ok, true, completed.error);
                        assert(completed.savedId);
                        const segments = f.store.listSessionTranscriptSegments(completed.savedId);
                        assertEquals(segments.length, 2, "Approve and Run must create an execution successor");
                        assertEquals(segments[1].kind, "execution");
                        assert(segments[0].sealedDigestHex, "The planning predecessor is sealed before execution");
                        assertEquals(
                            f.store.getCurrentSessionSegment(completed.savedId)?.segmentId,
                            segments[1].segmentId,
                        );
                        assertEquals(model.engineerRequests(), 1);
                        if (canonical) await assertCanonicalExecution(f, completed);
                    } catch (error) {
                        await client.terminate();
                        throw error;
                    } finally {
                        await client.close();
                    }
                    await assertRemoteStorageAbsent(f);
                },
                { planSource },
            );
        });
    }
}

async function assertCanonicalExecution(f: RuntimeFixture, completed: RuntimeClientReport) {
    const endpoint = `http://127.0.0.1:${f.connection.port}`;
    const response = await fetch(`${endpoint}/project-store/inspect`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.connection.credential}` },
    });
    assertEquals(response.status, 200);
    const binding: ProjectStoreBinding = await response.json();
    assert(binding?.projectId, "Planning must admit a canonical Project owner");
    const owner = new ProjectStoreClient(endpoint, f.connection.credential, binding);
    const resolved = (await owner.execute({ kind: "resolve-plan", reference: "remote-delivery" })).result;
    assert("plan" in resolved && resolved.plan?.attrs.planId);
    const plan = resolved.plan;
    const planId = plan.attrs.planId;
    assert(planId);
    assert(plan.path.startsWith(join(f.homeDir, ".wld", "projects", binding.projectId, "plans") + "/"));
    assertEquals(await readFile(plan.path, "utf8"), deliveryContextMarkdown);
    await rejects(stat(join(f.remoteProject, "docs/plans/remote-delivery.md")), { code: "ENOENT" });
    const reserved = (await owner.execute({ kind: "read-execution", planId })).result;
    assert("execution" in reserved && reserved.execution, "Owner must retain the execution reservation");
    assert(completed.activeWorkflow?.packageSelection);
    assertEquals(completed.activeWorkflow.packageAttemptId, reserved.execution.attemptId);
    assertEquals(completed.activeWorkflow.packageInput, reserved.execution.input);
}

interface AcceptedPlanEntry {
    type?: string;
    customType?: string;
    data?: {
        state?: string;
        kind?: string;
        payload?: { outcome?: string };
    };
}

function containsAcceptedExecution(contents: string) {
    return contents
        .trim()
        .split("\n")
        .some((line) => {
            const entry: AcceptedPlanEntry = JSON.parse(line);
            return (
                entry.type === "custom" &&
                entry.customType === WORKFLOW_TOOL_EVENT_CUSTOM_TYPE &&
                entry.data?.state === "accepted" &&
                entry.data.kind === "plan_written" &&
                entry.data.payload?.outcome === "approved_execute"
            );
        });
}

/** Only the external model is scripted; Plan review, writes and ownership are real. */
function scriptInitialExecution(f: RuntimeFixture, agentName = "planner", contextMarkdown?: string) {
    let executionProviderRequests = 0;
    f.setModelResponseFactories([
        ...(agentName === "router"
            ? [
                  () =>
                      fauxAssistantMessage(
                          fauxToolCall("triage_report", {
                              routingIntent: "PLANNED_CHANGE",
                              complexity: "LOW",
                              summary: "Plan a remote sentinel change.",
                          }),
                      ),
              ]
            : []),
        () =>
            fauxAssistantMessage(
                fauxToolCall("plan_written", {
                    planName: "remote-delivery",
                    ...(contextMarkdown === undefined
                        ? {}
                        : {
                              contextMarkdown,
                              validationMarkdown: "Read the sentinel and run the fixture verification command.\n",
                              targetBranch: "main",
                              definition: {
                                  summary: "Deliver a remote-only sentinel change",
                                  affectedPaths: ["sentinel.txt"],
                              },
                          }),
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                }),
            ),
        () => {
            // The accepted plan_written stops planning; the next provider turn belongs to execution.
            executionProviderRequests++;
            return fauxAssistantMessage(fauxText("Execution stopped at the model boundary."));
        },
    ]);
    return { engineerRequests: () => executionProviderRequests };
}

async function approveAndRun(f: RuntimeFixture, ready: RuntimeClientReport) {
    assertEquals(ready.kind, "review-ready", JSON.stringify(ready));
    assert(ready.reviewUrl);
    const page = new URL(ready.reviewUrl);
    const token = page.searchParams.get("token");
    assert(token);
    const reviewPage = await fetch(page, { unix: f.review.socketPath });
    assertEquals(reviewPage.status, 200);
    const embedded = (await reviewPage.text()).match(
        /<script[^>]*data-(?:code-)?review-payload[^>]*>([\s\S]*?)<\/script>/,
    )?.[1];
    assert(embedded, "Review page should contain the offered document revision");
    const revisions: Pick<ReviewPayload, "documentRevision" | "reviewRevision"> = JSON.parse(embedded);
    const response = await fetch(new URL("/api/review/decision", page.origin), {
        unix: f.review.socketPath,
        method: "POST",
        headers: { "content-type": "application/json", "x-runwield-review-token": token },
        body: JSON.stringify({
            documentRevision: revisions.documentRevision,
            reviewRevision: revisions.reviewRevision,
            approved: true,
            approvalAction: "run",
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        }),
    });
    assertEquals(response.status, 200, await response.text());
}

async function startPlanning(client: RuntimeProcess) {
    assertEquals((await client.read()).kind, "ready");
    await client.send({ kind: "workflow-plan-start", agentName: "planner" });
    assertEquals((await client.read()).kind, "workflow-plan-started");
    return await client.read();
}

test("canceling Approve and Run during the planning checkpoint prevents initial execution", async () => {
    await withRetainedRemoteRuntimeFixture(async (f) => {
        await prepareDelivery(f);
        const model = scriptInitialExecution(f);
        const checkpoint = latch();
        const releaseCheckpoint = latch();
        let accepted = false;
        let held = false;
        f.policy.handle = async (request, path, response) => {
            if (
                request.kind === "append" &&
                response.ok &&
                "contents" in request &&
                containsAcceptedExecution(request.contents)
            )
                accepted = true;
            if (path === "/session/control" && request.kind === "checkpoint" && response.ok && accepted && !held) {
                held = true;
                checkpoint.release();
                await releaseCheckpoint.promise;
            }
            return response;
        };
        const client = await f.start();
        try {
            await approveAndRun(f, await startPlanning(client));
            await within(checkpoint.promise);
            await client.send({ kind: "cancel" });
            const canceled = await client.read();
            assertEquals(canceled.kind, "cancel");
            assertEquals(canceled.ok, true);
            assert(canceled.savedId);
            assertEquals(f.store.listSessionTranscriptSegments(canceled.savedId).length, 1);
            assertEquals(model.engineerRequests(), 0);
            const requestsBeforeRelease = f.modelRequests.length;
            releaseCheckpoint.release();
            const completed = await client.read();
            assertEquals(completed.kind, "workflow-plan", JSON.stringify(completed));
            assert(completed.savedId);
            const segments = f.store.listSessionTranscriptSegments(completed.savedId);
            console.log(
                "checkpoint cancellation evidence",
                JSON.stringify({
                    segments: segments.map((segment) => segment.kind),
                    engineerRequests: model.engineerRequests(),
                    newProviderRequests: f.modelRequests.length - requestsBeforeRelease,
                }),
            );
            assertEquals(
                {
                    executionSegments: segments.filter((segment) => segment.kind === "execution").length,
                    engineerRequests: model.engineerRequests(),
                    newProviderRequests: f.modelRequests.length - requestsBeforeRelease,
                },
                {
                    executionSegments: 0,
                    engineerRequests: 0,
                    newProviderRequests: 0,
                },
                "Cancellation before successor creation must stop execution and its provider turn",
            );
        } finally {
            releaseCheckpoint.release();
            await client.close();
        }
    });
});

test("an evidence-load failure after Approve and Run clears the Agent transition", async () => {
    await withRetainedRemoteRuntimeFixture(async (f) => {
        await prepareDelivery(f);
        scriptInitialExecution(f);
        const planPath = join(f.remoteProject, "docs/plans/remote-delivery.md");
        const hiddenPath = join(f.remoteHome, "accepted-plan.md");
        let faultApplied = false;
        f.policy.handle = async (request, _path, response) => {
            if (
                !faultApplied &&
                request.kind === "append" &&
                response.ok &&
                "contents" in request &&
                containsAcceptedExecution(request.contents)
            ) {
                // The accepted event is already in the owner's real transcript. Review succeeded.
                const approvedPlan = await readFile(planPath, "utf8");
                assert(approvedPlan.includes('status: "ready_for_work"'), approvedPlan);
                await rename(planPath, hiddenPath);
                faultApplied = true;
            }
            return response;
        };
        const client = await f.start();
        try {
            await approveAndRun(f, await startPlanning(client));
            const failed = await client.read();
            assertEquals(failed.kind, "workflow-plan", JSON.stringify(failed));
            assertEquals(faultApplied, true, "Fault must follow the accepted approved_execute event");
            assertEquals(failed.ok, false, JSON.stringify(failed));
            // This message originates in loadPlanActionEvidence, not the earlier review guards.
            assertEquals(failed.error, "Error: Plan action evidence check failed.", JSON.stringify(failed));
            assert(failed.savedId);
            const transcript = (await f.control.list(failed.savedId))[0].contents;
            assert(transcript);
            assert(containsAcceptedExecution(transcript), "Owner must retain the accepted approval event");
            console.log("evidence-load failure evidence", JSON.stringify(failed));
            assertEquals(failed.isAgentTransitioning, false, "A failed evidence read must release the transition");
        } finally {
            if (faultApplied) await rename(hiddenPath, planPath);
            await client.close();
        }
    });
});

test("Approve and Run TURN_END results do not expose the private execution handoff", async () => {
    await withRetainedRemoteRuntimeFixture(async (f) => {
        await prepareDelivery(f);
        scriptInitialExecution(f);
        const client = await f.start();
        try {
            await approveAndRun(f, await startPlanning(client));
            const completed = await client.read();
            assertEquals(completed.kind, "workflow-plan", JSON.stringify(completed));
            assertEquals(completed.ok, true, completed.error);
            const serialized = completed.turnEndResults;
            assert(serialized && serialized.length > 0, "Capture every result-bearing workflow TURN_END event");
            assert(completed.savedId);
            assertEquals(
                f.store.listSessionTranscriptSegments(completed.savedId).length,
                2,
                "Observe the completed workflow, not an early planning-only report",
            );
            console.log("synchronous TURN_END serialization evidence", JSON.stringify(serialized));
            assertEquals(
                serialized.filter((result) => result.includes('"_executionToStart"')),
                [],
                "No synchronous subscriber may receive the private execution handoff",
            );
        } finally {
            await client.close();
        }
    });
});
