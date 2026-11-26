import { strictEqual } from "node:assert";
import { test } from "node:test";
import { assertEquals, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { AgentSession, ExtensionRunner, SessionManager } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { startMcpIntegration } from "@runwield/pi-ai/mcp";
import { mcpFixtureHost, mcpFixtureServer } from "../mcp/integration-fixture.ts";
import { HostedSession } from "./hosted-session.ts";
import { SessionHost } from "./session-host.ts";

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

test("HostedSession keeps replacement MCP integration usable when the prior SDK shutdown fails", async (t) => {
    await withRuntimeCommandFixture("session-host-mcp-", async ({ projectRoot }) => {
        const hosted = new HostedSession({ id: "mcp-replacement", cwd: projectRoot });
        const options = { ...mcpFixtureHost(projectRoot), servers: [mcpFixtureServer()] };
        const { integration: prior } = await startMcpIntegration(options);
        try {
            await hosted.setMcpIntegration(prior);
            const { integration: replacement } = await startMcpIntegration(options);
            const toolNames = prior.getTools().map((tool) => tool.name);
            assertEquals(toolNames.length > 0, true);
            const emit = ExtensionRunner.prototype.emit;
            const shutdown = t.mock.method(
                ExtensionRunner.prototype,
                "emit",
                async function (this: ExtensionRunner, event: Parameters<typeof emit>[0]) {
                    const result = await emit.call(this, event);
                    if (event.type === "session_shutdown") throw new Error("SDK shutdown failed");
                    return result;
                },
            );
            const dispose = t.mock.method(AgentSession.prototype, "dispose");
            await hosted.setMcpIntegration(replacement);
            shutdown.mock.restore();
            strictEqual(hosted.getMcpIntegration(), replacement);
            assertEquals(prior.getTools(), []);
            assertEquals(replacement.getTools().map((tool) => tool.name), toolNames);
            assertEquals(dispose.mock.calls.length, 1);
            assertStringIncludes(JSON.stringify(await hosted.getMcpIntegration()?.runCommand("")), "connected");
            await hosted.dispose();
            assertEquals(replacement.getTools(), []);
            assertEquals(dispose.mock.calls.length, 2);
        } finally {
            if (!hosted.disposed) await hosted.dispose();
        }
    });
});
