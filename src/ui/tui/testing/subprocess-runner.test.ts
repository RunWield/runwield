import { assertEquals } from "../../../testing/assertions.ts";

import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { runGoldenChild } from "./subprocess-runner.ts";

test("Golden subprocesses cannot inherit caller credentials", async () => {
    const previous = process.env.WLD_AUDIT_AUTH_TOKEN;
    process.env.WLD_AUDIT_AUTH_TOKEN = "fixture-credential";
    try {
        const result = await runGoldenChild(
            [
                "-e",
                "console.log(JSON.stringify({ secret: process.env.WLD_AUDIT_AUTH_TOKEN ?? null, marker: process.env.WLD_AUDIT_MARKER }))",
            ],
            {
                env: { WLD_AUDIT_MARKER: "fixture-child" },
                timeoutMs: 2000,
            },
        );
        assert(result.success);
        assertEquals(JSON.parse(result.stdout), { secret: null, marker: "fixture-child" });
    } finally {
        if (previous === undefined) delete process.env.WLD_AUDIT_AUTH_TOKEN;
        else process.env.WLD_AUDIT_AUTH_TOKEN = previous;
    }
});

test("runGoldenChild captures output from a bounded active-runtime subprocess", async () => {
    const result = await runGoldenChild(["-e", "console.log('golden-child')"], {
        timeoutMs: 2000,
    });
    assert(result.success);
    assertEquals(result.timedOut, false);
    assert(result.stdout.includes("golden-child"));
});

test("runGoldenChild reports timeout and terminates child", async () => {
    const result = await runGoldenChild(["-e", "setInterval(() => {}, 1000)"], {
        timeoutMs: 100,
    });
    assertEquals(result.timedOut, true);
});
