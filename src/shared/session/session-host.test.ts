import { test } from "node:test";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { McpIntegration } from "../mcp/integration.ts";
import { HostedSession } from "./hosted-session.js";
import { SessionHost } from "./session-host.ts";

function makeSessionManager(id: string, cwd = `/work/${id}`) {
    return {
        getSessionId: () => id,
        getCwd: () => cwd,
        disposed: false,
        dispose() {
            this.disposed = true;
        },
    };
}

test("SessionHost creates sessions with deterministic ids and owns lookup metadata", () => {
    const sessionManager = makeSessionManager("manager-alpha", "/repo/alpha");
    const host = new SessionHost();

    const session = host.createSession({ id: "alpha", cwd: "/fallback/alpha", sessionManager });

    assertEquals(session instanceof HostedSession, true);
    assertEquals(session.id, "alpha");
    assertEquals(session.cwd, "/repo/alpha");
    assertStrictEquals(session.getRootSessionManager(), sessionManager);
    assertStrictEquals(host.getSession("alpha"), session);
    assertStrictEquals(host.requireSession("alpha"), session);
    assertEquals(host.listSessions(), [
        { id: "alpha", cwd: "/repo/alpha", sessionManagerId: "manager-alpha", disposed: false },
    ]);
});

test("SessionHost can adopt an existing HostedSession", () => {
    const hostedSession = new HostedSession({
        id: "adopted",
        cwd: "/repo/adopted",
        sessionManager: makeSessionManager("adopted-manager", "/repo/adopted"),
    });
    const host = new SessionHost();

    const adopted = host.adoptSession(hostedSession);

    assertStrictEquals(adopted, hostedSession);
    assertStrictEquals(host.getSession("adopted"), hostedSession);
    assertEquals(host.listSessions(), [
        { id: "adopted", cwd: "/repo/adopted", sessionManagerId: "adopted-manager", disposed: false },
    ]);
});

test("SessionHost prefers explicit internal ids and otherwise reuses SessionManager ids", () => {
    let idFactoryCalls = 0;
    const host = new SessionHost({ idFactory: () => `generated-${++idFactoryCalls}` });

    const first = host.createSession({ cwd: "/repo/one", sessionManager: makeSessionManager("one") });
    const second = host.createSession({
        id: "provided-two",
        cwd: "/repo/two",
        sessionManager: makeSessionManager("two"),
    });

    assertEquals(first.id, "one");
    assertEquals(second.id, "provided-two");
    assertEquals(idFactoryCalls, 0);
    assertEquals(
        host.listSessions().map((session) => session.id),
        ["one", "provided-two"],
    );
});

test("SessionHost falls back to provided or generated ids when SessionManager has none", () => {
    let next = 0;
    const host = new SessionHost({ idFactory: () => `generated-${++next}` });

    const first = host.createSession({ id: "provided", cwd: "/repo/provided", sessionManager: null });
    const second = host.createSession({ cwd: "/repo/generated", sessionManager: null });

    assertEquals(first.id, "provided");
    assertEquals(second.id, "generated-1");
    assertEquals(
        host.listSessions().map((session) => session.id),
        ["provided", "generated-1"],
    );
});

test("SessionHost requireSession fails clearly when the session is missing", () => {
    const host = new SessionHost();

    assertEquals(host.getSession("missing"), null);
    assertThrows(() => host.requireSession("missing"), Error, 'HostedSession "missing" was not found');
});

test("SessionHost rejects duplicate ids for created or adopted sessions", () => {
    const host = new SessionHost();

    host.createSession({ id: "duplicate", cwd: "/repo/duplicate", sessionManager: makeSessionManager("duplicate") });

    assertThrows(
        () =>
            host.createSession({
                id: "duplicate",
                cwd: "/repo/duplicate-2",
                sessionManager: makeSessionManager("duplicate"),
            }),
        Error,
        'HostedSession "duplicate" already exists',
    );
    assertThrows(
        () =>
            host.adoptSession(
                new HostedSession({
                    id: "duplicate",
                    cwd: "/repo/adopted",
                    sessionManager: makeSessionManager("duplicate"),
                }),
            ),
        Error,
        'HostedSession "duplicate" already exists',
    );
});

test("SessionHost disposeSession removes and disposes only the target HostedSession", async () => {
    const alphaManager = makeSessionManager("alpha-manager");
    const betaManager = makeSessionManager("beta-manager");
    const host = new SessionHost();
    const alpha = host.createSession({ id: "alpha", cwd: "/repo/alpha", sessionManager: alphaManager });
    const beta = host.createSession({ id: "beta", cwd: "/repo/beta", sessionManager: betaManager });

    assertEquals(await host.disposeSession("alpha"), true);

    assertEquals(alpha.disposed, true);
    assertEquals(alphaManager.disposed, true);
    assertEquals(beta.disposed, false);
    assertEquals(betaManager.disposed, false);
    assertEquals(host.getSession("alpha"), null);
    assertStrictEquals(host.getSession("beta"), beta);
    assertEquals(host.listSessions(), [
        { id: "beta", cwd: "/work/beta-manager", sessionManagerId: "beta-manager", disposed: false },
    ]);
    assertEquals(await host.disposeSession("missing"), false);
});

function makeManagedOptions(id: string, runwieldSessionId: string) {
    return {
        id,
        cwd: `/repo/${id}`,
        sessionManager: null,
        managed: {
            runwieldSessionId,
            projectId: "project-managed",
            piSessionId: `pi-${id}`,
            transcriptPath: `/repo/${id}/session.jsonl`,
            generation: 0,
            acknowledgedGeneration: 0,
            acknowledgedEventId: null,
            name: id,
            activeAgent: null,
            workflowContext: null,
            syncState: null,
        },
    };
}

test("HostedSession keeps replacement MCP pool authoritative when prior pool close fails", async () => {
    const hostedSession = new HostedSession({ id: "mcp-replacement", cwd: "/repo/mcp-replacement" });
    let replacementClosed = false;
    const priorPool = new McpIntegration();
    priorPool.close = () => Promise.reject(new Error("prior close failed"));
    const replacementPool = new McpIntegration();
    replacementPool.close = () => {
        replacementClosed = true;
        return Promise.resolve();
    };

    await hostedSession.setMcpIntegration(priorPool);
    await hostedSession.setMcpIntegration(replacementPool);

    assertStrictEquals(hostedSession.getMcpIntegration(), replacementPool);
    assertEquals(replacementClosed, false);
    await hostedSession.dispose();
    assertEquals(replacementClosed, true);
});

test("SessionHost rejects a second live HostedSession for one stable RunWield Session id", async () => {
    const host = new SessionHost();
    const first = host.createSession(makeManagedOptions("managed-one", "runwield-same"));

    assertThrows(
        () => host.createSession(makeManagedOptions("managed-two", "runwield-same")),
        Error,
        'RunWield Session "runwield-same" already has live HostedSession "managed-one"',
    );

    assertEquals(await host.disposeSession(first.id), true);
    const second = host.createSession(makeManagedOptions("managed-two", "runwield-same"));
    assertEquals(second.id, "managed-two");
});
