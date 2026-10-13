import { collectProcessOutput } from "../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../shared/foreground-process.ts";
import { makeTempFile } from "../testing/temp-file.ts";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * @module acp/server.test
 * ACP protocol coverage over the real RunWield Session Runtime.
 */

import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes, assertThrows } from "../testing/assertions.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { savePlan } from "../plan-store.js";
import { captureTranscriptEvidence } from "../shared/session/session-transcript-projection.js";
import { openFileSessionStore } from "../shared/session/file-session-store.ts";
import { __resetSettingsForTests, setCustomSetting } from "../shared/settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../shared/workflow/metrics.js";
import { createRootSessionManager, resolveCreatedRootSessionPath } from "../shared/session/root-session.js";
import { VERSION } from "../shared/version.js";
import { mapRuntimeEventToAcpUpdate } from "./event-mapper.js";
import { createAcpInteractionAdapter } from "./interaction-mapper.js";
import { assertAcpFrameSchema, assertAcpSchema } from "./schema-conformance.ts";
import { AcpSessionMap } from "./session-map.ts";
import {
    createInitializeResponse,
    mapEventWithSessionCost,
    startRunWieldAcpServer,
    validateNewSessionParams,
} from "./server.js";

/**
 * @typedef {Object} TestServerHandle
 * @property {WritableStreamDefaultWriter<Uint8Array>} inputWriter
 * @property {ReadableStreamDefaultReader<Uint8Array>} outputReader
 * @property {import('@agentclientprotocol/sdk').AgentConnection} connection
 * @property {string[]} diagnostics
 * @property {string[]} frames raw NDJSON lines the server wrote, in order
 * @property {Promise<void>} [heldResponseStarted]
 * @property {() => void} [releaseHeldResponse]
 */

/**
 * @typedef {Object} StartTestServerOptions
 * @property {string | number} [holdResponseId]
 * @property {string} [holdOutputText]
 */

/**
 * @typedef {Object} RuntimeFixtureModelConfig
 * @property {string} id
 * @property {string[]} input
 */

/**
 * @typedef {Object} RuntimeFixtureProviderConfig
 * @property {RuntimeFixtureModelConfig[]} models
 */

/**
 * @typedef {Object} RuntimeFixtureModelConfiguration
 * @property {Record<string, RuntimeFixtureProviderConfig>} providers
 */

/** @typedef {Extract<import('@agentclientprotocol/sdk').SessionConfigOption, { type: "select" }>} AcpSelectConfigOption */

/** @param {import('@agentclientprotocol/sdk').SessionConfigOption[]} options */
function configOptionIds(options) {
    return options.map((option) => option.id);
}

/** @param {import('@agentclientprotocol/sdk').SessionConfigOption[]} options */
function configOptionCurrentValues(options) {
    return options.map((option) => option.currentValue);
}

/**
 * @param {import('@agentclientprotocol/sdk').SessionConfigOption[]} options
 * @param {string} id
 * @returns {AcpSelectConfigOption}
 */
function requireSelectConfigOption(options, id) {
    const option = options.find((candidate) => candidate.id === id);
    assert(option?.type === "select", `Expected select config option: ${id}`);
    return option;
}

/** @param {AcpSelectConfigOption} option */
function configSelectValues(option) {
    return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]).map((entry) => entry.value);
}

/**
 * @param {string} text
 * @returns {RuntimeFixtureModelConfiguration}
 */
function parseRuntimeFixtureModelConfiguration(text) {
    return JSON.parse(text);
}

/** @param {import('@earendil-works/pi-ai').Message['content']} content */
function fauxContentToText(content) {
    if (typeof content === "string") return content;
    return content.map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return block.thinking;
        if ("arguments" in block) return `${block.name}:${JSON.stringify(block.arguments)}`;
        return `[image:${block.mimeType}:${block.data.length}]`;
    }).join("\n");
}

/** @param {import('@earendil-works/pi-ai').Message} message */
function fauxMessageToText(message) {
    if (message.role === "system") {
        return [
            getSystemMessageText(message),
            ...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []),
            ...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? []),
        ].filter((part) => part.length > 0).join("\n");
    }
    if (message.role === "toolResult") {
        return [message.toolName, ...message.content.map((block) => fauxContentToText([block]))].join("\n");
    }
    return fauxContentToText(message.content);
}

/** @param {import('@earendil-works/pi-ai').TranscriptContext} context */
function estimateFauxPromptTokens(context) {
    const parts = context.messages.map((message) => `${message.role}:${fauxMessageToText(message)}`);
    return Math.ceil(parts.join("\n\n").length / 4);
}

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "../..");
const MCP_FIXTURE_SERVER = join(dirname(fromFileUrl(import.meta.url)), "../shared/mcp/fixture-server.ts");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TERMINAL_AUTH_METHOD = {
    id: "runwield-terminal-login",
    name: "RunWield Login",
    description: "Open a terminal to configure RunWield credentials and choose a default model.",
    type: "terminal",
    args: ["login"],
};
const ACP_REGISTRY_INITIALIZE_REQUEST = {
    jsonrpc: "2.0",
    id: "registry-initialize",
    method: "initialize",
    params: {
        protocolVersion: 1,
        clientCapabilities: { _meta: { "terminal-auth": true } },
        clientInfo: { name: "ACP Registry" },
    },
};

/**
 * @param {Uint8Array} chunk
 * @param {string | number} responseId
 */
function chunkIncludesResponseId(chunk, responseId) {
    return decoder.decode(chunk).split("\n").some((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        return JSON.parse(trimmed).id === responseId;
    });
}

/**
 * @param {(chunk: Uint8Array) => boolean} shouldHold
 */
function createHeldOutput(shouldHold) {
    /** @type {PromiseWithResolvers<void>} */
    const heldResponseStarted = Promise.withResolvers();
    /** @type {PromiseWithResolvers<void>} */
    const releaseHeldResponse = Promise.withResolvers();
    /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
    let outputController = null;
    let held = false;
    const readable = new ReadableStream({
        start(controller) {
            outputController = controller;
        },
    });
    const writable = new WritableStream({
        write(chunk) {
            if (!held && shouldHold(chunk)) {
                held = true;
                heldResponseStarted.resolve(undefined);
                return releaseHeldResponse.promise.then(() => outputController?.enqueue(chunk));
            }
            outputController?.enqueue(chunk);
        },
        close() {
            outputController?.close();
        },
        abort(reason) {
            outputController?.error(reason);
        },
    });
    return {
        readable,
        writable,
        heldResponseStarted: heldResponseStarted.promise,
        releaseHeldResponse: () => releaseHeldResponse.resolve(undefined),
    };
}

/**
 * @param {StartTestServerOptions} [options]
 * @returns {TestServerHandle}
 */
function startTestServer(options = {}) {
    const input = new TransformStream();
    /** @type {ReadableStream<Uint8Array>} */
    let outputReadable;
    /** @type {WritableStream<Uint8Array>} */
    let outputWritable;
    /** @type {Promise<void> | undefined} */
    let heldResponseStarted;
    /** @type {(() => void) | undefined} */
    let releaseHeldResponse;
    if (options.holdResponseId !== undefined || options.holdOutputText !== undefined) {
        const output = createHeldOutput((chunk) =>
            options.holdResponseId !== undefined
                ? chunkIncludesResponseId(chunk, options.holdResponseId)
                : decoder.decode(chunk).includes(options.holdOutputText || "")
        );
        outputReadable = output.readable;
        outputWritable = output.writable;
        heldResponseStarted = output.heldResponseStarted;
        releaseHeldResponse = output.releaseHeldResponse;
    } else {
        const output = new TransformStream();
        outputReadable = output.readable;
        outputWritable = output.writable;
    }
    /** @type {string[]} */
    const diagnostics = [];
    const connection = startRunWieldAcpServer(input.readable, outputWritable, {
        diagnostic: (message) => {
            diagnostics.push(message);
        },
    });
    return {
        inputWriter: input.writable.getWriter(),
        outputReader: outputReadable.getReader(),
        connection,
        diagnostics,
        frames: [],
        ...(heldResponseStarted ? { heldResponseStarted } : {}),
        ...(releaseHeldResponse ? { releaseHeldResponse } : {}),
    };
}

/**
 * @param {TestServerHandle} handle
 * @param {Record<string, unknown>} message
 */
async function sendMessage(handle, message) {
    await handle.inputWriter.write(encoder.encode(`${JSON.stringify(message)}\n`));
}

/** @param {TestServerHandle} handle */
async function readMessage(handle) {
    const chunk = await handle.outputReader.read();
    assert(!chunk.done, "server should write a message");
    const firstLine = decoder.decode(chunk.value).trim().split("\n")[0];
    handle.frames.push(firstLine);
    return /** @type {Record<string, any>} */ (JSON.parse(firstLine));
}

/**
 * Raw NDJSON lines whose parsed message satisfies a predicate.
 *
 * Selection parses, but callers validate the original serialized text so the
 * assertion covers what a strict Client actually reads off the wire.
 *
 * @param {TestServerHandle} handle
 * @param {(message: Record<string, any>) => boolean} predicate
 */
function framesMatching(handle, predicate) {
    return handle.frames.filter((frame) => predicate(JSON.parse(frame)));
}

/**
 * @param {TestServerHandle} handle
 * @param {string} sessionUpdate
 */
function sessionUpdateFrames(handle, sessionUpdate) {
    return framesMatching(
        handle,
        (message) => message.method === "session/update" && message.params?.update?.sessionUpdate === sessionUpdate,
    );
}

/**
 * @param {TestServerHandle} handle
 * @param {Record<string, unknown>} message
 */
async function request(handle, message) {
    await sendMessage(handle, message);
    return await readMessage(handle);
}

/**
 * @param {TestServerHandle} handle
 * @param {string | number} requestId
 * @param {number} [limit]
 */
async function readThroughResponse(handle, requestId, limit = 80) {
    /** @type {Record<string, any>[]} */
    const messages = [];
    for (let index = 0; index < limit; index++) {
        const message = await readMessage(handle);
        messages.push(message);
        if (message.id === requestId) return { response: message, messages };
    }
    throw new Error(`ACP response ${requestId} was not received after ${limit} messages`);
}

/** @param {Record<string, any>[]} messages */
function joinedAgentText(messages) {
    return messages
        .filter((message) => message.params?.update?.sessionUpdate === "agent_message_chunk")
        .map((message) => String(message.params?.update?.content?.text || ""))
        .join("");
}

/** @param {TestServerHandle} handle */
async function closeTestServer(handle) {
    await handle.inputWriter.close();
    handle.connection.close();
    await handle.connection.closed;
    handle.outputReader.releaseLock();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {TestServerHandle} handle
 * @param {string} cwd
 */
async function createSession(handle, cwd) {
    const response = await request(handle, {
        jsonrpc: "2.0",
        id: "new",
        method: "session/new",
        params: { cwd, mcpServers: [] },
    });
    assert(response.result, JSON.stringify(response));
    const frame = handle.frames.at(-1);
    assert(frame, "session/new response frame should be captured");
    assertAcpFrameSchema("NewSessionResponse", frame, (message) => message.result);
    return {
        sessionId: /** @type {string} */ (response.result.sessionId),
        persistedSessionId: /** @type {string} */ (response.result._meta.runwield.persistedSessionId),
    };
}

/**
 * @param {string} directory
 * @param {string} runwieldSessionId
 * @returns {Promise<string | null>}
 */
async function findManifestPath(directory, runwieldSessionId) {
    for await (const entry of await fsReaddir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            const found = await findManifestPath(path, runwieldSessionId);
            if (found) return found;
            continue;
        }
        if (entry.name !== "manifest.json") continue;
        const manifest = JSON.parse(await fsReadFile(path, "utf8"));
        if (manifest.runwieldSessionId === runwieldSessionId) return path;
    }
    return null;
}

/**
 * @param {ReturnType<typeof openFileSessionStore>} store
 * @param {string} runwieldSessionId
 */
async function forceActivationToRequireHydration(store, runwieldSessionId) {
    const path = await findManifestPath(store.path, runwieldSessionId);
    assert(path, `manifest not found for ${runwieldSessionId}`);
    const manifest = JSON.parse(await fsReadFile(path, "utf8"));
    manifest.activation.state = "idle";
    await fsWriteFile(path, `${JSON.stringify(manifest, null, 4)}\n`);
}

/** @param {string} cwd */
async function createIdleUngeneratedPersistedSession(cwd) {
    const store = openFileSessionStore();
    const manager = await createRootSessionManager("new", cwd);
    try {
        const project = store.ensureRuntimeProject({ root: cwd });
        const piSessionId = manager.getSessionId();
        assert(typeof piSessionId === "string" && piSessionId.length > 0);
        const transcriptPath = await resolveCreatedRootSessionPath(cwd, manager);
        manager.appendCustomEntry("runwield.active_agent", { agentName: "router" });
        manager.appendMessage({
            role: "user",
            timestamp: Date.now(),
            content: [{ type: "text", text: "load this session" }],
        });
        const acquired = await store.ensureSessionCatalogRecordAndAcquire({
            locator: {
                projectId: project.projectId,
                piSessionId,
                transcriptPath,
                transcriptCwd: cwd,
                source: "created",
            },
            activation: {
                ownerInstanceId: "acp-load-auth-test",
                ownerProcessKind: "test",
                phase: "preparing",
            },
        });
        store.releaseUnchangedActivation(acquired.proof);
        await forceActivationToRequireHydration(store, acquired.session.runwieldSessionId);
        return { piSessionId, transcriptPath };
    } finally {
        await Promise.resolve((/** @type {{ dispose?: () => void | Promise<void> }} */ (manager)).dispose?.());
        store.close();
    }
}

