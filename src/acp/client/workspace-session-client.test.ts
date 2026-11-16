import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ElicitationSchema, InitializeResponse } from "@agentclientprotocol/sdk";
import type { SessionClientView } from "../../ui/workspace/client/session-client.ts";
import { AcpWorkspaceSessionClient } from "./workspace-session-client.ts";

const methods = ["session/new", "session/load", "session/prompt", "session/cancel", "session/close"];

function supported(): InitializeResponse {
    return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { close: {}, _meta: { runwield: { implementedMethods: methods } } },
        },
    };
}

/** Only adverse peer behavior is simulated. No successful Core journey is claimed. */
async function adversePeer(initialization: InitializeResponse, workspaceAdmission = false) {
    const project = await mkdtemp(join(tmpdir(), "workspace-acp-rejection-"));
    const outbound = new TransformStream<Uint8Array, Uint8Array>();
    const inbound = new TransformStream<Uint8Array, Uint8Array>();
    const frames: string[] = [];
    const app = agent();
    app.onRequest("initialize", () => {
        frames.push("initialize");
        return initialization;
    });
    app.onRequest("session/new", () => {
        frames.push("session/new");
        return { sessionId: "wire-session", _meta: { runwield: { persistedSessionId: "saved-session" } } };
    });
    app.onRequest("session/load", () => {
        frames.push("session/load");
        return { _meta: { runwield: { persistedSessionId: "saved-session" } } };
    });
    app.onRequest("session/prompt", () => {
        frames.push("session/prompt");
        return { stopReason: "end_turn" };
    });
    app.onRequest("session/close", () => ({}));
    const peer = app.connect(ndJsonStream(inbound.writable, outbound.readable));
    const client = new AcpWorkspaceSessionClient({
        connectionId: "desktop",
        project,
        workspaceAdmission,
        input: inbound.readable,
        output: outbound.writable,
    });
    const views: SessionClientView[] = [];
    const unobserve = client.observe((view) => views.push(view));
    const binding = { connectionId: "desktop", project, sessionId: "wire-session" };
    return {
        client,
        peer,
        frames,
        views,
        binding,
        async cleanup() {
            unobserve();
            await client.dispose();
            peer.close();
            await peer.closed;
            await rm(project, { recursive: true, force: true });
        },
    };
}

const incompatible: InitializeResponse[] = [
    { ...supported(), protocolVersion: PROTOCOL_VERSION + 1 },
    { protocolVersion: PROTOCOL_VERSION },
    { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } },
    { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } },
    {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
    },
    ...methods.map((missing) => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
            loadSession: true,
            sessionCapabilities: {
                close: {},
                _meta: { runwield: { implementedMethods: methods.filter((method) => method !== missing) } },
            },
        },
    })),
];

for (const [index, initialization] of incompatible.entries()) {
    test(
        `incompatible peer ${index + 1} refuses create, load, and send before dependent frames`,
        { timeout: 3000 },
        async () => {
            const fixture = await adversePeer(initialization);
            try {
                await assert.rejects(fixture.client.create(), /required Workspace Session protocol/);
                await assert.rejects(fixture.client.load("wire-session"), /required Workspace Session protocol/);
                await assert.rejects(
                    fixture.client.send(fixture.binding, "Do not send"),
                    /required Workspace Session protocol/,
                );
                assert.deepEqual(fixture.frames, ["initialize"]);
                assert.equal(fixture.views.at(-1)?.connection, "incompatible");
                assert.match(fixture.views.at(-1)?.error ?? "", /required Workspace Session protocol/);
            } finally {
                await fixture.cleanup();
            }
        },
    );
}

interface InvalidQuestion {
    name: string;
    schema: ElicitationSchema;
    error: RegExp;
}

