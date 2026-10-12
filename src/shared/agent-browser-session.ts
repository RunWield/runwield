/**
 * Keeps agent-browser processes owned by this wld invocation isolated and
 * closes them when the invocation exits.
 */

import { spawnSync } from "node:child_process";
import { env } from "node:process";

interface AgentBrowserCommandRuntime {
    envSet(name: string, value: string): void;
    spawnCleanup(): void;
}

function createNamespace(): string {
    return `wld-${crypto.randomUUID()}`;
}

function createSystemRuntime(): AgentBrowserCommandRuntime {
    return {
        envSet: (name, value) => {
            env[name] = value;
        },
        spawnCleanup: () => {
            spawnSync("agent-browser", ["close", "--all"], { stdio: "ignore" });
        },
    };
}

export function createAgentBrowserSessionCleanup(
    runtime: AgentBrowserCommandRuntime = createSystemRuntime(),
) {
    const namespace = createNamespace();
    let initialized = false;
    let cleanedUp = false;

    function initialize(): string {
        initialized = true;
        runtime.envSet("AGENT_BROWSER_NAMESPACE", namespace);
        return namespace;
    }

    function cleanupSync(): void {
        if (!initialized || cleanedUp) return;
        cleanedUp = true;
        try {
            runtime.spawnCleanup();
        } catch {
            // Browser cleanup is best-effort and must not hide the exit reason.
        }
    }

    return { initialize, cleanupSync, namespace };
}

const agentBrowserSessionCleanup = createAgentBrowserSessionCleanup();

export function initializeAgentBrowserSession(): void {
    agentBrowserSessionCleanup.initialize();
}

export function cleanupAgentBrowserSessionSync(): void {
    agentBrowserSessionCleanup.cleanupSync();
}
