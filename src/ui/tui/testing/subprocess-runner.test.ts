import { assertEquals } from "../../../testing/assertions.ts";

import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { runGoldenChild, sanitizeGoldenChildEnv } from "./subprocess-runner.js";

test("sanitizeGoldenChildEnv strips common credential variables", () => {
    const env = sanitizeGoldenChildEnv({ OPENAI_API_KEY: "secret", PATH: "/bin", AUTH_TOKEN: "secret" });
    assertEquals(env, { PATH: "/bin" });
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