test("createInitializeResponse advertises only implemented ACP capabilities", () => {
    const response = createInitializeResponse({ protocolVersion: 1 });
    const capabilities = /** @type {any} */ (response.agentCapabilities);

    assertEquals(response.protocolVersion, 1);
    assertEquals(capabilities.promptCapabilities.image, true);
    assertEquals(capabilities.promptCapabilities._meta.runwield.contentTypes, ["text", "image", "resource_link"]);
    assertEquals(capabilities.loadSession, true);
    assertEquals(capabilities.sessionCapabilities.close, {});
    assertEquals(capabilities.sessionCapabilities.delete, {});
    assertEquals(capabilities.sessionCapabilities._meta.runwield.implementedMethods, [
        "session/new",
        "session/load",
        "session/prompt",
        "session/cancel",
        "session/close",
        "session/delete",
        "session/set_config_option",
    ]);
    assertEquals(response.authMethods, []);
    assertEquals(response.agentInfo?.name, "RunWield");
});

test("createInitializeResponse advertises Terminal Auth only to capable clients", () => {
    assertEquals(
        createInitializeResponse({ protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } }).authMethods,
        [TERMINAL_AUTH_METHOD],
    );
    assertEquals(
        createInitializeResponse({ protocolVersion: 1, clientCapabilities: { _meta: { "terminal-auth": true } } })
            .authMethods,
        [TERMINAL_AUTH_METHOD],
    );
    assertEquals(createInitializeResponse({ protocolVersion: 1, clientCapabilities: {} }).authMethods, []);
    assertEquals(
        createInitializeResponse({ protocolVersion: 1, clientCapabilities: { auth: { terminal: false } } }).authMethods,
        [],
    );
    assertEquals(
        createInitializeResponse({ protocolVersion: 1, clientCapabilities: { terminal: true } }).authMethods,
        [],
    );
});

test("ACP server handles the registry initialize request with one Terminal Auth method", async () => {
    const handle = startTestServer();
    try {
        assertEquals(handle.diagnostics, ["RunWield ACP stdio server started"]);
        const response = await request(handle, ACP_REGISTRY_INITIALIZE_REQUEST);
        assertEquals(response.id, "registry-initialize");
        assertEquals(response.result.agentInfo.name, "RunWield");
        assertEquals(response.result.authMethods, [TERMINAL_AUTH_METHOD]);
    } finally {
        await closeTestServer(handle);
    }
});

test("ACP initialize answers with the version RunWield speaks, not the one requested", async () => {
    const handle = startTestServer();
    try {
        for (const requested of [1, 99]) {
            const response = await request(handle, {
                jsonrpc: "2.0",
                id: `initialize-${requested}`,
                method: "initialize",
                params: { protocolVersion: requested, clientCapabilities: {} },
            });
            assertEquals(response.result.protocolVersion, 1, `requested ${requested}`);
        }
    } finally {
        await closeTestServer(handle);
    }
});

test("ACP agentInfo reports the same build version as wld --version", async () => {
    const runCli = async (/** @type {string[]} */ args, /** @type {string} */ stdin) => {
        const child = spawnNativeProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", "src/cli.ts", ...args]),
            cwd: REPO_ROOT,
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });
        const writer = child.stdin.getWriter();
        if (stdin) await writer.write(encoder.encode(stdin));
        await writer.close();
        const { stdout } = await collectProcessOutput(child);
        return decoder.decode(stdout).trim();
    };

    const versionOutput = await runCli(["--version"], "");
    const acpOutput = await runCli(["--mode", "acp"], `${JSON.stringify(ACP_REGISTRY_INITIALIZE_REQUEST)}\n`);

    const cliVersion = versionOutput.match(/^runwield (\S+) \(/)?.[1];
    const acpVersion = JSON.parse(acpOutput).result.agentInfo.version;

    assertEquals(cliVersion, VERSION, `--version printed ${versionOutput}`);
    assertEquals(acpVersion, VERSION);
    const oldMvpVersion = ["0.0.0", "acp", "mvp"].join("-");
    assert(VERSION && VERSION !== oldMvpVersion, `generated version should be real, got ${VERSION}`);
});

test("ACP initialize and prompt responses satisfy the published ACP schema", async () => {
    const handle = startTestServer();
    try {
        const response = await request(handle, ACP_REGISTRY_INITIALIZE_REQUEST);
        const initializeFrame = framesMatching(handle, (message) => message.id === "registry-initialize")[0];
        assert(initializeFrame, "initialize response frame should be captured");
        assertAcpFrameSchema("InitializeResponse", initializeFrame, (message) => message.result);
        const authFrame = JSON.stringify({
            jsonrpc: "2.0",
            id: "auth-method",
            result: JSON.parse(initializeFrame).result.authMethods[0],
        });
        assertAcpFrameSchema("AuthMethod", authFrame, (message) => message.result);
        assertAcpSchema("AuthMethod", response.result.authMethods[0]);
    } finally {
        await closeTestServer(handle);
    }

    assertAcpSchema("PromptResponse", { stopReason: "cancelled" });
    assertAcpSchema("PromptResponse", { stopReason: "end_turn" });
});

test("ACP schema checker rejects published numeric and map constraints", () => {
    assertThrows(() => assertAcpSchema("ProtocolVersion", 65_536), Error, "above maximum 65535");
    assertThrows(() => assertAcpSchema("RequestId", 1e100), Error, "format int64");
    assertThrows(
        () => assertAcpSchema("AuthMethodTerminal", { ...TERMINAL_AUTH_METHOD, env: { RUNWIELD_TOKEN: 1 } }),
        Error,
        "expected type string",
    );
});

test("ACP server returns structured errors for unimplemented session methods", async () => {
    const handle = startTestServer();
    try {
        const response = await request(handle, {
            jsonrpc: "2.0",
            id: "session-list",
            method: "session/list",
            params: {},
        });
        assertEquals(response.error.code, -32004);
        assertStringIncludes(response.error.message, "not implemented yet");
        assertEquals(response.error.data.phase, "session-runtime-acp-mvp");
    } finally {
        await closeTestServer(handle);
    }
});

test("CLI --mode acp routes to ACP stdio without stdout diagnostics", async () => {
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs(["run", "-A", "src/cli.ts", "--mode", "acp"]),
        cwd: REPO_ROOT,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const writer = child.stdin.getWriter();
    await writer.write(encoder.encode(`${JSON.stringify(ACP_REGISTRY_INITIALIZE_REQUEST)}\n`));
    await writer.close();

    const { code, stdout, stderr } = await collectProcessOutput(child);
    const stdoutText = decoder.decode(stdout).trim();
    const response = JSON.parse(stdoutText);
    assertEquals(code, 0);
    assertEquals(response.result.agentInfo.name, "RunWield");
    assertEquals(response.result.authMethods, [TERMINAL_AUTH_METHOD]);
    assert(!stdoutText.includes("RunWield ACP"), "stdout should contain protocol JSON only");
    assertStringIncludes(decoder.decode(stderr), "RunWield ACP");
});

test("ACP session/new requires login and a usable default model", async () => {
    await withRuntimeCommandFixture("runwield-acp-auth-required-", async (fixture) => {
        const handle = startTestServer();
        try {
            const response = await request(handle, {
                jsonrpc: "2.0",
                id: "new-without-model",
                method: "session/new",
                params: { cwd: fixture.projectRoot, mcpServers: [] },
            });
            assertEquals(response.error.code, -32000);
            assertStringIncludes(response.error.message, "login and default model setup");
        } finally {
            await closeTestServer(handle);
        }
    }, { providerState: "none" });
});

test("ACP session/new sends setup MCP warnings to the client", async () => {
    await withRuntimeCommandFixture("runwield-acp-mcp-warning-", async (fixture) => {
        const handle = startTestServer();
        try {
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "new-warning",
                method: "session/new",
                params: {
                    cwd: fixture.projectRoot,
                    mcpServers: [{
                        name: "dead",
                        command: "/definitely/not/runwield-mcp",
                        args: [],
                        env: [],
                    }],
                },
            });
            const { response, messages } = await readThroughResponse(handle, "new-warning");
            assert(response.result, JSON.stringify(response));
            const warningText = joinedAgentText(messages);
            assertStringIncludes(warningText, "MCP warning (connection/dead)");
            assertStringIncludes(warningText, "MCP server failed");
            assertEquals(warningText.includes("/definitely/not"), false);
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP session/new and session/prompt exercise the real Runtime and stream canonical updates", async () => {
    await withRuntimeCommandFixture("runwield-acp-prompt-", async (fixture) => {
        fixture.setModelResponse("hello from the fixture model");
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            assertEquals(created.sessionId, `acp-${created.persistedSessionId}`);

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "prompt",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] },
            });
            const { response, messages } = await readThroughResponse(handle, "prompt");

            assert(messages.some((message) => message.params?.update?.sessionUpdate === "user_message_chunk"));
            assertStringIncludes(joinedAgentText(messages), "hello from the fixture model");
            assertEquals(response.result, { stopReason: "end_turn" });
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP image prompts reach vision models", async () => {
    await withRuntimeCommandFixture("runwield-acp-image-", async (fixture) => {
        let modelMessages = "";
        fixture.setModelResponseFactory((context) => {
            modelMessages = JSON.stringify(context.messages);
            return fauxAssistantMessage(fauxText("Image received."));
        });
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            const imageData =
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "image-prompt",
                method: "session/prompt",
                params: {
                    sessionId: created.sessionId,
                    prompt: [
                        { type: "text", text: "Describe this image." },
                        { type: "image", data: imageData, mimeType: "image/png" },
                    ],
                },
            });
            const { response } = await readThroughResponse(handle, "image-prompt");

            assertEquals(response.result, { stopReason: "end_turn" });
            assertStringIncludes(modelMessages, imageData);
            assertStringIncludes(modelMessages, '"mimeType":"image/png"');
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP image prompts expose see_image to text-only models with a vision fallback", async () => {
    await withRuntimeCommandFixture(
        "runwield-acp-image-fallback-",
        async (fixture) => {
            const modelsPath = join(fixture.homeDir, ".wld", "models.json");
            const modelConfiguration = parseRuntimeFixtureModelConfiguration(await fsReadFile(modelsPath, "utf8"));
            const models = modelConfiguration.providers["runtime-command-fixture"].models;
            const textOnlyModel = models.find((model) => model.id === "text-only-model");
            assert(textOnlyModel);
            textOnlyModel.input = ["text"];
            await fsWriteFile(modelsPath, JSON.stringify(modelConfiguration));
            await fsWriteFile(
                fixture.settingsPath,
                JSON.stringify({
                    defaultProvider: "runtime-command-fixture",
                    defaultModel: "text-only-model",
                    visionFallback: { model: "runtime-command-fixture/fixture-model" },
                    notifications: { enabled: false },
                }),
            );
            __resetSettingsForTests();

            let modelContext = "";
            fixture.setModelResponseFactory((context) => {
                modelContext = JSON.stringify(context);
                return fauxAssistantMessage(fauxText("Fallback is available."));
            });
            const handle = startTestServer();
            try {
                const created = await createSession(handle, fixture.projectRoot);
                const imageData = btoa("discord-fallback-image");
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: "fallback-image-prompt",
                    method: "session/prompt",
                    params: {
                        sessionId: created.sessionId,
                        prompt: [
                            { type: "text", text: "Inspect this screenshot." },
                            { type: "image", data: imageData, mimeType: "image/png" },
                        ],
                    },
                });
                const { response } = await readThroughResponse(handle, "fallback-image-prompt");

                assertEquals(response.result, { stopReason: "end_turn" });
                assertStringIncludes(modelContext, "[Image attached: attachment:");
                assertStringIncludes(modelContext, "see_image");
                assertEquals(modelContext.includes(imageData), false);
            } finally {
                await closeTestServer(handle);
                __resetSettingsForTests();
            }
        },
        { additionalModels: [{ id: "text-only-model", name: "Text Only" }] },
    );
});

