import { seedPlanState } from "../testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../testing/retained-plan-fixture.ts";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { setCustomSetting } from "../settings.js";

import { loadPlan } from "../../plan-store/index.ts";
import { git } from "../git-test-fixture.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";
import { readEpicDeliveryState, runEpicIntegrationGate } from "./epic-integration.ts";
import {
    type ScriptedReview,
    type ReviewerCall,
    writePlan,
    childAttrs,
    epicWithPendingSecondChild,
    deliverSecondChild,
    scriptedReviewer,
    scriptedChecks,
    PASSING_CHECKS,
    gateSession,
} from "./epic-integration-test-fixture.ts";

test("existing integration repair children count toward the automatic review limit", async () => {
    const { repo } = await epicWithPendingSecondChild();
    return await withRetainedPlanFixture(repo, async () => {
        await deliverSecondChild(repo);
        await git(repo, ["switch", "epic/epic"]);
        for (const order of [3, 4]) {
            await writePlan(
                repo,
                `epic/0${order}-repair-integration-findings`,
                childAttrs(order),
                "# Delivered repair\n",
            );
        }
        await git(repo, ["add", "docs/plans"]);
        await git(repo, ["commit", "-m", "earlier integration repairs"]);
        await git(repo, ["switch", "main"]);
        const { hostedSession } = gateSession();
        const result = await runEpicIntegrationGate({
            hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            semanticReviewPort: scriptedReviewer({
                approved: false,
                findings: [
                    { title: "Broken seam", requirement: "Ship together", evidence: "Not connected", status: "new" },
                ],
            }),
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks(PASSING_CHECKS),
        });
        assertEquals(result.kind, "paused");
        assertEquals((await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round, 3);
        assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 4);
    });
});

const SEAM_FINDINGS: ScriptedReview = {
    approved: false,
    findings: [
        { title: "First seam", requirement: "Ship together", evidence: "First disconnected", status: "new" },
        { title: "Second seam", requirement: "Ship together", evidence: "Second disconnected", status: "new" },
    ],
};

async function readyGate() {
    const { repo } = await epicWithPendingSecondChild();
    return await withRetainedPlanFixture(repo, async () => {
        await setCustomSetting("codereview", "none", "project", repo);
        await deliverSecondChild(repo);
        const { hostedSession, recorder } = gateSession();
        const options = {
            hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks(PASSING_CHECKS),
        };
        return { repo, hostedSession, recorder, options };
    });
}

async function seedReviewRound(repo: string, round: number) {
    const plan = await loadPlan(repo, "epic");
    assert(plan);
    await seedPlanState(
        repo,
        "epic",
        {
            epicIntegrationReview: {
                round,
                ledger: { items: [], sequence: 0 },
                checkedCommit: await git(repo, ["rev-parse", "epic/epic"]),
            },
        },
        {},
        { expectedRevision: plan.revision },
    );
}

async function deliverRepair(repo: string, childName: string) {
    const child = await loadPlan(repo, childName);
    assert(child);
    await git(repo, ["add", "docs/plans"]);
    await git(repo, ["commit", "-m", "save primary fixture documents"]);
    await git(repo, ["switch", "epic/epic"]);
    await writePlan(
        repo,
        childName,
        childAttrs(Number(child.attrs.order), { planId: child.attrs.planId! }),
        "# Delivered repair\n",
    );
    await fsWriteFile(join(repo, "repair.js"), "export const repaired = true;\n");
    await git(repo, ["add", "docs/plans", "repair.js"]);
    await git(repo, ["commit", "-m", "deliver integration repair"]);
    await git(repo, ["switch", "main"]);
}

