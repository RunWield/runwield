import { test } from "node:test";
import { assertEquals, assertRejects } from "../../../testing/assertions.ts";
import { GoldenPlanIdentity, GoldenScenarioActor } from "./scenario-actor.ts";
import { runGoldenScenario, type GoldenAction } from "./scenario-runner.ts";

test("Golden scenario does not time out when the wall clock moves forward", async () => {
    const originalNow = Date.now;
    let reads = 0;
    Date.now = () => originalNow() + reads++ * 600_000;
    try {
        const result = await runGoldenScenario(
            {
                name: "forward-clock-jump",
                timeoutMs: 1000,
                actions: [{ type: "screen", text: "completed" }],
            },
            { keepArtifacts: false },
        );
        assertEquals(result.screenText, "\ncompleted");
    } finally {
        Date.now = originalNow;
    }
});

test("Golden scenario enforces its timeout when the wall clock moves backward", async () => {
    const originalNow = Date.now;
    let reads = 0;
    Date.now = () => originalNow() - reads++ * 600_000;
    try {
        await assertRejects(
            () =>
                runGoldenScenario(
                    {
                        name: "backward-clock-jump",
                        timeoutMs: 1,
                        get actions(): GoldenAction[] {
                            const start = performance.now();
                            while (performance.now() - start < 10) {
                                // Let the deadline pass without changing the monotonic clock.
                            }
                            return [{ type: "screen", text: "past deadline" }];
                        },
                    },
                    { keepArtifacts: false },
                ),
            Error,
            "Scenario timed out",
        );
    } finally {
        Date.now = originalNow;
    }
});

test("concurrent scripted review keeps its own Plan when a managed segment temporarily has no Plan", () => {
    const identity = new GoldenPlanIdentity();
    const actor = new GoldenScenarioActor([
        {
            id: "a-review",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "plan-a",
            ordinal: 1,
        },
        {
            id: "b-review",
            agent: "reviewer",
            phase: "semantic_review",
            planName: "plan-b",
            ordinal: 1,
        },
    ]);
    identity.seed("", "/load-plan plan-a");
    identity.seed("other", "/load-plan plan-b");
    assertEquals(identity.resolve("other", "plan-b"), "plan-b");
    // A has no current ID; a shared fallback would route this turn to B.
    actor.next({
        agent: "reviewer",
        phase: "semantic_review",
        planName: identity.resolve("", undefined),
        ordinal: 1,
    });
    actor.next({
        agent: "reviewer",
        phase: "semantic_review",
        planName: identity.resolve("other", ""),
        ordinal: 1,
    });
    assertEquals(actor.diagnostics().consumed, ["a-review", "b-review"]);
    assertEquals(identity.resolve("unused", undefined), "");
    actor.assertComplete();
});