test("ACP model config switches the next turn and survives session/load", async () => {
    await withRuntimeCommandFixture("runwield-acp-model-config-", async (fixture) => {
        /** @type {string[]} */
        const models = [];
        fixture.setModelResponseFactory((_context, _options, _state, model) => {
            models.push(model.id);
            return fauxAssistantMessage(fauxText("Model selected."));
        });
        let handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            const newResponse = JSON.parse(framesMatching(handle, (message) => message.id === "new")[0]);
            /** @type {import('@agentclientprotocol/sdk').SessionConfigOption[]} */
            const configOptions = newResponse.result.configOptions || [];
            const option = configOptions.find((option) => option.category === "model");
            assert(option, "session/new must expose model options for OpenAB /models");
            assert(option.type === "select");
            assertEquals(option.currentValue, "runtime-command-fixture/fixture-model");
            assert(
                option.options.some((option) =>
                    "value" in option && option.value === "runtime-command-fixture/alternate-model"
                ),
            );

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "select-model",
                method: "session/set_config_option",
                params: {
                    sessionId: created.sessionId,
                    configId: option.id,
                    value: "runtime-command-fixture/alternate-model",
                },
            });
            const switched = await readThroughResponse(handle, "select-model");
            assert(switched.response.result, JSON.stringify(switched.response));
            assertAcpSchema("SetSessionConfigOptionResponse", switched.response.result);
            assertEquals(
                switched.response.result.configOptions[0].currentValue,
                "runtime-command-fixture/alternate-model",
            );
            assertEquals(models, [], "switching models must not invoke a model");
            const updates = sessionUpdateFrames(handle, "config_option_update");
            assert(updates.length > 0);
            for (const frame of updates) {
                assertAcpFrameSchema("SessionNotification", frame, (message) => message.params);
            }

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "selected-prompt",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "Use the selected model." }] },
            });
            assertEquals((await readThroughResponse(handle, "selected-prompt")).response.result, {
                stopReason: "end_turn",
            });
            assertEquals(models, ["alternate-model"]);

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "restore-model-with-context",
                method: "session/set_config_option",
                params: {
                    sessionId: created.sessionId,
                    configId: option.id,
                    value: "runtime-command-fixture/fixture-model",
                },
            });
            const restoredContext = await readThroughResponse(handle, "restore-model-with-context");
            assertEquals(
                restoredContext.messages.some((message) => message.params?.update?.sessionUpdate === "usage_update"),
                false,
                "a model change must not combine new capacity with stale context tokens",
            );

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "reselect-model",
                method: "session/set_config_option",
                params: {
                    sessionId: created.sessionId,
                    configId: option.id,
                    value: "runtime-command-fixture/alternate-model",
                },
            });
            const reselected = await readThroughResponse(handle, "reselect-model");
            assertEquals(
                reselected.messages.some((message) => message.params?.update?.sessionUpdate === "usage_update"),
                false,
                "a later model change must keep unknown context usage off the wire",
            );

            await closeTestServer(handle);
            handle = startTestServer();
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "load-selected",
                method: "session/load",
                params: { sessionId: created.sessionId, cwd: fixture.projectRoot, mcpServers: [] },
            });
            const loaded = await readThroughResponse(handle, "load-selected");
            assert(loaded.response.result, JSON.stringify(loaded.response));
            assertAcpSchema("LoadSessionResponse", loaded.response.result);
            assertEquals(
                loaded.response.result.configOptions[0].currentValue,
                "runtime-command-fixture/alternate-model",
            );
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "slash-model",
                method: "session/prompt",
                params: {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "/model runtime-command-fixture/fixture-model" }],
                },
            });
            const slash = await readThroughResponse(handle, "slash-model");
            assertEquals(slash.response.result, { stopReason: "end_turn" });
            assert(slash.messages.some((message) =>
                message.params?.update?.sessionUpdate === "config_option_update" &&
                message.params.update.configOptions[0].currentValue === "runtime-command-fixture/fixture-model"
            ));
            assertEquals(models, ["alternate-model"], "the model command must not invoke a model");
        } finally {
            await closeTestServer(handle);
        }
    }, { additionalModels: [{ id: "alternate-model", name: "Alternate Model", contextWindow: 64_000 }] });
});

test("ACP reasoning config controls the next turn, rejects unsupported values, and survives reload", async () => {
    await withRuntimeCommandFixture("runwield-acp-reasoning-config-", async (fixture) => {
        /** @type {string[]} */
        const reasoningLevels = [];
        fixture.setModelResponseFactory((_context, options) => {
            reasoningLevels.push(String(options?.reasoning || ""));
            return fauxAssistantMessage(fauxText("Reasoning selected."));
        });
        let handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            const newResponse = JSON.parse(framesMatching(handle, (message) => message.id === "new")[0]);
            const configOptions = newResponse.result.configOptions || [];
            assertEquals(configOptionIds(configOptions), ["model", "thought_level"]);
            const reasoning = requireSelectConfigOption(configOptions, "thought_level");
            assertEquals(reasoning.category, "thought_level");
            assertEquals(reasoning.currentValue, "medium");
            assertEquals(configSelectValues(reasoning), [
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
            ]);

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "select-reasoning",
                method: "session/set_config_option",
                params: { sessionId: created.sessionId, configId: "thought_level", value: "high" },
            });
            const selected = await readThroughResponse(handle, "select-reasoning");
            assertEquals(configOptionCurrentValues(selected.response.result?.configOptions || []), [
                "runtime-command-fixture/fixture-model",
                "high",
            ]);
            assertEquals(reasoningLevels, [], "changing reasoning must not invoke a model");
            assert(
                selected.messages.some((message) =>
                    message.params?.update?.sessionUpdate === "config_option_update" &&
                    message.params.update.configOptions[1]?.currentValue === "high"
                ),
            );

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "invalid-reasoning",
                method: "session/set_config_option",
                params: { sessionId: created.sessionId, configId: "thought_level", value: "extreme" },
            });
            assertEquals((await readThroughResponse(handle, "invalid-reasoning")).response.error?.code, -32602);
            assertEquals(reasoningLevels, []);

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "reasoning-prompt",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "Use high reasoning." }] },
            });
            assertEquals((await readThroughResponse(handle, "reasoning-prompt")).response.result, {
                stopReason: "end_turn",
            });
            assertEquals(reasoningLevels, ["high"]);

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "select-nonreasoning-model",
                method: "session/set_config_option",
                params: {
                    sessionId: created.sessionId,
                    configId: "model",
                    value: "runtime-command-fixture/plain-model",
                },
            });
            const plainModel = await readThroughResponse(handle, "select-nonreasoning-model");
            assertEquals(configOptionIds(plainModel.response.result?.configOptions || []), ["model"]);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "unsupported-reasoning",
                method: "session/set_config_option",
                params: { sessionId: created.sessionId, configId: "thought_level", value: "low" },
            });
            assertEquals((await readThroughResponse(handle, "unsupported-reasoning")).response.error?.code, -32602);
            assertEquals(reasoningLevels, ["high"]);

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "restore-reasoning-model",
                method: "session/set_config_option",
                params: {
                    sessionId: created.sessionId,
                    configId: "model",
                    value: "runtime-command-fixture/fixture-model",
                },
            });
            const restored = await readThroughResponse(handle, "restore-reasoning-model");
            assertEquals(restored.response.result?.configOptions[1]?.currentValue, "high");

            await closeTestServer(handle);
            handle = startTestServer();
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "load-reasoning",
                method: "session/load",
                params: { sessionId: created.sessionId, cwd: fixture.projectRoot, mcpServers: [] },
            });
            const loaded = await readThroughResponse(handle, "load-reasoning");
            assertEquals(configOptionCurrentValues(loaded.response.result?.configOptions || []), [
                "runtime-command-fixture/fixture-model",
                "high",
            ]);
        } finally {
            await closeTestServer(handle);
        }
    }, {
        reasoning: true,
        additionalModels: [{ id: "plain-model", name: "Plain Model", reasoning: false }],
    });
});

test("ACP model config can recover after a failed turn and rejects invalid selections", async () => {
    await withRuntimeCommandFixture("runwield-acp-model-recovery-", async (fixture) => {
        fixture.setModelResponseFactory(() => {
            throw new Error("You have hit your session limit");
        });
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "failed-turn",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "Try the exhausted model." }] },
            });
            const failed = await readThroughResponse(handle, "failed-turn");
            assertStringIncludes(
                JSON.stringify(failed),
                "The model service reports a usage or billing limit. Check your account.",
            );
            assertEquals(JSON.stringify(failed).includes("You have hit your session limit"), false);
            for (
                const { id, params, code } of [
                    {
                        id: "unknown-session",
                        params: {
                            sessionId: "missing",
                            configId: "model",
                            value: "runtime-command-fixture/alternate-model",
                        },
                        code: -32001,
                    },
                    {
                        id: "unknown-config",
                        params: {
                            sessionId: created.sessionId,
                            configId: "missing",
                            value: "runtime-command-fixture/alternate-model",
                        },
                        code: -32602,
                    },
                    {
                        id: "unknown-model",
                        params: {
                            sessionId: created.sessionId,
                            configId: "model",
                            value: "runtime-command-fixture/missing",
                        },
                        code: -32602,
                    },
                    {
                        id: "boolean-model",
                        params: { sessionId: created.sessionId, configId: "model", type: "boolean", value: true },
                        code: -32602,
                    },
                ]
            ) {
                await sendMessage(handle, { jsonrpc: "2.0", id, method: "session/set_config_option", params });
                assertEquals((await readThroughResponse(handle, id)).response.error?.code, code);
            }
            /** @type {string[]} */
            const models = [];
            fixture.setModelResponseFactory((_context, _options, _state, model) => {
                models.push(model.id);
                return fauxAssistantMessage(fauxText("Recovered in the same conversation."));
            });
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "recover-model",
                method: "session/set_config_option",
                params: {
                    sessionId: created.sessionId,
                    configId: "model",
                    value: "runtime-command-fixture/alternate-model",
                },
            });
            const recovered = await readThroughResponse(handle, "recover-model");
            assertEquals(
                recovered.response.result?.configOptions[0].currentValue,
                "runtime-command-fixture/alternate-model",
            );
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "recovered-turn",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "Continue." }] },
            });
            assertEquals((await readThroughResponse(handle, "recovered-turn")).response.result, {
                stopReason: "end_turn",
            });
            assertEquals(models, ["alternate-model"]);
        } finally {
            await closeTestServer(handle);
        }
    }, { additionalModels: [{ id: "alternate-model", name: "Alternate Model" }] });
});

test("ACP session/new and session/prompt can invoke a real MCP fixture tool", async () => {
    await withRuntimeCommandFixture("runwield-acp-mcp-call-", async (fixture) => {
        const logPath = await makeTempFile({ prefix: "runwield-acp-mcp-log-" });
        fixture.setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("mcp__fixture__fixture_echo", { marker: "acp-root" })),
            () => fauxAssistantMessage(fauxText("ACP MCP turn complete.")),
        ]);
        const handle = startTestServer();
        try {
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "new-mcp",
                method: "session/new",
                params: {
                    cwd: fixture.projectRoot,
                    mcpServers: [{
                        name: "fixture",
                        command: process.execPath,
                        args: runtimeSourceArgs(["run", "-A", MCP_FIXTURE_SERVER]),
                        env: [{ name: "RUNWIELD_MCP_FIXTURE_LOG", value: logPath }],
                    }],
                },
            });
            const created = await readThroughResponse(handle, "new-mcp");
            assert(created.response.result, JSON.stringify(created.response));
            const sessionId = created.response.result.sessionId;

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "prompt-mcp",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "Use MCP." }] },
            });
            const { response, messages } = await readThroughResponse(handle, "prompt-mcp");
            assertEquals(response.result, { stopReason: "end_turn" });
            assertStringIncludes(joinedAgentText(messages), "ACP MCP turn complete.");
            assertStringIncludes(await fsReadFile(logPath, "utf8"), '"marker":"acp-root"');
        } finally {
            await closeTestServer(handle);
            await fsRm(logPath).catch(() => {});
        }
    });
});

test("ACP /agent opens selection without a model turn and affects the next request", async () => {
    await withRuntimeCommandFixture("runwield-acp-agent-command-", async (fixture) => {
        fixture.setModelResponseFactory(() => {
            throw new Error("/agent must not call the model");
        });
        const handle = startTestServer();
        try {
            await request(handle, {
                jsonrpc: "2.0",
                id: "init-form",
                method: "initialize",
                params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
            });
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "agent-command",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "/agent" }] },
            });
            let elicitation = null;
            for (let index = 0; index < 40; index++) {
                const message = await readMessage(handle);
                if (message.method === "elicitation/create") {
                    elicitation = message;
                    break;
                }
            }
            assert(elicitation, "ACP /agent should ask the client to choose an Agent");
            assertEquals(elicitation.params.sessionId, sessionId);
            assertEquals(elicitation.params._meta.runwield.interactionType, "select");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: elicitation.id,
                result: { action: "accept", content: { answer: "guide" } },
            });
            const result = await readThroughResponse(handle, "agent-command");
            assertEquals(result.response.result.stopReason, "end_turn");
            assertStringIncludes(JSON.stringify(result.messages), "Active agent: guide");

            assertEquals(
                result.messages.filter((message) => message.params?.update?._meta?.runwield?.type === "agent_changed")
                    .length,
                1,
            );
            assert(result.messages.some((message) =>
                message.params?.update?.sessionUpdate === "config_option_update" &&
                configOptionIds(message.params.update.configOptions).join(",") === "model,thought_level"
            ));
            for (const command of ["/version", "/session", "/agent guide"]) {
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: "same-agent-command",
                    method: "session/prompt",
                    params: { sessionId, prompt: [{ type: "text", text: command }] },
                });
                const commandResult = await readThroughResponse(handle, "same-agent-command");
                assertEquals(commandResult.response.result.stopReason, "end_turn");
                assert(!joinedAgentText(commandResult.messages).includes("Active agent:"), command);
            }

            fixture.setModelResponse("Guide handled this follow-up.");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "follow-up",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "Now answer normally" }] },
            });
            const followUp = await readThroughResponse(handle, "follow-up");
            assertStringIncludes(joinedAgentText(followUp.messages), "Guide handled this follow-up.");
            assert(!joinedAgentText(followUp.messages).includes("Active agent:"));
            assertStringIncludes(JSON.stringify(followUp.messages), '"agentName":"Guide"');
        } finally {
            await closeTestServer(handle);
        }
    }, { reasoning: true });
});

