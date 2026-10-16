import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HostedSession } from "../../shared/session/hosted-session.js";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { createSetSessionNameTool } from "../set-session-name.ts";

interface CapturedRuntimeEvent {
    type?: string;
    name?: string;
}

interface SetSessionNameResult {
    content: Array<{ type: string; text: string }>;
    details: { name: string } | null;
    isError?: boolean;
}

async function executeSetSessionNameTool(
    tool: ReturnType<typeof createSetSessionNameTool>,
    name: string,
): Promise<SetSessionNameResult> {
    const result = await tool.execute("call-1", { name }, new AbortController().signal, () => {}, {} as never);
    return result as SetSessionNameResult;
}

async function withSessionNameFixture(
    callback: (
        fixture: {
            projectRoot: string;
            sessionManager: SessionManager;
            events: CapturedRuntimeEvent[];
            hostedSession: HostedSession;
        },
    ) => Promise<void>,
): Promise<void> {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-set-session-name-"));
    try {
        const sessionManager = SessionManager.inMemory(projectRoot);
        const events: CapturedRuntimeEvent[] = [];
        const hostedSession = new HostedSession({
            id: `set-session-name-${crypto.randomUUID()}`,
            cwd: projectRoot,
            sessionManager: sessionManager as never,
            eventSink: { emit: (event: CapturedRuntimeEvent) => events.push(event) },
        });
        await callback({ projectRoot, sessionManager, events, hostedSession });
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => undefined);
    }
}

test("set_session_name exposes expected metadata", () => {
    const tool = createSetSessionNameTool();

    assertEquals(tool.name, "set_session_name");
    assertEquals(tool.label, "Set Session Name");
    assertStringIncludes(tool.description, "Set or replace the current Session Name");
    assertEquals(typeof tool.execute, "function");
    assertEquals(tool.parameters.required, ["name"]);
});

test("set_session_name sanitizes, persists, and emits one rename event", async () => {
    await withSessionNameFixture(async ({ sessionManager, events, hostedSession }) => {
        const tool = createSetSessionNameTool({ hostedSession });

        const result = await executeSetSessionNameTool(tool, "  direct\n\tagent\u0007 naming  ");

        assertEquals(result.isError, undefined);
        assertEquals(result.details, { name: "direct agent naming" });
        assertEquals(result.content[0].text, "Session name set: direct agent naming");
        assertEquals(sessionManager.getSessionName(), "direct agent naming");
        assertEquals(events.filter((event) => event.type === RuntimeEventTypes.SESSION_RENAMED), [
            { type: RuntimeEventTypes.SESSION_RENAMED, name: "direct agent naming" },
        ]);
    });
});

test("set_session_name replaces an existing Session Name", async () => {
    await withSessionNameFixture(async ({ sessionManager, events, hostedSession }) => {
        sessionManager.appendSessionInfo("old name");
        const tool = createSetSessionNameTool({ hostedSession });

        const result = await executeSetSessionNameTool(tool, "new name");

        assertEquals(result.details, { name: "new name" });
        assertEquals(sessionManager.getSessionName(), "new name");
        assertEquals(events.filter((event) => event.type === RuntimeEventTypes.SESSION_RENAMED).length, 1);
        assertEquals(events[0].name, "new name");
    });
});

test("set_session_name rejects names that sanitize to empty", async () => {
    await withSessionNameFixture(async ({ sessionManager, events, hostedSession }) => {
        const tool = createSetSessionNameTool({ hostedSession });

        const result = await executeSetSessionNameTool(tool, "\n\t\u0007");

        assertEquals(result.isError, true);
        assertStringIncludes(result.content[0].text, "empty after sanitization");
        assertEquals(result.details, null);
        assertEquals(sessionManager.getSessionName(), undefined);
        assertEquals(events.length, 0);
    });
});

test("set_session_name fails clearly without a HostedSession", async () => {
    const tool = createSetSessionNameTool();

    const result = await executeSetSessionNameTool(tool, "valid name");

    assertEquals(result.isError, true);
    assertStringIncludes(result.content[0].text, "no active HostedSession");
    assertEquals(result.details, null);
});

test("set_session_name fails clearly without a writable root Session manager", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-set-session-name-missing-manager-"));
    try {
        const hostedSession = new HostedSession({ id: "missing-manager", cwd: projectRoot });
        const tool = createSetSessionNameTool({ hostedSession });

        const result = await executeSetSessionNameTool(tool, "valid name");

        assertEquals(result.isError, true);
        assertStringIncludes(result.content[0].text, "no writable root Session manager");
        assertEquals(result.details, null);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => undefined);
    }
});
