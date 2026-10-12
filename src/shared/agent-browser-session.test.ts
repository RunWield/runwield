import { assertEquals } from "../testing/assertions.ts";
import { test } from "node:test";
import { match as assertMatch, notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { createAgentBrowserSessionCleanup } from "./agent-browser-session.ts";

test("agent-browser cleanup uses a unique wld namespace and runs once", () => {
    const env: Record<string, string> = {};
    let cleanupRuns = 0;
    const cleanup = createAgentBrowserSessionCleanup({
        envSet(name, value) {
            env[name] = value;
        },
        spawnCleanup() {
            cleanupRuns += 1;
        },
    });

    cleanup.initialize();
    cleanup.cleanupSync();
    cleanup.cleanupSync();

    assertMatch(env.AGENT_BROWSER_NAMESPACE, /^wld-[0-9a-f-]{36}$/);
    assertEquals(env.AGENT_BROWSER_NAMESPACE, cleanup.namespace);
    assertEquals(cleanupRuns, 1);
});

test("separate agent-browser cleanups cannot share a namespace", () => {
    const runtime = {
        envSet() {},
        spawnCleanup() {},
    };

    const first = createAgentBrowserSessionCleanup(runtime);
    const second = createAgentBrowserSessionCleanup(runtime);

    assertNotEquals(first.namespace, second.namespace);
});

test("agent-browser cleanup tolerates an unavailable helper", () => {
    let attempted = 0;
    const cleanup = createAgentBrowserSessionCleanup({
        envSet() {},
        spawnCleanup() {
            attempted += 1;
            throw new Error("agent-browser is unavailable");
        },
    });
    cleanup.initialize();
    cleanup.cleanupSync();
    cleanup.cleanupSync();
    assertEquals(attempted, 1);
});
