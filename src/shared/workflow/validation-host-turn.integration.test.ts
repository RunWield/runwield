import {
    realpath as fsRealpath,
    readdir as fsReaddir,
    readFile as fsReadFile,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertExists, assertStringIncludes } from "../../testing/assertions.ts";
import { basename, dirname, join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { updatePlanFrontMatter } from "../../plan-store.js";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import { getWorkspaceSearchRefreshMarker } from "../workspace-search-refresh.ts";
import { getWorkflowMetricsFilePath } from "./metrics.js";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import { createLedger } from "./review-ledger.ts";
import { complete, coverage, hostFixture, hostRequest } from "./testing/validation-host-fixture.ts";
import { type ValidationHostResume } from "./validation-host-contract.ts";

async function canonicalPath(path: string): Promise<string> {
    try {
        return await fsRealpath(path);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        return join(await canonicalPath(dirname(path)), basename(path));
    }
}

async function files(root: string, result = new Map<string, string>()): Promise<Map<string, string>> {
    root = await fsRealpath(root);
    for await (const entry of await fsReaddir(root, { withFileTypes: true })) {
        if (entry.name === ".git") continue; // Tree snapshots write Git objects, never a validation sidecar.
        const path = join(root, entry.name);
        if (entry.isDirectory()) await files(path, result);
        else if (entry.isFile()) result.set(path, Array.from(await fsReadFile(path)).join(","));
    }
    return result;
}

test("fresh network-denied host turns validate real work without a Session or hidden state", async () => {
    const fixture = await hostFixture();
    try {
        // One prior discovery round makes this discovery round 2, followed by verify round 3.
        // Core deliberately keeps two discovery rounds; this fixture does not change that policy.
        const plan = await fixture.plan();
        await updatePlanFrontMatter(
            fixture.cwd,
            "p",
            {
                validationCheckpoint: makeValidationCheckpoint({
                    attemptId: fixture.id,
                    generation: "host-journey",
                    status: "implemented",
                    phase: "mechanical",
                    state: "ready",
                    reviewState: { semanticRound: 1, reviewLedger: createLedger(), repairBaselineTree: "" },
                }),
            },
            plan.attrs,
            { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
        );
        const layout = resolveProjectRuntimeLayout(fixture.root);
        const originalControllers = await files(layout.primary.controllerPlansDir);
        const metricsPath = await canonicalPath(getWorkflowMetricsFilePath(fixture.root));
        const deliveryEvidenceRoot = await canonicalPath(layout.primary.deliveryEvidenceRoot);
        const settingsPath = await canonicalPath(join(fixture.root, ".wld/settings.json"));
        const canonicalCwd = await fsRealpath(fixture.cwd);
        const searchRefreshMarker = await canonicalPath(await getWorkspaceSearchRefreshMarker(fixture.root));
        const snapshot = async () => {
            const result = await files(fixture.root);
            await files(fixture.parent, result);
            const home = getHomeDir();
            if (home) await files(home, result);
            return result;
        };
        const forbiddenWrites: string[] = [];
        const turn = async (resume?: ValidationHostResume) => {
            const before = await snapshot();
            const result = await fixture.processTurn(resume);
            const after = await snapshot();
            const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
                (path) => before.get(path) !== after.get(path),
            );
            const unexpected = changed.filter(
                (path) =>
                    !(
                        path.startsWith(canonicalCwd + "/") ||
                        path.startsWith(deliveryEvidenceRoot + "/") ||
                        originalControllers.has(path) ||
                        path === metricsPath ||
                        path === metricsPath + ".lock" ||
                        path === settingsPath ||
                        path === searchRefreshMarker
                    ),
            );
            forbiddenWrites.push(...unexpected);
            return result;
        };
        let result = await turn();
        const ciRepair = hostRequest(result, "repair");
        const waiting = (await fixture.plan()).attrs.validationCheckpoint;
        assertExists(waiting);
        assertEquals(waiting.state, "awaiting_repair");
        assertEquals(ciRepair.repairGeneration, waiting.repairGeneration);
        assertEquals(ciRepair.role, "reviewer-feedback-engineer");
        assertEquals(ciRepair.cwd, fixture.cwd);
        assertEquals(await fixture.ciCount(), 1);
        assertEquals(
            (await fixture.evidence()).map((entry) => entry.kind),
            ["ci", "ci-repair"],
        );
        const checkpointBytes = await fixture.checkpointBytes();
        result = await turn({
            kind: "task_completed",
            identity: { ...ciRepair.identity, repairGeneration: "wrong" },
            report: "wrong",
        });
        assertEquals(result.kind, "failed");
        assertEquals(await fixture.checkpointBytes(), checkpointBytes);
        await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
        let reviewer = hostRequest(await turn(complete(ciRepair)), "reviewer");
        assertEquals(reviewer.reviewMode, "discovery");
        assertEquals(await fixture.ciCount(), 2);
        const settledEvidence = await fixture.evidence();
        const repeated = hostRequest(await turn(complete(ciRepair)), "reviewer");
        assertEquals(repeated.identity, reviewer.identity);
        assertEquals(await fixture.ciCount(), 2);
        assertEquals(await fixture.evidence(), settledEvidence);
        const beforeCorrection = await fixture.lifecycle();
        reviewer = hostRequest(
            await turn({ kind: "reviewer", identity: reviewer.identity, outcome: { approved: true }, coverage: [] }),
            "reviewer",
        );
        assertEquals(reviewer.identity.correctionCount, 1);
        assertStringIncludes(reviewer.prompt, "without inspecting the diff");
        assertEquals(await fixture.lifecycle(), beforeCorrection);
        const spans = coverage(reviewer);
        assert(spans.length > 0);
        const half = spans.map((span, index) => (index ? span : { ...span, end: Math.floor(span.end / 2) }));
        reviewer = hostRequest(
            await turn({ kind: "reviewer", identity: reviewer.identity, outcome: { approved: true }, coverage: half }),
            "reviewer",
        );
        assertEquals(reviewer.identity.correctionCount, 2);
        assertStringIncludes(reviewer.prompt, "unread bytes");
        assertStringIncludes(reviewer.prompt, spans[0].path);
        const businessState = async () => {
            const plan = await fixture.plan();
            return {
                history: await fixture.lifecycle(),
                review: plan.attrs.validationCheckpoint?.reviewState,
                generation: plan.attrs.validationCheckpoint?.repairGeneration,
                hostReview: plan.attrs.validationCheckpoint?.hostReview,
                evidence: await fixture.evidence(),
                metrics: await fixture.metrics(),
            };
        };
        const stable = await businessState();
        result = await turn({
            kind: "reviewer",
            identity: reviewer.identity,
            outcome: { approved: true },
            coverage: [{ ...spans[0], path: "not-in-diff" }],
        });
        assertEquals(result.kind, "failed");
        assertEquals(await businessState(), stable);
        result = await turn({
            kind: "reviewer",
            identity: { ...reviewer.identity, correctionCount: 1 },
            outcome: { approved: true },
            coverage: coverage(reviewer),
        });
        assertEquals(result.kind, "failed");
        assertEquals(await businessState(), stable);
        for (const identity of [
            { ...reviewer.identity, attemptId: "other" },
            { ...reviewer.identity, generation: "other" },
            { ...reviewer.identity, semanticRound: reviewer.identity.semanticRound + 1 },
            { ...reviewer.identity, reviewMode: "verify" as const },
            { ...reviewer.identity, diffHash: "other" },
        ]) {
            assertEquals(
                (await turn({ kind: "reviewer", identity, outcome: { approved: true }, coverage: coverage(reviewer) }))
                    .kind,
                "failed",
            );
            assertEquals(await businessState(), stable);
        }
        assertEquals(
            (
                await turn({
                    kind: "reviewer",
                    identity: reviewer.identity,
                    outcome: { approved: true },
                    coverage: [{ ...spans[0], end: spans[0].end + 1 }],
                })
            ).kind,
            "failed",
        );
        assertEquals(await businessState(), stable);
        const implementation = join(fixture.cwd, "implementation.ts");
        const original = await fsReadFile(implementation, "utf8");
        await fsWriteFile(implementation, original + "export const stale = true;\n");
        result = await turn({
            kind: "reviewer",
            identity: reviewer.identity,
            outcome: { approved: true },
            coverage: coverage(reviewer),
        });
        assertEquals(result.kind, "failed");
        assertEquals(await businessState(), stable);
        await fsWriteFile(implementation, original);
        const { getWorktreeReviewDiff } = await import("./git-snapshot.ts");
        assertEquals(await getWorktreeReviewDiff(fixture.cwd, "main"), reviewer.fullDiff);
        const semanticRepair = hostRequest(
            await turn({
                kind: "reviewer",
                identity: reviewer.identity,
                coverage: coverage(reviewer),
                outcome: {
                    approved: false,
                    findings: [
                        {
                            title: "Wrong value",
                            requirement: "Implement value",
                            evidence: "value is 1",
                            status: "new",
                        },
                    ],
                },
            }),
            "repair",
        );
        const feedbackPlan = await fixture.plan();
        assertEquals(feedbackPlan.attrs.validationCheckpoint?.reviewState?.reviewLedger.items[0].status, "new");
        assertEquals(
            (await fixture.evidence()).filter((entry) => entry.kind === "ai").at(-1)?.outcome,
            "Changes requested",
        );
        const repairState = await businessState();
        const semanticBytes = await fixture.checkpointBytes();
        assertEquals(
            (
                await turn({
                    kind: "task_completed",
                    identity: { ...semanticRepair.identity, repairGeneration: "wrong" },
                    report: "wrong",
                })
            ).kind,
            "failed",
        );
        assertEquals(await businessState(), repairState);
        assertEquals(await fixture.checkpointBytes(), semanticBytes);
        await fsWriteFile(implementation, "export const value = 2;\n");
        reviewer = hostRequest(await turn(complete(semanticRepair)), "reviewer");
        assertEquals(reviewer.reviewMode, "verify");
        assertEquals(reviewer.requiredScope, "repair");
        const completedSemanticEvidence = await fixture.evidence();
        const completedSemanticMetrics = await fixture.metrics();
        const repeatedSemantic = hostRequest(await turn(complete(semanticRepair)), "reviewer");
        assertEquals(repeatedSemantic.identity, reviewer.identity);
        assertEquals(await fixture.ciCount(), 3);
        assertEquals(await fixture.evidence(), completedSemanticEvidence);
        assertEquals(await fixture.metrics(), completedSemanticMetrics);

        const verifyOutcome = {
            approved: true,
            findings: [{ id: "R2-1", title: "Wrong value", status: "fix_confirmed" as const }],
        };
        result = await turn({
            kind: "reviewer",
            identity: reviewer.identity,
            outcome: verifyOutcome,
            coverage: coverage(reviewer).map((span) => ({ ...span, scope: "full" })),
        });
        assertEquals(result.kind, "failed");
        if (result.kind === "failed") assertStringIncludes(result.reason, "incomplete");
        result = await turn({
            kind: "reviewer",
            identity: reviewer.identity,
            outcome: verifyOutcome,
            coverage: coverage(reviewer),
        });
        assertEquals(result.kind, "awaiting_delivery");
        const reviewed = await fixture.plan();
        assertEquals(reviewed.attrs.status, "reviewed");
        assertEquals(reviewed.attrs.validationCheckpoint?.reviewState?.reviewLedger.items[0].status, "fix_confirmed");
        assertEquals(
            (await fixture.evidence()).some((entry) => entry.kind === "human"),
            false,
        );
        assertEquals(reviewed.attrs.humanReviewedAt ?? null, null);
        assertEquals(reviewed.attrs.publicationReceipt ?? null, null);
        assertEquals(reviewed.attrs.worktreeStatus, "completed");
        assertEquals(
            (await fixture.lifecycle()).filter(
                (event) =>
                    event === "plan_event:validation_passed" ||
                    event === "plan_event:epic_publication_confirmed" ||
                    event.includes("human"),
            ),
            [],
        );
        const final = await businessState();
        const finalCheckpoint = await fixture.checkpointBytes();
        assertEquals((await turn(complete(semanticRepair))).kind, "awaiting_delivery");
        assertEquals(await businessState(), final);
        assertEquals(await fixture.checkpointBytes(), finalCheckpoint);
        assertEquals(await fixture.ciCount(), 3);
        assert((await fixture.metrics()).includes("semantic_review_result"));
        assertEquals(
            [...new Set(forbiddenWrites)],
            [],
            "Every turn must stay inside the Plan Verification write allowlist.",
        );
    } finally {
        await fixture.close();
    }
});
