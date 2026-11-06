import { test } from "node:test";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { McpIntegration } from "../mcp/integration.ts";
import { HostedSession } from "./hosted-session.js";
import { SessionHost } from "./session-host.ts";
import { buildAgentSession } from "./session.js";

// Pi is an external SDK. Keep RunWield's MCP integration and cleanup real while
// making the SDK report a failed shutdown and observing its disposal boundary.
async function sdkShutdown(cwd: string, fail: boolean, disposed: () => void): Promise<AgentSession> {
    const { session } = await buildAgentSession({ cwd, agentName: "guide" });
    const runner = session.extensionRunner;
    if (!runner) throw new Error("Real Pi extension runner was not initialized");
    if (fail) runner.emit = () => Promise.reject(new Error("SDK shutdown failed"));
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
        dispose();
        disposed();
    };
    return session;
}

test("SessionHost preserves real manager identity and removes only the requested session", async () => {
    await withRuntimeCommandFixture("session-host-identity-", async ({ projectRoot }) => {
        const host = new SessionHost();
        const firstManager = SessionManager.inMemory(projectRoot);
        const secondManager = SessionManager.inMemory(projectRoot);
        const first = host.createSession({ sessionManager: firstManager });
        const second = new HostedSession({ id: "explicit", sessionManager: secondManager });
        host.adoptSession(second);
        try {
            assertEquals(first.id, firstManager.getSessionId());
            assertEquals(
                host.listSessions().map(({ id, cwd }) => ({ id, cwd })),
                [
                    { id: firstManager.getSessionId(), cwd: projectRoot },
                    { id: "explicit", cwd: projectRoot },
                ],
            );
            assertThrows(() => host.adoptSession(second), Error, "already exists");
            assertEquals(await host.disposeSession(first.id), true);
            assertEquals(first.disposed, true);
            assertEquals(second.disposed, false);
            assertEquals(
                host.listSessions().map(({ id }) => id),
                ["explicit"],
            );
            assertThrows(() => host.requireSession(first.id), Error, "was not found");
            assertEquals(await host.disposeSession(first.id), false);
        } finally {
            await host.dispose();
        }
    });
});

test("SessionHost rejects two live owners of one persisted RunWield Session until the first is disposed", async () => {
    await withRuntimeCommandFixture("session-host-managed-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        const host = new SessionHost();
        const managed = {
            ...fixture.session,
            generation: 0,
            name: "Managed session",
            activeAgent: null,
            workflowContext: null,
        };
        try {
            const first = host.createSession({ id: "first", cwd: projectRoot, managed });
            assertThrows(
                () => host.createSession({ id: "second", cwd: projectRoot, managed }),
                Error,
                "already has live HostedSession",
            );
            assertEquals(
                host.listSessions().map(({ id }) => id),
                ["first"],
            );
            await host.disposeSession(first.id);
            assertEquals(host.createSession({ id: "second", cwd: projectRoot, managed }).id, "second");
        } finally {
            await host.dispose();
            await fixture.cleanup();
        }
    });
});

test("HostedSession keeps replacement MCP integration usable when the prior SDK shutdown fails", async () => {
    await withRuntimeCommandFixture("session-host-mcp-", async ({ projectRoot }) => {
        const hosted = new HostedSession({ id: "mcp-replacement", cwd: projectRoot });
        let priorDisposed = false;
        let replacementDisposed = false;
        const prior = new McpIntegration();
        prior.setSession(
            await sdkShutdown(projectRoot, true, () => {
                priorDisposed = true;
            }),
        );
        const replacement = new McpIntegration();
        replacement.setSession(
            await sdkShutdown(projectRoot, false, () => {
                replacementDisposed = true;
            }),
        );
        await hosted.setMcpIntegration(prior);
        await hosted.setMcpIntegration(replacement);
        assertEquals(priorDisposed, true);
        assertEquals(replacementDisposed, false);
        assertEquals(await hosted.getMcpIntegration()?.runCommand("status"), [
            { message: "No MCP servers configured.", level: "info" },
        ]);
        await hosted.dispose();
        assertEquals(replacementDisposed, true);
    });
});