for (const ending of ["cancel", "decline", "expired", "other", "choice", "empty-other"]) {
    test(`ACP ${ending} form releases the Session for the next prompt`, async () => {
        await withRuntimeCommandFixture("runwield-acp-form-ending-", async (fixture) => {
            fixture.setModelResponseFactories([
                () =>
                    fauxAssistantMessage(fauxToolCall("user_interview", {
                        question: {
                            type: "multiple_choice",
                            prompt: "Which color do you prefer?",
                            choices: [{ value: "blue", label: "Blue" }, { value: "green", label: "Green" }],
                        },
                    })),
                () => fauxAssistantMessage(fauxText("The interview has ended.")),
            ]);
            const handle = startTestServer();
            try {
                await request(handle, {
                    jsonrpc: "2.0",
                    id: "init-form",
                    method: "initialize",
                    params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
                });
                const { sessionId } = await createSession(handle, fixture.projectRoot);
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: "select-ideator",
                    method: "session/prompt",
                    params: { sessionId, prompt: [{ type: "text", text: "/agent ideator" }] },
                });
                const selected = await readThroughResponse(handle, "select-ideator");
                assertEquals(selected.response.result.stopReason, "end_turn");
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: "question",
                    method: "session/prompt",
                    params: { sessionId, prompt: [{ type: "text", text: "Ask me to choose a color" }] },
                });
                let elicitation = null;
                for (let index = 0; index < 40; index++) {
                    const message = await readMessage(handle);
                    if (message.method === "elicitation/create") {
                        elicitation = message;
                        break;
                    }
                }
                assert(elicitation, "Expected an ACP form");
                assertEquals(elicitation.params.requestedSchema.properties.answer.oneOf, [
                    { const: "blue", title: "Blue" },
                    { const: "green", title: "Green" },
                    { const: "other", title: "Other" },
                ]);
                assertEquals(elicitation.params.requestedSchema.properties.otherAnswer.type, "string");
                assertEquals(elicitation.params.requestedSchema.required, ["answer"]);
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: elicitation.id,
                    ...(ending === "other" || ending === "choice" || ending === "empty-other"
                        ? {
                            result: {
                                action: "accept",
                                content: {
                                    answer: ending === "choice" ? "blue" : "other",
                                    otherAnswer: ending === "empty-other" ? "  " : "  purple  ",
                                },
                            },
                        }
                        : ending === "expired"
                        ? { error: { code: -32603, message: "Form expired" } }
                        : { result: { action: ending } }),
                });
                const settled = await readThroughResponse(handle, "question");
                assertEquals(settled.response.result.stopReason, "end_turn");
                assert(!settled.messages.some((message) => message.method === "elicitation/create"));
                const interview = settled.messages.find((message) =>
                    message.params?.update?._meta?.runwield?.toolName === "user_interview" &&
                    message.params?.update?.rawOutput?.details
                )?.params.update.rawOutput.details;
                assert(interview, "The Agent must receive the interview result");
                if (ending === "other") {
                    assertEquals(interview.status, "completed");
                    assertEquals(interview.answers[0].otherText, "purple");
                } else if (ending === "choice") {
                    assertEquals(interview.answers[0].value, "blue");
                    assertEquals(interview.answers[0].otherText, undefined);
                } else if (ending === "empty-other") {
                    assertEquals(interview.status, "validation_error");
                    assertEquals(interview.answeredCount, 0);
                    assertEquals(interview.errors[0].code, "EMPTY_ANSWER");
                }

                fixture.setModelResponse("The conversation is available again.");
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: "follow-up",
                    method: "session/prompt",
                    params: { sessionId, prompt: [{ type: "text", text: "Continue normally" }] },
                });
                const followUp = await readThroughResponse(handle, "follow-up");
                assertEquals(followUp.response.result.stopReason, "end_turn");
                assertStringIncludes(joinedAgentText(followUp.messages), "The conversation is available again.");
            } finally {
                await closeTestServer(handle);
            }
        });
    });
}

test("ACP /session reports real Runtime totals", async () => {
    await withRuntimeCommandFixture("runwield-acp-session-command-", async (fixture) => {
        fixture.setModelResponse("session command fixture response");
        const handle = startTestServer();
        try {
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "normal-before-session",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "count this" }] },
            });
            await readThroughResponse(handle, "normal-before-session");

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "session-command",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "/session" }] },
            });
            const result = await readThroughResponse(handle, "session-command");
            const text = joinedAgentText(result.messages);
            assertStringIncludes(text, "Session Info");
            assertStringIncludes(text, "Messages");
            assertStringIncludes(text, "Tool Calls:");
            assertStringIncludes(text, "Total:");
            assertEquals(result.response.result.stopReason, "end_turn");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP /plan-review reports when this Session has no saved review", async () => {
    await withRuntimeCommandFixture("runwield-acp-plan-review-", async (fixture) => {
        await setCustomSetting("workflowMetrics", true, "project", fixture.projectRoot);
        const handle = startTestServer();
        try {
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "plan-review-command",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "/plan-review" }] },
            });
            const result = await readThroughResponse(handle, "plan-review-command");
            assertStringIncludes(joinedAgentText(result.messages), "no previous Plan review");
            assertEquals(result.response.result.stopReason, "end_turn");
            await drainWorkflowMetrics();
            const rows = (await fsReadFile(getWorkflowMetricsFilePath(fixture.projectRoot), "utf8")).trim().split("\n")
                .map((line) => JSON.parse(line)).filter((row) =>
                    row.category === "command" && row.command === "plan-review"
                );
            assertEquals(rows.map((row) => [row.event, row.phase, row.outcome]), [
                ["command_started", "start", undefined],
                ["command_dispatched", "dispatched", undefined],
                ["command_finished", "finish", "failed"],
            ]);
            assertEquals(new Set(rows.map((row) => row.commandId)).size, 1);
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP /plan-review returns the live Plan Review URL while the original prompt remains pending", async () => {
    await withRuntimeCommandFixture("runwield-acp-live-plan-review-", async (fixture) => {
        await setCustomSetting("workflowMetrics", true, "project", fixture.projectRoot);
        await savePlan(fixture.projectRoot, "acp-review", "# ACP review\n\nReview this Plan.\n", {
            classification: "PLANNED_CHANGE",
            status: "draft",
            summary: "Review this Plan",
            affectedPaths: [],
        });
        let modelTurns = 0;
        fixture.setModelResponseFactory(() => {
            modelTurns++;
            if (modelTurns !== 1) throw new Error("/plan-review must not start another model turn");
            return fauxAssistantMessage(fauxToolCall("plan_written", { planName: "acp-review" }));
        });
        const handle = startTestServer();
        /** @type {string | undefined} */
        let reviewUrl;
        try {
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "select-planner",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "/agent planner" }] },
            });
            assertEquals((await readThroughResponse(handle, "select-planner")).response.result.stopReason, "end_turn");

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "original-review-turn",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "Present the saved Plan for review" }] },
            });
            for (let index = 0; index < 80; index++) {
                const message = await readMessage(handle);
                assert(message.id !== "original-review-turn", "Original prompt must wait for the review decision");
                const meta = message.params?.update?._meta?.runwield;
                if (meta?.interactionType === "plan_review" && typeof meta.reviewUrl === "string") {
                    reviewUrl = meta.reviewUrl;
                    break;
                }
            }
            assert(reviewUrl, "The real review must publish a URL in an ACP session/update");
            const page = await fetch(reviewUrl);
            assertEquals(page.status, 200, await page.text());

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "live-review-command",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "/plan-review" }] },
            });
            const result = await readThroughResponse(handle, "live-review-command");
            assertEquals(result.response.result.stopReason, "end_turn");
            assert(
                !result.messages.some((message) => message.id === "original-review-turn"),
                "Original prompt must still wait for review after /plan-review",
            );
            const link = result.messages.find((message) =>
                message.params?.update?._meta?.runwield?.command === "plan-review"
            )?.params.update;
            assertEquals(link?._meta?.runwield?.reviewUrl, reviewUrl);
            assertStringIncludes(link?.content?.text || "", reviewUrl);
            assertEquals(
                result.messages.filter((message) => message.params?.update?._meta?.runwield?.interactionType).length,
                0,
                "/plan-review must not create another interaction",
            );
            assertEquals(modelTurns, 1);

            const url = new URL(reviewUrl);
            const token = url.searchParams.get("token");
            assert(token, "The review URL must include a decision token");
            const decision = await fetch(
                new URL(`/api/review/decision?token=${encodeURIComponent(token)}`, url.origin),
                {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-runwield-review-token": token },
                    body: JSON.stringify({ canceled: true }),
                },
            );
            assertEquals(decision.status, 200, await decision.text());
            const original = await readThroughResponse(handle, "original-review-turn");
            assertEquals(original.response.result.stopReason, "end_turn");
            assertEquals(modelTurns, 1);
            await drainWorkflowMetrics();
            const commandRows = (await fsReadFile(getWorkflowMetricsFilePath(fixture.projectRoot), "utf8")).trim()
                .split(
                    "\n",
                )
                .map((line) => JSON.parse(line)).filter((row) =>
                    row.category === "command" && row.command === "plan-review"
                );
            assertEquals(commandRows.map((row) => [row.event, row.outcome]), [
                ["command_started", undefined],
                ["command_dispatched", undefined],
                ["command_finished", "succeeded"],
            ]);
            assertEquals(new Set(commandRows.map((row) => row.commandId)).size, 1);
        } finally {
            if (reviewUrl) {
                const url = new URL(reviewUrl);
                const token = url.searchParams.get("token");
                if (token) {
                    await fetch(new URL(`/api/review/decision?token=${encodeURIComponent(token)}`, url.origin), {
                        method: "POST",
                        headers: { "content-type": "application/json", "x-runwield-review-token": token },
                        body: JSON.stringify({ canceled: true }),
                    }).catch(() => {});
                }
            }
            await closeTestServer(handle);
        }
    });
});

test("ACP /plan-review does not replace a prompt whose response is still pending", async () => {
    await withRuntimeCommandFixture("runwield-acp-plan-review-busy-", async (fixture) => {
        await setCustomSetting("workflowMetrics", true, "project", fixture.projectRoot);
        fixture.setModelResponse("Original turn complete.");
        const handle = startTestServer({ holdResponseId: "original-turn" });
        try {
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "original-turn",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "Original prompt" }] },
            });
            await handle.heldResponseStarted;
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "review-while-busy",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "/plan-review" }] },
            });
            handle.releaseHeldResponse?.();
            const result = await readThroughResponse(handle, "review-while-busy");
            assertStringIncludes(joinedAgentText(result.messages), "busy with other work");
            assertEquals(result.response.result.stopReason, "end_turn");
            assert(result.messages.some((message) => message.id === "original-turn"), "Original prompt must finish.");
            await drainWorkflowMetrics();
            const commandRows = (await fsReadFile(getWorkflowMetricsFilePath(fixture.projectRoot), "utf8")).trim()
                .split(
                    "\n",
                )
                .map((line) => JSON.parse(line)).filter((row) =>
                    row.category === "command" && row.command === "plan-review"
                );
            assertEquals(commandRows.map((row) => [row.event, row.phase, row.outcome]), [
                ["command_started", "start", undefined],
                ["command_finished", "rejected", "rejected"],
            ]);
        } finally {
            handle.releaseHeldResponse?.();
            await closeTestServer(handle);
        }
    });
});

