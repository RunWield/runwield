import { assertEquals } from "@std/assert";
import { installEarlySteeringInterruption } from "./early-steering.ts";

Deno.test("installEarlySteeringInterruption allows current tool calls to complete when steering is pending", async () => {
    const executed = /** @type {string[]} */ ([]);
    const providerCalls = /** @type {string[][]} */ ([]);
    const steering = /** @type {string[]} */ ([]);
    const session = /** @type {any} */ ({
        agent: {},
        getSteeringMessages: () => steering,
    });

    installEarlySteeringInterruption(session);
    assertEquals(session.agent.toolExecution, undefined);
    assertEquals(session.agent.beforeToolCall, undefined);

    async function runProviderTurn() {
        providerCalls.push([...steering]);
        const tools = ["first", "second", "third"];
        const results = [];
        for (const tool of tools) {
            const decision = await session.agent.beforeToolCall?.({ name: tool });
            if (decision?.block) {
                results.push({ tool, skipped: true, reason: decision.reason });
                continue;
            }
            executed.push(tool);
            results.push({ tool, skipped: false });
            if (tool === "first") steering.push("Focus on the migration edge case first");
        }
        return results;
    }

    const results = await runProviderTurn();
    assertEquals(executed, ["first", "second", "third"]);
    assertEquals(results, [
        { tool: "first", skipped: false },
        { tool: "second", skipped: false },
        { tool: "third", skipped: false },
    ]);

    await runProviderTurn();
    assertEquals(providerCalls[1], ["Focus on the migration edge case first"]);
});

Deno.test("installEarlySteeringInterruption preserves existing blocking beforeToolCall and is idempotent", async () => {
    let existingCalls = 0;
    const session = /** @type {any} */ ({
        agent: {
            beforeToolCall() {
                existingCalls++;
                return { block: true, reason: "original block" };
            },
        },
        getSteeringMessages: () => ["pending"],
    });

    installEarlySteeringInterruption(session);
    const wrapped = session.agent.beforeToolCall;
    installEarlySteeringInterruption(session);

    assertEquals(session.agent.beforeToolCall, wrapped);
    assertEquals(await session.agent.beforeToolCall({ name: "tool" }), { block: true, reason: "original block" });
    assertEquals(existingCalls, 1);
});
