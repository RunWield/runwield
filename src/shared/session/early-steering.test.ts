import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import type { BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import {
    installEarlySteeringInterruption,
    type EarlySteeringAgent,
    type EarlySteeringSession,
} from "./early-steering.ts";

interface FixtureToolCall {
    name: string;
}

type FixtureBeforeToolCall = (
    call: FixtureToolCall,
) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;

interface FixtureAgent extends Omit<EarlySteeringAgent, "beforeToolCall"> {
    beforeToolCall?: FixtureBeforeToolCall;
}

interface FixtureSession extends Omit<EarlySteeringSession, "agent" | "getSteeringMessages"> {
    agent: FixtureAgent;
    getSteeringMessages: () => string[];
}

interface BlockingFixtureAgent extends FixtureAgent {
    beforeToolCall: FixtureBeforeToolCall;
}

interface BlockingFixtureSession extends FixtureSession {
    agent: BlockingFixtureAgent;
}

type FixtureInstaller = (session: EarlySteeringSession | FixtureSession) => void;

interface FixtureToolResult {
    tool: string;
    skipped: boolean;
    reason?: string;
}

test("installEarlySteeringInterruption allows current tool calls to complete when steering is pending", async () => {
    const executed: string[] = [];
    const providerCalls: string[][] = [];
    const steering: string[] = [];
    const session: FixtureSession = {
        agent: {},
        getSteeringMessages: () => steering,
    };

    (installEarlySteeringInterruption as FixtureInstaller)(session);
    assertEquals(session.agent.toolExecution, undefined);
    assertEquals(session.agent.beforeToolCall, undefined);

    async function runProviderTurn() {
        providerCalls.push([...steering]);
        const tools = ["first", "second", "third"];
        const results: FixtureToolResult[] = [];
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

test("installEarlySteeringInterruption preserves existing blocking beforeToolCall and is idempotent", async () => {
    let existingCalls = 0;
    const session: BlockingFixtureSession = {
        agent: {
            beforeToolCall() {
                existingCalls++;
                return { block: true, reason: "original block" };
            },
        },
        getSteeringMessages: () => ["pending"],
    };

    (installEarlySteeringInterruption as FixtureInstaller)(session);
    const wrapped = session.agent.beforeToolCall;
    (installEarlySteeringInterruption as FixtureInstaller)(session);

    assertEquals(session.agent.beforeToolCall, wrapped);
    assertEquals(await session.agent.beforeToolCall({ name: "tool" }), { block: true, reason: "original block" });
    assertEquals(existingCalls, 1);
});