test("ACP /reload refreshes Runtime resources and advertised commands", async () => {
    await withRuntimeCommandFixture("runwield-acp-reload-command-", async (fixture) => {
        const handle = startTestServer();
        try {
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            const promptDir = join(fixture.projectRoot, ".wld", "prompts");
            await fsMkdir(promptDir, { recursive: true });
            await fsWriteFile(
                join(promptDir, "after-reload.md"),
                ["---", "description: Loaded after reload", "---", "Template loaded after reload."].join("\n"),
            );

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "reload-command",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "/reload" }] },
            });
            const result = await readThroughResponse(handle, "reload-command");
            assertStringIncludes(joinedAgentText(result.messages), "Successfully reloaded");
            const catalogUpdate = result.messages.findLast((message) =>
                message.params?.update?.sessionUpdate === "available_commands_update"
            );
            assert(catalogUpdate, JSON.stringify(result.messages));
            const availableCommands = /** @type {{ name: string }[]} */ (catalogUpdate.params.update.availableCommands);
            assert(
                availableCommands.some((command) => command.name === "after-reload"),
                JSON.stringify(availableCommands),
            );
            assertEquals(result.response.result.stopReason, "end_turn");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP /agent remains a command when a Plan attachment is present", async () => {
    await withRuntimeCommandFixture("runwield-acp-agent-attachment-", async (fixture) => {
        fixture.setModelResponseFactory(() => {
            throw new Error("/agent with an attachment must not call the model");
        });
        const handle = startTestServer();
        try {
            await request(handle, {
                jsonrpc: "2.0",
                id: "init-form-attachment",
                method: "initialize",
                params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
            });
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "agent-attachment-command",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [
                        { type: "text", text: "/agent" },
                        { type: "resource_link", uri: "file://docs/plans/example.md", name: "example Plan" },
                    ],
                },
            });
            let elicitation = null;
            for (let index = 0; index < 40; index++) {
                const message = await readMessage(handle);
                if (message.method === "elicitation/create") {
                    elicitation = message;
                    break;
                }
            }
            assert(elicitation, "ACP /agent with an attachment should ask the client to choose an Agent");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: elicitation.id,
                result: { action: "accept", content: { answer: "guide" } },
            });
            const result = await readThroughResponse(handle, "agent-attachment-command");
            assertEquals(result.response.result.stopReason, "end_turn");
            assertStringIncludes(JSON.stringify(result.messages), "Active agent: guide");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP rejects prompts with more than one slash command", async () => {
    await withRuntimeCommandFixture("runwield-acp-command-ambiguity-", async (fixture) => {
        const handle = startTestServer();
        try {
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            const response = await request(handle, {
                jsonrpc: "2.0",
                id: "ambiguous-command",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "/agent" }, { type: "text", text: "/model" }],
                },
            });
            assertEquals(response.error?.code, -32602);
            assertStringIncludes(response.error?.message || "", "only one slash command");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP ordinary multiline prompt does not execute slash text from a later line", async () => {
    await withRuntimeCommandFixture("runwield-acp-command-text-", async (fixture) => {
        fixture.setModelResponse("ordinary text kept its prompt behavior");
        const handle = startTestServer();
        try {
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "ordinary-multiline",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "Explain this command:\n/logout anthropic" }],
                },
            });
            const result = await readThroughResponse(handle, "ordinary-multiline");
            assertEquals(result.response.result, { stopReason: "end_turn" });
            assertStringIncludes(joinedAgentText(result.messages), "ordinary text kept its prompt behavior");
            assertEquals(JSON.stringify(result.messages).includes("Logged out"), false);
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP session/prompt resolves Prompt Template invocations through Core", async () => {
    await withRuntimeCommandFixture("runwield-acp-named-invocation-", async (fixture) => {
        const promptDir = join(fixture.projectRoot, ".wld", "prompts");
        await fsMkdir(promptDir, { recursive: true });
        await fsWriteFile(
            join(promptDir, "acp-template.md"),
            ["---", "agent: operator", "---", "ACP expanded request for {{input}}"].join("\n"),
        );
        /** @type {string[]} */
        const modelRequests = [];
        fixture.setModelResponseFactory((context) => {
            modelRequests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxText("named ACP response"));
        });
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "named-prompt",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "/acp-template evidence" }] },
            });
            const { response, messages } = await readThroughResponse(handle, "named-prompt");

            assertEquals(response.result, { stopReason: "end_turn" });
            assertStringIncludes(JSON.stringify(messages), "ACP expanded request for {{input}}\\n\\nevidence");
            assert(!JSON.stringify(messages).includes("/acp-template evidence"));
            assertStringIncludes(modelRequests[0] || "", "ACP expanded request for {{input}}\\n\\nevidence");
            assert(!modelRequests[0]?.includes("/acp-template evidence"));
            assertStringIncludes(joinedAgentText(messages), "named ACP response");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP session/load replays a real persisted Session and accepts another prompt", async () => {
    await withRuntimeCommandFixture("runwield-acp-load-", async (fixture) => {
        const logPath = await makeTempFile({ prefix: "runwield-acp-load-mcp-log-" });
        let sawLoadedMcpResultInTurn = false;
        fixture.setModelResponseFactories([
            () => fauxAssistantMessage(fauxText("first fixture response")),
            () => fauxAssistantMessage(fauxToolCall("mcp__fixture__fixture_echo", { marker: "acp-loaded" })),
            (context) => {
                sawLoadedMcpResultInTurn = JSON.stringify(context.messages).includes("fixture-result:acp-loaded");
                return fauxAssistantMessage(fauxText("continued fixture response"));
            },
        ]);

        const firstHandle = startTestServer();
        const created = await createSession(firstHandle, fixture.projectRoot);
        await sendMessage(firstHandle, {
            jsonrpc: "2.0",
            id: "first-prompt",
            method: "session/prompt",
            params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "persist me" }] },
        });
        await readThroughResponse(firstHandle, "first-prompt");
        await closeTestServer(firstHandle);

        const secondHandle = startTestServer();
        try {
            await sendMessage(secondHandle, {
                jsonrpc: "2.0",
                id: "load",
                method: "session/load",
                params: {
                    sessionId: created.sessionId,
                    cwd: fixture.projectRoot,
                    mcpServers: [{
                        name: "fixture",
                        command: process.execPath,
                        args: runtimeSourceArgs(["run", "-A", MCP_FIXTURE_SERVER]),
                        env: [{ name: "RUNWIELD_MCP_FIXTURE_LOG", value: logPath }],
                    }],
                },
            });
            const loaded = await readThroughResponse(secondHandle, "load");
            const loadFrame = framesMatching(secondHandle, (message) => message.id === "load")[0];
            assert(loadFrame, "session/load response frame should be captured");
            assertAcpFrameSchema("LoadSessionResponse", loadFrame, (message) => message.result);
            assert(
                loaded.messages.some((message) =>
                    message.method === "session/update" &&
                    message.params?.update?.sessionUpdate === "user_message_chunk"
                ),
                JSON.stringify(loaded.messages),
            );
            assert(
                loaded.messages.some((message) =>
                    message.method === "session/update" &&
                    message.params?.update?.sessionUpdate === "agent_message_chunk"
                ),
            );
            const stablePersistedSessionId = loaded.response.result._meta.runwield.persistedSessionId;
            assert(typeof stablePersistedSessionId === "string" && stablePersistedSessionId.length > 0);
            assert(stablePersistedSessionId !== created.persistedSessionId);

            await sendMessage(secondHandle, {
                jsonrpc: "2.0",
                id: "prompt-loaded",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "continue with MCP" }] },
            });
            const continued = await readThroughResponse(secondHandle, "prompt-loaded");
            assertEquals(continued.response.result.stopReason, "end_turn");
            assertEquals(sawLoadedMcpResultInTurn, true);
            assertStringIncludes(joinedAgentText(continued.messages), "continued fixture response");
            assertStringIncludes(await fsReadFile(logPath, "utf8"), '"marker":"acp-loaded"');
        } finally {
            await closeTestServer(secondHandle);
            await fsRm(logPath).catch(() => {});
        }
    });
});

test("ACP rejects overlapping prompts and cancels the real in-flight Runtime turn", async () => {
    await withRuntimeCommandFixture("runwield-acp-cancel-", async (fixture) => {
        fixture.setModelResponseFactories([
            () => fauxAssistantMessage(fauxText("working ".repeat(5_000))),
            () => fauxAssistantMessage(fauxText("turn after cancellation")),
        ]);
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "prompt-1",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "wait" }] },
            });

            // Wait for the agent to actually stream. A user_message_chunk arrives during turn
            // setup, before the agent session exists, and cancelling then has nothing to abort.
            let sawAgentStreaming = false;
            while (!sawAgentStreaming) {
                const message = await readMessage(handle);
                sawAgentStreaming = message.params?.update?.sessionUpdate === "agent_message_chunk" &&
                    String(message.params?.update?.content?.text || "").includes("working");
            }

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "prompt-2",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "overlap" }] },
            });
            const overlap = await readThroughResponse(handle, "prompt-2");
            assertEquals(overlap.response.error.code, -32002);

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "busy-model",
                method: "session/set_config_option",
                params: {
                    sessionId: created.sessionId,
                    configId: "model",
                    value: "runtime-command-fixture/fixture-model",
                },
            });
            assertEquals((await readThroughResponse(handle, "busy-model")).response.error?.code, -32002);

            await sendMessage(handle, {
                jsonrpc: "2.0",
                method: "session/cancel",
                params: { sessionId: created.sessionId },
            });
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "prompt-3",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "while cancel settles" }] },
            });
            const settlingOverlap = await readThroughResponse(handle, "prompt-3");
            assertEquals(settlingOverlap.response.error.code, -32002);
            assertEquals(settlingOverlap.messages.some((message) => message.id === "prompt-1"), false);

            const cancelled = await readThroughResponse(handle, "prompt-1", 10_000);
            assertEquals(cancelled.response.result.stopReason, "cancelled");
            const cancelledFrame = framesMatching(handle, (message) => message.id === "prompt-1")[0];
            assert(cancelledFrame, "cancelled prompt response frame should be captured");
            assertAcpFrameSchema("PromptResponse", cancelledFrame, (message) => message.result);

            // The Runtime's own cancellation message is mapped like any other update, so it
            // has to reach the Client before the response that ends the turn. The overlap
            // request can read some of those pending updates before it gets its own error.
            const cancelSequence = [...settlingOverlap.messages, ...cancelled.messages];
            const promptResponseIndex = cancelSequence.findIndex((message) => message.id === "prompt-1");
            const cancellationIndex = cancelSequence.findIndex((message) =>
                message.method === "session/update" &&
                String(message.params?.update?.content?.text || "").includes("Agent run canceled.")
            );
            assert(
                cancellationIndex >= 0,
                `the Runtime cancellation message should be streamed: ${
                    JSON.stringify(cancelSequence.slice(-8).map((m) => [m.method, m.id, m.params?.update]))
                }`,
            );
            assertEquals(cancellationIndex < promptResponseIndex, true);
            assertEquals(cancelled.messages.at(-1)?.id, "prompt-1");

            // After the Client receives the cancelled response, the next prompt is accepted,
            // and nothing from the cancelled turn trails behind it.
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "prompt-4",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "after cancel" }] },
            });
            const resumed = await readThroughResponse(handle, "prompt-4", 1_000);
            assertEquals(resumed.response.result.stopReason, "end_turn");
            assertStringIncludes(joinedAgentText(resumed.messages), "turn after cancellation");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP rejects a prompt sent before the Client receives the cancelled response for request ID 0", async () => {
    await withRuntimeCommandFixture("runwield-acp-cancel-response-held-", async (fixture) => {
        fixture.setModelResponseFactories([
            () => fauxAssistantMessage(fauxText("working ".repeat(5_000))),
            () => fauxAssistantMessage(fauxText("should not run before cancelled response")),
        ]);
        const handle = startTestServer({ holdResponseId: 0 });
        assert(handle.heldResponseStarted);
        assert(handle.releaseHeldResponse);
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: 0,
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "wait" }] },
            });

            let sawAgentStreaming = false;
            while (!sawAgentStreaming) {
                const message = await readMessage(handle);
                sawAgentStreaming = message.params?.update?.sessionUpdate === "agent_message_chunk" &&
                    String(message.params?.update?.content?.text || "").includes("working");
            }

            await sendMessage(handle, {
                jsonrpc: "2.0",
                method: "session/cancel",
                params: { sessionId: created.sessionId },
            });
            await handle.heldResponseStarted;

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "prompt-2",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "too soon" }] },
            });
            handle.releaseHeldResponse?.();

            const overlap = await readThroughResponse(handle, "prompt-2", 10_000);
            const cancelled = overlap.messages.find((message) => message.id === 0);
            assertEquals(cancelled?.result?.stopReason, "cancelled");
            assertEquals(overlap.response.error.code, -32002);
        } finally {
            await closeTestServer(handle);
        }
    });
});

/**
 * A Runtime usage event carrying one message's cost, as the Runtime emits it.
 *
 * @param {number} costUsd
 */
function usageEvent(costUsd) {
    return /** @type {any} */ ({
        type: "usage",
        sessionId: "runtime-1",
        timestamp: "now",
        usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 7,
            cacheWriteTokens: 3,
            contextWindow: 100,
            costUsd,
        },
    });
}

test("ACP usage_update reports the Session's cumulative cost, not the last turn's", () => {
    const sessionMap = new AcpSessionMap();
    sessionMap.createRecord(/** @type {any} */ ({ sessionId: "runtime-1", cwd: "/repo" }), { acpSessionId: "acp-1" });

    // The Runtime prices each message on its own; ACP wants the running Session total.
    const notifications = [0.25, 0.25, 0.5].map((costUsd) =>
        mapEventWithSessionCost(
            sessionMap,
            "acp-1",
            usageEvent(costUsd),
            { tokens: 48_000, contextWindow: 128_000 },
        )
    );

    assertEquals(notifications.map((notification) => /** @type {any} */ (notification).update.cost), [
        { amount: 0.25, currency: "USD" },
        { amount: 0.5, currency: "USD" },
        { amount: 1, currency: "USD" },
    ]);
    for (const notification of notifications) {
        assertAcpSchema("SessionNotification", JSON.parse(JSON.stringify(notification)));
    }
    const costedUsageFrame = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: notifications[2] });
    assertAcpFrameSchema("SessionNotification", costedUsageFrame, (message) => message.params);
});

test("ACP replayed usage events keep adding to the same Session total", () => {
    const sessionMap = new AcpSessionMap();
    sessionMap.createRecord(/** @type {any} */ ({ sessionId: "runtime-1", cwd: "/repo" }), { acpSessionId: "acp-1" });

    // session/load replays the transcript's priced turns before the next prompt runs.
    for (const costUsd of [0.25, 0.25]) {
        mapEventWithSessionCost(
            sessionMap,
            "acp-1",
            usageEvent(costUsd),
            { tokens: 48_000, contextWindow: 128_000 },
        );
    }
    sessionMap.replaceRuntimeSession("acp-1", { sessionId: "runtime-2", cwd: "/repo" });
    const afterLoad = mapEventWithSessionCost(
        sessionMap,
        "acp-1",
        usageEvent(0.25),
        { tokens: 48_000, contextWindow: 128_000 },
    );

    assertEquals(/** @type {any} */ (afterLoad).update.cost, { amount: 0.75, currency: "USD" });
});

