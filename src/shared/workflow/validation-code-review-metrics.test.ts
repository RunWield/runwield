import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import { setCustomSetting } from "../settings.js";
import { recordDeliveryEvidence } from "./delivery-evidence.ts";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "./metrics.js";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import {
    makeRecordedSession,
    makeUi,
    makeValidationProjectRoot,
    runValidationPhase,
} from "./validation-test-helpers.js";

interface DecisionDetails {
    decision: "approved" | "changes_requested";
    semanticRound: number;
    aiReviewOutcome: "approved" | "human_takeover" | "skipped" | "unavailable";
    codeReviewRound: number;
    hasFeedback: boolean;
    annotationCount: number;
}

interface MetricRecord {
    event: string;
    category: string;
    details: DecisionDetails;
}

async function makeReviewFixture(semanticRound = 2, mode: "always" | "ask" | "none" = "always", enabled = true) {
    const validationCheckpoint = makeValidationCheckpoint({
        attemptId: "in-place",
        generation: crypto.randomUUID(),
        status: "reviewed",
        phase: "delivery",
        state: "ready",
        reviewState: {
            semanticRound,
            reviewLedger: { sequence: 0, items: [] },
            repairBaselineTree: "",
        },
    });
    const triageMeta = {
        classification: "QUICK_FIX" as const,
        status: "reviewed" as const,
        humanReviewMode: mode,
        validationCheckpoint,
    };
    const projectRoot = await makeValidationProjectRoot("p", triageMeta);
    await setCustomSetting("workflowMetrics", enabled, "project", projectRoot);
    const hostedSession = makeRecordedSession("code-review-metrics", makeUi());
    hostedSession.setActiveExecutionWorkflow({
        planName: "p",
        triageMeta,
        executionAgent: "engineer",
        projectRoot,
        executionCwd: projectRoot,
        nonGitInPlace: true,
    });
    return {
        projectRoot,
        hostedSession,
        run: () =>
            runValidationPhase({
                hostedSession,
                planName: "p",
                planContent: "# p",
                triageMeta,
                // The external Agent stops without completing the repair. Recording
                // the user's decision must not depend on a successful repair.
                semanticReviewPort: { runIsolatedAgentSession: () => Promise.resolve([]) },
            }),
    };
}

async function decisionMetrics(projectRoot: string): Promise<MetricRecord[]> {
    await drainWorkflowMetrics();
    let serialized: string;
    try {
        serialized = await readFile(getWorkflowMetricsFilePath(projectRoot), "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
    return serialized
        .trim()
        .split("\n")
        .map((line): MetricRecord => JSON.parse(line))
        .filter((record) => record.event === "code_review_decision");
}

for (const approved of [true, false]) {
    test(`Code Review ${approved ? "approval" : "changes requested"} records prior AI approval without review content`, async () => {
        const fixture = await makeReviewFixture();
        await recordDeliveryEvidence(fixture.projectRoot, "p", "in-place", "ai", "Approved", "private AI review");
        fixture.hostedSession.setInteractionAdapter({
            requestInteraction: () =>
                Promise.resolve({
                    outcome: "selected",
                    _meta: {
                        approved,
                        feedback: "private feedback text",
                        annotations: [{ file: "private-file.ts", line: 123, text: "private annotation" }],
                        images: [{ base64: "private image bytes", mimeType: "image/png" }],
                    },
                }),
        });

        await fixture.run();

        const records = await decisionMetrics(fixture.projectRoot);
        assertEquals(records.length, 1);
        assertEquals(records[0].category, "validation");
        assertEquals(records[0].details, {
            decision: approved ? "approved" : "changes_requested",
            semanticRound: 2,
            aiReviewOutcome: "approved",
            codeReviewRound: 1,
            hasFeedback: true,
            annotationCount: 1,
        });
        const serialized = await readFile(getWorkflowMetricsFilePath(fixture.projectRoot), "utf8");
        for (const content of [
            "private feedback text",
            "private annotation",
            "private-file.ts",
            "private image bytes",
            "private AI review",
        ]) {
            assertEquals(serialized.includes(content), false);
        }
    });
}

test("a resumed second changes request records human takeover and Code Review round two", async () => {
    const fixture = await makeReviewFixture(5);
    await recordDeliveryEvidence(fixture.projectRoot, "p", "in-place", "ai-skip", "Human takeover");
    await recordDeliveryEvidence(fixture.projectRoot, "p", "in-place", "human", "Changes requested");
    // Another delivery attempt must not affect this attempt's round count.
    await recordDeliveryEvidence(fixture.projectRoot, "p", "old-attempt", "human", "Changes requested");
    fixture.hostedSession.setInteractionAdapter({
        requestInteraction: () =>
            Promise.resolve({
                outcome: "selected",
                _meta: { annotations: [{ body: "private second annotation" }] },
            }),
    });

    await fixture.run();

    assertEquals(
        (await decisionMetrics(fixture.projectRoot)).map((record) => record.details),
        [
            {
                decision: "changes_requested",
                semanticRound: 5,
                aiReviewOutcome: "human_takeover",
                codeReviewRound: 2,
                hasFeedback: false,
                annotationCount: 1,
            },
        ],
    );
});

for (const aiEvidence of ["missing", "skipped"] as const) {
    test(`${aiEvidence} AI evidence is not recorded as AI approval`, async () => {
        const fixture = await makeReviewFixture(0);
        if (aiEvidence === "skipped") {
            await recordDeliveryEvidence(fixture.projectRoot, "p", "in-place", "ai-skip", "Skipped");
        }
        fixture.hostedSession.setInteractionAdapter({
            requestInteraction: () => Promise.resolve({ outcome: "selected", _meta: { approved: true } }),
        });

        await fixture.run();

        assertEquals(
            (await decisionMetrics(fixture.projectRoot)).map((record) => record.details),
            [
                {
                    decision: "approved",
                    semanticRound: 0,
                    aiReviewOutcome: aiEvidence === "missing" ? "unavailable" : "skipped",
                    codeReviewRound: 1,
                    hasFeedback: false,
                    annotationCount: 0,
                },
            ],
        );
    });
}

for (const scenario of ["canceled", "empty", "skipped", "not_required"] as const) {
    test(`Code Review ${scenario} records no decision metric`, async () => {
        const fixture = await makeReviewFixture(
            2,
            scenario === "skipped" ? "ask" : scenario === "not_required" ? "none" : "always",
        );
        fixture.hostedSession.setInteractionAdapter({
            requestInteraction: (request) => {
                if (request.type === "select")
                    return Promise.resolve({ outcome: "selected", value: scenario === "skipped" ? "skip" : "stop" });
                if (scenario === "empty") return Promise.resolve({ outcome: "selected" });
                return Promise.resolve({ outcome: "canceled", _meta: { approved: true, feedback: "stale draft" } });
            },
        });

        await fixture.run();

        assertEquals(await decisionMetrics(fixture.projectRoot), []);
    });
}

test("Code Review decisions honor metrics opt-out", async () => {
    const fixture = await makeReviewFixture(2, "always", false);
    fixture.hostedSession.setInteractionAdapter({
        requestInteraction: () => Promise.resolve({ outcome: "selected", _meta: { approved: true } }),
    });

    await fixture.run();

    assertEquals(await decisionMetrics(fixture.projectRoot), []);
});
