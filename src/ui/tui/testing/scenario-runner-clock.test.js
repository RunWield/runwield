import { test } from "node:test";
import { assertEquals, assertRejects } from "../../../testing/assertions.ts";
import { runGoldenScenario } from "./scenario-runner.js";

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
                        get actions() {
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