test("ACP non-usage events do not disturb the Session cost total", () => {
    const sessionMap = new AcpSessionMap();
    sessionMap.createRecord(/** @type {any} */ ({ sessionId: "runtime-1", cwd: "/repo" }), { acpSessionId: "acp-1" });

    mapEventWithSessionCost(
        sessionMap,
        "acp-1",
        usageEvent(0.25),
        { tokens: 48_000, contextWindow: 128_000 },
    );
    mapEventWithSessionCost(
        sessionMap,
        "acp-1",
        /** @type {any} */ ({
            type: "assistant_text_delta",
            sessionId: "runtime-1",
            timestamp: "now",
            messageId: "m1",
            delta: "hello",
        }),
    );

    assertEquals(sessionMap.getRecord("acp-1")?.usageCostUsd, 0.25);
});

test("ACP streams exact current context usage from a real Runtime turn", async () => {
    await withRuntimeCommandFixture("runwield-acp-usage-", async (fixture) => {
        let latestInputTokens = 0;
        fixture.setModelResponseFactory((context) => {
            latestInputTokens = estimateFauxPromptTokens(context);
            const outputTokens = 52_000 - (latestInputTokens * 2);
            assert(outputTokens > 0, "fixture prompt must leave room for a 52k exact context total");
            return fauxAssistantMessage(fauxText("x".repeat(outputTokens * 4)));
        });
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "usage-prompt",
                method: "session/prompt",
                params: {
                    sessionId: created.sessionId,
                    prompt: [{ type: "text", text: "x".repeat(65_000) }],
                },
            });
            // This deliberately large response can exceed 80 streamed chunks.
            await readThroughResponse(handle, "usage-prompt", 10_000);

            const frames = sessionUpdateFrames(handle, "usage_update");
            assert(frames.length > 0, "a real turn should report usage");
            for (const frame of frames) {
                assertAcpFrameSchema("SessionNotification", frame, (message) => message.params);
                const update = JSON.parse(frame).params.update;
                assertEquals(Object.hasOwn(update, "cost"), false);
            }
            const update = JSON.parse(frames[frames.length - 1]).params.update;
            assertEquals(update.used, 52_000);
            assertEquals(update.size, 128_000);
            assert(
                update.used !== latestInputTokens,
                "current context must not use the latest message input count",
            );
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP live wire suppresses usage when Runtime context capacity is unavailable", async () => {
    await withRuntimeCommandFixture("runwield-acp-unknown-capacity-", async (fixture) => {
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "unknown-capacity-command",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "/agent guide" }] },
            });
            const result = await readThroughResponse(handle, "unknown-capacity-command");
            assert(result.response.result, JSON.stringify(result.response));
            assertEquals(
                result.messages.some((message) => message.params?.update?.sessionUpdate === "usage_update"),
                false,
                "unavailable Runtime capacity must suppress usage on the live wire",
            );
        } finally {
            await closeTestServer(handle);
        }
    }, { contextWindow: 0 });
});

test("ACP live wire suppresses unknown post-compaction context and restores exact usage", async () => {
    await withRuntimeCommandFixture("runwield-acp-compacted-usage-", async (fixture) => {
        fixture.setModelResponseFactories([
            () => fauxAssistantMessage(fauxText("Context before compaction.")),
            () => fauxAssistantMessage(fauxText("Compacted context summary.")),
            () => fauxAssistantMessage(fauxText("Exact context restored.")),
        ]);
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "before-compaction",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "Establish context." }] },
            });
            const before = await readThroughResponse(handle, "before-compaction");
            assert(before.messages.some((message) => message.params?.update?.sessionUpdate === "usage_update"));

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "compact-context",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "/compact" }] },
            });
            assertEquals((await readThroughResponse(handle, "compact-context")).response.result, {
                stopReason: "end_turn",
            });

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "model-after-compaction",
                method: "session/set_config_option",
                params: {
                    sessionId: created.sessionId,
                    configId: "model",
                    value: "runtime-command-fixture/alternate-model",
                },
            });
            const changed = await readThroughResponse(handle, "model-after-compaction");
            assertEquals(
                changed.messages.some((message) => message.params?.update?.sessionUpdate === "usage_update"),
                false,
                "unknown post-compaction tokens must stay off the live wire",
            );

            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "after-compaction",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "Continue." }] },
            });
            const after = await readThroughResponse(handle, "after-compaction");
            assert(
                after.messages.some((message) =>
                    message.params?.update?.sessionUpdate === "usage_update" &&
                    message.params.update.size === 64_000
                ),
                "the next exact Runtime snapshot must restore live usage",
            );
        } finally {
            await closeTestServer(handle);
        }
    }, { additionalModels: [{ id: "alternate-model", name: "Alternate Model", contextWindow: 64_000 }] });
});

test("ACP usage_update uses exact Runtime context and suppresses unknown capacity", () => {
    const event = usageEvent(0);
    const exact = mapRuntimeEventToAcpUpdate(event, 0, { tokens: 48_000, contextWindow: 128_000 });
    assertEquals(exact, { sessionUpdate: "usage_update", used: 48_000, size: 128_000 });
    assertEquals(Object.hasOwn(/** @type {any} */ (exact), "cost"), false);
    assertEquals(mapRuntimeEventToAcpUpdate(event, 0, { tokens: null, contextWindow: 128_000 }), null);
    assertEquals(mapRuntimeEventToAcpUpdate(event, 0, { tokens: 48_000, contextWindow: 0 }), null);
    assertEquals(mapRuntimeEventToAcpUpdate(event, 0), null);

    assertEquals(
        /** @type {any} */ (
            mapRuntimeEventToAcpUpdate(event, 0.25, { tokens: 48_000, contextWindow: 128_000 })
        ).cost,
        { amount: 0.25, currency: "USD" },
    );
});

test("ACP session/close disposes a real Runtime session and rejects later prompts", async () => {
    await withRuntimeCommandFixture("runwield-acp-close-", async (fixture) => {
        const handle = startTestServer();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            const closed = await request(handle, {
                jsonrpc: "2.0",
                id: "close",
                method: "session/close",
                params: { sessionId: created.sessionId },
            });
            assertEquals(closed.result._meta.runwield.closed, true);

            const afterClose = await request(handle, {
                jsonrpc: "2.0",
                id: "after-close",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "nope" }] },
            });
            assertEquals(afterClose.error.code, -32001);
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP validates new/load inputs and maps missing persisted Sessions", async () => {
    assertThrows(() => validateNewSessionParams({ cwd: "relative", mcpServers: [] }));
    assertThrows(() => validateNewSessionParams({ cwd: REPO_ROOT }));
    assertThrows(() => validateNewSessionParams({ cwd: REPO_ROOT, mcpServers: { local: { command: "secret" } } }));
    assertThrows(() =>
        validateNewSessionParams({
            cwd: REPO_ROOT,
            mcpServers: [{ type: "http", name: "web", url: "https://example.test", headers: [] }],
        })
    );
    assertThrows(() =>
        validateNewSessionParams({
            cwd: REPO_ROOT,
            mcpServers: [{ name: "stdio", command: "/bin/echo", args: ["ok"] }],
        })
    );
    const validMcp = validateNewSessionParams({
        cwd: REPO_ROOT,
        mcpServers: [{ name: "stdio", command: "/bin/echo", args: ["ok"], env: [{ name: "TOKEN", value: "secret" }] }],
    });
    assertEquals(validMcp.runwieldMcpServers, [{
        name: "stdio",
        command: "/bin/echo",
        args: ["ok"],
        env: { TOKEN: "secret" },
        source: "request",
    }]);

    await withRuntimeCommandFixture("runwield-acp-invalid-", async (fixture) => {
        const handle = startTestServer();
        try {
            const badCwd = await request(handle, {
                jsonrpc: "2.0",
                id: "bad-cwd",
                method: "session/load",
                params: { sessionId: "persisted-1", cwd: "relative", mcpServers: [] },
            });
            assertEquals(badCwd.error.code, -32602);

            const missing = await request(handle, {
                jsonrpc: "2.0",
                id: "missing",
                method: "session/load",
                params: { sessionId: "acp-missing", cwd: fixture.projectRoot, mcpServers: [] },
            });
            assertEquals(missing.error.code, -32001);
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP session/load maps a persisted Session with no configured model to authentication required", async () => {
    await withRuntimeCommandFixture("runwield-acp-load-no-model-", async (fixture) => {
        const persisted = await createIdleUngeneratedPersistedSession(fixture.projectRoot);
        const handle = startTestServer();
        try {
            const response = await request(handle, {
                jsonrpc: "2.0",
                id: "load-auth-required",
                method: "session/load",
                params: {
                    sessionId: persisted.piSessionId,
                    cwd: fixture.projectRoot,
                    mcpServers: [],
                    _meta: { runwield: { sessionPath: persisted.transcriptPath } },
                },
            });
            assertEquals(response.error.code, -32000);
            assertStringIncludes(response.error.message, "login and default model setup");
        } finally {
            await closeTestServer(handle);
        }
    }, { providerState: "none" });
});

test("ACP agent notices suppress activation and same-Agent rebuilds", () => {
    const event = {
        type: /** @type {const} */ ("agent_changed"),
        sessionId: "session-1",
        messageId: "agent-1",
        timestamp: "2026-09-15T00:00:00.000Z",
        agentName: "guide",
    };
    assertEquals(mapRuntimeEventToAcpUpdate(event), null);
    assertEquals(mapRuntimeEventToAcpUpdate({ ...event, rootHandoff: false }), null);
    assertEquals(
        mapRuntimeEventToAcpUpdate({ ...event, rootHandoff: true })?.content,
        { type: "text", text: "Active agent: guide" },
    );
});

test("ACP event mapper forwards canonical Runtime tool metadata", () => {
    const toolStart = mapRuntimeEventToAcpUpdate({
        type: "tool_start",
        sessionId: "session-1",
        timestamp: "now",
        toolCallId: "tool-1",
        toolName: "bash",
        title: "$ echo safe",
        kind: "execute",
        args: { token: "secret" },
    });
    const toolEnd = mapRuntimeEventToAcpUpdate({
        type: "tool_end",
        sessionId: "session-1",
        timestamp: "now",
        toolCallId: "tool-1",
        toolName: "bash",
        title: "$ echo safe",
        kind: "execute",
        content: [{ type: "text", text: "safe output" }],
        output: "safe output",
        details: { truncated: false },
        isError: false,
        durationMs: 25,
    });
    assertEquals(/** @type {any} */ (toolStart).rawInput, { token: "secret" });
    assertEquals(/** @type {any} */ (toolEnd)._meta?.runwield?.durationMs, 25);
});

test("ACP event mapper forwards structured validation progress", () => {
    const progress = /** @type {import('../shared/session/session-runtime-events.js').RuntimeValidationProgress} */ ({
        kind: "workflow",
        outcome: "paused",
        stage: "engineer_repair",
        cycle: 1,
        maxCycles: 3,
        totalCycle: 1,
        repairAttempt: 1,
        maxRepairAttempts: 3,
        checks: { ci: "failed", semanticReview: "pending", humanReview: "pending", merge: "pending" },
        message: "Awaiting Engineer continuation.",
    });
    const update = mapRuntimeEventToAcpUpdate({
        type: "system_status",
        sessionId: "session-1",
        timestamp: "now",
        messageId: "status-1",
        message: "Validation paused.",
        level: "warning",
        validationProgress: progress,
    });
    assertEquals(/** @type {any} */ (update)._meta?.runwield?.validationProgress, progress);
});

test("ACP production modules do not import TUI adapter code", async () => {
    /** @type {string[]} */
    const violations = [];
    for await (const entry of await fsReaddir(new URL(".", import.meta.url), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".js") || entry.name.endsWith(".test.js")) continue;
        const path = `src/acp/${entry.name}`;
        const source = await fsReadFile(path, "utf8");
        if (/from\s+["'][^"']*(?:\/ui\/|shared\/interactive)/.test(source)) violations.push(path);
        if (/import\(["'][^"']*(?:\/ui\/|shared\/interactive)/.test(source)) violations.push(path);
    }
    assertEquals(violations, []);
});

test("ACP interaction adapter does not expose the obsolete Pair form", async () => {
    /** @type {unknown[]} */
    const requests = [];
    const adapter = createAcpInteractionAdapter({
        acpSessionId: "acp-1",
        clientCapabilities: { elicitation: { form: {} } },
        context: {
            request: (/** @type {unknown} */ request) => {
                requests.push(request);
                return Promise.resolve({ action: "accept", content: { answer: "continue" } });
            },
        },
    });
    assertEquals(adapter.supportsInteraction?.("pair_checkpoint"), false);
    assertEquals(
        await adapter.requestInteraction({
            id: "interaction-pair",
            type: "pair_checkpoint",
            prompt: "Review the increment",
        }),
        {
            outcome: "unsupported",
            message: "Pair checkpoints use ordinary ACP prompts, not structured interactions.",
        },
    );
    assertEquals(requests, []);
});

test("ACP interaction adapter maps valid selections and rejects invalid ones", async () => {
    const accepted = createAcpInteractionAdapter({
        acpSessionId: "acp-1",
        clientCapabilities: { elicitation: { form: {} } },
        context: { request: () => Promise.resolve({ action: "accept", content: { answer: "yes" } }) },
    });
    assertEquals(
        await accepted.requestInteraction({
            id: "interaction-1",
            type: "select",
            prompt: "Proceed?",
            options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
        }),
        { outcome: "selected", value: "yes", valueLabel: "Yes" },
    );

    const invalid = createAcpInteractionAdapter({
        acpSessionId: "acp-1",
        clientCapabilities: { elicitation: { form: {} } },
        context: { request: () => Promise.resolve({ action: "accept", content: { answer: "invalid" } }) },
    });
    const response = await invalid.requestInteraction({
        id: "interaction-2",
        type: "select",
        prompt: "Proceed?",
        options: [{ value: "yes", label: "Yes" }],
    });
    assertEquals(response.outcome, "unsupported");
    assertEquals(response.message, "ACP elicitation returned invalid option: invalid");
});

test("ACP interaction adapter distinguishes approval acceptance from decline", async () => {
    const makeAdapter = (/** @type {string} */ answer) =>
        createAcpInteractionAdapter({
            acpSessionId: "acp-1",
            clientCapabilities: { elicitation: { form: {} } },
            context: { request: () => Promise.resolve({ action: "accept", content: { answer } }) },
        });
    const request = {
        id: "interaction-1",
        type: /** @type {'approval'} */ ("approval"),
        prompt: "Approve?",
        options: [{ value: "approve", label: "Approve" }, { value: "deny", label: "Deny" }],
    };
    assertEquals(await makeAdapter("approve").requestInteraction(request), {
        outcome: "accepted",
        value: true,
    });
    assertEquals(await makeAdapter("deny").requestInteraction(request), {
        outcome: "canceled",
        value: false,
        valueLabel: "Deny",
        message: "Approval was not accepted.",
    });
});

test("ACP interaction adapter falls back to a local browser question without form capabilities", async () => {
    /** @type {PromiseWithResolvers<string>} */
    const notified = Promise.withResolvers();
    const adapter = createAcpInteractionAdapter({
        acpSessionId: "acp-1",
        clientCapabilities: {},
        context: {
            notify: (
                /** @type {string} */ _method,
                /** @type {Record<string, any>} */ params,
            ) => {
                notified.resolve(String(params.update?.content?.text || ""));
            },
        },
    });
    const pending = adapter.requestInteraction({
        id: "interaction-browser",
        type: "select",
        prompt: "Choose Agent",
        options: [{ value: "guide", label: "Guide" }, { value: "planner", label: "Planner" }],
    });
    const ready = await Promise.race([
        notified.promise.then((text) => ({ text })),
        Promise.resolve(pending).then((response) => ({ response })),
    ]);
    if ("response" in ready) {
        assertEquals(ready.response.outcome, "unsupported");
        assertStringIncludes(ready.response.message || "", "browser question page");
        return;
    }
    const text = ready.text;
    const [questionUrl] = text.match(/http:\/\/127\.0\.0\.1:\d+\/session-question\?token=[^\s]+/) || [];
    assert(questionUrl, text);
    const page = await fetch(questionUrl);
    const pageText = await page.text();
    assertEquals(page.status, 200, pageText);
    assertStringIncludes(pageText, "Choose Agent");
    const answerUrl = questionUrl.replace("/session-question", "/api/session-question/answer");
    const submitted = await fetch(answerUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(questionUrl).origin },
        body: "answer=guide",
    });
    assertEquals(submitted.status, 200);
    assertEquals(await pending, { outcome: "selected", value: "guide", valueLabel: "Guide" });
});

test("ACP event mapper maps Plan review links without maintainer secrets", () => {
    const update = mapRuntimeEventToAcpUpdate({
        type: "plan_review_link",
        sessionId: "s1",
        timestamp: "2026-07-07T00:00:00.000Z",
        messageId: "review-link-1",
        planName: "p",
        reviewerUrl: "https://plans.example/#key=review&cap=reviewer&role=reviewer",
        spaceId: "space-1",
        message: "review it",
    });
    assertEquals(update?.sessionUpdate, "agent_message_chunk");
    assertStringIncludes(JSON.stringify(update), "reviewer");
    assertEquals(JSON.stringify(update).includes("maintainer"), false);
});

for (
    const [reply, expectedValue, expectedOther] of [
        ["1", "blue", undefined],
        [" green ", "green", undefined],
        ["1, but include tests\nand preserve the notes.", "other", "1, but include tests\nand preserve the notes."],
    ]
) {
    test(`ACP no-form interview returns the original tool result for ${JSON.stringify(reply)}`, async () => {
        await withRuntimeCommandFixture("runwield-acp-interview-chat-", async (fixture) => {
            fixture.setModelResponseFactories([
                () =>
                    fauxAssistantMessage(fauxToolCall("user_interview", {
                        question: {
                            type: "multiple_choice",
                            prompt: "Pick a color",
                            choices: [
                                { value: "blue", label: "Blue" },
                                { value: "green", label: "Green" },
                            ],
                        },
                    })),
                () => fauxAssistantMessage(fauxText("Interview complete.")),
            ]);
            const handle = startTestServer();
            try {
                await request(handle, {
                    jsonrpc: "2.0",
                    id: "init-chat",
                    method: "initialize",
                    params: {
                        protocolVersion: 1,
                        clientCapabilities: {},
                    },
                });
                const { sessionId } = await createSession(handle, fixture.projectRoot);
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: "select-agent",
                    method: "session/prompt",
                    params: {
                        sessionId,
                        prompt: [{ type: "text", text: "/agent ideator" }],
                    },
                });
                await readThroughResponse(handle, "select-agent");
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: 0,
                    method: "session/prompt",
                    params: {
                        sessionId,
                        prompt: [{ type: "text", text: "Interview me" }],
                    },
                });
                const question = await readThroughResponse(handle, 0);
                assertEquals(question.response.result.stopReason, "end_turn");
                assertStringIncludes(joinedAgentText(question.messages), "Pick a color");
                assertStringIncludes(joinedAgentText(question.messages), "1. Blue");
                assert(!JSON.stringify(question.messages).includes("questionUrl"));
                assert(!question.messages.some((message) => message.method === "elicitation/create"));
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: "answer",
                    method: "session/prompt",
                    params: {
                        sessionId,
                        prompt: [{ type: "text", text: reply }],
                    },
                });
                const completion = await readThroughResponse(handle, "answer");
                assertEquals(completion.response.result.stopReason, "end_turn");
                const result = completion.messages.find((message) =>
                    message.params?.update?._meta?.runwield?.toolName ===
                        "user_interview" && message.params?.update?.rawOutput?.details
                )?.params.update.rawOutput.details;
                assertEquals(result?.status, "completed");
                assertEquals(result.answers[0].value, expectedValue);
                assertEquals(result.answers[0].otherText, expectedOther);
                assertStringIncludes(joinedAgentText(completion.messages), "Interview complete.");
            } finally {
                await closeTestServer(handle);
            }
        });
    });
}

