import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { coverage, hostFixture, hostRequest } from "./testing/validation-host-fixture.ts";
import { sessionScript } from "../../testing/validation-session-script.ts";
import { classifyValidationOperationalError } from "./validation-operational-errors.ts";
import {
    decideValidationRecovery,
    readValidationRetryPolicy,
    VALIDATION_PROTOCOL_CORRECTION_LIMIT,
} from "./validation-recovery.ts";

test("fresh reviewer corrections spend the same limit as Session nudges and cannot reset it", async () => {
    const host = await hostFixture();
    const core = await hostFixture();
    try {
        for (const fixture of [host, core]) await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
        let reviewer = hostRequest(await host.processTurn(), "reviewer");
        for (let count = 1; count <= VALIDATION_PROTOCOL_CORRECTION_LIMIT; count++) {
            reviewer = hostRequest(
                await host.processTurn({
                    kind: "reviewer",
                    identity: reviewer.identity,
                    outcome: null,
                    coverage: coverage(reviewer),
                }),
                "reviewer",
            );
            assertEquals(reviewer.identity.correctionCount, count);
        }
        const metrics = await host.metrics();
        const ledger = (await host.plan()).attrs.validationCheckpoint?.reviewState;
        assertEquals(
            (
                await host.processTurn({
                    kind: "reviewer",
                    identity: { ...reviewer.identity, correctionCount: 0 },
                    outcome: { approved: true },
                    coverage: coverage(reviewer),
                })
            ).kind,
            "failed",
        );
        assertEquals(await host.metrics(), metrics);
        assertEquals((await host.plan()).attrs.validationCheckpoint?.reviewState, ledger);
        const result = await host.processTurn({
            kind: "reviewer",
            identity: reviewer.identity,
            outcome: null,
            coverage: coverage(reviewer),
        });
        const session = await sessionScript(core, {
            outcomes: Array(VALIDATION_PROTOCOL_CORRECTION_LIMIT + 1).fill(null),
        });
        assertEquals(result.kind, "paused");
        if (result.kind !== "paused") throw new Error("Expected the correction pause.");
        assertStringIncludes(result.reason, "Protocol correction budget is spent");
        assertEquals(result.recovery, session.result.recovery);
        assertEquals(
            (await host.plan()).attrs.validationCheckpoint?.hostReview?.correctionCount,
            VALIDATION_PROTOCOL_CORRECTION_LIMIT + 1,
        );
        assertEquals(await host.ciCount(), 1);
        assertEquals(session.reviewerTurn, VALIDATION_PROTOCOL_CORRECTION_LIMIT + 1);
        assertEquals(new Set(session.managers).size, 1, "Session nudges must share the same Pi manager.");
    } finally {
        await host.close();
        await core.close();
    }
});
test("host operational retries pause without sleeping and retain their budget across processes", async () => {
    const fixture = await hostFixture();
    try {
        await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
        let reviewer = hostRequest(await fixture.processTurn(), "reviewer");
        const failure = classifyValidationOperationalError({
            source: "provider",
            kind: "rate_limited",
            operation: "semantic_review",
            message: "Provider is busy.",
            retryAfter: 60,
        });
        for (let attempt = 1; attempt <= 3; attempt++) {
            const started = performance.now();
            const result = await fixture.processTurn({
                kind: "reviewer",
                identity: reviewer.identity,
                outcome: null,
                coverage: [],
                failure,
            });
            assert(performance.now() - started < 10_000, "Host mode must not sleep for the provider's 60-second wait.");
            assertEquals(result.kind, "paused");
            if (result.kind !== "paused") throw new Error("Expected retry pause.");
            const policyDecision = decideValidationRecovery({
                failure,
                attempt,
                policy: readValidationRetryPolicy(fixture.root),
                nextPhase: "semantic",
            });
            assertEquals(result.recovery, policyDecision.result);
            assertEquals(result.reason, policyDecision.result.message);
            assertEquals(await fixture.ciCount(), 1);
            if (attempt < 3) reviewer = hostRequest(await fixture.processTurn(), "reviewer");
        }
    } finally {
        await fixture.close();
    }
});
