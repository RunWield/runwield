import { assert, assertEquals } from "@std/assert";
import { runGoldenChild, sanitizeGoldenChildEnv } from "./subprocess-runner.js";

Deno.test("sanitizeGoldenChildEnv strips common credential variables", () => {
    const env = sanitizeGoldenChildEnv({ OPENAI_API_KEY: "secret", PATH: "/bin", AUTH_TOKEN: "secret" });
    assertEquals(env, { PATH: "/bin" });
});

Deno.test("runGoldenChild captures output from a bounded Deno subprocess", async () => {
    const result = await runGoldenChild(["eval", "console.log('golden-child')"], { timeoutMs: 2000 });
    assert(result.success);
    assertEquals(result.timedOut, false);
    assert(result.stdout.includes("golden-child"));
});

Deno.test("runGoldenChild reports timeout and terminates child", async () => {
    const result = await runGoldenChild(["eval", "setInterval(() => {}, 1000)"], { timeoutMs: 100 });
    assertEquals(result.timedOut, true);
});
