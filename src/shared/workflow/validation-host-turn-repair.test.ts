import { test } from "node:test";
import { writeFile as fsWriteFile, mkdtemp as fsMkdtemp, symlink as fsSymlink, rm as fsRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertExists, assertStringIncludes } from "../../testing/assertions.ts";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { git } from "../git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { updatePlanFrontMatter } from "../../plan-store.js";
import { recordValidationRepairCompletion } from "./validation-supervisor.ts";
import { makeValidationCheckpoint } from "./validation-checkpoint.ts";
import { captureWorktreeTree } from "./git-snapshot.ts";
import { applyRoundFindings, createLedger } from "./review-ledger.ts";
import { complete, hostFixture, hostRequest } from "./testing/validation-host-fixture.ts";

import process from "node:process";

test("host reclaims the existing semantic repair handoff without another check or receipt", async () => {
    const fixture = await hostFixture();
    try {
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
                validationCheckpoint: makeValidationCheckpoint({
                    attemptId: fixture.id,
                    generation: "shared-attempt",
                    status: "implemented",
                    phase: "mechanical",
                    state: "awaiting_repair",
                    repairKind: "semantic",
                    repairGeneration: "shared-repair",
                    reviewState: {
                        semanticRound: 1,
                        reviewLedger: ledger,
                        repairBaselineTree: await captureWorktreeTree(fixture.cwd),
                    },
                }),
            },
            plan.attrs,
            { expectedRevision: plan.revision, expectedControllerRevision: plan.controllerRevision },
        );
        const repair = hostRequest(await fixture.processTurn(), "repair");
        assertEquals(repair.repairGeneration, "shared-repair");
        assertStringIncludes(repair.prompt, "R1-1");
        assertEquals(await fixture.ciCount(), 0);
        assertEquals(await fixture.evidence(), []);
        assertEquals(hostRequest(await fixture.processTurn(), "repair").identity, repair.identity);
        assertEquals(await fixture.evidence(), []);
        await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
        const reviewer = hostRequest(await fixture.processTurn(complete(repair)), "reviewer");
        assertEquals(
            (await fixture.plan()).attrs.validationCheckpoint?.reviewState?.reviewLedger.items[0].status,
            "fix_claimed",
        );
        assertEquals(await fixture.ciCount(), 1);
        const evidence = await fixture.evidence();
        assertEquals(hostRequest(await fixture.processTurn(complete(repair)), "reviewer").identity, reviewer.identity);
        assertEquals(await fixture.ciCount(), 1);
        assertEquals(await fixture.evidence(), evidence);
    } finally {
        await fixture.close();
    }
});
test("a consumed repair cannot rerun CI even when its check requires another repair", async () => {
    const fixture = await hostFixture();
    try {
        const repair = hostRequest(await fixture.processTurn(), "repair");
        const nextRepair = hostRequest(await fixture.processTurn(complete(repair)), "repair");
        assertNotEquals(nextRepair.repairGeneration, repair.repairGeneration);
        assertEquals(await fixture.ciCount(), 2);
        const evidence = await fixture.evidence();
        const checkpoint = await fixture.checkpointBytes();
        assertEquals((await fixture.processTurn(complete(repair))).kind, "failed");
        assertEquals(await fixture.ciCount(), 2);
        assertEquals(await fixture.evidence(), evidence);
        assertEquals(await fixture.checkpointBytes(), checkpoint);
    } finally {
        await fixture.close();
    }
});

for (const legacyReceipt of [false, true]) {
    test(`process loss before a new repair settles preserves its pending request (${legacyReceipt ? "old receipt" : "new checkpoint"})`, async () => {
        const fixture = await hostFixture();
        try {
            const first = hostRequest(await fixture.processTurn(), "repair");
            const second = hostRequest(await fixture.processTurn(complete(first)), "repair");
            const plan = await fixture.plan();
            const pending = plan.attrs.validationCheckpoint;
            assertExists(pending);
            if (!legacyReceipt) assertEquals(pending.repairCompletedOperationId, undefined);
            // The real failed R1 completion saved R2. Restore the crash interval
            // before supervisor settlement, without replacing persistence or CI.
            await updatePlanFrontMatter(
                fixture.cwd,
                "p",
                {
                    validationCheckpoint: {
                        ...pending,
                        lastSettledOperationId: undefined,
                        ...(legacyReceipt ? { repairCompletedOperationId: first.repairGeneration } : {}),
                    },
                },
                plan.attrs,
                {
                    expectedRevision: plan.revision,
                    expectedControllerRevision: plan.controllerRevision,
                },
            );
            const evidence = await fixture.evidence();
            assertEquals(hostRequest(await fixture.processTurn(), "repair"), second);
            assertEquals(await fixture.ciCount(), 2);
            assertEquals(await fixture.evidence(), evidence);
        } finally {
            await fixture.close();
        }
    });
}

