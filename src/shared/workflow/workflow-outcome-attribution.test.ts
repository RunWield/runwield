import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createHash } from "node:crypto";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { PLAN_ASSOCIATION_CUSTOM_TYPE } from "../session/plan-association.ts";
import { encodeCwdForSessionDir, getRunWieldSessionsBaseDir } from "../session/root-session.js";
import { recordWorkflowOutcome } from "./outcome-observations.ts";

Deno.test("outcomes use only the committed Plan association in their observation time scope", async () => {
    await withWorkflowMetricsFixture(async (metrics) => {
        const store = openFileSessionStore();
        try {
            const project = store.ensureRuntimeProject({ root: metrics.projectRoot });
            const directory = join(
                getRunWieldSessionsBaseDir(),
                encodeCwdForSessionDir(await Deno.realPath(metrics.projectRoot)),
            );
            await Deno.mkdir(directory, { recursive: true });
            const transcriptPath = join(directory, "2026-01-01T00-00-00-000Z_two-plan-session.jsonl");
            const start = "2026-01-01T00:00:00.000Z";
            await Deno.writeTextFile(
                transcriptPath,
                JSON.stringify({
                    type: "session",
                    id: "two-plan-session",
                    version: 3,
                    timestamp: start,
                    cwd: metrics.projectRoot,
                }) + "\n",
            );
            const session = await store.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId: "two-plan-session",
                transcriptPath,
                transcriptCwd: metrics.projectRoot,
                source: "created",
            });
            const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
            assert(segment);
            let proof = store.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "owner",
                ownerProcessKind: "test",
            });
            for (const [planName, second] of [["alpha", "10"], ["beta", "20"]]) {
                const data = {
                    planId: `plan-${planName}`,
                    planName,
                    purpose: "execution" as const,
                    segmentId: segment.segmentId,
                    segmentKind: segment.kind,
                    recordedAt: `2026-01-01T00:00:${second}.000Z`,
                };
                await Deno.writeTextFile(
                    transcriptPath,
                    JSON.stringify({
                        type: "custom",
                        customType: PLAN_ASSOCIATION_CUSTOM_TYPE,
                        id: `association-${planName}`,
                        timestamp: data.recordedAt,
                        data,
                    }) + "\n",
                    { append: true },
                );
                store.stagePlanAssociation(proof, data);
            }
            proof = store.changeSessionActivationPhase(proof, "hydrated");
            proof = store.changeSessionActivationPhase(proof, "checkpointing");
            const bytes = await Deno.readFile(transcriptPath);
            store.publishGenerationAndRelease(proof, {
                generation: 0,
                byteLength: bytes.byteLength,
                terminalEntryId: "association-beta",
                digestHex: createHash("sha256").update(bytes).digest("hex"),
            });
            const pendingProof = store.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "owner",
                ownerProcessKind: "test",
            });
            store.stagePlanAssociation(pendingProof, {
                planId: "plan-pending",
                planName: "pending",
                purpose: "execution",
                segmentId: segment.segmentId,
                segmentKind: segment.kind,
                recordedAt: "2026-01-01T00:00:30.000Z",
            });
            const metadata = { runwieldSessionId: session.runwieldSessionId, currentSegmentId: segment.segmentId };
            const cases = [
                { second: "05", planName: "alpha", expected: undefined },
                { second: "15", planName: "alpha", expected: "plan-alpha" },
                { second: "15", planName: "beta", expected: undefined },
                { second: "25", planName: "beta", expected: "plan-beta" },
                { second: "25", planName: "alpha", expected: undefined },
                { second: "25", planName: undefined, expected: undefined },
                { second: "35", planName: "pending", expected: undefined },
                { second: "35", planName: "beta", expected: "plan-beta" },
            ];
            for (const [index, item] of cases.entries()) {
                await recordWorkflowOutcome(metrics.projectRoot, {
                    event: "validation_attempt",
                    category: "validation",
                    operationId: `operation-${index}`,
                    outcome: "failed",
                    planName: item.planName,
                    session: metadata,
                    ts: `2026-01-01T00:00:${item.second}.000Z`,
                    attempt: 1,
                });
            }
            const rows = await metrics.readMetrics();
            assertEquals(rows.length, cases.length);
            assertEquals(rows.map((row) => row.planId), cases.map((item) => item.expected));
            assertEquals(rows.filter((row) => row.outcome === "abandoned").length, 0);
            assertEquals(rows[5].planId, undefined); // General discussion is not an undelivered Plan.
            store.close();
            const reopened = openFileSessionStore();
            try {
                reopened.sealSessionTranscriptSegment({
                    runwieldSessionId: session.runwieldSessionId,
                    segmentId: segment.segmentId,
                    now: () => "2026-01-01T00:00:40.000Z",
                    evidence: {
                        byteLength: bytes.byteLength,
                        terminalEntryId: "association-beta",
                        digestHex: createHash("sha256").update(bytes).digest("hex"),
                    },
                });
                await recordWorkflowOutcome(metrics.projectRoot, {
                    category: "validation",
                    event: "validation_attempt",
                    operationId: "after-seal",
                    outcome: "incomplete",
                    planName: "beta",
                    session: metadata,
                    ts: "2026-01-01T00:00:41.000Z",
                });
                assertEquals((await metrics.readMetrics()).at(-1)?.planId, undefined);
            } finally {
                reopened.close();
            }
        } finally {
            store.close();
        }
    });
});
