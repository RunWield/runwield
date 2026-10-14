import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertExists, assertStringIncludes } from "../../testing/assertions.ts";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { join } from "node:path";
import { updatePlanFrontMatter } from "../../plan-store.js";
import { getExactProjectCustomSetting } from "../settings.js";
import { captureWorktreeTree } from "./git-snapshot.ts";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import { CI_REPAIR_CYCLES, SEMANTIC_REVIEW_CYCLES } from "./validation-types.ts";
import { applyRoundFindings, createLedger } from "./review-ledger.ts";
import { complete, coverage, type HostFixture, hostFixture, hostRequest } from "./testing/validation-host-fixture.ts";
import { sessionScript } from "../../testing/validation-session-script.ts";

async function pastReviewLimit(fixture: HostFixture) {
    await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
    const plan = await fixture.plan();
    const ledger = applyRoundFindings(
        createLedger(),
        [
            {
                title: "Value",
                resolved: false,
                requirement: "Value",
                evidence: "Missing",
            },
        ],
        1,
    ).ledger;
    await updatePlanFrontMatter(
        fixture.cwd,
        "p",
        {
            validationPhase: "semantic",
            validationSemanticRounds: SEMANTIC_REVIEW_CYCLES,
            validationCheckpoint: makeValidationCheckpoint({
                attemptId: fixture.id,
                generation: "round-limit",
                status: "implemented",
                phase: "semantic",
                state: "ready",
                reviewState: {
                    semanticRound: SEMANTIC_REVIEW_CYCLES,
                    reviewLedger: ledger,
                    repairBaselineTree: await captureWorktreeTree(fixture.cwd),
                    lastRepairReport: "Fixed the value.",
                },
            }),
        },
        plan.attrs,
        { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
    );
}
test("round-limit continue is durable and accepts the next reviewer without another decision", async () => {
    const fixture = await hostFixture();
    try {
        await pastReviewLimit(fixture);
        const decision = hostRequest(await fixture.processTurn(), "decision");
        assertEquals(
            decision.interaction.options?.map((option) => option.value),
            ["continue", "engineer_follow_up", "code_review", "stop"],
        );
        const reviewer = hostRequest(
            await fixture.processTurn({
                kind: "decision",
                identity: decision.identity,
                answer: { outcome: "selected", value: "continue" },
            }),
            "reviewer",
        );
        assertEquals(reviewer.reviewMode, "verify");
        const reread = hostRequest(await fixture.processTurn(), "reviewer");
        assertEquals(reread.identity, reviewer.identity);
        const result = await fixture.processTurn({
            kind: "reviewer",
            identity: reread.identity,
            coverage: coverage(reread),
            outcome: { approved: true, findings: [{ id: "R1-1", title: "Value", status: "fix_confirmed" }] },
        });
        assertEquals(result.kind, "awaiting_delivery");
        assertEquals(await fixture.ciCount(), 0);
    } finally {
        await fixture.close();
    }
});
test("round-limit stop preserves passing tests and findings like the Session answer", async () => {
    const host = await hostFixture();
    const core = await hostFixture();
    try {
        await pastReviewLimit(host);
        await pastReviewLimit(core);
        const decision = hostRequest(await host.processTurn(), "decision");
        assertEquals(hostRequest(await host.processTurn(), "decision").identity, decision.identity);
        const before = (await host.plan()).attrs.validationCheckpoint?.reviewState;
        const result = await host.processTurn({
            kind: "decision",
            identity: decision.identity,
            answer: { outcome: "selected", value: "stop" },
        });
        const session = await sessionScript(core, {
            outcomes: [],
            answer: () => ({ outcome: "selected", value: "stop" }),
        });
        assertEquals(result.kind, "paused");
        assertEquals(session.result.kind, "paused");
        assertEquals((await host.plan()).attrs.validationCheckpoint?.reviewState, before);
        assertEquals(
            (await host.plan()).attrs.validationCheckpoint?.reviewState,
            (await core.plan()).attrs.validationCheckpoint?.reviewState,
        );
        assertEquals(await host.ciCount(), 0);
        assertEquals(await core.ciCount(), 0);
        const nextDecision = hostRequest(await host.processTurn(), "decision");
        assertNotEquals(nextDecision.identity, decision.identity);
        const reviewer = hostRequest(
            await host.processTurn({
                kind: "decision",
                identity: nextDecision.identity,
                answer: { outcome: "selected", value: "continue" },
            }),
            "reviewer",
        );
        const outcome = {
            approved: true,
            findings: [{ id: "R1-1", title: "Value", status: "fix_confirmed" as const }],
        };
        assertEquals(
            (
                await host.processTurn({
                    kind: "reviewer",
                    identity: reviewer.identity,
                    coverage: coverage(reviewer),
                    outcome,
                })
            ).kind,
            "awaiting_delivery",
        );
        const restarted = await sessionScript(core, {
            outcomes: [outcome],
            answer: () => ({ outcome: "selected", value: "continue" }),
        });
        // Core continues to its human delivery gate; the host stops at reviewed.
        assertEquals(restarted.result.kind, "paused");
        assertEquals((await core.plan()).attrs.status, "reviewed");
        assertEquals(await host.lifecycle(), await core.lifecycle());
        assertEquals(
            (await host.evidence()).map(({ kind, outcome }) => ({ kind, outcome })),
            (await core.evidence()).map(({ kind, outcome }) => ({ kind, outcome })),
        );
        assertEquals(
            (await host.plan()).attrs.validationCheckpoint?.reviewState,
            (await core.plan()).attrs.validationCheckpoint?.reviewState,
        );
    } finally {
        await host.close();
        await core.close();
    }
});
test("missing validation command asks the same question and saves the answer before CI", async () => {
    const fixture = await hostFixture({ command: null });
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
        const decision = hostRequest(await fixture.processTurn(), "decision");
        assertEquals(decision.interaction.type, "text");
        assertEquals(decision.interaction.allowEmpty, false);
        assertEquals(await fixture.ciCount(), 0);
        const checkpoint = JSON.stringify((await fixture.plan()).attrs.validationCheckpoint);
        assertEquals(
            (
                await fixture.processTurn({
                    kind: "decision",
                    identity: { ...decision.identity, generation: "stale" },
                    answer: { outcome: "text", value: "sh verify.sh" },
                })
            ).kind,
            "failed",
        );
        assertEquals(JSON.stringify((await fixture.plan()).attrs.validationCheckpoint), checkpoint);
        hostRequest(
            await fixture.processTurn({
                kind: "decision",
                identity: decision.identity,
                answer: { outcome: "text", value: "sh verify.sh" },
            }),
            "reviewer",
        );
        assertEquals(getExactProjectCustomSetting("verification_command", fixture.cwd), "sh verify.sh");
        assertEquals(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});
for (const answer of ["retry", "engineer_follow_up", "stop"] as const) {
    test(`CI exhaustion resumes ${answer} at the original prompt without running CI first`, async () => {
        const host = await hostFixture({ attrs: { validationCiAttempts: CI_REPAIR_CYCLES } });
        const core = await hostFixture({ attrs: { validationCiAttempts: CI_REPAIR_CYCLES } });
        try {
            const decision = hostRequest(await host.processTurn(), "decision");
            const checkpoint = (await host.plan()).attrs.validationCheckpoint;
            assertExists(checkpoint?.pendingCiDecision);
            assertEquals(checkpoint.pendingCiDecision.ciAttempts, CI_REPAIR_CYCLES);
            assertEquals(
                decision.interaction.options?.map((option) => option.value),
                ["engineer_follow_up", "retry", "stop"],
            );
            const before = (await host.evidence()).filter((entry) => entry.kind === "ci").length;
            let result = await host.processTurn({
                kind: "decision",
                identity: decision.identity,
                answer: { outcome: "selected", value: answer },
            });
            let selection = 0;
            const sessionPrompts: string[] = [];
            const session = await sessionScript(core, {
                outcomes: [],
                repairCompleted: false,
                answer: (request) => {
                    sessionPrompts.push(request.prompt);
                    if (request.type === "text") return { outcome: "text", value: "Fix the new value." };
                    return { outcome: "selected", value: selection++ === 0 ? answer : "stop" };
                },
            });
            assertEquals(decision.interaction.prompt, sessionPrompts[0]);
            if (answer === "engineer_follow_up") {
                const text = hostRequest(result, "decision");
                assertEquals(text.interaction.type, "text");
                result = await host.processTurn({
                    kind: "decision",
                    identity: text.identity,
                    answer: { outcome: "text", value: "Fix the new value." },
                });
                const repair = hostRequest(result, "repair");
                assertEquals(await host.lifecycle(), await core.lifecycle());
                assertStringIncludes(repair.prompt, "Fix the new value.");
                assertStringIncludes(repair.prompt, "Continue the interrupted validation repair");
                const waiting = (await host.plan()).attrs.validationCheckpoint;
                assertEquals(waiting?.repairGeneration, repair.repairGeneration);
                const bytes = await host.checkpointBytes();
                assertEquals(
                    (
                        await host.processTurn({
                            kind: "task_completed",
                            identity: { ...repair.identity, repairGeneration: "wrong" },
                            report: "wrong",
                        })
                    ).kind,
                    "failed",
                );
                assertEquals(await host.checkpointBytes(), bytes);
                const count = await host.ciCount();
                const repeated = hostRequest(await host.processTurn(), "repair");
                assertEquals(repeated.identity, repair.identity);
                assertEquals(await host.ciCount(), count);
                // A completed follow-up reruns CI once. Repeating its receipt runs nothing.
                await fsWriteFile(join(host.cwd, "marker"), "fixed");
                const afterRepair = hostRequest(await host.processTurn(complete(repair)), "reviewer");
                assertEquals(await host.ciCount(), count + 1);
                const evidence = await host.evidence();
                const afterRepeat = hostRequest(await host.processTurn(complete(repair)), "reviewer");
                assertEquals(afterRepeat.identity, afterRepair.identity);
                assertEquals(await host.ciCount(), count + 1);
                assertEquals(await host.evidence(), evidence);
            } else if (answer === "retry") hostRequest(result, "decision");
            else assertEquals(result.kind, "paused");
            // Compare at the answer boundary, before the explicit follow-up completion above.
            assertEquals(before, 1);
            assertEquals(
                (await core.evidence()).filter((entry) => entry.kind === "ci").length,
                answer === "retry" ? 2 : 1,
            );
            assertEquals(session.result.kind, "paused");
            const expectedHostCi = answer === "engineer_follow_up" ? 2 : answer === "retry" ? 2 : 1;
            assertEquals((await host.evidence()).filter((entry) => entry.kind === "ci").length, expectedHostCi);
            if (answer === "stop") {
                hostRequest(await host.processTurn(), "decision");
                assertEquals((await host.evidence()).filter((entry) => entry.kind === "ci").length, before + 1);
            }
        } finally {
            await host.close();
            await core.close();
        }
    });
}

test("round-limit human takeover stops at reviewed without a human or publication turn", async () => {
    const fixture = await hostFixture();
    try {
        await pastReviewLimit(fixture);
        const decision = hostRequest(await fixture.processTurn(), "decision");
        const result = await fixture.processTurn({
            kind: "decision",
            identity: decision.identity,
            answer: { outcome: "selected", value: "code_review" },
        });
        assertEquals(result.kind, "awaiting_delivery");
        const plan = await fixture.plan();
        assertEquals(plan.attrs.status, "reviewed");
        assertEquals(plan.attrs.humanReviewMode, "always");
        assertEquals(plan.attrs.humanReviewDecision, null);
        assertEquals(
            (await fixture.evidence()).map(({ kind, outcome }) => ({ kind, outcome })),
            [
                {
                    kind: "ai-skip",
                    outcome: "Human takeover",
                },
            ],
        );
        assertEquals(await fixture.ciCount(), 0);
    } finally {
        await fixture.close();
    }
});
test("round-limit Engineer follow-up keeps the ledger and consumes task completion once", async () => {
    const fixture = await hostFixture();
    try {
        await pastReviewLimit(fixture);
        const decision = hostRequest(await fixture.processTurn(), "decision");
        const text = hostRequest(
            await fixture.processTurn({
                kind: "decision",
                identity: decision.identity,
                answer: { outcome: "selected", value: "engineer_follow_up" },
            }),
            "decision",
        );
        const repair = hostRequest(
            await fixture.processTurn({
                kind: "decision",
                identity: text.identity,
                answer: { outcome: "text", value: "Keep the existing finding and fix the value." },
            }),
            "repair",
        );
        assertStringIncludes(repair.prompt, "Keep the existing finding");
        assertStringIncludes(repair.prompt, "R1-1");
        assertEquals(
            (await fixture.plan()).attrs.validationCheckpoint?.reviewState?.reviewLedger.items[0].status,
            "new",
        );
        const bytes = await fixture.checkpointBytes();
        assertEquals(
            (
                await fixture.processTurn({
                    kind: "task_completed",
                    identity: { ...repair.identity, repairGeneration: "wrong" },
                    report: "wrong",
                })
            ).kind,
            "failed",
        );
        assertEquals(await fixture.checkpointBytes(), bytes);
        await fsWriteFile(join(fixture.cwd, "implementation.ts"), "export const value = 2; // follow-up repair\n");
        const nextDecision = hostRequest(await fixture.processTurn(complete(repair)), "decision");
        assertEquals(await fixture.ciCount(), 1);
        assertEquals(
            (await fixture.plan()).attrs.validationCheckpoint?.reviewState?.reviewLedger.items[0].status,
            "fix_claimed",
        );
        const evidence = await fixture.evidence();
        assertEquals(
            hostRequest(await fixture.processTurn(complete(repair)), "decision").identity,
            nextDecision.identity,
        );
        assertEquals(await fixture.ciCount(), 1);
        assertEquals(await fixture.evidence(), evidence);
    } finally {
        await fixture.close();
    }
});
test("CI exhaustion without an answer reruns CI rather than replaying the old decision", async () => {
    const fixture = await hostFixture({ attrs: { validationCiAttempts: CI_REPAIR_CYCLES } });
    try {
        hostRequest(await fixture.processTurn(), "decision");
        assertEquals(await fixture.ciCount(), 1);
        hostRequest(await fixture.processTurn(), "decision");
        assertEquals(await fixture.ciCount(), 2);
        assertEquals((await fixture.evidence()).filter((entry) => entry.kind === "ci").length, 2);
    } finally {
        await fixture.close();
    }
});

test("Retry followed by the same CI failure rejects the old decision without effects", async () => {
    const fixture = await hostFixture({ attrs: { validationCiAttempts: CI_REPAIR_CYCLES } });
    try {
        const first = hostRequest(await fixture.processTurn(), "decision");
        const retry = {
            kind: "decision" as const,
            identity: first.identity,
            answer: { outcome: "selected" as const, value: "retry" },
        };
        const next = hostRequest(await fixture.processTurn(retry), "decision");
        assertEquals(next.interaction, first.interaction);
        assertEquals(await fixture.ciCount(), 2);
        const checkpoint = await fixture.checkpointBytes();
        const evidence = await fixture.evidence();
        const metrics = await fixture.metrics();
        assertEquals((await fixture.processTurn(retry)).kind, "failed");
        assertEquals(await fixture.checkpointBytes(), checkpoint);
        assertEquals(await fixture.evidence(), evidence);
        assertEquals(await fixture.metrics(), metrics);
        assertEquals(await fixture.ciCount(), 2);
        assertNotEquals(next.identity, first.identity);
        const text = hostRequest(
            await fixture.processTurn({
                kind: "decision",
                identity: next.identity,
                answer: { outcome: "selected", value: "engineer_follow_up" },
            }),
            "decision",
        );
        assertEquals(
            hostRequest(
                await fixture.processTurn({
                    kind: "decision",
                    identity: text.identity,
                    answer: { outcome: "text", value: "Fix it." },
                }),
                "repair",
            ).role,
            "reviewer-feedback-engineer",
        );
        assertEquals(await fixture.ciCount(), 2);
    } finally {
        await fixture.close();
    }
});