test("a consumed CI repair returns its pending decision without another CI run or checkpoint write", async () => {
    const fixture = await hostFixture({ attrs: { validationCiAttempts: 2 } });
    try {
        const repair = hostRequest(await fixture.processTurn(), "repair");
        assertEquals(await fixture.ciCount(), 1);
        const decision = hostRequest(await fixture.processTurn(complete(repair)), "decision");
        assertEquals(await fixture.ciCount(), 2);
        const evidence = await fixture.evidence();
        const checkpoint = await fixture.checkpointBytes();
        assertEquals(hostRequest(await fixture.processTurn(complete(repair)), "decision").identity, decision.identity);
        assertEquals(await fixture.ciCount(), 2);
        assertEquals(await fixture.evidence(), evidence);
        assertEquals(await fixture.checkpointBytes(), checkpoint);
    } finally {
        await fixture.close();
    }
});

test("a consumed repair cannot repeat a failed CI process start", async () => {
    await withProcessGlobalTestLock(async () => {
        const fixture = await hostFixture();
        const path = process.env["PATH"];
        const bin = await fsMkdtemp(join(tmpdir(), "host-git-only-"));
        try {
            const repair = hostRequest(await fixture.processTurn(), "repair");
            const execPath = (await git(fixture.cwd, ["--exec-path"])).trim();
            await fsSymlink(join(execPath, "git"), join(bin, "git"));
            process.env["PATH"] = bin;
            assertEquals((await fixture.processTurn(complete(repair))).kind, "paused");
            const evidence = await fixture.evidence();
            assertEquals(evidence.at(-1)?.kind, "ci");
            assertEquals(evidence.at(-1)?.outcome, "operational_failure");
            const checkpoint = await fixture.checkpointBytes();
            assertEquals((await fixture.processTurn(complete(repair))).kind, "paused");
            assertEquals(await fixture.evidence(), evidence);
            assertEquals(await fixture.checkpointBytes(), checkpoint);
            assertEquals(await fixture.ciCount(), 1);
        } finally {
            if (path === undefined) delete process.env["PATH"];
            else process.env["PATH"] = path;
            await fsRm(bin, { recursive: true });
            await fixture.close();
        }
    });
});

for (const resumeWithCompletion of [true, false]) {
    test(`process loss after a ready repair receipt resumes CI once (${resumeWithCompletion ? "completion" : "no answer"})`, async () => {
        const fixture = await hostFixture();
        try {
            const repair = hostRequest(await fixture.processTurn(), "repair");
            await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
            await recordValidationRepairCompletion({
                projectRoot: fixture.cwd,
                planName: "p",
                repairGeneration: repair.repairGeneration,
                report: "Fixed before process loss.",
            });
            const ready = (await fixture.plan()).attrs.validationCheckpoint;
            assertEquals(ready?.state, "ready");
            assertEquals(ready?.repairCompletedOperationId, repair.repairGeneration);
            assertEquals(ready?.lastSettledOperationId, undefined);
            const reviewer = hostRequest(
                await fixture.processTurn(resumeWithCompletion ? complete(repair) : undefined),
                "reviewer",
            );
            assertEquals(await fixture.ciCount(), 2);
            assertEquals(
                (await fixture.plan()).attrs.validationCheckpoint?.lastSettledOperationId,
                repair.repairGeneration,
            );
            const evidence = await fixture.evidence();
            assertEquals(
                hostRequest(await fixture.processTurn(complete(repair)), "reviewer").identity,
                reviewer.identity,
            );
            assertEquals(await fixture.ciCount(), 2);
            assertEquals(await fixture.evidence(), evidence);
            assertEquals(hostRequest(await fixture.processTurn(), "reviewer").identity, reviewer.identity);
            assertEquals(await fixture.ciCount(), 2);
            assertEquals(await fixture.evidence(), evidence);
        } finally {
            await fixture.close();
        }
    });
}