test("integration findings retain their IDs across delivery and verify only the repair delta", async () => {
    const { repo, options } = await readyGate();
    return await withRetainedPlanFixture(repo, async () => {
        const calls: ReviewerCall[] = [];
        const head = await git(repo, ["rev-parse", "epic/epic"]);
        const first = await runEpicIntegrationGate({
            ...options,
            semanticReviewPort: scriptedReviewer(SEAM_FINDINGS, calls),
        });
        assert(first.kind === "findings");
        assertEquals(calls[0].definition?.options?.reviewerMode, "discovery");
        const state = (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview;
        assertEquals(state?.round, 1);
        assertEquals(state?.checkedCommit, head);
        assertEquals(
            state?.ledger.items.map((item) => item.id),
            ["R1-1", "R1-2"],
        );
        const report = await fsReadFile(join(repo, first.reportPath), "utf8");
        const repair = await loadPlan(repo, first.repairChild.childPlanName!);
        for (const id of ["R1-1", "R1-2"]) {
            assertStringIncludes(report, `### ${id}.`);
            assertStringIncludes(repair!.markdown, `### ${id}.`);
        }
        const markdown = await fsReadFile(join(repo, "docs/plans/epic.md"), "utf8");
        assertEquals(markdown.includes("epicIntegrationReview:"), false);
        await deliverRepair(repo, first.repairChild.childPlanName!);
        // A new hosted Session reads the ledger from disk, not from the earlier gate's memory.
        const second = await runEpicIntegrationGate({
            ...options,
            hostedSession: gateSession().hostedSession,
            semanticReviewPort: scriptedReviewer(
                {
                    approved: false,
                    findings: [
                        {
                            ...SEAM_FINDINGS.findings![0],
                            id: "R1-1",
                            status: "fix_confirmed",
                            evidence: "Connected now",
                        },
                        {
                            ...SEAM_FINDINGS.findings![1],
                            id: "R1-2",
                            status: "fix_rejected",
                            rejectionReason: "Still not wired",
                        },
                    ],
                },
                calls,
            ),
        });
        assert(second.kind === "findings");
        assertEquals(calls[1].definition?.options?.reviewerMode, "verify");
        assertStringIncludes(calls[1].userRequest, "R1-1");
        assertStringIncludes(calls[1].userRequest, "R1-2");
        assertStringIncludes(calls[1].userRequest, "fix claimed");
        assertStringIncludes(calls[1].repairDiff || "", "repair.js");
        assertEquals(calls[1].repairDiff?.includes("diff --git a/first.js"), false);
        const nextRepair = await loadPlan(repo, second.repairChild.childPlanName!);
        assertStringIncludes(nextRepair!.markdown, "### R1-2.");
        assertStringIncludes(nextRepair!.markdown, "Still not wired");
        assertEquals(nextRepair!.markdown.includes("### R1-1."), false);
        assertEquals(
            (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.ledger.items.map((item) => item.status),
            ["fix_confirmed", "fix_rejected"],
        );
    });
});

test("a verify verdict cannot omit an open integration finding", async () => {
    const { repo, options } = await readyGate();
    return await withRetainedPlanFixture(repo, async () => {
        const first = await runEpicIntegrationGate({ ...options, semanticReviewPort: scriptedReviewer(SEAM_FINDINGS) });
        assert(first.kind === "findings");
        await deliverRepair(repo, first.repairChild.childPlanName!);
        const calls: ReviewerCall[] = [];
        const result = await runEpicIntegrationGate({
            ...options,
            semanticReviewPort: scriptedReviewer(
                [
                    { approved: true },
                    {
                        approved: true,
                        findings: SEAM_FINDINGS.findings!.map((item, i) => ({
                            ...item,
                            id: `R1-${i + 1}`,
                            status: "fix_confirmed",
                            evidence: "Connected",
                        })),
                    },
                ],
                calls,
            ),
        });
        assertEquals(result.kind, "passed");
        assertEquals(calls.length, 2);
        assertEquals(
            (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.ledger.items.every(
                (item) => item.status === "fix_confirmed",
            ),
            true,
        );
    });
});

for (const choice of ["stop", "repair", "unanswered"]) {
    test(`third integration review asks before creating a child: ${choice}`, async () => {
        const { repo, options, hostedSession } = await readyGate();
        return await withRetainedPlanFixture(repo, async () => {
            await seedReviewRound(repo, 2);
            hostedSession.setInteractionAdapter({
                requestInteraction: async (request) => {
                    assertEquals(request.type, "select");
                    assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 2);
                    assertEquals((await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round, 3);
                    return choice === "unanswered" ? { outcome: "canceled" } : { outcome: "selected", value: choice };
                },
            });
            const result = await runEpicIntegrationGate({
                ...options,
                semanticReviewPort: scriptedReviewer(SEAM_FINDINGS),
            });
            assertEquals(result.kind, choice === "repair" ? "findings" : "paused");
            assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, choice === "repair" ? 3 : 2);
            const report = await fsReadFile(join(repo, "docs/plans/epic/integration-report.md"), "utf8");
            assertStringIncludes(report, "R3-1");
            if (result.kind === "paused") assertStringIncludes(result.reason, "docs/plans/epic/integration-report.md");
        });
    });
}

for (const checksPass of [true, false]) {
    test(`limit Code Review takeover requires passing project checks: ${checksPass}`, async () => {
        const { repo, options, hostedSession, recorder } = await readyGate();
        return await withRetainedPlanFixture(repo, async () => {
            await seedReviewRound(repo, 2);
            let codeReviewOpened = false;
            hostedSession.setInteractionAdapter({
                requestInteraction: (request) => {
                    if (request.type === "select") {
                        assertEquals(
                            request.options?.some((option) => option.value === "code_review"),
                            checksPass,
                        );
                        return Promise.resolve({ outcome: "selected", value: checksPass ? "code_review" : "stop" });
                    }
                    assertEquals(request.type, "code_review");
                    codeReviewOpened = true;
                    return Promise.resolve({ outcome: "accepted", _meta: { approved: true } });
                },
            });
            const result = await runEpicIntegrationGate({
                ...options,
                semanticReviewPort: scriptedReviewer(SEAM_FINDINGS),
                localCIPort: scriptedChecks(
                    checksPass ? PASSING_CHECKS : { kind: "completed", exitCode: 1, output: "failed" },
                ),
            });
            assertEquals(result.kind, checksPass ? "passed" : "paused");
            assertEquals(codeReviewOpened, checksPass);
            const epic = await loadPlan(repo, "epic");
            if (checksPass) {
                assertEquals(epic?.attrs.status, "reviewed");
                assert(epic?.attrs.epicIntegrationReview?.userTakeoverAt);
                assertEquals(epic?.attrs.humanReviewMode, "always");
                assertEquals(epic?.attrs.humanReviewDecision, "approved");
                assertStringIncludes(recorder.messages.join("\n"), "integration review did not approve");
                assertEquals(epic?.attrs.epicIntegrationReview?.ledger.items.length, 2);
            }
        });
    });
}

for (const takeover of [true, false]) {
    test(`Code Review changes create a repair child without a second limit decision: takeover=${takeover}`, async () => {
        const { repo, options, hostedSession } = await readyGate();
        return await withRetainedPlanFixture(repo, async () => {
            await seedReviewRound(repo, 2);
            await setCustomSetting("codereview", "always", "project", repo);
            let limitPrompts = 0;
            hostedSession.setInteractionAdapter({
                requestInteraction: (request) => {
                    if (request.type === "select") {
                        limitPrompts++;
                        return Promise.resolve({ outcome: "selected", value: "code_review" });
                    }
                    assertEquals(request.type, "code_review");
                    return Promise.resolve({ outcome: "accepted", message: "Connect the seam" });
                },
            });
            const result = await runEpicIntegrationGate({
                ...options,
                semanticReviewPort: scriptedReviewer(takeover ? SEAM_FINDINGS : { approved: true }),
            });
            assertEquals(result.kind, "findings");
            assertEquals(limitPrompts, takeover ? 1 : 0);
            assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 3);
        });
    });
}

for (const change of ["head", "controller"]) {
    test(`a changed ${change} prevents a completed review from overwriting saved gate evidence`, async () => {
        const { repo, options } = await readyGate();
        return await withRetainedPlanFixture(repo, async () => {
            const reviewer = scriptedReviewer(SEAM_FINDINGS);
            const result = await runEpicIntegrationGate({
                ...options,
                semanticReviewPort: {
                    runIsolatedAgentSession: async (request) => {
                        if (change === "head") {
                            await git(repo, ["switch", "epic/epic"]);
                            await fsWriteFile(join(repo, "new-head.js"), "export const changed = true;\n");
                            await git(repo, ["add", "new-head.js"]);
                            await git(repo, ["commit", "-m", "branch moved during review"]);
                            await git(repo, ["switch", "main"]);
                        } else {
                            await seedReviewRound(repo, 9);
                        }
                        return await reviewer.runIsolatedAgentSession(request);
                    },
                },
            });
            assertEquals(result.kind, "not_ready");
            assertEquals(
                (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round,
                change === "head" ? undefined : 9,
            );
            assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 2);
        });
    });
}

test("a reviewer without a verdict pauses without consuming a round", async () => {
    const { repo, options } = await readyGate();
    return await withRetainedPlanFixture(repo, async () => {
        await seedReviewRound(repo, 2);
        const result = await runEpicIntegrationGate({
            ...options,
            semanticReviewPort: {
                runIsolatedAgentSession: () => Promise.resolve([]),
            },
        });
        assertEquals(result.kind, "paused");
        assertEquals((await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview?.round, 2);
        assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 2);
    });
});

test("project-check failures alone reach the limit without becoming ledger findings", async () => {
    const { repo, options, hostedSession } = await readyGate();
    return await withRetainedPlanFixture(repo, async () => {
        await seedReviewRound(repo, 2);
        hostedSession.setInteractionAdapter({
            requestInteraction: (request) => {
                assertEquals(request.type, "select");
                assertEquals(
                    request.options?.map((option) => option.value),
                    ["repair", "stop"],
                );
                return Promise.resolve({ outcome: "selected", value: "stop" });
            },
        });
        const result = await runEpicIntegrationGate({
            ...options,
            semanticReviewPort: scriptedReviewer({ approved: true }),
            localCIPort: scriptedChecks({ kind: "completed", exitCode: 1, output: "a deterministic failure" }),
        });
        assertEquals(result.kind, "paused");
        const saved = (await loadPlan(repo, "epic"))?.attrs.epicIntegrationReview;
        assertEquals(saved?.round, 3);
        assertEquals(saved?.ledger.items, []);
        assertEquals((await readEpicDeliveryState(repo, "epic"))?.children.length, 2);
    });
});

test("repair names do not reuse a surviving repair after an earlier member is removed", async () => {
    const { repo } = await epicWithPendingSecondChild();
    return await withRetainedPlanFixture(repo, async () => {
        await deliverSecondChild(repo);
        await git(repo, ["switch", "epic/epic"]);
        const oldName = "epic/99-repair-integration-findings-2";
        await writePlan(repo, oldName, childAttrs(40, { status: "user_verified" }), "# Keep delivered repair\n");
        await git(repo, ["add", "."]);
        await git(repo, ["commit", "-m", "surviving repair"]);
        const before = await git(repo, ["show", `epic/epic:docs/plans/${oldName}.md`]);
        await git(repo, ["switch", "main"]);
        const result = await runEpicIntegrationGate({
            hostedSession: gateSession().hostedSession,
            projectRoot: repo,
            epicPlanName: "epic",
            semanticReviewPort: scriptedReviewer({ approved: true }),
            workRecordMnemotecaPort: createWorkRecordMnemotecaFixture(),
            localCIPort: scriptedChecks({ kind: "completed", exitCode: 1, output: "repair required" }),
        });
        if (result.kind !== "findings") throw new Error(`Expected findings, got ${result.kind}`);
        assertEquals(result.repairChild.childPlanName, "epic/repair-integration-findings-3");
        assertEquals((await loadPlan(repo, "epic/repair-integration-findings-3"))?.attrs.order, 41);
        assertEquals(await git(repo, ["show", `epic/epic:docs/plans/${oldName}.md`]), before);
    });
});
