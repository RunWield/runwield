import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { loadPlan } from "../../plan-store.js";
import { type ReviewCompletePayload } from "./review-outcome.ts";
import {
    complete,
    coverage,
    type HostFixture,
    hostFixture,
    type HostFixtureOptions,
    hostRequest,
} from "./testing/validation-host-fixture.ts";
import { sessionScript } from "../../testing/validation-session-script.ts";

const finding = {
    title: "Wrong value",
    requirement: "Implement the value",
    evidence: "Wrong result",
    status: "new" as const,
};
const fixed = { id: "R1-1", title: "Wrong value", status: "fix_confirmed" as const };
type Case = { name: string; options?: HostFixtureOptions; ciRepair?: boolean; outcomes: ReviewCompletePayload[] };
const cases: Case[] = [
    { name: "CI failure, repair, and pass", ciRepair: true, outcomes: [{ approved: true }] },
    {
        name: "feedback, repair, and verify-round approval",
        outcomes: [
            { approved: false, findings: [finding] },
            {
                approved: false,
                findings: [{ ...fixed, status: "fix_rejected", rejectionReason: "The value still needs a guard." }],
            },
            { approved: true, findings: [fixed] },
        ],
    },
    {
        name: "unaccounted finding corrected on retry",
        outcomes: [{ approved: false, findings: [finding] }, { approved: true }, { approved: true, findings: [fixed] }],
    },
    {
        name: "approval with open findings rejected",
        outcomes: [{ approved: true, findings: [finding] }, { approved: true }],
    },
    { name: "Plan-only diff fails validation", options: { planOnly: true }, outcomes: [] },
    {
        name: "human changes_requested skips AI review",
        options: { attrs: { humanReviewDecision: "changes_requested" } },
        outcomes: [],
    },
    { name: "non-Git skip", options: { nonGit: true }, outcomes: [] },
    {
        name: "Epic child records integration notes",
        options: { attrs: { parentPlan: "epic" } },
        outcomes: [
            {
                approved: true,
                integrationNotes: [{ check: "Check assembled value", where: "implementation.ts" }],
            },
        ],
    },
];
async function observable(fixture: HostFixture) {
    const plan = await fixture.plan();
    const metrics: Array<{ category: string; event: string; details?: Record<string, string | number | boolean> }> = (
        await fixture.metrics()
    )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const validationBoundary = metrics.findLastIndex(
        (metric) =>
            metric.event === "plan_transition_committed" &&
            ["plan_event:semantic_review_passed", "plan_event:validation_failed"].includes(
                String(metric.details?.operation),
            ),
    );
    assert(validationBoundary >= 0, "Validation must record its final lifecycle boundary.");
    return {
        status: plan.attrs.status,
        events: await fixture.lifecycle(),
        review: plan.attrs.validationCheckpoint?.reviewState,
        evidence: (await fixture.evidence()).map(({ kind, outcome }) => ({ kind, outcome })),
        // Compare every validation metric up to reviewed/failed, before Core enters delivery.
        metrics: metrics
            .slice(0, validationBoundary + 1)
            .filter((metric) => metric.category === "validation")
            .map(({ event, details }) => ({ event, details })),
    };
}
for (const scenario of cases) {
    test(`Session and host-turn parity: ${scenario.name}`, async () => {
        const core = await hostFixture(scenario.options);
        const host = await hostFixture(scenario.options);
        try {
            if (!scenario.ciRepair) {
                for (const fixture of [core, host]) await fsWriteFile(join(fixture.cwd, "marker"), "fixed");
            }
            const session = await sessionScript(core, { outcomes: scenario.outcomes });
            let outcomeIndex = 0;
            let repairTurn = 0;
            let result = await host.turn();
            while (result.kind === "host_request") {
                if (result.request.kind === "repair") {
                    repairTurn++;
                    await fsWriteFile(join(host.cwd, "marker"), "fixed");
                    await fsWriteFile(
                        join(host.cwd, "implementation.ts"),
                        `export const value = ${repairTurn + 1}; // repaired implementation\n`,
                    );
                    result = await host.turn(complete(result.request));
                } else {
                    const reviewer = hostRequest(result, "reviewer");
                    if (scenario.options?.attrs?.parentPlan) assertStringIncludes(reviewer.prompt, "### Epic Context");
                    result = await host.turn({
                        kind: "reviewer",
                        identity: reviewer.identity,
                        outcome: scenario.outcomes[outcomeIndex++],
                        coverage: coverage(reviewer),
                    });
                }
            }
            assertEquals(result.kind, scenario.options?.planOnly ? "failed" : "awaiting_delivery");
            assertEquals(session.result.kind, scenario.options?.planOnly ? "failed" : "paused");
            assertEquals(await observable(host), await observable(core));
            if (scenario.options?.attrs?.parentPlan) {
                const coreEpic = await loadPlan(core.root, "epic");
                const hostEpic = await loadPlan(host.root, "epic");
                assertStringIncludes(hostEpic?.body || "", "Check assembled value");
                assertEquals(hostEpic?.body, coreEpic?.body);
            }
        } finally {
            await core.close();
            await host.close();
        }
    });
}