const invalidQuestions: InvalidQuestion[] = [
    { name: "missing answer", schema: { type: "object", properties: {} }, error: /unsupported answer type/ },
    {
        name: "unexpected field",
        schema: { type: "object", properties: { answer: { type: "string" }, password: { type: "string" } } },
        error: /unsupported fields/,
    },
    {
        name: "missing required field",
        schema: { type: "object", properties: { answer: { type: "string" } }, required: ["absent"] },
        error: /Invalid required question field/,
    },
    {
        name: "non-string answer",
        schema: { type: "object", properties: { answer: { type: "boolean" } } },
        error: /unsupported answer type/,
    },
    {
        name: "unsupported text constraint",
        schema: { type: "object", properties: { answer: { type: "string", pattern: "^[a-z]+$" } } },
        error: /unsupported text constraints/,
    },
    {
        name: "duplicate choices",
        schema: { type: "object", properties: { answer: { type: "string", enum: ["same", "same"] } } },
        error: /duplicate choices/,
    },
    {
        name: "required Other",
        schema: {
            type: "object",
            properties: { answer: { type: "string", enum: ["yes", "no"] }, otherAnswer: { type: "string" } },
            required: ["otherAnswer"],
        },
        error: /unsupported Other field/,
    },
];

for (const scenario of invalidQuestions) {
    test(`wire question with ${scenario.name} reports an error and settles`, { timeout: 3000 }, async () => {
        const fixture = await adversePeer(supported());
        try {
            await fixture.client.load("wire-session");
            const response = await fixture.peer.client.request("elicitation/create", {
                sessionId: "wire-session",
                mode: "form",
                message: "Unsupported question",
                requestedSchema: scenario.schema,
            });
            assert.deepEqual(response, { action: "cancel" });
            assert.match(fixture.views.at(-1)?.error ?? "", scenario.error);
            assert.equal(fixture.views.at(-1)?.question, null);
            assert.equal(fixture.views.at(-1)?.phase, "idle");
        } finally {
            await fixture.cleanup();
        }
    });
}

test(
    "questions for an unknown or different Session are canceled without exposing a form",
    { timeout: 3000 },
    async () => {
        const fixture = await adversePeer(supported());
        try {
            const question = {
                sessionId: "unbound-session",
                mode: "form",
                message: "Do not display",
                requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
            };
            assert.deepEqual(await fixture.peer.client.request("elicitation/create", question), { action: "cancel" });
            await fixture.client.load("wire-session");
            assert.deepEqual(await fixture.peer.client.request("elicitation/create", question), { action: "cancel" });
            assert.equal(
                fixture.views.some((view) => view.question !== null),
                false,
            );
            await assert.rejects(
                fixture.client.answer(fixture.binding, { requestId: "unknown", action: "accept", answer: "yes" }),
                /no longer waiting/,
            );
            await assert.rejects(
                fixture.client.answer(
                    { ...fixture.binding, sessionId: "different" },
                    { requestId: "unknown", action: "cancel" },
                ),
                /does not belong/,
            );
        } finally {
            await fixture.cleanup();
        }
    },
);

for (const [index, extension] of [
    undefined,
    { version: 2, connectionId: "runtime", projects: { version: 1 } },
    { version: 1, connectionId: "runtime", projects: { version: 2 } },
    { version: 1, connectionId: "", projects: { version: 1 } },
].entries()) {
    test(`Workspace opt-in refuses unsupported Project negotiation ${index + 1} without ordinary ACP fallback`, async () => {
        const fixture = await adversePeer(
            { ...supported(), ...(extension ? { _meta: { "dev.runwield/workspace": extension } } : {}) },
            true,
        );
        try {
            await assert.rejects(fixture.client.create(), /Project admission version 1/);
            await assert.rejects(fixture.client.load("wire-session"), /Project admission version 1/);
            await assert.rejects(fixture.client.listProjects(), /Project admission version 1/);
            assert.deepEqual(fixture.frames, ["initialize"]);
            assert.equal(fixture.views.at(-1)?.connection, "incompatible");
        } finally {
            await fixture.cleanup();
        }
    });
}