test("ACP chat interview keeps one tool open across three answer requests and an Other follow-up", async () => {
    await withRuntimeCommandFixture("runwield-acp-batch-chat-", async (fixture) => {
        fixture.setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("user_interview", {
                    questions: [
                        { type: "yes_no", prompt: "Include tests?", default: true },
                        {
                            type: "multiple_choice",
                            prompt: "Choose scope",
                            choices: [
                                { value: "small", label: "Small" },
                                { value: "large", label: "Large" },
                            ],
                        },
                        { type: "text", prompt: "Any notes?" },
                    ],
                })),
            () => fauxAssistantMessage(fauxText("Finished three questions.")),
        ]);
        const handle = startTestServer();
        try {
            await request(handle, {
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: {
                    protocolVersion: 1,
                    clientCapabilities: {},
                },
            });
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "agent",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "/agent ideator" }],
                },
            });
            await readThroughResponse(handle, "agent");
            /** @param {string} id @param {string} text */
            const turn = async (id, text) => {
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id,
                    method: "session/prompt",
                    params: {
                        sessionId,
                        prompt: [{ type: "text", text }],
                    },
                });
                return await readThroughResponse(handle, id);
            };
            const first = await turn("start", "Ask three questions");
            assertStringIncludes(joinedAgentText(first.messages), "Include tests?");
            const blank = await turn("blank", "  ");
            assertStringIncludes(joinedAgentText(blank.messages), "An answer is required");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "attachment",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "image", data: "AQ==", mimeType: "image/png" }],
                },
            });
            const attachment = await readThroughResponse(handle, "attachment");
            assertStringIncludes(joinedAgentText(attachment.messages), "Attachments were not submitted");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "model-during-interview",
                method: "session/set_config_option",
                params: { sessionId, configId: "model", value: "runtime-command-fixture/fixture-model" },
            });
            const model = await readThroughResponse(handle, "model-during-interview");
            assertEquals(model.response.error.code, -32002);
            const second = await turn("yes", "1");
            assertStringIncludes(joinedAgentText(second.messages), "Choose scope");
            const followUp = await turn("other", "Other");
            assertStringIncludes(joinedAgentText(followUp.messages), "Please specify your answer");
            const third = await turn("other-text", "  Only APIs\nwith compatibility tests.  ");
            assertStringIncludes(joinedAgentText(third.messages), "Any notes?");
            const final = await turn("notes", "  Keep the order.\nAnd preserve punctuation!  ");
            const details = final.messages.find((message) =>
                message.params?.update?._meta?.runwield?.toolName ===
                    "user_interview" && message.params?.update?.rawOutput?.details
            )?.params.update.rawOutput.details;
            assertEquals(details?.status, "completed");
            assertEquals(details.answers.map((/** @type {{ value: string | boolean }} */ answer) => answer.value), [
                true,
                "other",
                "Keep the order.\nAnd preserve punctuation!",
            ]);
            assertEquals(details.answers[1].otherText, "Only APIs\nwith compatibility tests.");
            assertStringIncludes(joinedAgentText(final.messages), "Finished three questions.");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP interview reply cannot overtake a held question response", async () => {
    await withRuntimeCommandFixture("runwield-acp-held-chat-", async (fixture) => {
        fixture.setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("user_interview", {
                    question: { type: "yes_no", prompt: "Proceed?" },
                })),
            () => fauxAssistantMessage(fauxText("Completed after the reply.")),
        ]);
        const handle = startTestServer({ holdResponseId: 0 });
        try {
            await request(handle, {
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: {
                    protocolVersion: 1,
                    clientCapabilities: {},
                },
            });
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "agent",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "/agent ideator" }],
                },
            });
            await readThroughResponse(handle, "agent");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: 0,
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "Ask now" }],
                },
            });
            await handle.heldResponseStarted;
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "too-early",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "1" }],
                },
            });
            handle.releaseHeldResponse?.();
            const response = await readThroughResponse(handle, 0);
            assertStringIncludes(joinedAgentText(response.messages), "Proceed?");
            const rejected = await readThroughResponse(handle, "too-early");
            assertEquals(rejected.response.error.code, -32002);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "answer",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "1" }],
                },
            });
            const final = await readThroughResponse(handle, "answer");
            assertStringIncludes(joinedAgentText(final.messages), "Completed after the reply.");
        } finally {
            handle.releaseHeldResponse?.();
            await closeTestServer(handle);
        }
    });
});

test("ACP cancellation between interview requests settles the original turn", async () => {
    await withRuntimeCommandFixture("runwield-acp-cancel-chat-", async (fixture) => {
        fixture.setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("user_interview", {
                    question: { type: "text", prompt: "What changed?" },
                })),
            () => fauxAssistantMessage(fauxText("Next turn is usable.")),
        ]);
        const handle = startTestServer();
        try {
            await request(handle, {
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: {
                    protocolVersion: 1,
                    clientCapabilities: {},
                },
            });
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "agent",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "/agent ideator" }],
                },
            });
            await readThroughResponse(handle, "agent");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "question",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "Ask" }],
                },
            });
            const asked = await readThroughResponse(handle, "question");
            assertStringIncludes(joinedAgentText(asked.messages), "What changed?");
            await sendMessage(handle, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
            // The next prompt can follow once the Runtime has settled; it must not answer the canceled tool.
            let next;
            for (let index = 0; index < 20; index++) {
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: `next-${index}`,
                    method: "session/prompt",
                    params: {
                        sessionId,
                        prompt: [{ type: "text", text: "Continue" }],
                    },
                });
                next = await readThroughResponse(handle, `next-${index}`);
                if (next.response.result) break;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assertEquals(next?.response.result?.stopReason, "end_turn");
            assert(next);
            assertStringIncludes(joinedAgentText(next.messages), "Next turn is usable.");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP duplicate load rejects an already mapped Session before it opens another Runtime Session", async () => {
    await withRuntimeCommandFixture("runwield-acp-duplicate-load-", async (fixture) => {
        fixture.setModelResponse("Original Session remains usable.");
        const handle = startTestServer();
        try {
            const { sessionId, persistedSessionId } = await createSession(handle, fixture.projectRoot);
            const duplicate = await request(handle, {
                jsonrpc: "2.0",
                id: "duplicate",
                method: "session/load",
                params: {
                    sessionId: persistedSessionId,
                    cwd: fixture.projectRoot,
                    mcpServers: [],
                },
            });
            assertEquals(duplicate.error.code, -32002);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "original",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "Continue" }],
                },
            });
            const original = await readThroughResponse(handle, "original");
            assertStringIncludes(joinedAgentText(original.messages), "Original Session remains usable.");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP chat interview returns two ordered answers to one waiting model turn", async () => {
    await withRuntimeCommandFixture("runwield-acp-two-chat-", async (fixture) => {
        fixture.setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("user_interview", {
                    questions: [
                        { type: "yes_no", prompt: "Proceed?" },
                        { type: "text", prompt: "Reason?" },
                    ],
                })),
            () => fauxAssistantMessage(fauxText("Both received.")),
        ]);
        const handle = startTestServer();
        try {
            await request(handle, {
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: {
                    protocolVersion: 1,
                    clientCapabilities: {},
                },
            });
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "agent",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "/agent ideator" }],
                },
            });
            await readThroughResponse(handle, "agent");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "ask",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "Ask two" }],
                },
            });
            assertStringIncludes(joinedAgentText((await readThroughResponse(handle, "ask")).messages), "Proceed?");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "first",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "No" }],
                },
            });
            assertStringIncludes(joinedAgentText((await readThroughResponse(handle, "first")).messages), "Reason?");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "second",
                method: "session/prompt",
                params: {
                    sessionId,
                    prompt: [{ type: "text", text: "  Needs more time.  " }],
                },
            });
            const final = await readThroughResponse(handle, "second");
            const details = final.messages.find((message) =>
                message.params?.update?._meta?.runwield?.toolName ===
                    "user_interview" && message.params?.update?.rawOutput?.details
            )?.params.update.rawOutput.details;
            assertEquals(details?.answers.map((/** @type {{ value: string | boolean }} */ answer) => answer.value), [
                false,
                "Needs more time.",
            ]);
            assertStringIncludes(joinedAgentText(final.messages), "Both received.");
        } finally {
            await closeTestServer(handle);
        }
    });
});

test("ACP interview cancellation during a blocked question write precedes its response", async () => {
    await withRuntimeCommandFixture("runwield-acp-question-cancel-", async (fixture) => {
        fixture.setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("user_interview", {
                    question: { type: "text", prompt: "Question while writing?" },
                })),
        ]);
        const handle = startTestServer({ holdOutputText: "Question while writing?" });
        try {
            const { sessionId } = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "agent",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "/agent ideator" }] },
            });
            await readThroughResponse(handle, "agent");
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "ask",
                method: "session/prompt",
                params: { sessionId, prompt: [{ type: "text", text: "Ask" }] },
            });
            await handle.heldResponseStarted;
            await sendMessage(handle, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
            await new Promise((resolve) => setTimeout(resolve, 50));
            handle.releaseHeldResponse?.();
            const { messages, response } = await readThroughResponse(handle, "ask", 1000);
            assertEquals(response.result.stopReason, "cancelled");
            assert(
                messages.some((message) =>
                    String(message.params?.update?.content?.text || "").includes("Operation canceled.")
                ),
                "Runtime cancellation update must precede the response",
            );
        } finally {
            handle.releaseHeldResponse?.();
            await closeTestServer(handle);
        }
    });
});

test("ACP session/delete archives a mapped Session and succeeds for repeated and missing IDs", async () => {
    await withRuntimeCommandFixture("runwield-acp-delete-", async (fixture) => {
        fixture.setModelResponseFactories([() => fauxAssistantMessage(fauxText("saved conversation"))]);
        const handle = startTestServer();
        const store = openFileSessionStore();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "persist-delete",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "save" }] },
            });
            await readThroughResponse(handle, "persist-delete", 1000);
            const session = store.getSessionById(created.persistedSessionId) ||
                store.findSessionByLocator({ piSessionId: created.persistedSessionId });
            assert(session);
            const segments = store.listSessionTranscriptSegments(session.runwieldSessionId);
            for (const [index, sessionId] of [created.sessionId, created.sessionId, "acp-missing"].entries()) {
                await sendMessage(handle, {
                    jsonrpc: "2.0",
                    id: `delete-${index}`,
                    method: "session/delete",
                    params: { sessionId },
                });
                assertEquals((await readThroughResponse(handle, `delete-${index}`)).response.result, {});
            }
            assert(store.getSessionById(session.runwieldSessionId)?.archivedAt);
            assertEquals(store.listSessionTranscriptSegments(session.runwieldSessionId), segments);
            const after = await request(handle, {
                jsonrpc: "2.0",
                id: "deleted-prompt",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "no" }] },
            });
            assertEquals(after.error.code, -32001);
            const frame = framesMatching(handle, (message) => message.id === "delete-0")[0];
            assertAcpFrameSchema("DeleteSessionResponse", frame, (message) => message.result);
        } finally {
            store.close();
            await closeTestServer(handle);
        }
    });
});

test("ACP session/delete resolves an unmapped Pi segment ID to its multi-segment Session", async () => {
    await withRuntimeCommandFixture("runwield-acp-delete-pi-", async (fixture) => {
        const store = openFileSessionStore();
        const handle = startTestServer();
        try {
            const first = await createIdleUngeneratedPersistedSession(fixture.projectRoot);
            const neighbor = await createIdleUngeneratedPersistedSession(fixture.projectRoot);
            const session = store.findSessionByLocator({ piSessionId: first.piSessionId });
            const other = store.findSessionByLocator({ piSessionId: neighbor.piSessionId });
            assert(session);
            assert(other);
            // Use a fresh uncataloged transcript for the successor segment.
            const piSessionId = "delete-pi-successor";
            const transcriptPath = join(dirname(first.transcriptPath), `2026-01-02T00-00-00-000Z_${piSessionId}.jsonl`);
            await fsWriteFile(
                transcriptPath,
                `${
                    JSON.stringify({
                        type: "session",
                        version: 3,
                        id: piSessionId,
                        timestamp: "2026-01-02T00:00:00.000Z",
                        cwd: fixture.projectRoot,
                    })
                }\n`,
            );
            const current = store.getCurrentSessionSegment(session.runwieldSessionId);
            assert(current);
            store.sealSessionTranscriptSegment({
                runwieldSessionId: session.runwieldSessionId,
                segmentId: current.segmentId,
                evidence: await captureTranscriptEvidence({
                    transcriptPath: first.transcriptPath,
                    transcriptCwd: fixture.projectRoot,
                }),
            });
            await store.appendSessionTranscriptSegment({
                runwieldSessionId: session.runwieldSessionId,
                projectId: session.projectId,
                piSessionId,
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
                kind: "execution",
            });
            const segments = store.listSessionTranscriptSegments(session.runwieldSessionId);
            assertEquals(segments.length, 2);
            const deleted = await request(handle, {
                jsonrpc: "2.0",
                id: "delete-pi",
                method: "session/delete",
                params: { sessionId: `acp-${first.piSessionId}` },
            });
            assertEquals(deleted.result, {});
            assert(store.getSessionById(session.runwieldSessionId)?.archivedAt);
            assertEquals(store.getSessionById(other.runwieldSessionId)?.archivedAt, null);
            assertEquals(store.listSessionTranscriptSegments(session.runwieldSessionId), segments);
        } finally {
            store.close();
            await closeTestServer(handle);
        }
    });
});

test("ACP session/delete cancels busy work and archives only after writer settlement", async () => {
    await withRuntimeCommandFixture("runwield-acp-delete-busy-", async (fixture) => {
        fixture.setModelResponseFactories([() => fauxAssistantMessage(fauxText("working ".repeat(5_000)))]);
        const handle = startTestServer();
        const store = openFileSessionStore();
        try {
            const created = await createSession(handle, fixture.projectRoot);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "busy-delete-prompt",
                method: "session/prompt",
                params: { sessionId: created.sessionId, prompt: [{ type: "text", text: "work" }] },
            });
            for (;;) {
                const message = await readMessage(handle);
                if (
                    message.params?.update?.sessionUpdate === "agent_message_chunk" &&
                    String(message.params.update.content?.text || "").includes("working")
                ) break;
            }
            const session = store.getSessionById(created.persistedSessionId) ||
                store.findSessionByLocator({ piSessionId: created.persistedSessionId });
            assert(session);
            assertEquals(store.inspectSessionActivation(session.runwieldSessionId).activation?.state, "active");
            assertEquals(session.archivedAt, null);
            await sendMessage(handle, {
                jsonrpc: "2.0",
                id: "busy-delete",
                method: "session/delete",
                params: { sessionId: created.sessionId },
            });
            const result = await readThroughResponse(handle, "busy-delete", 10_000);
            assertEquals(result.response.result, {});
            const prompt = result.messages.find((message) => message.id === "busy-delete-prompt");
            assertEquals(prompt?.result.stopReason, "cancelled");
            assertEquals(store.inspectSessionActivation(session.runwieldSessionId).activation?.state, "idle");
            assert(store.getSessionById(session.runwieldSessionId)?.archivedAt);
        } finally {
            store.close();
            await closeTestServer(handle);
        }
    });
});

for (const mapped of [false, true]) {
    for (const cancellationFails of [false, true]) {
        test(`ACP session/delete ${mapped ? "mapped" : "unmapped"} remote owner ${cancellationFails ? "failed cancellation keeps archive unchanged" : "waits for cancellation settlement"}`, async () => {
            if (process.platform === "win32") return;
            const { createServer } = await import("node:http");
            const { createHash } = await import("node:crypto");
            const { getHomeDir } = await import("../constants.js");
            await withRuntimeCommandFixture("runwield-acp-delete-remote-", async (fixture) => {
                const handle = startTestServer();
                const store = openFileSessionStore();
                /** @type {ReturnType<typeof createServer> | undefined} */
                let socket;
                let proof;
                let socketPath = "";
                let stopped = () => {};
                const cancellation = new Promise((resolve) => {
                    stopped = () => resolve(undefined);
                });
                try {
                    const created = mapped
                        ? await createSession(handle, fixture.projectRoot)
                        : await createIdleUngeneratedPersistedSession(fixture.projectRoot);
                    const persistedId = "persistedSessionId" in created
                        ? created.persistedSessionId
                        : created.piSessionId;
                    const sessionId = "sessionId" in created ? created.sessionId : `acp-${created.piSessionId}`;
                    const session = store.getSessionById(persistedId) ||
                        store.findSessionByLocator({ piSessionId: persistedId });
                    assert(session);
                    proof = store.acquireSessionActivation({
                        runwieldSessionId: session.runwieldSessionId,
                        projectId: session.projectId,
                        ownerInstanceId: "remote-workspace",
                        ownerProcessKind: "workspace",
                        operationId: "remote-delete-op",
                    });
                    const key = createHash("sha256").update(
                        `${getHomeDir()}:${session.runwieldSessionId}:remote-delete-op`,
                    ).digest("hex").slice(0, 40);
                    socketPath = `/tmp/runwield-${key}.sock`;
                    socket = createServer(async (incoming, response) => {
                        let body = "";
                        for await (const chunk of incoming) body += chunk.toString();
                        assertEquals(JSON.parse(body).action, "cancel");
                        response.setHeader("content-type", "application/json");
                        response.end(
                            JSON.stringify(
                                cancellationFails ? { ok: false, error: "Remote cancellation failed" } : { ok: true },
                            ),
                        );
                        stopped();
                    });
                    const listeningSocket = socket;
                    await new Promise((resolve) => listeningSocket.listen(socketPath, () => resolve(undefined)));
                    await sendMessage(handle, {
                        jsonrpc: "2.0",
                        id: "remote-delete",
                        method: "session/delete",
                        params: { sessionId },
                    });
                    let deleteSettled = false;
                    const deletion = readThroughResponse(handle, "remote-delete", 10_000).then((result) => {
                        deleteSettled = true;
                        return result.response;
                    });
                    await cancellation;
                    assertEquals(store.getSessionById(session.runwieldSessionId)?.archivedAt, null);
                    assertEquals(store.inspectSessionActivation(session.runwieldSessionId).activation?.state, "active");
                    if (!cancellationFails) {
                        // Cancellation acknowledgment is not writer settlement.
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        assertEquals(deleteSettled, false);
                        assertEquals(store.getSessionById(session.runwieldSessionId)?.archivedAt, null);
                        store.releaseUnchangedActivation(proof);
                        proof = null;
                    }
                    const result = await deletion;
                    if (cancellationFails) {
                        assert(result.error);
                        assertEquals(store.getSessionById(session.runwieldSessionId)?.archivedAt, null);
                        assertEquals(
                            store.inspectSessionActivation(session.runwieldSessionId).activation?.state,
                            "active",
                        );
                    } else {
                        assertEquals(result.result, {});
                        assert(store.getSessionById(session.runwieldSessionId)?.archivedAt);
                        assertEquals(
                            store.inspectSessionActivation(session.runwieldSessionId).activation?.state,
                            mapped ? "idle" : "uninitialized",
                        );
                    }
                } finally {
                    if (proof) store.releaseUnchangedActivation(proof);
                    const closingSocket = socket;
                    if (closingSocket) await new Promise((resolve) => closingSocket.close(resolve));
                    if (socketPath) await fsRm(socketPath).catch(() => {});
                    store.close();
                    await closeTestServer(handle);
                }
            });
        });
    }
}
