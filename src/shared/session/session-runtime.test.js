import {
    assert,
    assertEquals,
    assertExists,
    assertRejects,
    assertStrictEquals,
    assertStringIncludes,
} from "@std/assert";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    getCurrentSystemPrompt,
    getCurrentTools,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { join } from "@std/path";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { __resetSettingsForTests, setCustomSetting } from "../settings.js";
import { SessionHost } from "./session-host.ts";
import { captureTranscriptEvidence } from "./session-transcript-projection.js";
import { switchActiveAgent } from "./agent-switching.js";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import { RuntimeInteractionTypes } from "./session-runtime-interactions.js";
import { createSessionRuntime, SessionRuntime, SessionTurnInProgressError } from "./session-runtime.ts";
import { getRootSessionRebuildOptions } from "./session.js";
import { createRootSessionManager, getRunWieldSessionDir, resolveCreatedRootSessionPath } from "./root-session.js";
import { openFileSessionStore } from "./file-session-store.ts";
import { sessionDirForRoot } from "./file-session-storage.ts";
import { openOwnerCoordinationStore } from "../owner-coordination/index.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getPlanRevisionForText, savePlan } from "../../plan-store.js";
import { rememberNonGitExecutionConsent } from "../non-git-execution-consent.ts";
import { McpIntegration } from "../mcp/integration.ts";
import { loadPlanActionEvidence } from "../workflow/plan-actions.ts";
import { buildSemanticRepairSegmentContinuation } from "../workflow/execution-segment-handoff.ts";
import { WORKFLOW_TOOL_EVENT_CUSTOM_TYPE } from "../workflow/workflow-tool-events.ts";
import { getHomeDir, SUBAGENTS } from "../../constants.js";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";

const RUNTIME_TEST_PROVIDER = "session-runtime-test";
const RUNTIME_TEST_MODEL = "fixture-model";
const RUNTIME_TEST_API = "session-runtime-faux";
// A real PNG is required: invalid image bytes are omitted during prompt preparation.
const RUNTIME_TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const RUNTIME_REPAIR_GIT_FIXTURE = defineCommittedGitFixture({ "README.md": "# Runtime repair fixture\n" });

/** @type {ReturnType<typeof registerFauxProvider> | null} */
let runtimeFauxProvider = null;

function runtimeProjectRoot() {
    const sandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
    const home = getHomeDir();
    if (!sandboxHome) {
        throw new Error("SessionRuntime tests must run through scripts/run-tests.js with an isolated HOME");
    }
    const projectRoot = join(home, "runtime-project");
    Deno.mkdirSync(projectRoot, { recursive: true });
    return projectRoot;
}

function ensureRuntimeModelFixture() {
    const sandboxHome = Deno.env.get("WLD_TEST_SANDBOX_HOME");
    const home = getHomeDir();
    if (!sandboxHome) {
        throw new Error("SessionRuntime tests must run through scripts/run-tests.js with an isolated HOME");
    }
    const runwieldDir = join(home, ".wld");
    Deno.mkdirSync(runwieldDir, { recursive: true });
    const settingsPath = join(runwieldDir, "settings.json");
    try {
        Deno.statSync(settingsPath);
        return;
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    Deno.writeTextFileSync(
        join(runwieldDir, "models.json"),
        JSON.stringify({
            providers: {
                [RUNTIME_TEST_PROVIDER]: {
                    name: "SessionRuntime Test Provider",
                    baseUrl: "http://127.0.0.1:0",
                    apiKey: "fixture-key",
                    api: RUNTIME_TEST_API,
                    models: [{
                        id: RUNTIME_TEST_MODEL,
                        name: "SessionRuntime Fixture Model",
                        api: RUNTIME_TEST_API,
                        input: ["text", "image"],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    }],
                },
            },
        }),
    );
    Deno.writeTextFileSync(
        join(runwieldDir, "auth.json"),
        JSON.stringify({ [RUNTIME_TEST_PROVIDER]: { type: "api_key", key: "fixture-key" } }),
    );
    Deno.writeTextFileSync(
        settingsPath,
        JSON.stringify({
            defaultProvider: RUNTIME_TEST_PROVIDER,
            defaultModel: RUNTIME_TEST_MODEL,
            notifications: { enabled: false },
        }),
    );
    runtimeFauxProvider ??= registerFauxProvider({
        api: RUNTIME_TEST_API,
        provider: RUNTIME_TEST_PROVIDER,
        // Preserve every streamed delta without simulating network latency.
        tokensPerSecond: 0,
        models: [{ id: RUNTIME_TEST_MODEL, name: "SessionRuntime Fixture Model", input: ["text", "image"] }],
    });
    runtimeFauxProvider.setResponses(
        Array.from(
            { length: 100 },
            () => () => fauxAssistantMessage(fauxText("SessionRuntime fixture response.")),
        ),
    );
    __resetSettingsForTests();
}

/** @param {ReturnType<typeof fauxAssistantMessage>[]} messages */
function setRuntimeModelMessages(messages) {
    ensureRuntimeModelFixture();
    runtimeFauxProvider?.setResponses([
        ...messages.map((message) => () => message),
        ...Array.from(
            { length: 100 },
            () => () => fauxAssistantMessage(fauxText("SessionRuntime fixture response.")),
        ),
    ]);
}

/** @param {import('@earendil-works/pi-ai').FauxResponseFactory[]} factories */
function setRuntimeModelResponseFactories(factories) {
    ensureRuntimeModelFixture();
    runtimeFauxProvider?.setResponses([
        ...factories,
        ...Array.from(
            { length: 100 },
            () => () => fauxAssistantMessage(fauxText("SessionRuntime fixture response.")),
        ),
    ]);
}

/** @param {number} ms */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True while the OS still has a process with this pid.
 * @param {number} pid
 */
function processAlive(pid) {
    try {
        Deno.kill(pid, "SIGCONT");
        return true;
    } catch {
        return false;
    }
}

/**
 * Poll until the OS no longer reports a process with this pid. The wrapper
 * shell's exit settles before its SIGKILLed descendants are reaped, so a
 * single immediate probe can still observe them — and under CI load the
 * window is wide enough to fail a one-shot check.
 *
 * @param {number} pid
 * @param {number} [timeoutMs]
 */
async function waitForProcessDeath(pid, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!processAlive(pid)) return true;
        await delay(20);
    }
    return !processAlive(pid);
}

/**
 * macOS can briefly report recursive temp cleanup as ENOTEMPTY/EBUSY while
 * filesystem metadata settles after a test's last writes. Retry boundedly so
 * cleanup flakiness does not fail an otherwise successful test.
 *
 * @param {string} path
 */
async function removeTempDir(path) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await Deno.remove(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) return;
            const isRetryable = error instanceof Error &&
                /Directory not empty|resource busy|os error 66|os error 16/i.test(error.message);
            if (!isRetryable || attempt === 4) throw error;
            await delay(25 * (attempt + 1));
        }
    }
}

/**
 * @typedef {Object} RuntimePreparationBusySample
 * @property {string} message
 * @property {boolean | undefined} busy
 */

/**
 * @typedef {Object} HandoffProviderRequest
 * @property {string} agentName
 * @property {string} messages
 * @property {number} imageCount
 */

/** @typedef {Awaited<ReturnType<SessionRuntime["steerSession"]>>} SteeringResult */

/** @returns {{ promise: Promise<void>, resolve: () => void }} */
function deferredVoid() {
    /** @type {() => void} */
    let resolve = () => {};
    const promise = new Promise((done) => {
        resolve = () => done(undefined);
    });
    return { promise, resolve };
}

/**
 * @typedef {Object} RuntimeFixtureOptions
 * @property {SessionHost} [sessionHost]
 */

/** @param {RuntimeFixtureOptions} [options] */
function makeRuntime(options = {}) {
    ensureRuntimeModelFixture();
    return new SessionRuntime({
        sessionHost: options.sessionHost ?? new SessionHost(),
        sessionStore: openOwnerCoordinationStore(),
        ownerProcessKind: "test",
        ownerInstanceId: crypto.randomUUID(),
    });
}

/**
 * Attach a Pi-facing AgentSession test double to a real Runtime-created persisted
 * session. These doubles stand in only for the external Pi session object; all
 * RunWield creation, queueing, cancellation, and event machinery stays real.
 *
 * @param {SessionRuntime} _runtime
 * @param {SessionHost} sessionHost
 * @param {ReturnType<typeof makeSteeringAgentSession> | Record<string, any>} agentSession
 * @param {import('./types.js').AgentMessageHandler} [handler]
 */
function attachExternalAgentSession(
    _runtime,
    sessionHost,
    agentSession,
    handler = () => Promise.resolve({ kind: "complete" }),
) {
    const hostedSession = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd: runtimeProjectRoot(),
        sessionManager: null,
    });
    hostedSession.setRootAgentName("router");
    hostedSession.setRootAgentSession(agentSession);
    hostedSession.setActiveOnMessage(handler);
    return Promise.resolve(hostedSession.id);
}

Deno.test("SessionRuntime commits a Claude CLI model reconfiguration only after root rebuild succeeds", async () => {
    const sessionHost = new SessionHost();
    const session = sessionHost.createSession({ id: "claude-model-commit", cwd: runtimeProjectRoot() });
    const previousHandler = () => Promise.resolve({ kind: "complete" });
    const previousAgentSession = { dispose() {} };
    session.setRootAgentName("engineer");
    session.setRootAgentSession(previousAgentSession);
    session.setActiveOnMessage(previousHandler);
    const runtime = makeRuntime({ sessionHost });
    /** @type {import('./session-runtime-events.js').SessionRuntimeEvent[]} */
    const events = [];
    runtime.subscribeSessionEvents("claude-model-commit", (event) => {
        events.push(event);
    });

    await runtime.reconfigureSessionModel("claude-model-commit", "sonnet", "claude-cli");

    assertEquals(session.getActiveModelState(), { model: "sonnet", provider: "claude-cli" });
    assertEquals(events.filter((event) => event.type === RuntimeEventTypes.MODEL_CHANGED).length, 1);
    const rebuiltRoot = /** @type {any} */ (session.getRootAgentSession());
    assertEquals(rebuiltRoot?.kind, "claude-cli");
    rebuiltRoot?.session?.dispose?.();
});

Deno.test("SessionRuntime restores the previous user model override when active root rebuild fails", async () => {
    const sessionHost = new SessionHost();
    const session = sessionHost.createSession({ id: "model-rollback", cwd: runtimeProjectRoot() });
    const previousHandler = () => Promise.resolve({ kind: "complete" });
    const previousAgentSession = { dispose() {} };
    session.setRootAgentName("engineer");
    session.setRootAgentSession(previousAgentSession);
    session.setActiveOnMessage(previousHandler);
    session.setActiveModelState("sonnet", "anthropic", true);
    const runtime = makeRuntime({ sessionHost });
    /** @type {import('./session-runtime-events.js').SessionRuntimeEvent[]} */
    const events = [];
    runtime.subscribeSessionEvents("model-rollback", (event) => {
        events.push(event);
    });

    await assertRejects(
        () => runtime.reconfigureSessionModel("model-rollback", "opus", "unknown-provider"),
        Error,
        "Unknown manual /model override",
    );

    assertEquals(session.getActiveModelState(), { model: "sonnet", provider: "anthropic" });
    assertStrictEquals(session.getRootAgentSession(), previousAgentSession);
    assertStrictEquals(session.getActiveOnMessage(), previousHandler);
    assertEquals(events.filter((event) => event.type === RuntimeEventTypes.MODEL_CHANGED), []);
});

function makeSteeringAgentSession() {
    /** @type {Set<(event: any) => void>} */
    const listeners = new Set();
    /** @type {string[]} */
    let steering = [];
    const session = /** @type {any} */ ({
        isStreaming: true,
        model: { input: ["text", "image"] },
        /** @param {(event: any) => void} listener */
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        /** @param {string} text */
        steer(text) {
            steering.push(text);
            session.emitQueueUpdate();
            return Promise.resolve();
        },
        /** @param {string} text */
        followUp(text) {
            steering.push(text);
            session.emitQueueUpdate();
            return Promise.resolve();
        },
        clearQueue() {
            const cleared = { steering: [...steering], followUp: [] };
            steering = [];
            session.emitQueueUpdate();
            return cleared;
        },
        abort() {
            session.isStreaming = false;
        },
        getSteeringMessages: () => steering,
        emitQueueUpdate() {
            for (const listener of listeners) {
                listener({ type: "queue_update", steering: [...steering], followUp: [] });
            }
        },
        consumeNextSteering() {
            steering.shift();
            session.emitQueueUpdate();
        },
        consumeNextSteeringSilently() {
            steering.shift();
        },
        dispose() {},
    });
    return session;
}

Deno.test("SessionRuntime exposes opaque ids and snapshots, never HostedSession objects", async () => {
    const runtime = makeRuntime();
    const created = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });

    assertEquals(typeof created.sessionId, "string");
    assertEquals(await Deno.realPath(created.cwd), await Deno.realPath(runtimeProjectRoot()));
    assertEquals("hostedSession" in created, false);
    assertEquals("sessionManager" in created, false);
    assertEquals(Object.hasOwn(runtime, "sessionHost"), false);
    assertEquals(runtime.getSessionSnapshot(created.sessionId)?.sessionStats, null);
    assertEquals(runtime.listSessions(), [runtime.getSessionSnapshot(created.sessionId)]);
    assertEquals("getActiveOnMessage" in /** @type {any} */ (runtime.listSessions()[0]), false);
});

Deno.test("SessionRuntime snapshots keep Session names current with transcript changes", () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const cwd = runtimeProjectRoot();
    const sessionManager = SessionManager.create(cwd, getRunWieldSessionDir(cwd));
    sessionManager.appendMessage({ role: "user", timestamp: Date.now(), content: "First question" });
    sessionManager.appendMessage(fauxAssistantMessage(fauxText("First answer")));
    const session = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd,
        sessionManager,
    });

    assertEquals(runtime.getSessionSnapshot(session.id)?.sessionStats, {
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        compactionCount: 0,
    });
    sessionManager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "README.md" })));
    assertEquals(runtime.getSessionSnapshot(session.id)?.sessionStats, {
        userMessages: 1,
        assistantMessages: 2,
        toolCalls: 1,
        compactionCount: 0,
    });
    sessionManager.appendSessionInfo("Renamed Session");
    assertEquals(runtime.getSessionSnapshot(session.id)?.name, "Renamed Session");
});

Deno.test("SessionRuntime snapshot exposes active context capacity without exposing AgentSession", () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    agentSession.getContextUsage = () => ({ tokens: 48_000, contextWindow: 128_000, percent: 37.5 });
    agentSession.settingsManager = {
        getCompactionSettings: () => ({ enabled: true }),
    };
    const runtime = makeRuntime({ sessionHost });
    const hostedSession = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd: runtimeProjectRoot(),
        sessionManager: null,
    });
    hostedSession.setRootAgentName("router");
    hostedSession.setRootAgentSession(agentSession);
    const sessionId = hostedSession.id;

    assertEquals(runtime.getSessionSnapshot(sessionId)?.contextUsage, {
        tokens: 48_000,
        contextWindow: 128_000,
        percent: 37.5,
    });
    assertEquals(runtime.getSessionSnapshot(sessionId)?.autoCompactionEnabled, true);

    const transientSession = /** @type {any} */ ({
        getContextUsage: () => ({ tokens: 4_000, contextWindow: 64_000, percent: 6.25 }),
        settingsManager: { getCompactionSettings: () => ({ enabled: false }) },
    });
    hostedSession.addSubAgentSession(transientSession);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.contextUsage, {
        tokens: 4_000,
        contextWindow: 64_000,
        percent: 6.25,
    });
    assertEquals(runtime.getSessionSnapshot(sessionId)?.autoCompactionEnabled, false);

    const snapshot = runtime.getSessionSnapshot(sessionId);
    assertEquals("agentSession" in /** @type {Record<string, unknown>} */ (snapshot || {}), false);
});

Deno.test("SessionRuntime snapshots tolerate a streaming assistant message without usage", () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    agentSession.agent = { state: { messages: [{ role: "assistant" }] } };
    agentSession.getContextUsage = () => ({ tokens: 4_000, contextWindow: 64_000, percent: 6.25 });
    const runtime = makeRuntime({ sessionHost });
    const hostedSession = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd: runtimeProjectRoot(),
        sessionManager: null,
    });
    hostedSession.setRootAgentSession(agentSession);

    assertEquals(runtime.getSessionSnapshot(hostedSession.id)?.contextUsage, {
        tokens: 4_000,
        contextWindow: 64_000,
        percent: 6.25,
    });
});

Deno.test("SessionRuntime rejects non-absolute session roots", async () => {
    const runtime = makeRuntime();
    await assertRejects(
        () => runtime.createInteractiveSession({ cwd: "relative/project" }),
        Error,
        "requires an absolute cwd",
    );
    await assertRejects(
        () => runtime.loadSession({ cwd: "relative/project", sessionId: "persisted" }),
        Error,
        "requires an absolute cwd",
    );
});

Deno.test("SessionRuntime blocks Pi-backed create and load when owner coordination is absent", async () => {
    ensureRuntimeModelFixture();
    const runtime = new SessionRuntime({
        sessionHost: new SessionHost(),
        sessionStore: null,
        ownerProcessKind: "test",
        ownerInstanceId: crypto.randomUUID(),
    });
    await assertRejects(
        () => runtime.createInteractiveSession({ cwd: runtimeProjectRoot(), mode: "new" }),
        Error,
        "session_store_unavailable",
    );
    await assertRejects(
        () => runtime.loadSession({ cwd: runtimeProjectRoot(), sessionId: "persisted" }),
        Error,
        "session_store_unavailable",
    );
});

Deno.test("SessionRuntime keeps dormant managed image persistence read-only but allows live manager paste", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await Deno.makeTempDir({ prefix: "runwield-runtime-managed-image-" });
        Deno.env.set("HOME", home);
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        ensureRuntimeModelFixture();
        const sessionHost = new SessionHost();
        try {
            const session = sessionHost.createSession({
                id: "managed-image-runtime",
                cwd,
                sessionManager: null,
                managed: {
                    runwieldSessionId: "rw-managed-image",
                    projectId: "project-managed-image",
                    piSessionId: "pi-managed-image",
                    transcriptPath: `${cwd}/transcript.jsonl`,
                    generation: 1,
                    name: "Managed image",
                    activeAgent: "Router",
                    model: RUNTIME_TEST_MODEL,
                    provider: RUNTIME_TEST_PROVIDER,
                    workflowContext: null,
                },
            });
            assertEquals(session.getRootSessionManager(), null);
            const runtime = makeRuntime({ sessionHost });

            const dormantResult = await runtime.persistSessionImage(session.id, {
                base64: btoa("img"),
                mimeType: "image/png",
            });
            assertEquals(dormantResult.error, "refresh_required");

            const sessionDir = getRunWieldSessionDir(cwd);
            await Deno.mkdir(sessionDir, { recursive: true });
            const sessionManager = SessionManager.create(cwd, sessionDir, { id: "pi-managed-image" });
            /** @type {import('./managed-operation.ts').ManagedOperationCapability} */
            const capability = {
                runtimeSessionId: session.id,
                runwieldSessionId: "rw-managed-image",
                operationId: "op-managed-image",
                proof: {
                    runwieldSessionId: "rw-managed-image",
                    projectId: "project-managed-image",
                    ownerInstanceId: "owner-managed-image",
                    ownerProcessKind: "test",
                    operationId: "op-managed-image",
                    fence: 1,
                    phase: "hydrated",
                    expectedGeneration: 1,
                },
                settled: false,
                registerArtifact: () => ({
                    artifactId: "artifact-managed-image",
                    kind: "report",
                    path: "artifact.md",
                    title: "Artifact",
                    registeredAt: "2026-01-01T00:00:00.000Z",
                    registeredBy: "test",
                    sourceSegmentId: null,
                }),
                updateProof: () => {},
                assertLive: () => {},
                settle: () => {},
            };
            session.setManagedOperationCapability(capability);
            session.setRootSessionManager(/** @type {any} */ (sessionManager), capability);
            const persisted = await runtime.persistSessionImage(session.id, {
                base64: btoa("img"),
                mimeType: "image/png",
            });
            if (!("base64" in persisted)) throw new Error(persisted.error);

            const persistedPath = persisted.path || "";
            assertEquals(persisted.ref?.startsWith("attachment:"), true);
            assertEquals(persistedPath.startsWith(`${getRunWieldSessionDir(cwd)}/pi-managed-image_images/`), true);
            assertEquals(new TextDecoder().decode(await Deno.readFile(persistedPath)), "img");
            assertEquals(await runtime.preflightSessionImages(session.id, [persisted]), { ok: true, mode: "direct" });
        } finally {
            Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
});

Deno.test("SessionRuntime uses the model selected by image preflight for submission", async () => {
    await withRuntimeCommandFixture(
        "runtime-image-model-agreement-",
        async ({ projectRoot, settingsPath, setModelResponseFactory }) => {
            /** @type {string[]} */
            const requestedModels = [];
            setModelResponseFactory((_context, _options, _state, model) => {
                requestedModels.push(model.id);
                return fauxAssistantMessage(fauxText("SessionRuntime fixture response."));
            });
            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({
                cwd: projectRoot,
                mode: "new",
                deferManagedActivationUntilAgentReady: true,
            });
            try {
                const image = { base64: btoa("img"), mimeType: "image/png" };
                const preflight = await runtime.preflightUserTurnImages(created.sessionId, {
                    initialRequest: "describe this",
                    initialImages: [image],
                });
                assertEquals(preflight.ok, true);
                const preparedModelOverride = "preparedModelOverride" in preflight
                    ? preflight.preparedModelOverride
                    : undefined;
                assertEquals(preparedModelOverride, "runtime-command-fixture/fixture-model");
                await Deno.writeTextFile(
                    settingsPath,
                    JSON.stringify({
                        defaultProvider: "runtime-command-fixture",
                        defaultModel: "alternate-model",
                        notifications: { enabled: false },
                    }),
                );
                __resetSettingsForTests();

                const result = await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "describe this",
                    initialImages: [image],
                    preparedModelOverride,
                });

                assertEquals(result.ok, true);
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.activeModel, {
                    provider: "runtime-command-fixture",
                    model: "fixture-model",
                });
                assertEquals(requestedModels, ["fixture-model"]);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
            }
        },
        { additionalModels: [{ id: "alternate-model", name: "Alternate" }] },
    );
});

Deno.test("SessionRuntime keeps a prepared image model through Prompt Template preflight and provider submission", async () => {
    await withRuntimeCommandFixture(
        "runtime-template-image-model-agreement-",
        async ({ homeDir, projectRoot, settingsPath, setModelResponseFactory }) => {
            const promptDir = join(projectRoot, ".wld", "prompts");
            await Deno.mkdir(promptDir, { recursive: true });
            await Deno.writeTextFile(
                join(promptDir, "vision-note.md"),
                ["---", "agent: operator", "---", "Describe this image: {{input}}"].join("\n"),
            );
            /** @type {string[]} */
            const requestedModels = [];
            setModelResponseFactory((_context, _options, _state, model) => {
                requestedModels.push(model.id);
                return fauxAssistantMessage(fauxText("Template image response."));
            });
            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({
                cwd: projectRoot,
                mode: "new",
                deferManagedActivationUntilAgentReady: true,
            });
            try {
                const image = { base64: btoa("img"), mimeType: "image/png" };
                const preflight = await runtime.preflightUserTurnImages(created.sessionId, {
                    initialRequest: "/vision-note carefully",
                    initialImages: [image],
                });
                assertEquals(preflight.ok, true);
                const preparedModelOverride = "preparedModelOverride" in preflight
                    ? preflight.preparedModelOverride
                    : undefined;
                assertEquals(preparedModelOverride, "runtime-command-fixture/fixture-model");
                await Deno.writeTextFile(
                    join(homeDir, ".wld", "models.json"),
                    JSON.stringify({
                        providers: {
                            "runtime-command-fixture": {
                                name: "Runtime Command Fixture Provider",
                                baseUrl: "http://127.0.0.1:0",
                                apiKey: "fixture-key",
                                api: "runtime-command-faux",
                                models: [{
                                    id: "fixture-model",
                                    name: "Runtime Command Fixture Model",
                                    api: "runtime-command-faux",
                                    input: ["text", "image"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                }, {
                                    id: "text-only-model",
                                    name: "Text Only",
                                    api: "runtime-command-faux",
                                    input: ["text"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                }],
                            },
                        },
                    }),
                );
                await Deno.writeTextFile(
                    settingsPath,
                    JSON.stringify({
                        defaultProvider: "runtime-command-fixture",
                        defaultModel: "text-only-model",
                        notifications: { enabled: false },
                    }),
                );
                __resetSettingsForTests();

                const result = await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "/vision-note carefully",
                    initialImages: [image],
                    preparedModelOverride,
                });

                assertEquals(result.ok, true);
                assertEquals(requestedModels, ["fixture-model"]);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
            }
        },
        { additionalModels: [{ id: "text-only-model", name: "Text Only" }] },
    );
});

Deno.test("SessionRuntime rejects a persisted image before hydrating a deferred Session", async () => {
    await withRuntimeCommandFixture(
        "runtime-persisted-image-preflight-",
        async ({ homeDir, projectRoot, settingsPath }) => {
            const modelsPath = `${homeDir}/.wld/models.json`;
            const modelConfiguration = JSON.parse(await Deno.readTextFile(modelsPath));
            modelConfiguration.providers["runtime-command-fixture"].models[0].input = ["text"];
            await Deno.writeTextFile(modelsPath, JSON.stringify(modelConfiguration));
            await Deno.writeTextFile(
                settingsPath,
                JSON.stringify({
                    defaultProvider: "runtime-command-fixture",
                    defaultModel: "fixture-model",
                    notifications: { enabled: false },
                }),
            );
            __resetSettingsForTests();
            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({
                cwd: projectRoot,
                mode: "new",
                deferManagedActivationUntilAgentReady: true,
            });
            const imagePath = join(projectRoot, "image.png");
            await Deno.writeFile(imagePath, new TextEncoder().encode("img"));
            try {
                const result = await runtime.preflightUserTurnImages(created.sessionId, {
                    initialRequest: "describe this",
                    initialImages: [{ path: imagePath, mimeType: "image/png", base64: "" }],
                });

                assertEquals(result.ok, false);
                const message = "message" in result ? result.message || "" : "";
                assertStringIncludes(message, "image");
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, null);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
            }
        },
    );
});

Deno.test("SessionRuntime persists a newly managed Pi transcript before cataloging it", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await Deno.makeTempDir({ prefix: "runwield-runtime-managed-lazy-transcript-" });
        Deno.env.set("HOME", home);
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
        try {
            ensureRuntimeModelFixture();
            store.registerProject({ root: cwd, now: () => "2026-01-01T00:00:01.000Z" });
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "runtime-test-owner",
            });
            try {
                const created = await runtime.createInteractiveSession({
                    cwd,
                    mode: "new",
                });
                assertEquals(typeof created.sessionManagerId, "string");
                const managed = runtime.getSessionSnapshot(created.sessionId)?.managed;
                const segment = store.getCurrentSessionSegment(managed?.runwieldSessionId || "");
                assertExists(segment?.transcriptPath);
                assertEquals((await Deno.stat(segment.transcriptPath)).isFile, true);
                const resumable = await runtime.listResumableSessions(cwd);
                assertEquals(resumable.some((session) => session.id === created.sessionManagerId), false);
                await runtime.renameSession(created.sessionId, "Named empty Session");
                const named = await runtime.listResumableSessions(cwd);
                assertEquals(named.some((session) => session.id === created.sessionManagerId), true);

                await runtime.switchAgent(created.sessionId, { agentName: "Ideator" });
                const snapshot = runtime.getSessionSnapshot(created.sessionId);
                assertEquals(snapshot?.managed?.generation, 2);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
            }
        } finally {
            store.close();
            Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
});

/** @param {boolean} disconnect */
async function exerciseRepairCompactionFollowUp(disconnect) {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await Deno.makeTempDir({ prefix: "runwield-runtime-worktree-header-" });
        Deno.env.set("HOME", home);
        const projectRoot = await RUNTIME_REPAIR_GIT_FIXTURE.checkout({ prefix: "runwield-runtime-project-" });
        const worktreeRoot = `${home}/worktree`;
        await git(projectRoot, ["worktree", "add", "-b", "repair-worktree", worktreeRoot]);
        const store = openFileSessionStore();
        let manager;
        try {
            ensureRuntimeModelFixture();
            const planBody = "# Repair Follow Up\n\nApproved Plan body";
            const planId = "runtime-repair-follow-up-plan";
            await savePlan(worktreeRoot, "repair-follow-up", planBody, {
                planId,
                status: "implemented",
                classification: "PLANNED_CHANGE",
                executionAgent: "engineer",
            });
            const actionEvidence = await loadPlanActionEvidence(worktreeRoot, planId);
            if (actionEvidence.kind !== "success") throw new Error(actionEvidence.message);
            const approvedRevision = await getPlanRevisionForText(planBody);
            /** @type {import('../types.js').ActiveExecutionWorkflow} */
            const activeWorkflow = {
                planName: "repair-follow-up",
                projectRoot: worktreeRoot,
                executionCwd: worktreeRoot,
                executionAgent: "engineer",
                worktreeId: "29c0436d",
                worktreeBranch: "repair-worktree",
                worktreeBaseBranch: "main",
                triageMeta: {
                    planId,
                    status: "validated_ci",
                    executionAgent: "engineer",
                },
            };
            const project = store.ensureRuntimeProject({ root: projectRoot });
            const projectSessionDir = sessionDirForRoot(store.path, projectRoot);
            manager = SessionManager.create(worktreeRoot, projectSessionDir, { id: "worktree-follow-up" });
            manager.appendMessage({
                role: "user",
                timestamp: Date.now(),
                content: [{ type: "text", text: "Initial repair blocker context" }],
            });
            const transcriptPath = manager.getSessionFile?.();
            if (!transcriptPath) throw new Error("Expected a persisted transcript path");
            const writableManager = /** @type {any} */ (manager);
            if (typeof writableManager._rewriteFile === "function") writableManager._rewriteFile();

            const acquired = await store.ensureSessionCatalogRecordAndAcquire({
                locator: {
                    projectId: project.projectId,
                    piSessionId: "worktree-follow-up",
                    transcriptPath,
                    transcriptCwd: worktreeRoot,
                    source: "created",
                },
                activation: {
                    ownerInstanceId: "runtime-test-owner",
                    ownerProcessKind: "test",
                    operationId: "fixture-create",
                },
            });
            const evidence = await captureTranscriptEvidence({
                transcriptPath,
                transcriptCwd: worktreeRoot,
            });
            const hydratedProof = store.changeSessionActivationPhase(acquired.proof, "hydrated");
            const checkpointProof = store.changeSessionActivationPhase(hydratedProof, "checkpointing");
            store.publishGenerationAndRelease(checkpointProof, { ...evidence, generation: 0 });
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "runtime-test-owner",
            });
            const blockerNeedle =
                "R1-2 blocked: missing reviewer artifact must be restored before this repair can finish.";
            const blockerText = `${blockerNeedle}\n${"Repair blocker evidence. ".repeat(6000)}`;
            let promptText = "";
            let repairPromptText = "";
            let deliveries = 0;
            try {
                const adopted = runtime.adoptManagedSession({
                    session: acquired.session,
                    generation: 0,
                    activeAgent: "reviewer-feedback-engineer",
                });
                const imagePreflight = await runtime.preflightUserTurnImages(adopted.sessionId, {
                    initialRequest: "Describe this pasted image.",
                    initialImages: [{ base64: btoa("img"), mimeType: "image/png" }],
                });
                assertEquals(imagePreflight.ok, true, JSON.stringify(imagePreflight));
                const continuation = buildSemanticRepairSegmentContinuation({
                    runwieldSessionId: acquired.session.runwieldSessionId,
                    planId,
                    planName: "repair-follow-up",
                    approvedRevision,
                    approvedStatus: "implemented",
                    approvedMarkdown: planBody,
                    preparedEvidence: actionEvidence.evidence,
                    activeWorkflow,
                    executionOwner: "plan-engineer",
                    semanticRound: 2,
                    repairGeneration: "repair-generation-2",
                    reviewLedger: { sequence: 1, items: [{ id: "R1-2", title: "Missing blocked repair" }] },
                    executionState: { executionCwd: worktreeRoot },
                    ciState: { status: "validated_ci" },
                    diffText: "diff --git a/file.js b/file.js\n",
                    findingsSection: "R1-2 — The required blocked-repair regression is still incomplete.",
                });
                await runtime.rollManagedSessionSegment(adopted.sessionId, {
                    kind: "semantic_repair",
                    continuation,
                    expectedGeneration: 0,
                });
                const rolledImagePreflight = await runtime.preflightUserTurnImages(adopted.sessionId, {
                    initialRequest: "Describe this pasted image.",
                    initialImages: [{ base64: btoa("img"), mimeType: "image/png" }],
                });
                assertEquals(rolledImagePreflight.ok, true, JSON.stringify(rolledImagePreflight));
                if (disconnect) await setCustomSetting("retry", { enabled: false }, "project", worktreeRoot);
                setRuntimeModelResponseFactories([
                    (context) => {
                        repairPromptText = JSON.stringify(context.messages.at(-1));
                        return disconnect
                            ? fauxAssistantMessage(fauxText(blockerText.repeat(3)), {
                                stopReason: "error",
                                errorMessage: "Unexpected EOF",
                            })
                            : fauxAssistantMessage(fauxText(blockerText));
                    },
                    () => fauxAssistantMessage(fauxText(`Compacted repair context keeps: ${blockerNeedle}`)),
                ]);
                /** @type {string[]} */
                const repairUserMessages = [];
                const unsubscribeRepair = runtime.subscribeSessionEvents(adopted.sessionId, (event) => {
                    if (event.type === "user_message") repairUserMessages.push(event.text);
                });
                // Handoffs carry the original request as context, not as a new user turn.
                const repairOptions = {
                    planName: "repair-follow-up",
                    planContent: planBody,
                    triageMeta: activeWorkflow.triageMeta,
                    initialRequest: "Make a plan for this",
                };
                const repairResult = await runtime.executePlan(adopted.sessionId, repairOptions);
                unsubscribeRepair();
                assertEquals(repairUserMessages, []);
                assertEquals(repairResult.kind, "paused");
                assertStringIncludes(repairPromptText, "docs/plans/repair-follow-up.md");
                assertEquals(repairPromptText.includes("file.js"), false);
                const blockedSegment = store.getCurrentSessionSegment(acquired.session.runwieldSessionId);
                if (!blockedSegment) throw new Error("Expected a blocked repair segment");
                assertStringIncludes(await Deno.readTextFile(blockedSegment.transcriptPath), blockerNeedle);
                assertEquals(
                    runtime.getRuntimeActiveExecutionWorkflow(adopted.sessionId)?.planName,
                    "repair-follow-up",
                );

                if (disconnect) {
                    const transcript = await captureTranscriptEvidence({
                        transcriptPath: blockedSegment.transcriptPath,
                        transcriptCwd: worktreeRoot,
                    });
                    assert(transcript.entries.some((entry) => entry.type === "compaction"));
                } else {
                    setRuntimeModelResponseFactories([
                        () => fauxAssistantMessage(fauxText(`Compacted repair context keeps: ${blockerNeedle}`)),
                    ]);
                    const compaction = await runtime.compactSession(adopted.sessionId);
                    assertEquals(compaction.error, undefined);
                }
                setRuntimeModelResponseFactories([(context) => {
                    deliveries += 1;
                    promptText = JSON.stringify(context);
                    return fauxAssistantMessage(fauxText("Follow-up reached the repair Agent."));
                }]);
                const result = await runtime.promptUserTurn(adopted.sessionId, {
                    initialRequest: "Summarize remaining repair work.",
                });
                assertEquals(result.ok, true);
                assertEquals(deliveries, 1);
                assertStringIncludes(promptText, "Summarize remaining repair work.");
                assertStringIncludes(promptText, blockerNeedle);
                assertEquals(runtime.getSessionSnapshot(adopted.sessionId)?.activeAgent, "reviewer-feedback-engineer");
                assertEquals(runtime.getSessionSnapshot(adopted.sessionId)?.cwd, worktreeRoot);
                assert((runtime.getSessionSnapshot(adopted.sessionId)?.managed?.generation || 0) >= 2);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
            }

            const currentSegment = store.getCurrentSessionSegment(acquired.session.runwieldSessionId);
            if (!currentSegment) throw new Error("Expected a current repair segment after compaction");
            assertEquals(currentSegment.kind, "semantic_repair");
            const reloadedRuntime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "runtime-test-owner-reloaded",
            });
            setRuntimeModelResponseFactories([(context) => {
                deliveries += 1;
                promptText = JSON.stringify(context);
                return fauxAssistantMessage(fauxText("Reloaded follow-up reached the repair Agent."));
            }]);
            try {
                const loaded = reloadedRuntime.adoptManagedSession({
                    session: acquired.session,
                    generation: null,
                    activeAgent: "reviewer-feedback-engineer",
                });
                assertEquals(reloadedRuntime.getRuntimeActiveExecutionWorkflow(loaded.sessionId), null);
                const result = await reloadedRuntime.promptUserTurn(loaded.sessionId, {
                    initialRequest: "Continue after disposal.",
                });
                assertEquals(result.ok, true);
                assertEquals(deliveries, 2);
                assertEquals(
                    reloadedRuntime.getSessionSnapshot(loaded.sessionId)?.activeAgent,
                    "reviewer-feedback-engineer",
                );
                assertStringIncludes(promptText, "Continue after disposal.");
                assertStringIncludes(promptText, blockerNeedle);
                assertEquals(
                    reloadedRuntime.getSessionSnapshot(loaded.sessionId)?.cwd,
                    await Deno.realPath(worktreeRoot),
                );
            } finally {
                await reloadedRuntime.closeAllSessionsWhenIdle?.();
            }
        } finally {
            await Promise.resolve((/** @type {any} */ (manager))?.dispose?.());
            store.close();
            Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
            await removeTempDir(projectRoot);
        }
    });
}

Deno.test("SessionRuntime preserves a blocked semantic repair through compaction and follow-up", async () => {
    await exerciseRepairCompactionFollowUp(false);
});

Deno.test("SessionRuntime preserves repair follow-up after provider EOF and automatic compaction", async () => {
    await exerciseRepairCompactionFollowUp(true);
});

Deno.test("SessionRuntime automatically segments new Sessions in unregistered local projects", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await Deno.makeTempDir({ prefix: "runwield-runtime-unmanaged-registered-project-" });
        Deno.env.set("HOME", home);
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
        try {
            ensureRuntimeModelFixture();
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "runtime-test-owner",
            });
            try {
                const created = await runtime.createInteractiveSession({ cwd, mode: "new" });
                const managed = runtime.getSessionSnapshot(created.sessionId)?.managed;
                assertEquals(typeof managed?.runwieldSessionId, "string");
                assertEquals(typeof managed?.currentSegmentId, "string");
                assertEquals(store.listProjects(), []);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
            }
        } finally {
            store.close();
            Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
});

Deno.test("SessionRuntime publishes generation zero before dehydrating newly managed Sessions", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await Deno.makeTempDir({ prefix: "runwield-runtime-managed-create-" });
        Deno.env.set("HOME", home);
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
        try {
            ensureRuntimeModelFixture();
            const project = store.registerProject({ root: cwd, now: () => "2026-01-01T00:00:01.000Z" });
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "runtime-test-owner",
            });
            try {
                const created = await runtime.createInteractiveSession({
                    cwd,
                    mode: "new",
                });
                assertEquals(typeof created.sessionManagerId, "string");
                const active = store.inspectSessionActivation(
                    runtime.getSessionSnapshot(created.sessionId)?.managed?.runwieldSessionId || "",
                );
                assertEquals(active.activation?.state, "idle");

                await runtime.switchAgent(created.sessionId, { agentName: "Ideator" });
                const snapshot = runtime.getSessionSnapshot(created.sessionId);
                const managed = snapshot?.managed;
                assertEquals(snapshot?.activeAgent, "ideator");
                assertEquals(managed?.projectId, store.ensureRuntimeProject({ root: cwd }).projectId);
                assertEquals(managed?.projectId === project.projectId, false);
                assertEquals(managed?.generation, 1);
                assertEquals(managed?.acknowledgedGeneration, 1);
                assertEquals(managed?.syncState?.status, "current");
                const inspected = store.inspectSessionActivation(managed?.runwieldSessionId || "");
                assertEquals(inspected.activation?.state, "idle");
                assertEquals(inspected.generation?.generation, 1);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
            }
        } finally {
            store.close();
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
});

Deno.test("SessionRuntime automatically recovers append-only output written before generation zero", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await Deno.makeTempDir({ prefix: "runwield-runtime-initial-recovery-" });
        Deno.env.set("HOME", home);
        const cwd = join(home, "project");
        await Deno.mkdir(cwd, { recursive: true });
        const interruptedStore = openFileSessionStore();
        try {
            const project = interruptedStore.ensureRuntimeProject({ root: cwd });
            const manager = await createRootSessionManager("new", cwd);
            const piSessionId = manager.getSessionId();
            const transcriptPath = await resolveCreatedRootSessionPath(cwd, manager);
            const session = await interruptedStore.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId,
                transcriptPath,
                transcriptCwd: cwd,
                source: "created",
            });
            const segment = interruptedStore.getCurrentSessionSegment(session.runwieldSessionId);
            if (!segment) throw new Error("fixture segment missing");
            interruptedStore.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "interrupted-owner",
                ownerProcessKind: "test",
                expectedGeneration: null,
                expectedCurrentSegmentId: segment.segmentId,
            });
            manager.appendMessage({
                role: "user",
                timestamp: Date.now(),
                content: [{ type: "text", text: "preserved output" }],
            });
            await Promise.resolve(
                (/** @type {{ dispose?: () => void | Promise<void> }} */ (manager)).dispose?.(),
            );
            interruptedStore.close();

            const resumedStore = openFileSessionStore();
            const runtime = createSessionRuntime({
                sessionStore: resumedStore,
                ownerProcessKind: "test",
                ownerInstanceId: "resuming-owner",
            });
            try {
                const loaded = await runtime.loadSession({ cwd, sessionId: piSessionId, sessionPath: transcriptPath });
                assertEquals(loaded.sessionManagerId, piSessionId);
                const recovered = resumedStore.inspectSessionActivation(session.runwieldSessionId);
                assertEquals(recovered.activation?.state, "idle");
                assertEquals(recovered.generation?.generation, 0);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
                resumedStore.close();
            }
        } finally {
            interruptedStore.close();
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
});

Deno.test("SessionRuntime synchronization recovers safe append-only output after a later interrupted turn", async () => {
    await withRuntimeCommandFixture(
        "runtime-managed-later-recovery-",
        async ({ homeDir: home, projectRoot: cwd }) => {
            const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "runtime-recovery-owner",
            });
            try {
                const sessionId = await runtime.createPromptReadySession({ cwd, agentName: "guide" });
                const managed = runtime.getSessionSnapshot(sessionId)?.managed;
                if (!managed) throw new Error("Fixture Session was not managed");
                const segment = store.getCurrentSessionSegment(managed.runwieldSessionId);
                if (!segment) throw new Error("Fixture Session segment was unavailable");
                const state = store.inspectSessionActivation(managed.runwieldSessionId);
                const proof = store.acquireSessionActivation({
                    runwieldSessionId: managed.runwieldSessionId,
                    projectId: managed.projectId,
                    ownerInstanceId: "interrupted-claude-turn",
                    ownerProcessKind: "test",
                    expectedGeneration: state.generation?.generation ?? null,
                    expectedCurrentSegmentId: managed.currentSegmentId,
                    phase: "turning",
                });
                await Deno.writeTextFile(
                    segment.transcriptPath,
                    `${
                        JSON.stringify({
                            type: "custom",
                            id: crypto.randomUUID(),
                            customType: "runwield.backend_status",
                            data: {
                                version: 1,
                                backend: "claude-cli",
                                kind: "non_zero_exit",
                                exitCode: 1,
                                message: "Claude Code exited before completing the turn.",
                            },
                        })
                    }\n`,
                    { append: true },
                );
                store.markSessionUncertain(proof, { reason: "Claude Code exited before completing the turn." });

                const synchronized = await runtime.synchronizeManagedSession(sessionId);

                assertEquals(synchronized.ok, true);
                assertEquals(
                    store.inspectSessionActivation(managed.runwieldSessionId).generation?.generation,
                    (state.generation?.generation ?? 0) + 1,
                );
                assertEquals(store.inspectSessionActivation(managed.runwieldSessionId).activation?.state, "idle");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.managed?.syncState?.status, "current");
                assertEquals(runtime.getUserTurnSubmissionBlockMessage(sessionId), null);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
                store.close();
            }
        },
    );
});

Deno.test("SessionRuntime does not emit unchanged current managed sync state on idle polls", async () => {
    await withRuntimeCommandFixture(
        "runtime-managed-idle-sync-",
        async ({ homeDir, projectRoot }) => {
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            try {
                const writerRuntime = createSessionRuntime({
                    sessionStore: store,
                    ownerProcessKind: "test",
                    ownerInstanceId: "runtime-idle-sync-writer",
                });
                let runwieldSessionId = "";
                try {
                    const created = await writerRuntime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                    await writerRuntime.switchAgent(created.sessionId, { agentName: "Ideator" });
                    runwieldSessionId = writerRuntime.getSessionSnapshot(created.sessionId)?.managed
                        ?.runwieldSessionId || "";
                    assert(runwieldSessionId);
                } finally {
                    await writerRuntime.closeAllSessionsWhenIdle?.();
                }

                const observerRuntime = createSessionRuntime({
                    sessionStore: store,
                    ownerProcessKind: "test",
                    ownerInstanceId: "runtime-idle-sync-observer",
                });
                try {
                    const resumed = await observerRuntime.createInteractiveSession({
                        cwd: projectRoot,
                        mode: "continue",
                        resumeSessionId: runwieldSessionId,
                    });
                    await observerRuntime.synchronizeManagedSession(resumed.sessionId);
                    /** @type {string[]} */
                    const events = [];
                    observerRuntime.subscribeSessionEvents(resumed.sessionId, (event) => {
                        if (event.type === RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED) events.push(event.status);
                    });

                    await observerRuntime.synchronizeManagedSession(resumed.sessionId);
                    await observerRuntime.synchronizeManagedSession(resumed.sessionId);

                    assertEquals(events, []);
                } finally {
                    await observerRuntime.closeAllSessionsWhenIdle?.();
                }
            } finally {
                store.close();
            }
        },
    );
});

Deno.test("SessionRuntime hydrates dormant managed Sessions for direct Plan workflow operations", async () => {
    await withRuntimeCommandFixture(
        "runtime-managed-plan-workflow-",
        async ({ homeDir: home, projectRoot: cwd, setModelMessages }) => {
            setModelMessages([fauxAssistantMessage(fauxText("Planning remains active after hydration."))]);
            const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
            try {
                store.registerProject({ root: cwd, now: () => "2026-01-01T00:00:01.000Z" });
                const runtime = createSessionRuntime({
                    sessionStore: store,
                    ownerProcessKind: "test",
                    ownerInstanceId: "runtime-test-owner",
                });
                try {
                    const created = await runtime.createInteractiveSession({
                        cwd,
                        mode: "new",
                        deferManagedActivationUntilAgentReady: true,
                    });
                    await runtime.switchAgent(created.sessionId, { agentName: "planner" });
                    assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed?.generation, 0);
                    assertEquals(typeof runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, "string");

                    const result = await runtime.runPlanningAgent(created.sessionId, {
                        agentName: "planner",
                        initialRequest: "Resume planning",
                    });

                    assertEquals(result, { outcome: "no_call" });
                    assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed?.generation, 1);
                    assertEquals(typeof runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, "string");
                } finally {
                    await runtime.closeAllSessionsWhenIdle?.();
                }
            } finally {
                store.close();
            }
        },
    );
});

Deno.test("SessionRuntime lazy materialization creates missing Project roots", async () => {
    ensureRuntimeModelFixture();
    const cwd = join(runtimeProjectRoot(), `lazy-missing-root-${crypto.randomUUID()}`);
    const runtime = createSessionRuntime({ sessionStore: null, ownerProcessKind: "test" });
    const created = await runtime.createInteractiveSession({
        cwd,
        mode: "new",
        deferManagedActivationUntilAgentReady: true,
    });
    try {
        runtime.markPromptReadyAgent(created.sessionId, { agentName: "router" });
        const result = await runtime.promptUserTurn(created.sessionId, { initialRequest: "hello" });
        assertEquals(result.ok, true);
        assertEquals((await Deno.stat(cwd)).isDirectory, true);
        assertEquals(typeof runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, "string");
    } finally {
        await runtime.closeAllSessionsWhenIdle?.();
    }
});

Deno.test("SessionRuntime keeps first-turn materialization failures retryable", async () => {
    ensureRuntimeModelFixture();
    const cwd = join(runtimeProjectRoot(), `lazy-file-root-${crypto.randomUUID()}`);
    await Deno.writeTextFile(cwd, "not a directory");
    const runtime = createSessionRuntime({ sessionStore: null, ownerProcessKind: "test" });
    const created = await runtime.createInteractiveSession({
        cwd,
        mode: "new",
        deferManagedActivationUntilAgentReady: true,
    });
    try {
        runtime.markPromptReadyAgent(created.sessionId, { agentName: "router" });
        await assertRejects(
            () => runtime.promptUserTurn(created.sessionId, { initialRequest: "first try" }),
            Error,
            "Project root must be a directory",
        );
        assertEquals(runtime.getSessionSnapshot(created.sessionId)?.busy, false);
        assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed, null);
        await Deno.remove(cwd);
        await Deno.mkdir(cwd, { recursive: true });
        const result = await runtime.promptUserTurn(created.sessionId, { initialRequest: "retry" });
        assertEquals(result.ok, true);
        assertEquals(typeof runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, "string");
    } finally {
        await runtime.closeAllSessionsWhenIdle?.();
    }
});

Deno.test("SessionRuntime creates persisted Sessions outside Git without project runtime state", async () => {
    const cwd = await Deno.makeTempDir({ prefix: "runwield-non-git-session-" });
    const runtime = createSessionRuntime({ ownerProcessKind: "test" });
    try {
        const created = await runtime.createInteractiveSession({ cwd, mode: "new" });
        assert(typeof created.sessionManagerId === "string");
        await assertRejects(() => Deno.stat(join(cwd, ".wld", "internal")), Deno.errors.NotFound);
    } finally {
        await runtime.closeAllSessionsWhenIdle();
        await Deno.remove(cwd, { recursive: true }).catch(() => {});
    }
});

Deno.test("SessionRuntime can defer managed creation cataloging until Agent readiness", async () => {
    const cwd = join(runtimeProjectRoot(), `deferred-${crypto.randomUUID()}`);
    await Deno.mkdir(cwd, { recursive: true });
    const home = getHomeDir();
    const store = openOwnerCoordinationStore({ dbPath: join(home, "owner-defer.sqlite3") });
    try {
        const project = store.registerProject({ root: cwd, now: () => "2026-01-01T00:00:01.000Z" });

        const runtime = createSessionRuntime({
            sessionStore: store,
            ownerProcessKind: "test",
            ownerInstanceId: "runtime-test-owner",
        });
        const created = await runtime.createInteractiveSession({
            cwd,
            mode: "new",
            deferManagedActivationUntilAgentReady: true,
        });
        try {
            assertEquals(created.sessionManagerId, null);
            assertEquals(runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, null);
            assertEquals(runtime.getSessionSnapshot(created.sessionId)?.managed, null);
            assertEquals((await store.listProjectSessions(project.projectId)).sessions, []);
        } finally {
            runtime.closeSession(created.sessionId);
        }
    } finally {
        store.close();
    }
});

Deno.test("SessionRuntime continue opens the explicitly requested saved Session", async () => {
    ensureRuntimeModelFixture();
    const cwd = join(runtimeProjectRoot(), `explicit-resume-${crypto.randomUUID()}`);
    await Deno.mkdir(cwd, { recursive: true });
    const runtime = createSessionRuntime({ ownerProcessKind: "test" });
    let firstPersistedId = "";
    let firstRunWieldId = "";
    try {
        const first = await runtime.createInteractiveSession({ cwd, mode: "new" });
        const second = await runtime.createInteractiveSession({ cwd, mode: "new" });
        firstPersistedId = runtime.getSessionSnapshot(first.sessionId)?.sessionManagerId || "";
        firstRunWieldId = runtime.getSessionSnapshot(first.sessionId)?.managed?.runwieldSessionId || "";
        const secondPersistedId = runtime.getSessionSnapshot(second.sessionId)?.sessionManagerId;
        assert(firstPersistedId);
        assert(firstRunWieldId);
        assert(typeof secondPersistedId === "string");
        assert(firstPersistedId !== secondPersistedId);
    } finally {
        await runtime.closeAllSessionsWhenIdle();
    }

    const resumedRuntime = createSessionRuntime({ ownerProcessKind: "test" });
    try {
        const resumed = await resumedRuntime.createInteractiveSession({
            cwd,
            mode: "continue",
            resumeSessionId: firstRunWieldId,
        });

        assertEquals(resumedRuntime.getSessionSnapshot(resumed.sessionId)?.sessionManagerId, firstPersistedId);
        assertEquals(resumedRuntime.getSessionSnapshot(resumed.sessionId)?.managed?.runwieldSessionId, firstRunWieldId);
    } finally {
        await resumedRuntime.closeAllSessionsWhenIdle();
    }

    const transcriptIdRuntime = createSessionRuntime({ ownerProcessKind: "test" });
    try {
        const resumed = await transcriptIdRuntime.createInteractiveSession({
            cwd,
            mode: "continue",
            resumeSessionId: firstPersistedId,
        });

        assertEquals(transcriptIdRuntime.getSessionSnapshot(resumed.sessionId)?.sessionManagerId, firstPersistedId);
        assertEquals(
            transcriptIdRuntime.getSessionSnapshot(resumed.sessionId)?.managed?.runwieldSessionId,
            firstRunWieldId,
        );
    } finally {
        await transcriptIdRuntime.closeAllSessionsWhenIdle();
    }
});

Deno.test("SessionRuntime does not apply dormant local mutations when Session evidence is absent", async () => {
    const sessionHost = new SessionHost();
    const session = sessionHost.createSession({
        id: "managed-pending-agent",
        cwd: runtimeProjectRoot(),
        sessionManager: null,
        managed: {
            runwieldSessionId: "rw-pending-agent",
            projectId: "project-pending-agent",
            piSessionId: "pi-pending-agent",
            transcriptPath: `${runtimeProjectRoot()}/transcript.jsonl`,
            generation: 3,
            acknowledgedGeneration: 3,
            name: "Pending Agent",
            activeAgent: "router",
            workflowContext: null,
        },
    });
    const home = getHomeDir();
    const store = openOwnerCoordinationStore({
        dbPath: join(home, `owner-no-authority-${crypto.randomUUID()}.sqlite3`),
    });
    const runtime = new SessionRuntime({
        sessionHost,
        sessionStore: store,
        ownerProcessKind: "test",
        ownerInstanceId: crypto.randomUUID(),
    });
    /** @type {string[]} */
    const changedAgents = [];
    runtime.subscribeSessionEvents(session.id, (event) => {
        if (event.type === RuntimeEventTypes.AGENT_CHANGED) changedAgents.push(event.agentName);
    });

    assertEquals((await runtime.switchAgent(session.id, { agentName: "engineer" })).error, "refresh_required");
    assertEquals(
        (await runtime.reconfigureSessionModel(session.id, "gpt-next", "test-provider")).error,
        "refresh_required",
    );
    assertEquals((await runtime.setSessionThinkingLevel(session.id, "high")).error, "refresh_required");

    const snapshot = runtime.getSessionSnapshot(session.id);

    assertEquals(changedAgents, []);
    assertEquals(session.getPendingManagedTurnIntent(), {});
    assertEquals(snapshot?.activeAgent, "router");
    assertEquals(snapshot?.activeModel, { model: "", provider: "" });
    assertEquals(snapshot?.thinkingLevel, "off");
    store.close();
});

Deno.test("SessionRuntime keeps dormant managed projection separate from runtime authority", () => {
    const sessionHost = new SessionHost();
    const session = sessionHost.createSession({
        id: "managed-authority-separation",
        cwd: runtimeProjectRoot(),
        sessionManager: null,
        managed: {
            runwieldSessionId: "rw-authority-separation",
            projectId: "project-authority-separation",
            piSessionId: "pi-authority-separation",
            transcriptPath: `${runtimeProjectRoot()}/transcript.jsonl`,
            generation: 9,
            acknowledgedGeneration: 9,
            name: "Managed Authority Separation",
            activeAgent: "router",
            model: "cached-model",
            provider: "cached-provider",
            thinkingLevel: "medium",
            workflowContext: { routingIntent: "PLANNED_CHANGE", complexity: "LOW" },
        },
    });
    const runtime = makeRuntime({ sessionHost });

    assertEquals(runtime.isManagedSessionDormant(session.id), true);
    assertEquals(runtime.getRuntimeActiveAgentName(session.id), null);
    assertEquals(runtime.getEffectiveAgentName(session.id), "router");
    assertEquals(runtime.getRuntimeActiveExecutionWorkflow(session.id), null);
    assertEquals(runtime.getSessionSnapshot(session.id)?.activeAgent, "router");
    assertEquals(runtime.getSessionSnapshot(session.id)?.activeModel, {
        model: "cached-model",
        provider: "cached-provider",
    });
    assertEquals(runtime.getSessionSnapshot(session.id)?.thinkingLevel, "medium");
    assertEquals(runtime.getSessionSnapshot(session.id)?.workflowContext, {
        routingIntent: "PLANNED_CHANGE",
        complexity: "LOW",
    });

    assertEquals(session.getRootSessionManager?.(), null);

    assertEquals(runtime.getRuntimeActiveAgentName(session.id), null);
    assertEquals(runtime.getSessionSnapshot(session.id)?.activeAgent, "router");
});

Deno.test("SessionRuntime blocks dormant reload and compaction when Session evidence is absent", async () => {
    const sessionHost = new SessionHost();
    const session = sessionHost.createSession({
        id: "managed-reload-compact",
        cwd: runtimeProjectRoot(),
        sessionManager: null,
        managed: {
            runwieldSessionId: "rw-reload-compact",
            projectId: "project-reload-compact",
            piSessionId: "pi-reload-compact",
            transcriptPath: `${runtimeProjectRoot()}/transcript.jsonl`,
            generation: 3,
            acknowledgedGeneration: 3,
            name: "Managed Reload Compact",
            activeAgent: "router",
            workflowContext: null,
        },
    });
    const home = getHomeDir();
    const store = openOwnerCoordinationStore({ dbPath: join(home, `owner-no-reload-${crypto.randomUUID()}.sqlite3`) });
    const runtime = new SessionRuntime({
        sessionHost,
        sessionStore: store,
        ownerProcessKind: "test",
        ownerInstanceId: crypto.randomUUID(),
    });

    assertEquals((await runtime.reloadSession(session.id)).error, "refresh_required");
    assertEquals((await runtime.compactSession(session.id)).error, "refresh_required");
    store.close();
});

Deno.test("SessionRuntime reload preserves the canonical hidden-agent selection", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const cwd = runtimeProjectRoot();
    const sessionManager = SessionManager.create(cwd, getRunWieldSessionDir(cwd));
    const session = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd,
        sessionManager,
    });
    const customTool = {
        name: "slicer_finalize",
        label: "Finalize fixture",
        description: "Finalize child plans",
        parameters: { type: "object", properties: {} },
        execute: () =>
            Promise.resolve({
                content: [{ type: /** @type {const} */ ("text"), text: "ok" }],
                details: null,
            }),
    };
    await switchActiveAgent(session, {
        agentName: "slicer",
        subAgentDefinition: { id: SUBAGENTS.SLICER },
        customTools: [customTool],
        toolNames: ["slicer_finalize"],
        sessionManager: /** @type {any} */ (session.getRootSessionManager()),
    });

    assertEquals(await runtime.reloadSession(session.id), { ok: true });
    const rebuilt = getRootSessionRebuildOptions(session);
    assertEquals(rebuilt?.subAgentDefinition, { id: SUBAGENTS.SLICER });
    assertStrictEquals(rebuilt?.customTools?.[0], customTool);
    assertEquals(rebuilt?.toolNames?.includes("slicer_finalize"), true);
    assertEquals(session.getRootAgentName(), "slicer");
});

Deno.test("SessionRuntime emits the first user message before busy and persistence", async () => {
    ensureRuntimeModelFixture();
    const cwd = join(runtimeProjectRoot(), `first-message-order-${crypto.randomUUID()}`);
    await Deno.mkdir(cwd, { recursive: true });
    const runtime = createSessionRuntime({ sessionStore: null, ownerProcessKind: "test" });
    const created = await runtime.createInteractiveSession({
        cwd,
        mode: "new",
        deferManagedActivationUntilAgentReady: true,
    });
    /** @type {string[]} */
    const events = [];
    let userEventCount = 0;
    let presentationTurnRanBeforePersistence = false;
    let resolvePresentationTurn = () => {};
    const presentationTurn = new Promise((resolve) => {
        resolvePresentationTurn = () => resolve(undefined);
    });
    runtime.subscribeSessionEvents(created.sessionId, (event) => {
        if (event.type === RuntimeEventTypes.USER_MESSAGE) {
            userEventCount += 1;
            events.push(`user:${runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId || "none"}`);
        }
        if (event.type === RuntimeEventTypes.BUSY_CHANGED && event.busy) {
            events.push(`busy:${runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId || "none"}`);
            setTimeout(() => {
                presentationTurnRanBeforePersistence =
                    runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId === null;
                resolvePresentationTurn();
            }, 0);
        }
        if (event.type === RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED) {
            events.push(`sync:${runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId || "none"}`);
        }
    });
    try {
        runtime.markPromptReadyAgent(created.sessionId, { agentName: "router" });
        const result = await runtime.promptUserTurn(created.sessionId, {
            initialRequest: "hello",
        });
        assertEquals(result.ok, true);
        await presentationTurn;
        assertEquals(userEventCount, 1);
        assertEquals(events.slice(0, 2), ["user:none", "busy:none"]);
        assertEquals(presentationTurnRanBeforePersistence, true);
        assert(events.some((event) => event.startsWith("sync:")));
    } finally {
        await runtime.closeAllSessionsWhenIdle?.();
    }
});

Deno.test("SessionRuntime clean agent starts and switches resolve each agent preset model", async () => {
    await withRuntimeCommandFixture(
        "runtime-router-engineer-preset-",
        async ({ homeDir, projectRoot, settingsPath }) => {
            await Deno.writeTextFile(
                settingsPath,
                JSON.stringify({
                    activeModelPreset: "split-agents",
                    modelPresets: {
                        "split-agents": {
                            agents: {
                                router: { model: "runtime-command-fixture/router-model" },
                                engineer: { model: "runtime-command-fixture/engineer-model" },
                                guide: { model: "runtime-command-fixture/guide-model" },
                            },
                        },
                    },
                    notifications: { enabled: false },
                }),
            );
            await Deno.writeTextFile(
                `${homeDir}/.wld/models.json`,
                JSON.stringify({
                    providers: {
                        "runtime-command-fixture": {
                            name: "Runtime Command Fixture Provider",
                            baseUrl: "http://127.0.0.1:0",
                            apiKey: "fixture-key",
                            api: "runtime-command-faux",
                            models: [
                                {
                                    id: "router-model",
                                    name: "Router Model",
                                    api: "runtime-command-faux",
                                    input: ["text", "image"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                },
                                {
                                    id: "engineer-model",
                                    name: "Engineer Model",
                                    api: "runtime-command-faux",
                                    input: ["text", "image"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                },
                                {
                                    id: "guide-model",
                                    name: "Guide Model",
                                    api: "runtime-command-faux",
                                    input: ["text", "image"],
                                    contextWindow: 128000,
                                    maxTokens: 4096,
                                },
                            ],
                        },
                    },
                }),
            );
            const sessionHost = new SessionHost();
            const runtime = makeRuntime({ sessionHost });
            const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot });
            const hostedSession = sessionHost.getSession(sessionId);
            assert(hostedSession);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                provider: "runtime-command-fixture",
                model: "router-model",
            });

            const switched = await runtime.switchAgent(sessionId, { agentName: "engineer" });
            assertEquals(switched.ok, true);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                provider: "runtime-command-fixture",
                model: "engineer-model",
            });

            const guideSwitched = await runtime.switchAgent(sessionId, { agentName: "guide" });
            assertEquals(guideSwitched.ok, true);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                provider: "runtime-command-fixture",
                model: "guide-model",
            });
            await runtime.closeSession(sessionId);

            const directGuideSessionId = await runtime.createPromptReadySession({
                cwd: projectRoot,
                agentName: "guide",
            });
            assertEquals(runtime.getSessionSnapshot(directGuideSessionId)?.activeAgent, "guide");
            assertEquals(runtime.getSessionSnapshot(directGuideSessionId)?.activeModel, {
                provider: "runtime-command-fixture",
                model: "guide-model",
            });
            await runtime.closeSession(directGuideSessionId);
        },
    );
});

Deno.test("SessionRuntime prompt-ready metadata is limited to unpersisted new-session shells", async () => {
    ensureRuntimeModelFixture();
    const cwd = join(runtimeProjectRoot(), `prompt-ready-shell-${crypto.randomUUID()}`);
    await Deno.mkdir(cwd, { recursive: true });
    const runtime = createSessionRuntime({ sessionStore: null, ownerProcessKind: "test" });
    const created = await runtime.createInteractiveSession({
        cwd,
        mode: "new",
        deferManagedActivationUntilAgentReady: true,
    });
    try {
        assertEquals(runtime.markPromptReadyAgent(created.sessionId, { agentName: "router" }).ok, true);
        assertEquals(runtime.getSessionSnapshot(created.sessionId)?.activeAgent, "router");
        const result = await runtime.promptUserTurn(created.sessionId, { initialRequest: "hello" });
        assertEquals(result.ok, true);
        assertEquals(typeof runtime.getSessionSnapshot(created.sessionId)?.sessionManagerId, "string");
        assertEquals(runtime.markPromptReadyAgent(created.sessionId, { agentName: "guide" }), {
            ok: false,
            error: "not_unpersisted_new_session",
        });
    } finally {
        await runtime.closeAllSessionsWhenIdle?.();
    }
});

/**
 * @typedef {Object} ManagedModelTurnSample
 * @property {string | null | undefined} agent
 * @property {string} prompt
 * @property {string} model
 */

Deno.test("SessionRuntime releases managed activation after a completed TUI turn", async () => {
    await withRuntimeCommandFixture(
        "runtime-managed-turn-release-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const sessionHost = new SessionHost();
            const store = openFileSessionStore();
            const runtime = new SessionRuntime({
                sessionHost,
                sessionStore: store,
                ownsSessionStore: false,
                ownerProcessKind: "tui",
                ownerInstanceId: crypto.randomUUID(),
            });
            try {
                const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "guide" });
                const managed = runtime.getSessionSnapshot(sessionId)?.managed;
                assert(managed);
                const before = store.inspectSessionActivation(managed.runwieldSessionId);
                setModelResponseFactory(() => fauxAssistantMessage(fauxText("The TUI turn finished.")));

                const result = await runtime.promptUserTurn(sessionId, { initialRequest: "Continue from TUI." });

                assertEquals(result.ok, true);
                const inspected = store.inspectSessionActivation(managed.runwieldSessionId);
                assertEquals(inspected.activation?.state, "idle");
                assertEquals(inspected.generation?.generation, (before.generation?.generation ?? 0) + 1);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        },
    );
});

Deno.test("SessionRuntime managed operation prefers persisted active agent over stale catalog summary", async () => {
    await withRuntimeCommandFixture(
        "runtime-stale-agent-summary-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const sessionHost = new SessionHost();
            const runtime = new SessionRuntime({
                sessionHost,
                sessionStore: openFileSessionStore(),
                ownsSessionStore: true,
                ownerProcessKind: "test",
                ownerInstanceId: crypto.randomUUID(),
            });
            try {
                const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "guide" });
                const hosted = sessionHost.getSession(sessionId);
                assert(hosted);
                const managed = hosted.getManagedMetadata();
                assert(managed);
                hosted.setManagedMetadata({ ...managed, activeAgent: "router", model: "stale-router-model" });
                /** @type {ManagedModelTurnSample[]} */
                const turns = [];
                setModelResponseFactory((context, _options, _state, model) => {
                    turns.push({
                        agent: runtime.getSessionSnapshot(sessionId)?.activeAgent,
                        prompt: getCurrentSystemPrompt(context.messages),
                        model: model.id,
                    });
                    return fauxAssistantMessage(fauxText("The saved Guide handled this turn."));
                });
                const result = await runtime.promptUserTurn(sessionId, { initialRequest: "Continue explaining." });
                assertEquals(result.ok, true);
                assertEquals(turns.length, 1);
                assertEquals(turns[0].agent, "guide");
                assertEquals(turns[0].model, "fixture-model");
                assert(turns[0].prompt.includes("You are the Guide"));
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "guide");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});

Deno.test("SessionRuntime managed prompt acquires activation before writable hydration and publication", async () => {
    const source = await Deno.readTextFile(new URL("./runtime/managed-operations.ts", import.meta.url));
    const promptManagedIndex = source.indexOf("async runManagedOperation<T>(");
    const promptManagedBody = source.slice(promptManagedIndex);
    const inspectIndex = promptManagedBody.indexOf("inspectSessionActivation(managed.runwieldSessionId)");
    const acquireIndex = promptManagedBody.indexOf("acquireSessionActivation({", inspectIndex);
    const userMessageIndex = promptManagedBody.indexOf("type: RuntimeEventTypes.USER_MESSAGE", acquireIndex);
    const hydratedIndex = promptManagedBody.indexOf(
        'changeSessionActivationPhase(activeProof, "hydrated")',
        acquireIndex,
    );
    const openIndex = promptManagedBody.indexOf("await openPersistedRootSession({", hydratedIndex);
    const resumeAgentIndex = promptManagedBody.indexOf("await resolveResumeAgentName(sessionManager)", openIndex);
    const activateIndex = promptManagedBody.indexOf(
        "await this.settings.activateSessionAgent(hostedSession, {",
        resumeAgentIndex,
    );
    const promptIndex = promptManagedBody.indexOf(
        "async () => await body({ acceptedTurnId, hasPendingImages, capability }),",
        activateIndex,
    );
    const checkpointIndex = promptManagedBody.indexOf(
        'changeSessionActivationPhase(activeProof, "checkpointing")',
        promptIndex,
    );
    const publishIndex = promptManagedBody.indexOf("publishGenerationAndRelease(activeProof", checkpointIndex);
    const recoveryIndex = promptManagedBody.indexOf("markSessionUncertain(activeProof", publishIndex);

    assertEquals(promptManagedIndex >= 0, true);
    assertEquals(inspectIndex >= 0, true);
    assertEquals(acquireIndex > inspectIndex, true);
    assertEquals(userMessageIndex > acquireIndex, true);
    assertEquals(hydratedIndex > userMessageIndex, true);
    assertEquals(openIndex > hydratedIndex, true);
    assertEquals(resumeAgentIndex > openIndex, true);
    assertEquals(activateIndex > resumeAgentIndex, true);
    assertEquals(promptIndex > activateIndex, true);
    assertEquals(checkpointIndex > promptIndex, true);
    assertEquals(publishIndex > checkpointIndex, true);
    assertEquals(recoveryIndex > publishIndex, true);
});

/**
 * @typedef {Object} ManagedActivationSample
 * @property {string | undefined} state
 * @property {string | null | undefined} phase
 * @property {boolean} writable
 */

Deno.test("SessionRuntime managed workflow operations hold activation during model execution and publish afterward", async () => {
    await withRuntimeCommandFixture(
        "runtime-operation-publication-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const store = openFileSessionStore();
            const sessionHost = new SessionHost();
            const runtime = new SessionRuntime({
                sessionHost,
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: crypto.randomUUID(),
            });
            try {
                const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "guide" });
                const managed = sessionHost.getSession(sessionId)?.getManagedMetadata();
                assert(managed);
                /** @type {ManagedActivationSample[]} */
                const samples = [];
                setModelResponseFactory(() => {
                    const activation = store.inspectSessionActivation(managed.runwieldSessionId).activation;
                    samples.push({
                        state: activation?.state,
                        phase: activation?.phase,
                        writable: Boolean(sessionHost.getSession(sessionId)?.getRootSessionManager()),
                    });
                    return fauxAssistantMessage(fauxText("The isolated operation completed."));
                });
                await runtime.runIsolatedAgent(sessionId, { agentName: "guide", userRequest: "Inspect this project." });
                assertEquals(samples, [{ state: "active", phase: "turning", writable: true }]);
                const published = store.inspectSessionActivation(managed.runwieldSessionId);
                assertEquals(published.activation?.state, "idle");
                assertEquals(published.generation?.generation, (managed.generation ?? 0) + 1);
                assertEquals(published.generation?.byteLength, (await Deno.stat(managed.transcriptPath)).size);
                assertEquals(sessionHost.getSession(sessionId)?.getRootSessionManager(), null);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        },
    );
});

Deno.test("SessionRuntime persists tutorial context before the first model turn and restores it dormant", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const cwd = runtimeProjectRoot();
    let contextSeenByModel = null;
    setRuntimeModelResponseFactories([() => {
        const active = runtime.listSessions()[0];
        contextSeenByModel = active?.tutorialContext || null;
        return fauxAssistantMessage(fauxText("Tutorial context observed."));
    }]);
    const sessionId = await runtime.createPromptReadySession({ cwd, agentName: "guide" });
    const initialTutorialContext = {
        version: 1,
        guidanceEnabled: true,
        shownExplanationIds: ["welcome", "welcome"],
        recapShown: false,
        planId: null,
    };
    try {
        const first = await runtime.promptUserTurn(sessionId, {
            initialRequest: "Start the tutorial.",
            initialTutorialContext,
        });
        assertEquals(first.ok, true);
        assertEquals(contextSeenByModel, { ...initialTutorialContext, shownExplanationIds: ["welcome"] });
        assertEquals(runtime.getSessionSnapshot(sessionId)?.managed?.dormant, true);

        const rejected = await runtime.updateTutorialContext(sessionId, { planId: "plan-1" });
        assertEquals(rejected, { ok: false, error: "tutorial_context_plan_association_required" });
        const association = await runtime.recordPlanAssociation(sessionId, {
            planId: "plan-1",
            planName: "example-plan",
            purpose: "planning",
        });
        assertEquals(association.ok, true);
        const updated = await runtime.updateTutorialContext(sessionId, {
            guidanceEnabled: false,
            shownExplanationIds: ["welcome", "plans", "plans"],
            recapShown: true,
            planId: "plan-1",
        });
        assertEquals(updated.ok, true);
        assertEquals(updated.tutorialContext, {
            version: 1,
            guidanceEnabled: false,
            shownExplanationIds: ["welcome", "plans"],
            recapShown: true,
            planId: "plan-1",
        });
        const runwieldSessionId = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId;
        assert(runwieldSessionId);
        await runtime.closeAllSessions();

        const reloaded = makeRuntime();
        try {
            const loaded = await reloaded.createInteractiveSession({
                cwd,
                mode: "continue",
                resumeSessionId: runwieldSessionId,
            });
            assertEquals(reloaded.getSessionSnapshot(loaded.sessionId)?.managed?.dormant, true);
            assertEquals(reloaded.getSessionSnapshot(loaded.sessionId)?.tutorialContext, updated.tutorialContext);
            assertEquals(
                reloaded.getSessionSnapshot(loaded.sessionId)?.planAssociations?.map((entry) => entry.planId),
                ["plan-1"],
            );
        } finally {
            await reloaded.closeAllSessions();
        }
    } finally {
        await runtime.closeAllSessions();
    }
});

Deno.test("SessionRuntime uses one segmented user-turn submission path", async () => {
    setRuntimeModelMessages([fauxAssistantMessage(fauxText("Normalized request received."))]);
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    /** @type {string[]} */
    const userMessages = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.USER_MESSAGE) userMessages.push(event.text);
    });

    const result = await runtime.promptUserTurn(sessionId, {
        initialRequest: "  hello from editor  ",
        initialImages: [],
    });

    assertEquals(userMessages, ["  hello from editor  "]);
    assertEquals(result, {
        ok: true,
        turns: 1,
        managed: true,
        submittedRequest: "  hello from editor  ",
        restoreDraft: false,
        historyText: "hello from editor",
    });
});

Deno.test("SessionRuntime routes execution continuation input to the resolved Plan owner", async () => {
    setRuntimeModelMessages([fauxAssistantMessage(fauxText("Engineer continuation received."))]);
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    await runtime.switchAgent(sessionId, { agentName: "planner" });
    await runtime.setActiveExecutionWorkflow(sessionId, {
        planName: "p",
        triageMeta: { classification: "FEATURE" },
        executionAgent: "engineer",
        executionCwd: runtimeProjectRoot(),
        validationContinuation: true,
    });
    /** @type {string[]} */
    const changedAgents = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.AGENT_CHANGED) changedAgents.push(event.agentName);
    });

    const result = await runtime.promptUserTurn(sessionId, {
        initialRequest: "  continue  ",
        initialImages: [],
    });

    assertEquals(result.ok, true);
    // The workflow still records `engineer`; the user talks to Plan Engineer.
    assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "plan-engineer");
    // Restore activates the owner directly, without an intermediate stale Planner activation.
    assertEquals(changedAgents, ["plan-engineer"]);
});

Deno.test("SessionRuntime keeps the next Epic decomposition reply with Slicer", async () => {
    const projectRoot = join(runtimeProjectRoot(), `slicer-resume-${crypto.randomUUID()}`);
    await Deno.mkdir(projectRoot, { recursive: true });
    await savePlan(projectRoot, "epic-a", "# Epic A", {
        classification: "PROJECT",
        complexity: "HIGH",
        summary: "Epic A",
        affectedPaths: ["src/epic.ts"],
        status: "ready_for_decomposition",
    });
    let resumedSystemPrompt = "";
    const resumedToolNames = new Set([""]);
    resumedToolNames.clear();
    setRuntimeModelResponseFactories([
        () => fauxAssistantMessage(fauxText("I recommend two child Plans. Should I finalize them?")),
        (context) => {
            resumedSystemPrompt = getCurrentSystemPrompt(context.messages);
            for (const tool of getCurrentTools(context.messages)) resumedToolNames.add(tool.name);
            return fauxAssistantMessage(fauxText("I will keep refining this Epic decomposition."));
        },
    ]);
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "architect" });

    try {
        const slicerResult = await runtime.runSlicerAgent(sessionId, { planName: "epic-a" });
        assertEquals(slicerResult, { ok: true });
        assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "slicer");

        const replyResult = await runtime.promptUserTurn(sessionId, {
            initialRequest: "Yes; use epic-base as the shared branch and finalize the children.",
            initialImages: [],
        });

        assertEquals(replyResult.ok, true);
        assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "slicer");
        assertEquals(resumedSystemPrompt.includes("You are the Slicer"), true);
        assertEquals(resumedToolNames.has("slicer_finalize_decomposition"), true);
    } finally {
        await runtime.closeSession(sessionId);
    }
});

Deno.test("SessionRuntime owns managed submission blocking messages", () => {
    const sessionHost = new SessionHost();
    const session = sessionHost.createSession({
        id: "managed-submission-block",
        cwd: runtimeProjectRoot(),
        sessionManager: null,
        managed: {
            runwieldSessionId: "rw-managed-submission-block",
            projectId: "project-managed-submission-block",
            piSessionId: "pi-managed-submission-block",
            transcriptPath: `${runtimeProjectRoot()}/transcript.jsonl`,
            generation: 2,
            acknowledgedGeneration: 2,
            name: "Managed Submission Block",
            activeAgent: "router",
            workflowContext: null,
            syncState: {
                type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
                status: "active_elsewhere",
                localGeneration: 2,
                latestGeneration: 2,
                owningSurfaceKind: "workspace",
            },
        },
    });
    const runtime = makeRuntime({ sessionHost });

    assertEquals(
        runtime.getUserTurnSubmissionBlockMessage(session.id),
        "This conversation is still running in RunWield Workspace. Continue there, or wait for its current turn to finish before sending here.",
    );

    session.setManagedMetadata({
        .../** @type {NonNullable<ReturnType<typeof session.getManagedMetadata>>} */ (session.getManagedMetadata()),
        syncState: {
            type: RuntimeEventTypes.MANAGED_SYNC_STATE_CHANGED,
            status: "degraded",
            localGeneration: 2,
            latestGeneration: 3,
            message: "Refresh failed.",
        },
    });

    assertEquals(runtime.getUserTurnSubmissionBlockMessage(session.id), "Refresh failed.");
});

Deno.test("SessionRuntime projects an empty context report before an Agent is selected", async () => {
    const runtime = makeRuntime();
    const { sessionId } = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });
    assertEquals((await runtime.getSessionContextReport(sessionId))?.usedTokens, 0);
});

Deno.test("SessionRuntime projects active Agent Session context without exposing internals", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "engineer" });

    const report = await runtime.getSessionContextReport(sessionId);
    assertEquals(report?.agentDisplayName, "Engineer");
    assertEquals(report?.provider, RUNTIME_TEST_PROVIDER);
    assertEquals(report?.model, RUNTIME_TEST_MODEL);
    assertEquals(report?.usageState, "estimated");
    assertEquals(report?.staticTokens, 0);
    assertEquals(report?.activeMessageTokens, 0);
    assertEquals(JSON.stringify(report).includes("systemPrompt"), false);
});

Deno.test("SessionRuntime uses one activation transaction for initial readiness and later switches", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    const hostedSession = sessionHost.requireSession(sessionId);
    assertEquals(hostedSession.getRootAgentName(), null);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "router");
    assertEquals(hostedSession.getRootSessionManager(), null);

    /** @type {string[]} */
    const changedAgents = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.AGENT_CHANGED) changedAgents.push(event.agentName);
    });
    await runtime.switchAgent(sessionId, { agentName: "operator" });

    assertEquals(hostedSession.getRootAgentName(), null);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "operator");
    assertEquals(hostedSession.getRootSessionManager(), null);
    assertEquals(changedAgents, ["operator"]);
});

Deno.test("SessionRuntime snapshots and events keep workflow footer context separate from execution state", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const hostedSession = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd: runtimeProjectRoot(),
        sessionManager: null,
    });
    const sessionId = hostedSession.id;
    /** @type {any[]} */
    const events = [];
    /** @param {import('./session-runtime-events.js').SessionRuntimeEvent} event */
    const captureEvent = (event) => events.push(event);
    hostedSession.setEventSink({ emit: captureEvent });

    hostedSession.setWorkflowTriageContext({ routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM" });
    hostedSession.setWorkflowPlanName("docs/plans/footer-restoration.md");
    await runtime.setActiveExecutionWorkflow(sessionId, {
        planName: "execution-plan",
        triageMeta: { complexity: "HIGH" },
        executionAgent: "frontend-engineer",
        collaborationRecommendation: "pair",
        collaborationStyle: "pair",
        pairCheckpointCount: 2,
        executionCwd: runtimeProjectRoot(),
    });

    const snapshot = runtime.getSessionSnapshot(sessionId);
    assertEquals(snapshot?.workflowContext, {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "footer-restoration",
    });
    assertEquals(snapshot?.activeExecutionWorkflow, {
        planName: "execution-plan",
        triageMeta: { complexity: "HIGH" },
        executionAgent: "frontend-engineer",
        collaborationRecommendation: "pair",
        collaborationStyle: "pair",
        pairCheckpointCount: 2,
        executionCwd: runtimeProjectRoot(),
    });
    assertEquals(snapshot?.activeExecutionWorkflow === hostedSession.getActiveExecutionWorkflow(), false);
    assertEquals("workflow" in /** @type {Record<string, unknown>} */ (snapshot || {}), false);
    assertEquals(
        events.filter((event) => event.type === RuntimeEventTypes.WORKFLOW_CONTEXT_CHANGED)
            .map((event) => event.workflowContext),
        [
            { routingIntent: "PLANNED_CHANGE", complexity: "MEDIUM" },
            {
                routingIntent: "PLANNED_CHANGE",
                complexity: "MEDIUM",
                planName: "footer-restoration",
            },
        ],
    );
});

Deno.test("SessionRuntime emits one keyboard-help event for the requested session", async () => {
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    /** @type {any[]} */
    const events = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        events.push(event);
    });

    const result = runtime.requestSessionHelp(sessionId);
    const missing = runtime.requestSessionHelp("missing-session");

    assertEquals(result, { ok: true });
    assertEquals(missing, { ok: false, error: "not_found" });
    assertEquals(events.length, 1);
    assertEquals(events[0].type, RuntimeEventTypes.KEYBOARD_HELP);
    assertEquals(events[0].sessionId, sessionId);
    assertEquals(typeof events[0].timestamp, "string");
    assertEquals(events[0].title, "Keyboard shortcuts");
    assertEquals(events[0].items[0], { key: "esc", description: "to interrupt" });
});

Deno.test("SessionRuntime emits one ordered lifecycle for one prompt", async () => {
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    /** @type {any[]} */
    const events = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        events.push(event);
    });

    const result = await runtime.promptSession(sessionId, { initialRequest: "hello", initialImages: [] });

    assertEquals(result, { ok: true, turns: 1 });
    const eventTypes = events.map((event) => event.type);
    assertEquals(eventTypes.slice(0, 3), [
        RuntimeEventTypes.BUSY_CHANGED,
        RuntimeEventTypes.USER_MESSAGE,
        RuntimeEventTypes.TURN_START,
    ]);
    assertEquals(eventTypes.at(-1), RuntimeEventTypes.BUSY_CHANGED);
    assertEquals(events.at(-1)?.busy, false);
    assertEquals(eventTypes.filter((type) => type === RuntimeEventTypes.TURN_START).length, 2);
    assertEquals(eventTypes.filter((type) => type === RuntimeEventTypes.TURN_END).length, 2);
    assertEquals(eventTypes.filter((type) => type === RuntimeEventTypes.USAGE).length, 1);
    assertEquals(eventTypes.filter((type) => type === RuntimeEventTypes.ATTENTION_REQUESTED).length, 1);
    assertEquals(eventTypes.filter((type) => type === RuntimeEventTypes.ASSISTANT_TEXT_DELTA).length > 0, true);
    assertEquals(events.filter((event) => event.type === RuntimeEventTypes.USER_MESSAGE).length, 1);
    assertEquals(events.every((event) => event.sessionId === sessionId), true);
});

Deno.test("SessionRuntime persists pending prompt images once a live manager exists", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await Deno.makeTempDir({ prefix: "runwield-runtime-pending-image-" });
        Deno.env.set("HOME", home);
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        const runtime = makeRuntime();
        try {
            const sessionId = await runtime.createPromptReadySession({ cwd });
            /** @type {any[]} */
            const events = [];
            runtime.subscribeSessionEvents(sessionId, (event) => {
                events.push(event);
            });

            const result = await runtime.promptSession(sessionId, {
                initialRequest: "look",
                initialImages: [{ base64: btoa("img"), mimeType: "image/png" }],
            });

            assertEquals(result.ok, true);
            const userEvent = events.find((event) => event.type === RuntimeEventTypes.USER_MESSAGE);
            const eventImage = userEvent?.images?.[0];
            assertEquals(eventImage?.ref?.startsWith("attachment:"), true);
            assertEquals(new TextDecoder().decode(await Deno.readFile(eventImage.path)), "img");
        } finally {
            Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
});

Deno.test("SessionRuntime keeps executePlan workflow operations busy while preparation runs", async () => {
    await withRuntimeCommandFixture(
        "runtime-execute-busy-",
        async ({ projectRoot: cwd, setModelResponseFactory }) => {
            const runtime = createSessionRuntime();
            /** @type {() => void} */
            let releaseEngineerTurn = () => {};
            const engineerTurnReleased = new Promise((resolve) => {
                releaseEngineerTurn = /** @type {() => void} */ (resolve);
            });
            setModelResponseFactory(async () => {
                await engineerTurnReleased;
                return fauxAssistantMessage(fauxText("Execution remains paused in the fixture."));
            });
            const planName = "execute-busy-plan";
            await savePlan(cwd, planName, `# ${planName}`, {
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
                summary: planName,
                affectedPaths: [],
                planId: "execute-busy-plan-id",
            });
            // Exercise the real persisted-consent path against the fixture HOME. This keeps
            // the test on the non-Git execution branch without replacing workflow machinery
            // or opening an interactive prompt.
            await rememberNonGitExecutionConsent("featurePlan", cwd);
            const approvalEvidence = await loadPlanActionEvidence(cwd, "execute-busy-plan-id");
            if (approvalEvidence.kind !== "success") throw new Error(approvalEvidence.message);
            const sessionId = await runtime.createPromptReadySession({ cwd });
            /** @type {boolean[]} */
            const busyStates = [];
            /** @type {RuntimePreparationBusySample[]} */
            const preparationMessages = [];
            /** @type {() => void} */
            let resolveLaunchSeen = () => {};
            const launchSeen = new Promise((resolve) => {
                resolveLaunchSeen = /** @type {() => void} */ (resolve);
            });
            runtime.subscribeSessionEvents(sessionId, (event) => {
                if (event.type === RuntimeEventTypes.BUSY_CHANGED) busyStates.push(event.busy);
                if ("message" in event && typeof event.message === "string") {
                    if (
                        event.message.includes("Preparing the implementation target") ||
                        event.message.includes("Preparing in-place work because Git is unavailable") ||
                        event.message.includes("Marking the Plan as in progress") ||
                        event.message.includes("Starting Plan Engineer")
                    ) {
                        preparationMessages.push({
                            message: event.message,
                            busy: runtime.getSessionSnapshot(sessionId)?.busy,
                        });
                    }
                    if (event.message.includes("Starting Plan Engineer")) resolveLaunchSeen();
                }
            });

            const execution = runtime.executePlan(sessionId, {
                planName,
                triageMeta: {
                    planId: "execute-busy-plan-id",
                    classification: "PLANNED_CHANGE",
                    revision: approvalEvidence.evidence.revision,
                    status: approvalEvidence.evidence.status,
                    worktree: approvalEvidence.evidence.worktree,
                },
            });

            const preparation = await Promise.race([
                launchSeen.then(() => ({ kind: "launched" })),
                execution.then((result) => ({ kind: "completed", result })),
            ]);
            if (preparation.kind === "completed" && "result" in preparation) {
                throw new Error(`Execution completed before Engineer launch: ${JSON.stringify(preparation.result)}`);
            }
            assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, true);
            releaseEngineerTurn();
            await execution;

            assertEquals(busyStates, [true, false]);
            assertEquals(preparationMessages.map((entry) => entry.message), [
                "Preparing the implementation target...",
                "Preparing in-place work because Git is unavailable...",
                "Marking the Plan as in progress...",
                "Starting Plan Engineer...",
            ]);
            assertEquals(preparationMessages.map((entry) => entry.busy), [true, true, true, true]);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, false);
            runtime.closeAllSessions();
        },
    );
});

Deno.test("SessionRuntime keeps direct model operations busy until the outermost operation settles", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    /** @type {Array<() => void>} */
    const releases = [];
    agentSession.compact = () =>
        new Promise((resolve) => {
            releases.push(() => resolve({ ok: true }));
        });
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    /** @type {boolean[]} */
    const busyStates = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.BUSY_CHANGED) busyStates.push(event.busy);
    });

    const first = runtime.compactSession(sessionId);
    const second = runtime.compactSession(sessionId);
    assertEquals(releases.length, 2);
    assertEquals(busyStates, [true]);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, true);

    releases[0]();
    await first;
    assertEquals(busyStates, [true]);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, true);

    releases[1]();
    await second;
    assertEquals(busyStates, [true, false]);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, false);
});

Deno.test("SessionRuntime cycles through max thinking level", async () => {
    const runtime = makeRuntime();
    const { sessionId } = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });
    await runtime.setSessionThinkingLevel(sessionId, "xhigh");

    const result = await runtime.cycleSessionThinkingLevel(sessionId);

    assertEquals(result, { ok: true, thinkingLevel: "max" });
    assertEquals(runtime.getSessionSnapshot(sessionId)?.thinkingLevel, "max");
});

Deno.test("SessionRuntime event subscriptions unsubscribe deterministically", async () => {
    const runtime = makeRuntime();
    const { sessionId } = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });
    /** @type {any[]} */
    const events = [];
    const unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
        events.push(event);
    });

    await runtime.setSessionThinkingLevel(sessionId, "low");
    unsubscribe();
    await runtime.setSessionThinkingLevel(sessionId, "medium");

    assertEquals(
        events.filter((event) => event.type === RuntimeEventTypes.THINKING_LEVEL_CHANGED)
            .map((event) => event.thinkingLevel),
        ["low"],
    );
});

Deno.test("SessionRuntime owns the complete local shell tool lifecycle", async () => {
    const runtime = makeRuntime();
    const { sessionId } = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });
    /** @type {any[]} */
    const events = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        events.push(event);
    });

    const result = await runtime.runLocalShellCommand(sessionId, {
        command: "printf runtime-shell",
        userRequest: "!printf runtime-shell",
        persist: true,
    });

    assertEquals(result.ok, true);
    assertEquals(result.output, "runtime-shell");
    assertEquals(events.find((event) => event.type === RuntimeEventTypes.USER_MESSAGE)?.text, "!printf runtime-shell");
    assertEquals(events.find((event) => event.type === RuntimeEventTypes.TOOL_START)?.title, "! printf runtime-shell");
    assertEquals(events.filter((event) => event.type === RuntimeEventTypes.TOOL_START).length, 1);
    assertEquals(events.filter((event) => event.type === RuntimeEventTypes.TOOL_END).length, 1);
    assertEquals(events.find((event) => event.type === RuntimeEventTypes.TOOL_END)?.output, "runtime-shell");
});

Deno.test("SessionRuntime persists local shell commands as bash execution messages visible to LLM context", async () => {
    setRuntimeModelMessages([fauxAssistantMessage(fauxText("Initial fixture turn."))]);
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    await runtime.promptSession(sessionId, { initialRequest: "start", initialImages: [] });

    await runtime.runLocalShellCommand(sessionId, {
        command: "printf visible-shell",
        userRequest: "!printf visible-shell",
        persist: true,
    });
    let nextTurnContext = "";
    setRuntimeModelResponseFactories([(context) => {
        nextTurnContext = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxText("Observed the shell result."));
    }]);
    await runtime.promptSession(sessionId, { initialRequest: "what happened?", initialImages: [] });

    assertEquals(nextTurnContext.includes("visible-shell"), true);
});

Deno.test("SessionRuntime cancellation terminates an active local shell command", async () => {
    const runtime = makeRuntime();
    const { sessionId } = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });
    let resolveStarted = () => {};
    const started = new Promise((resolve) => {
        resolveStarted = () => resolve(undefined);
    });
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.TOOL_START) resolveStarted();
    });

    const command = runtime.runLocalShellCommand(sessionId, { command: "sleep 5", persist: false });
    await started;
    runtime.cancelSession(sessionId);
    const result = await command;

    assertEquals(result.canceled, true);
    assertEquals(result.exitCode, 130);
});

Deno.test({
    name: "SessionRuntime cancellation kills the local shell command's descendant processes",
    ignore: Deno.build.os === "windows",
    fn: async () => {
        const runtime = makeRuntime();
        const { sessionId } = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });
        const pidFile = await Deno.makeTempFile({ prefix: "runwield-local-shell-descendant-" });
        let resolveStarted = () => {};
        const started = new Promise((resolve) => {
            resolveStarted = () => resolve(undefined);
        });
        runtime.subscribeSessionEvents(sessionId, (event) => {
            if (event.type === RuntimeEventTypes.TOOL_START) resolveStarted();
        });

        const command = runtime.runLocalShellCommand(sessionId, {
            command: `sleep 30 & echo $! > ${pidFile}; wait`,
            persist: false,
        });
        await started;
        let descendantPid = 0;
        while (!descendantPid) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            descendantPid = Number((await Deno.readTextFile(pidFile)).trim()) || 0;
        }
        runtime.cancelSession(sessionId);
        const result = await command;

        const descendantDead = await waitForProcessDeath(descendantPid);
        if (!descendantDead) Deno.kill(descendantPid, "SIGKILL");
        await Deno.remove(pidFile).catch(() => {});

        assertEquals(result.canceled, true);
        assertEquals(result.exitCode, 130);
        assertEquals(
            descendantDead,
            true,
            "cancellation must kill the wrapper shell's descendants, not only the wrapper",
        );
    },
});

Deno.test("SessionRuntime publishes handler errors and releases the turn", async () => {
    setRuntimeModelResponseFactories([() => {
        throw new Error("boom");
    }]);
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    /** @type {string[]} */
    const types = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        types.push(event.type);
    });

    const result = await runtime.promptSession(sessionId, { initialRequest: "fail", initialImages: [] });

    assertEquals(result.ok, true);
    assertEquals(types.includes(RuntimeEventTypes.TERMINAL_ERROR), true);
    assertEquals(types.at(-1), RuntimeEventTypes.BUSY_CHANGED);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, false);
});

Deno.test("SessionRuntime rejects overlapping turns for one id", async () => {
    /** @type {() => void} */
    let release = () => {};
    const released = new Promise((resolve) => {
        release = () => resolve(undefined);
    });
    /** @type {() => void} */
    let markStarted = () => {};
    const started = new Promise((resolve) => {
        markStarted = () => resolve(undefined);
    });
    setRuntimeModelResponseFactories([async () => {
        markStarted();
        await released;
        return fauxAssistantMessage(fauxText("Released."));
    }]);
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });

    const first = runtime.promptSession(sessionId, { initialRequest: "first", initialImages: [] });
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    try {
        await Promise.race([
            started,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error("The first model turn did not start")), 10000);
            }),
        ]);
        assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, true);
        await assertRejects(
            () => runtime.promptSession(sessionId, { initialRequest: "second", initialImages: [] }),
            SessionTurnInProgressError,
            "already has an active turn",
        );
    } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        release();
        await first;
        assertEquals(runtime.getSessionSnapshot(sessionId)?.busy, false);
        await runtime.closeAllSessionsWhenIdle();
    }
});

Deno.test("SessionRuntime allows independent session ids to run concurrently", async () => {
    /** @type {() => void} */
    let releaseResponses = () => {};
    const released = new Promise((resolve) => {
        releaseResponses = () => resolve(undefined);
    });
    /** @type {() => void} */
    let markBothStarted = () => {};
    const bothStarted = new Promise((resolve) => {
        markBothStarted = () => resolve(undefined);
    });
    let startedCount = 0;
    setRuntimeModelResponseFactories(["Alpha.", "Beta."].map((text) => async () => {
        startedCount++;
        if (startedCount === 2) markBothStarted();
        await released;
        return fauxAssistantMessage(fauxText(text));
    }));
    const runtime = makeRuntime();
    const alpha = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    const beta = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });

    const prompts = [
        runtime.promptSession(alpha, { initialRequest: "alpha", initialImages: [] }),
        runtime.promptSession(beta, { initialRequest: "beta", initialImages: [] }),
    ];
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    try {
        await Promise.race([
            bothStarted,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error("Both model turns did not start concurrently")), 10000);
            }),
        ]);
        assertEquals(runtime.getSessionSnapshot(alpha)?.busy, true);
        assertEquals(runtime.getSessionSnapshot(beta)?.busy, true);
    } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        // A shared gate also releases a late-starting response on failure.
        releaseResponses();
        await Promise.all(prompts);
        await runtime.closeAllSessionsWhenIdle();
    }
    assertEquals((await Promise.all(prompts)).map((result) => result.ok), [true, true]);
});

Deno.test("SessionRuntime /reload publishes replacement Prompt Template and Skill catalogs", async () => {
    await withRuntimeCommandFixture("runtime-reload-catalogs-", async ({ projectRoot, setModelResponseFactory }) => {
        const promptDir = join(projectRoot, ".wld", "prompts");
        const skillRoot = join(projectRoot, ".wld", "skills");
        const changedSkillDir = join(skillRoot, "reload-fixture");
        const removedSkillDir = join(skillRoot, "removed-fixture");
        await Deno.mkdir(promptDir, { recursive: true });
        await Deno.mkdir(changedSkillDir, { recursive: true });
        await Deno.mkdir(removedSkillDir, { recursive: true });
        await Deno.writeTextFile(
            join(promptDir, "reload-prompt.md"),
            ["---", 'description: "before reload"', "---", "before body"].join("\n"),
        );
        await Deno.writeTextFile(
            join(changedSkillDir, "SKILL.md"),
            ["---", 'name: "reload-fixture"', 'description: "before skill"', "---", "before skill body"].join("\n"),
        );
        await Deno.writeTextFile(
            join(removedSkillDir, "SKILL.md"),
            ["---", 'name: "removed-fixture"', 'description: "remove me"', "---", "removed skill body"].join("\n"),
        );
        /** @type {string[]} */
        const modelRequests = [];
        setModelResponseFactory((context) => {
            modelRequests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxText("Ready."));
        });
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        /** @type {Array<import('./session-runtime-events.js').SessionRuntimeEvent>} */
        const catalogEvents = [];
        runtime.subscribeSessionEvents(created.sessionId, (event) => {
            if (event.type === RuntimeEventTypes.COMMAND_CATALOG_CHANGED) catalogEvents.push(event);
        });

        await Deno.writeTextFile(
            join(promptDir, "reload-prompt.md"),
            ["---", 'description: "after reload"', "---", "after body"].join("\n"),
        );
        await Deno.writeTextFile(
            join(promptDir, "added-prompt.md"),
            ["---", 'description: "added prompt"', "---", "added body"].join("\n"),
        );
        await Deno.writeTextFile(
            join(changedSkillDir, "SKILL.md"),
            ["---", 'name: "reload-fixture"', 'description: "after skill"', "---", "after skill body"].join("\n"),
        );
        await Deno.remove(removedSkillDir, { recursive: true });

        assertEquals(await runtime.reloadSession(created.sessionId), { ok: true });
        assertEquals(catalogEvents.length, 1);
        const catalogEvent =
            /** @type {import('./session-runtime-events.js').RuntimeCommandCatalogChangedEvent} */ (catalogEvents[0]);
        assertEquals(
            catalogEvent.promptTemplates.find((template) => template.name === "reload-prompt")?.description,
            "after reload",
        );
        assertEquals(catalogEvent.promptTemplates.some((template) => template.name === "added-prompt"), true);
        assertEquals(catalogEvent.skills.find((skill) => skill.name === "reload-fixture")?.description, "after skill");
        assertEquals(catalogEvent.skills.some((skill) => skill.name === "removed-fixture"), false);
        assertEquals(await runtime.expandSessionPromptTemplate(join(promptDir, "reload-prompt.md")), "after body");
        await assertRejects(
            () => runtime.expandSessionSkillCommand(created.sessionId, "removed-fixture"),
            Error,
            "Unknown skill: removed-fixture",
        );

        await runtime.promptUserTurn(created.sessionId, {
            initialRequest: "/skill:reload-fixture use the changed body",
            initialImages: [],
        });
        assertStringIncludes(modelRequests[0] || "", "after skill body");
        assertStringIncludes(modelRequests[0] || "", "use the changed body");
        runtime.closeAllSessions();
    });
});

Deno.test("SessionRuntime ignores synthetic switch-requesting tool results", async () => {
    setRuntimeModelMessages([
        fauxAssistantMessage(fauxToolCall("synthetic_switch_request", {})),
        fauxAssistantMessage(fauxText("Still working as Engineer.")),
    ]);
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "engineer" });
    const syntheticSwitchTool = {
        name: "synthetic_switch_request",
        label: "Synthetic Switch Request",
        description: "Return a synthetic tool result that asks the runtime to switch agents.",
        parameters: { type: "object", properties: {} },
        execute: () =>
            Promise.resolve({
                content: [{ type: /** @type {const} */ ("text"), text: "Switch to Router now." }],
                details: { outcome: "switch_agent", agentName: "router" },
            }),
    };
    await runtime.switchAgent(sessionId, {
        agentName: "engineer",
        customTools: [syntheticSwitchTool],
        toolNames: ["synthetic_switch_request"],
    });
    /** @type {string[]} */
    const submittedMessages = [];
    /** @type {string[]} */
    const changedAgents = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.USER_MESSAGE) submittedMessages.push(event.text);
        if (event.type === RuntimeEventTypes.AGENT_CHANGED) changedAgents.push(event.agentName);
    });
    const activeAgentBefore = runtime.getSessionSnapshot(sessionId)?.activeAgent;

    const result = await runtime.promptUserTurn(sessionId, { initialRequest: "fix this", initialImages: [] });

    assertEquals(result.ok, true);
    assertEquals(result.turns, 1);
    assertEquals(submittedMessages, ["fix this"]);
    assertEquals(changedAgents.filter((agentName) => agentName !== "engineer"), []);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, activeAgentBefore);
});

Deno.test("SessionRuntime delivers steering submitted from the Triage report to Planner once", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    /** @type {HandoffProviderRequest[]} */
    const providerRequests = [];
    /** @param {import('@earendil-works/pi-ai').Context} context */
    const response = (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        const messages = JSON.stringify(context.messages);
        const imageCount = context.messages.reduce(
            (count, message) =>
                count +
                (Array.isArray(message.content) ? message.content.filter((block) => block.type === "image").length : 0),
            0,
        );
        const agentName = tools.includes("triage_report")
            ? "router"
            : tools.includes("plan_written")
            ? "planner"
            : "other";
        providerRequests.push({ agentName, messages, imageCount });
        if (agentName === "router") {
            return fauxAssistantMessage(fauxToolCall("triage_report", {
                routingIntent: "PLANNED_CHANGE",
                workKind: "BUG_FIX",
                complexity: "MEDIUM",
                summary: "Fix the steering handoff race.",
                sessionName: "Fix steering handoff",
            }));
        }
        return fauxAssistantMessage(fauxText("Planner received the handoff."));
    };
    setRuntimeModelResponseFactories(Array.from({ length: 6 }, () => response));
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    /** @type {import('./session-runtime-events.js').SessionRuntimeEvent[]} */
    const runtimeEvents = [];
    /** @type {Promise<SteeringResult> | null} */
    let steeringSubmission = null;
    /** @type {Promise<SteeringResult> | null} */
    let plannerSteeringSubmission = null;
    runtime.subscribeSessionEvents(sessionId, (event) => {
        runtimeEvents.push(event);
        if (
            !steeringSubmission && event.type === RuntimeEventTypes.SYSTEM_STATUS &&
            event.header === "Triage"
        ) {
            steeringSubmission = runtime.steerSession(
                sessionId,
                "Keep the reproduction deterministic.",
                [{ base64: RUNTIME_TEST_PNG, mimeType: "image/png" }],
                "tui",
            );
        }
        if (
            !plannerSteeringSubmission && event.type === RuntimeEventTypes.AGENT_CHANGED &&
            event.agentName === "planner"
        ) {
            plannerSteeringSubmission = runtime.steerSession(
                sessionId,
                "Include the switch-boundary case.",
                [],
                "workspace",
            );
        }
    });

    const result = await runtime.promptUserTurn(sessionId, {
        initialRequest: "Fix steering across Agent handoffs.",
        initialImages: [],
    });
    assertExists(steeringSubmission);
    assertExists(plannerSteeringSubmission);
    const steered = await /** @type {Promise<SteeringResult>} */ (steeringSubmission);
    const plannerSteered = await /** @type {Promise<SteeringResult>} */ (plannerSteeringSubmission);

    assertEquals(result.ok, true);
    assertEquals(steered.queued, true);
    assertEquals(plannerSteered.queued, true);
    assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "planner");
    assertEquals(
        providerRequests.filter((request) => request.agentName === "router").length,
        1,
        "Router must not continue after its accepted Triage report",
    );
    const plannerRequests = providerRequests.filter((request) => request.agentName === "planner");
    assertEquals(plannerRequests.length, 1);
    assertStringIncludes(plannerRequests[0].messages, "Keep the reproduction deterministic.");
    assertStringIncludes(plannerRequests[0].messages, "Include the switch-boundary case.");
    assertEquals(plannerRequests[0].imageCount, 1);
    assertEquals(
        runtimeEvents.filter((event) => event.type === RuntimeEventTypes.AGENT_CHANGED && event.agentName === "planner")
            .length,
        1,
    );
    assertEquals(
        runtimeEvents.filter((event) => event.type === RuntimeEventTypes.SYSTEM_STATUS && event.header === "Triage")
            .length,
        1,
    );
    const hostedSession = sessionHost.requireSession(sessionId);
    const transcriptPath = hostedSession.getManagedMetadata()?.transcriptPath;
    assertExists(transcriptPath);
    const transcriptEntries = (await Deno.readTextFile(transcriptPath)).trim().split("\n").map((line) =>
        JSON.parse(line)
    );
    assertEquals(
        transcriptEntries.filter((entry) =>
            entry.type === "custom" && entry.customType === WORKFLOW_TOOL_EVENT_CUSTOM_TYPE &&
            entry.data?.state === "accepted" && entry.data?.kind === "triage_report"
        ).length,
        1,
    );
    const deliveredSteering = /** @type {import('./session-runtime-events.js').RuntimeUserMessageEvent[]} */ (
        runtimeEvents.filter((event) =>
            event.type === RuntimeEventTypes.USER_MESSAGE &&
            [steered.message?.id, plannerSteered.message?.id].includes(event.messageId)
        )
    );
    assertEquals(deliveredSteering.length, 2);
    const imageSteeringEvent = deliveredSteering.find((event) => event.messageId === steered.message?.id);
    assertExists(imageSteeringEvent);
    assertEquals(
        /** @type {import('./session-runtime-events.js').RuntimeUserMessageEvent} */ (imageSteeringEvent).images.length,
        1,
    );
    assertEquals(runtime.getQueuedMessages(sessionId), []);
    await runtime.closeAllSessionsWhenIdle();
});

Deno.test("SessionRuntime transfers pending Router steering to Planner in submission order", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const routerResponseStarted = deferredVoid();
    const releaseRouterResponse = deferredVoid();
    /** @type {HandoffProviderRequest[]} */
    const providerRequests = [];
    /** @param {import('@earendil-works/pi-ai').Context} context */
    const response = async (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        const messages = JSON.stringify(context.messages);
        const imageCount = context.messages.reduce(
            (count, message) =>
                count +
                (Array.isArray(message.content) ? message.content.filter((block) => block.type === "image").length : 0),
            0,
        );
        const agentName = tools.includes("triage_report") ? "router" : "planner";
        providerRequests.push({ agentName, messages, imageCount });
        if (agentName === "router") {
            routerResponseStarted.resolve();
            await releaseRouterResponse.promise;
            return fauxAssistantMessage(fauxToolCall("triage_report", {
                routingIntent: "PLANNED_CHANGE",
                workKind: "BUG_FIX",
                complexity: "MEDIUM",
                summary: "Transfer pending steering in order.",
                sessionName: "Ordered handoff steering",
            }));
        }
        return fauxAssistantMessage(fauxText("Planner received the pending steering."));
    };
    setRuntimeModelResponseFactories(Array.from({ length: 4 }, () => response));
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    const prompt = runtime.promptUserTurn(sessionId, {
        initialRequest: "Fix the handoff ordering.",
        initialImages: [],
    });

    await routerResponseStarted.promise;
    const firstSteering = await runtime.steerSession(sessionId, "First pending instruction.", []);
    const secondSteering = await runtime.steerSession(
        sessionId,
        "Second pending instruction with image.",
        [{ base64: RUNTIME_TEST_PNG, mimeType: "image/png" }],
    );
    releaseRouterResponse.resolve();

    const result = await prompt;
    assertEquals(result.ok, true);
    assertEquals(firstSteering.queued, true);
    assertEquals(secondSteering.queued, true);
    assertEquals(providerRequests.filter((request) => request.agentName === "router").length, 1);
    const plannerRequest = providerRequests.find((request) => request.agentName === "planner");
    assertExists(plannerRequest);
    const firstIndex = plannerRequest.messages.indexOf("First pending instruction.");
    const secondIndex = plannerRequest.messages.indexOf("Second pending instruction with image.");
    assertEquals(firstIndex >= 0, true);
    assertEquals(secondIndex > firstIndex, true);
    assertEquals(plannerRequest.imageCount, 1);
    assertEquals(runtime.getQueuedMessages(sessionId), []);
    await runtime.closeAllSessionsWhenIdle();
});

Deno.test("SessionRuntime waits for steering submitted during replacement prompt preparation", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const plannerActivated = deferredVoid();
    /** @type {HandoffProviderRequest[]} */
    const providerRequests = [];
    /** @param {import('@earendil-works/pi-ai').Context} context */
    const response = (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        const agentName = tools.includes("triage_report") ? "router" : "planner";
        providerRequests.push({
            agentName,
            messages: JSON.stringify(context.messages),
            imageCount: 0,
        });
        if (agentName === "router") {
            return fauxAssistantMessage(fauxToolCall("triage_report", {
                routingIntent: "PLANNED_CHANGE",
                workKind: "BUG_FIX",
                complexity: "MEDIUM",
                summary: "Hold replacement prompt preparation.",
                sessionName: "Prepared replacement steering",
            }));
        }
        return fauxAssistantMessage(fauxText("Planner received preparation-time steering."));
    };
    setRuntimeModelResponseFactories(Array.from({ length: 4 }, () => response));
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    /** @type {Promise<SteeringResult> | null} */
    let steeringSubmission = null;
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type !== RuntimeEventTypes.AGENT_CHANGED || event.agentName !== "planner") return;
        const hostedSession = sessionHost.requireSession(sessionId);
        hostedSession.beginAgentSteeringPreparation("hold-replacement-prompt");
        steeringSubmission = runtime.steerSession(sessionId, "Steering during replacement prompt preparation.", []);
        plannerActivated.resolve();
    });
    const prompt = runtime.promptUserTurn(sessionId, {
        initialRequest: "Fix the prompt preparation race.",
        initialImages: [],
    });

    await plannerActivated.promise;
    await Promise.resolve();
    assertEquals(providerRequests.map((request) => request.agentName), ["router"]);
    assertExists(steeringSubmission);
    const steered = await /** @type {Promise<SteeringResult>} */ (steeringSubmission);
    assertEquals(steered.queued, true);
    sessionHost.requireSession(sessionId).completeAgentSteeringPreparation("hold-replacement-prompt");

    const result = await prompt;
    assertEquals(result.ok, true);
    const plannerRequest = providerRequests.find((request) => request.agentName === "planner");
    assertExists(plannerRequest);
    assertStringIncludes(plannerRequest.messages, "Steering during replacement prompt preparation.");
    await runtime.closeAllSessionsWhenIdle();
});

Deno.test("SessionRuntime does not replay handoff steering after a replacement provider error", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    /** @type {string[]} */
    const plannerRequests = [];
    let plannerAttempts = 0;
    /** @param {import('@earendil-works/pi-ai').Context} context */
    const response = (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        if (tools.includes("triage_report")) {
            return fauxAssistantMessage(fauxToolCall("triage_report", {
                routingIntent: "PLANNED_CHANGE",
                workKind: "BUG_FIX",
                complexity: "MEDIUM",
                summary: "Do not replay handoff steering after an error.",
                sessionName: "No steering replay",
            }));
        }
        plannerRequests.push(JSON.stringify(context.messages));
        plannerAttempts += 1;
        if (plannerAttempts === 1) throw new Error("provider disconnected");
        return fauxAssistantMessage(fauxText("Planner retry completed."));
    };
    setRuntimeModelResponseFactories(Array.from({ length: 6 }, () => response));
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    /** @type {Promise<SteeringResult> | null} */
    let steeringSubmission = null;
    /** @type {string[]} */
    const statuses = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (
            !steeringSubmission && event.type === RuntimeEventTypes.SYSTEM_STATUS &&
            event.header === "Triage"
        ) {
            steeringSubmission = runtime.steerSession(sessionId, "Keep this steering exactly once.", [], "tui");
        }
        if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED) statuses.push(event.status);
    });

    const initial = await runtime.promptUserTurn(sessionId, {
        initialRequest: "Fix the handoff provider error.",
        initialImages: [],
    });
    assertExists(steeringSubmission);
    const steered = await /** @type {Promise<SteeringResult>} */ (steeringSubmission);

    assertEquals(initial.ok, true);
    assertEquals(steered.queued, true);
    assertEquals(runtime.getQueuedMessages(sessionId), []);

    const retried = await runtime.promptUserTurn(sessionId, {
        initialRequest: "Retry the planner request.",
        initialImages: [],
    });

    assertEquals(retried.ok, true);
    assertEquals(plannerRequests.length, 2);
    const deliveredSteering = "Keep this steering exactly once.";
    assertEquals(plannerRequests[1].split(deliveredSteering).length - 1, 1);
    assertEquals(statuses, ["queued", "consumed"]);
    assertEquals(runtime.getQueuedMessages(sessionId), []);
    await runtime.closeAllSessionsWhenIdle();
});

Deno.test("SessionRuntime cancellation after Triage acceptance does not start the replacement Agent", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    /** @type {string[]} */
    const providerAgents = [];
    /** @param {import('@earendil-works/pi-ai').Context} context */
    const response = (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        const agentName = tools.includes("triage_report") ? "router" : "replacement";
        providerAgents.push(agentName);
        if (agentName === "router") {
            return fauxAssistantMessage(fauxToolCall("triage_report", {
                routingIntent: "PLANNED_CHANGE",
                workKind: "BUG_FIX",
                complexity: "MEDIUM",
                summary: "Cancel this handoff.",
                sessionName: "Cancel handoff",
            }));
        }
        return fauxAssistantMessage(fauxText("Replacement must not run."));
    };
    setRuntimeModelResponseFactories(Array.from({ length: 4 }, () => response));
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    /** @type {ReturnType<typeof runtime.cancelSession> | undefined} */
    let cancellation;
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (!cancellation && event.type === RuntimeEventTypes.SYSTEM_STATUS && event.header === "Triage") {
            cancellation = runtime.cancelSession(sessionId);
        }
    });

    await runtime.promptUserTurn(sessionId, {
        initialRequest: "Cancel after triage.",
        initialImages: [],
    }).catch(() => undefined);

    assertEquals(cancellation, { ok: true, aborted: true });
    assertEquals(providerAgents, ["router"]);
    assertEquals(sessionHost.requireSession(sessionId).isAgentTransitioning(), false);
    await runtime.closeAllSessionsWhenIdle();
});

Deno.test("SessionRuntime cancellation during Planner activation prevents replacement provider work", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    /** @type {string[]} */
    const providerAgents = [];
    /** @param {import('@earendil-works/pi-ai').Context} context */
    const response = (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        const agentName = tools.includes("triage_report") ? "router" : "planner";
        providerAgents.push(agentName);
        if (agentName === "router") {
            return fauxAssistantMessage(fauxToolCall("triage_report", {
                routingIntent: "PLANNED_CHANGE",
                workKind: "BUG_FIX",
                complexity: "MEDIUM",
                summary: "Cancel during Planner activation.",
                sessionName: "Cancel Planner activation",
            }));
        }
        return fauxAssistantMessage(fauxText("Planner must not run."));
    };
    setRuntimeModelResponseFactories(Array.from({ length: 4 }, () => response));
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    /** @type {ReturnType<typeof runtime.cancelSession> | undefined} */
    let cancellation;
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (!cancellation && event.type === RuntimeEventTypes.AGENT_CHANGED && event.agentName === "planner") {
            cancellation = runtime.cancelSession(sessionId);
        }
    });

    await runtime.promptUserTurn(sessionId, {
        initialRequest: "Cancel when Planner activates.",
        initialImages: [],
    }).catch(() => undefined);

    assertEquals(cancellation, { ok: true, aborted: true });
    assertEquals(providerAgents, ["router"]);
    assertEquals(sessionHost.requireSession(sessionId).isAgentTransitioning(), false);
    await runtime.closeAllSessionsWhenIdle();
});

Deno.test("SessionRuntime owns steering and deferred queue transitions", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    /** @type {string[]} */
    const statuses = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED) statuses.push(event.status);
    });

    const steered = await runtime.steerSession(sessionId, "change direction", []);
    const deferred = runtime.queueNextTurnMessage(sessionId, "later", []);
    agentSession.consumeNextSteering();
    const taken = runtime.takeNextTurnMessage(sessionId);

    assertEquals(steered.queued, true);
    assertEquals(taken.message?.id, deferred.message?.id);
    assertEquals(statuses, ["queued", "queued", "consumed", "consumed"]);
    assertEquals(runtime.getQueuedMessages(sessionId), []);
});

/** Create a managed turn with a real Session manager and a scripted Agent boundary.
 * @param {SessionHost} sessionHost
 */
function createScriptedManagedTurn(sessionHost) {
    const cwd = runtimeProjectRoot();
    const sessionManager = SessionManager.create(cwd, getRunWieldSessionDir(cwd));
    const agentSession = makeSteeringAgentSession();
    const hostedSession = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd,
        sessionManager,
        managed: {
            runwieldSessionId: "direct-turn",
            projectId: "direct-turn-project",
            piSessionId: sessionManager.getSessionId(),
            transcriptPath: join(getRunWieldSessionDir(cwd), `${sessionManager.getSessionId()}.jsonl`),
            currentSegmentId: "direct-turn-segment",
            generation: 0,
            acknowledgedGeneration: 0,
            acknowledgedEventId: null,
            name: null,
            activeAgent: "router",
            workflowContext: null,
            syncState: null,
        },
    });
    /** @type {import('./managed-operation.ts').ManagedOperationCapability} */
    const capability = {
        runtimeSessionId: hostedSession.id,
        runwieldSessionId: "direct-turn",
        operationId: "direct-turn-operation",
        proof: {
            runwieldSessionId: "direct-turn",
            projectId: "direct-turn-project",
            ownerInstanceId: "direct-turn-owner",
            ownerProcessKind: "test",
            operationId: "direct-turn-operation",
            fence: 1,
            phase: "turning",
            expectedGeneration: 0,
        },
        settled: false,
        registerArtifact: () => ({
            artifactId: "direct-turn-artifact",
            kind: "report",
            path: "artifact.md",
            title: "Artifact",
            registeredAt: "2026-01-01T00:00:00.000Z",
            registeredBy: "test",
            sourceSegmentId: null,
        }),
        updateProof: () => {},
        assertLive: () => {},
        settle: () => {},
    };
    hostedSession.setManagedOperationCapability(capability);
    hostedSession.setRootAgentName("router", capability);
    hostedSession.setRootAgentSession(agentSession, capability);
    return { hostedSession, agentSession, capability };
}

Deno.test("SessionRuntime reconciles consumed steering at turn end when the backend emits no queue update", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const { hostedSession, agentSession, capability } = createScriptedManagedTurn(sessionHost);
    /** @type {Array<{ ok: boolean, queued: boolean, error?: string, reason?: string }>} */
    const steeredResults = [];
    hostedSession.setActiveOnMessage(async () => {
        steeredResults.push(await runtime.steerSession(hostedSession.id, "silent steering", []));
        agentSession.consumeNextSteeringSilently();
        return { kind: "complete" };
    });
    /** @type {Array<{ type: string, status?: string, text?: string }>} */
    const events = [];
    runtime.subscribeSessionEvents(hostedSession.id, (event) => {
        if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED) {
            events.push({ type: event.type, status: event.status, text: event.message.text });
        }
        if (event.type === RuntimeEventTypes.USER_MESSAGE) {
            events.push({ type: event.type, text: event.text });
        }
    });

    await runtime.promptSession(hostedSession.id, { initialRequest: "start", initialImages: [] }, capability);

    assertEquals(steeredResults[0]?.ok, true);
    assertEquals(steeredResults[0]?.queued, true);
    assertEquals(events, [
        { type: RuntimeEventTypes.USER_MESSAGE, text: "start" },
        { type: RuntimeEventTypes.QUEUED_MESSAGE_CHANGED, status: "queued", text: "silent steering" },
        { type: RuntimeEventTypes.QUEUED_MESSAGE_CHANGED, status: "consumed", text: "silent steering" },
        { type: RuntimeEventTypes.USER_MESSAGE, text: "silent steering" },
    ]);
    assertEquals(runtime.getQueuedMessages(hostedSession.id), []);
});

Deno.test("SessionRuntime lets dormant managed sessions consume deferred user follow-up messages", async () => {
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "router" });
    await runtime.promptUserTurn(sessionId, { initialRequest: "finish this session" });
    assertEquals(runtime.getSessionSnapshot(sessionId)?.managed?.dormant, true);

    const queued = runtime.queueNextTurnMessage(sessionId, "follow up anyway", []);
    const taken = runtime.takeNextTurnMessage(sessionId);

    assertEquals(taken.ok, true);
    assertEquals(taken.message?.id, queued.message?.id);
    assertEquals(taken.message?.text, "follow up anyway");
    assertEquals(runtime.getQueuedMessages(sessionId), []);
});

Deno.test("SessionRuntime steers active foreground sub-agent before streaming root and reconciles source queue", async () => {
    const sessionHost = new SessionHost();
    const rootSession = makeSteeringAgentSession();
    const foregroundSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, rootSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    hostedSession.addSubAgentSession(foregroundSession);
    const targetId = hostedSession.pushSteeringTargetSession(foregroundSession);
    /** @type {Array<{ status: string, text: string }>} */
    const queueEvents = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED) {
            queueEvents.push({ status: event.status, text: event.message.text });
        }
    });

    const steered = await runtime.steerSession(sessionId, "review this edge case", []);
    assertEquals(steered.queued, true);
    assertEquals(rootSession.getSteeringMessages(), []);
    assertEquals(foregroundSession.getSteeringMessages(), ["review this edge case"]);

    foregroundSession.consumeNextSteering();
    assertEquals(queueEvents, [
        { status: "queued", text: "review this edge case" },
        { status: "consumed", text: "review this edge case" },
    ]);
    assertEquals(runtime.getQueuedMessages(sessionId), []);

    hostedSession.popSteeringTargetSession(targetId);
    hostedSession.removeSubAgentSession(foregroundSession);
});

Deno.test("SessionRuntime accepts text steering for Antigravity CLI but rejects image steering", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    agentSession.model = { provider: "agy-cli", executionBackend: "agy-cli", input: ["text"] };
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);

    const steered = await runtime.steerSession(sessionId, "change direction", []);
    assertEquals(steered.queued, true);
    assertEquals(agentSession.getSteeringMessages(), ["change direction"]);
    await assertRejects(
        () => runtime.steerSession(sessionId, "look at this", [{ base64: btoa("img"), mimeType: "image/png" }]),
        Error,
        "Antigravity CLI sessions do not support image attachments.",
    );
});

Deno.test("SessionRuntime buffers identifiable steering for the replacement Agent and supports recall", async () => {
    const sessionHost = new SessionHost();
    const rootSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, rootSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    const transitionId = hostedSession.beginAgentTransition();
    /** @type {import('./session-runtime-events.js').RuntimeQueuedMessageEvent[]} */
    const events = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED) events.push(event);
    });

    const steered = await runtime.steerSession(
        sessionId,
        "send this to the new Agent",
        [{ base64: btoa("transition-image"), mimeType: "image/png" }],
    );

    assertEquals(steered.ok, true);
    assertEquals(steered.queued, true);
    assertExists(steered.message);
    assertEquals(rootSession.getSteeringMessages(), []);
    assertEquals(runtime.getQueuedMessages(sessionId), [steered.message]);
    assertEquals(hostedSession.consumeAgentTransitionSteering(), [{
        text: "send this to the new Agent",
        images: [{ base64: btoa("transition-image"), mimeType: "image/png" }],
        message: steered.message,
    }]);
    hostedSession.restoreAgentTransitionSteering([{
        text: steered.message.text,
        images: steered.message.images,
        message: steered.message,
    }]);
    const recalled = await runtime.dequeueLastQueuedMessage(sessionId);
    assertEquals(recalled.message?.id, steered.message.id);
    assertEquals(events.map((event) => event.status), ["queued", "dequeued"]);
    assertEquals(runtime.getQueuedMessages(sessionId), []);
    hostedSession.completeAgentTransition(transitionId);
});

Deno.test("SessionRuntime transfers old Agent steering without claiming consumption", async () => {
    const sessionHost = new SessionHost();
    const rootSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, rootSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    /** @type {string[]} */
    const statuses = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED) statuses.push(event.status);
    });
    const first = await runtime.steerSession(sessionId, "first pending", []);
    const second = await runtime.steerSession(
        sessionId,
        "second pending",
        [{ base64: btoa("pending-image"), mimeType: "image/png" }],
    );

    const transitionId = hostedSession.beginAgentTransition();
    rootSession.clearQueue();

    assertEquals(rootSession.getSteeringMessages(), []);
    assertEquals(statuses, ["queued", "queued"]);
    assertEquals(runtime.getQueuedMessages(sessionId).map((message) => message.id), [
        first.message?.id,
        second.message?.id,
    ]);
    const transferred = hostedSession.consumeAgentTransitionSteering();
    assertEquals(transferred.map((entry) => entry.message?.id), [first.message?.id, second.message?.id]);
    assertEquals(transferred[1].images, [{ base64: btoa("pending-image"), mimeType: "image/png" }]);
    hostedSession.restoreAgentTransitionSteering(transferred);
    hostedSession.completeAgentTransition(transitionId);
    const cleared = await runtime.clearQueuedMessages(sessionId, "session_cancel");
    if (!("cleared" in cleared)) throw new Error(cleared.error);
    assertEquals(cleared.cleared, 2);
    assertEquals(statuses, ["queued", "queued", "dequeued", "dequeued"]);
});

Deno.test("SessionRuntime keeps queue subscriptions for multiple steering source sessions", async () => {
    const sessionHost = new SessionHost();
    const rootSession = makeSteeringAgentSession();
    const foregroundSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, rootSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    /** @type {string[]} */
    const consumedTexts = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED && event.status === "consumed") {
            consumedTexts.push(event.message.text);
        }
    });

    await runtime.steerSession(sessionId, "root pending", []);
    const targetId = hostedSession.pushSteeringTargetSession(foregroundSession);
    await runtime.steerSession(sessionId, "foreground pending", []);

    rootSession.consumeNextSteering();
    foregroundSession.consumeNextSteering();

    assertEquals(consumedTexts, ["root pending", "foreground pending"]);
    assertEquals(runtime.getQueuedMessages(sessionId), []);
    hostedSession.popSteeringTargetSession(targetId);
});

Deno.test("SessionRuntime dequeue restores remaining steering onto original source when foreground changes", async () => {
    const sessionHost = new SessionHost();
    const rootSession = makeSteeringAgentSession();
    const foregroundSession = makeSteeringAgentSession();
    const otherForegroundSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, rootSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    const foregroundTargetId = hostedSession.pushSteeringTargetSession(foregroundSession);
    await runtime.steerSession(sessionId, "keep on child", []);
    await runtime.steerSession(sessionId, "recall from child", []);
    hostedSession.popSteeringTargetSession(foregroundTargetId);
    const otherTargetId = hostedSession.pushSteeringTargetSession(otherForegroundSession);

    const dequeued = await runtime.dequeueLastQueuedMessage(sessionId);

    assertEquals(dequeued.message?.text, "recall from child");
    assertEquals(foregroundSession.getSteeringMessages(), ["keep on child"]);
    assertEquals(otherForegroundSession.getSteeringMessages(), []);
    assertEquals(runtime.getQueuedMessages(sessionId).map((message) => message.text), ["keep on child"]);
    hostedSession.popSteeringTargetSession(otherTargetId);
});

Deno.test("SessionRuntime tracks steering before preparation and preserves submission order", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);

    const first = runtime.steerSession(sessionId, "first steering", []);
    const second = runtime.steerSession(sessionId, "second steering", []);

    assertEquals(runtime.getQueuedMessages(sessionId).map((message) => message.text), [
        "first steering",
        "second steering",
    ]);
    assertEquals((await first).queued, true);
    assertEquals((await second).queued, true);
    assertEquals(agentSession.getSteeringMessages(), ["first steering", "second steering"]);
});

Deno.test("SessionRuntime keeps pending steering ahead of newer transition steering", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    const hostedSession = sessionHost.requireSession(sessionId);

    await runtime.steerSession(sessionId, "first pending before handoff", []);
    await runtime.steerSession(
        sessionId,
        "second pending before handoff",
        [{ base64: btoa("pending-image"), mimeType: "image/png" }],
    );
    hostedSession.beginAgentTransition();
    const duringHandoff = runtime.steerSession(sessionId, "newer transition steering", []);
    await Promise.resolve();
    agentSession.clearQueue();

    await duringHandoff;
    assertEquals(
        hostedSession.listAgentTransitionSteering().map((entry) => entry.text),
        ["first pending before handoff", "second pending before handoff", "newer transition steering"],
    );
    assertEquals(hostedSession.listAgentTransitionSteering()[1].images.length, 1);
});

Deno.test("SessionRuntime recalls steering while asynchronous preparation is pending", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    /** @type {string[]} */
    const statuses = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED) statuses.push(event.status);
    });

    const steering = runtime.steerSession(sessionId, "recall during preparation", []);
    const recalled = await runtime.dequeueLastQueuedMessage(sessionId);
    const result = await steering;

    assertEquals(recalled.message?.text, "recall during preparation");
    assertEquals(result, { ok: true, queued: false, reason: "dequeued" });
    assertEquals(agentSession.getSteeringMessages(), []);
    assertEquals(statuses, ["queued", "dequeued"]);
});

Deno.test("SessionRuntime cancellation removes steering still preparing", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);

    const steering = runtime.steerSession(sessionId, "cancel during preparation", []);
    assertEquals(runtime.cancelSession(sessionId), { ok: true, aborted: true });

    assertEquals(await steering, { ok: true, queued: false, reason: "dequeued" });
    assertEquals(agentSession.getSteeringMessages(), []);
    assertEquals(runtime.getQueuedMessages(sessionId), []);
});

Deno.test("SessionRuntime moves image steering into the handoff after asynchronous preparation", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    agentSession.model = { input: ["text"] };
    const runtime = makeRuntime({ sessionHost });
    const projectRoot = runtimeProjectRoot();
    const modelProvider = `session-runtime-steering-${crypto.randomUUID()}`;
    const modelId = "discovered-vision";
    const discoveryRequestStarted = deferredVoid();
    const releaseDiscoveryRequest = deferredVoid();
    let discoveryRequests = 0;
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
        assertEquals(new URL(request.url).pathname, "/v1/models");
        discoveryRequests += 1;
        discoveryRequestStarted.resolve();
        await releaseDiscoveryRequest.promise;
        return new Response(JSON.stringify({ data: [{ id: modelId }] }), {
            headers: { "content-type": "application/json" },
        });
    });
    const address = server.addr;
    if (address.transport !== "tcp") {
        await server.shutdown();
        throw new Error("Image discovery test server did not bind a TCP address.");
    }
    const modelsPath = join(getHomeDir(), ".wld", "models.json");
    const projectSettingsPath = join(projectRoot, ".wld", "settings.json");
    const originalModels = await Deno.readTextFile(modelsPath);
    const originalProjectSettings = await Deno.readTextFile(projectSettingsPath).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
    });
    const modelConfiguration = JSON.parse(originalModels);
    modelConfiguration.providers[modelProvider] = {
        baseUrl: `http://${address.hostname}:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "test-key",
    };

    try {
        await Deno.writeTextFile(modelsPath, JSON.stringify(modelConfiguration));
        await setCustomSetting(
            "visionFallback",
            {
                model: `${modelProvider}/${modelId}`,
            },
            "project",
            projectRoot,
        );
        const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
        const hostedSession = sessionHost.requireSession(sessionId);
        const steering = runtime.steerSession(
            sessionId,
            "Image instruction prepared while handoff starts.",
            [{ base64: btoa("async-image"), mimeType: "image/png" }],
        );
        void steering.catch(() => undefined);

        await Promise.race([
            discoveryRequestStarted.promise,
            delay(1_000).then(() => {
                throw new Error("Image preparation did not reach the configured provider.");
            }),
        ]);
        const transitionId = hostedSession.beginAgentTransition();
        releaseDiscoveryRequest.resolve();

        const result = await steering;
        assertEquals(discoveryRequests, 1);
        assertEquals(result.queued, true);
        assertEquals(agentSession.getSteeringMessages(), []);
        assertEquals(
            hostedSession.listAgentTransitionSteering().map((entry) => entry.text),
            ["Image instruction prepared while handoff starts."],
        );
        assertEquals(hostedSession.listAgentTransitionSteering()[0].images.length, 1);
        hostedSession.completeAgentTransition(transitionId);
        const cleared = await runtime.clearQueuedMessages(sessionId, "session_cancel");
        if (!("cleared" in cleared)) throw new Error(cleared.error);
        assertEquals(cleared.cleared, 1);
    } finally {
        releaseDiscoveryRequest.resolve();
        await server.shutdown();
        await Deno.writeTextFile(modelsPath, originalModels);
        if (originalProjectSettings === null) {
            await Deno.remove(projectSettingsPath).catch((error) => {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
            });
        } else {
            await Deno.writeTextFile(projectSettingsPath, originalProjectSettings);
        }
        __resetSettingsForTests();
    }
});

Deno.test("SessionRuntime rechecks the foreground target after asynchronous steering preparation", async () => {
    const sessionHost = new SessionHost();
    const rootSession = makeSteeringAgentSession();
    const firstForegroundSession = makeSteeringAgentSession();
    const replacementForegroundSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, rootSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    const firstTargetId = hostedSession.pushSteeringTargetSession(firstForegroundSession);

    const steering = runtime.steerSession(sessionId, "follow the current target", []);
    hostedSession.popSteeringTargetSession(firstTargetId);
    const replacementTargetId = hostedSession.pushSteeringTargetSession(replacementForegroundSession);

    assertEquals((await steering).queued, true);
    assertEquals(firstForegroundSession.getSteeringMessages(), []);
    assertEquals(replacementForegroundSession.getSteeringMessages(), ["follow the current target"]);
    hostedSession.popSteeringTargetSession(replacementTargetId);
});

Deno.test("SessionRuntime falls back to root when foreground steering target stopped streaming", async () => {
    const sessionHost = new SessionHost();
    const rootSession = makeSteeringAgentSession();
    const foregroundSession = makeSteeringAgentSession();
    foregroundSession.isStreaming = false;
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, rootSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    const targetId = hostedSession.pushSteeringTargetSession(foregroundSession);

    const steered = await runtime.steerSession(sessionId, "root instead", []);
    assertEquals(steered.queued, true);
    assertEquals(rootSession.getSteeringMessages(), ["root instead"]);
    assertEquals(foregroundSession.getSteeringMessages(), []);

    hostedSession.popSteeringTargetSession(targetId);
});

Deno.test("SessionRuntime cancellation emits cancellation and dequeues pending messages", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    hostedSession.beginAgentTransition();
    /** @type {any[]} */
    const events = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        events.push(event);
    });
    await runtime.steerSession(sessionId, "cancel me", []);

    assertEquals(runtime.cancelSession(sessionId), { ok: true, aborted: true });
    assertEquals(events.filter((event) => event.type === RuntimeEventTypes.CANCELLATION).length, 1);
    assertEquals(events.find((event) => event.type === RuntimeEventTypes.CANCELLATION)?.message, "Agent run canceled.");
    assertEquals(
        events.filter((event) => event.type === RuntimeEventTypes.QUEUED_MESSAGE_CHANGED).map((event) => event.status),
        ["queued", "dequeued"],
    );
    assertEquals(hostedSession.isAgentTransitioning(), false);
    assertEquals(hostedSession.consumeAgentTransitionSteering(), []);
});

Deno.test("SessionRuntime marks aborted agent turns to suppress agent-stopped attention", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, makeSteeringAgentSession());
    const canceledSession = sessionHost.requireSession(sessionId);

    assertEquals(runtime.cancelSession(sessionId), { ok: true, aborted: true });
    assertEquals(canceledSession?.consumeSuppressedAgentStoppedAttention(), true);
    assertEquals(canceledSession?.consumeSuppressedAgentStoppedAttention(), false);
});

Deno.test("SessionRuntime Escape cancels active Plan review without aborting the recovery turn", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    runtime.setInteractionAdapter(sessionId, {
        requestInteraction: () => new Promise(() => {}),
    });

    const review = runtime.requestInteraction(sessionId, {
        type: RuntimeInteractionTypes.PLAN_REVIEW,
        prompt: "Review plan",
    });
    for (let attempt = 0; attempt < 20 && hostedSession.getActiveInteractions().size === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }

    assertEquals(hostedSession.getActiveInteractions().size, 1);
    assertEquals(runtime.cancelSession(sessionId), { ok: true, aborted: true });
    assertEquals(agentSession.isStreaming, true);
    assertEquals((await review).outcome, "canceled");
});

Deno.test("SessionRuntime suppresses attention when Esc races with turn completion", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    agentSession.isStreaming = false;
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    const hostedSession = sessionHost.requireSession(sessionId);
    hostedSession.beginTurn("racing-turn");

    assertEquals(runtime.cancelSession(sessionId), { ok: true, aborted: false });
    assertEquals(hostedSession.consumeSuppressedAgentStoppedAttention(), true);
});

Deno.test("SessionRuntime cancellation owns active compaction and publishes one operation event", async () => {
    const agentSession = makeSteeringAgentSession();
    agentSession.isStreaming = false;
    agentSession.isCompacting = true;
    let compactionAborts = 0;
    agentSession.abortCompaction = () => {
        compactionAborts++;
        agentSession.isCompacting = false;
    };
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    /** @type {any[]} */
    const events = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        events.push(event);
    });

    assertEquals(runtime.cancelSession(sessionId), { ok: true, aborted: true });
    assertEquals(compactionAborts, 1);
    const cancellationEvents = events.filter((event) => event.type === RuntimeEventTypes.CANCELLATION);
    assertEquals(typeof cancellationEvents[0].messageId, "string");
    const { messageId: _messageId, ...cancellation } = cancellationEvents[0];
    assertEquals(cancellation, {
        type: RuntimeEventTypes.CANCELLATION,
        sessionId,
        timestamp: events.at(-1).timestamp,
        aborted: true,
        reason: "session_cancel",
        scope: "operation",
        message: "Operation canceled.",
    });
});

Deno.test("SessionRuntime interaction adapter resolves through semantic lifecycle events", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const session = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd: runtimeProjectRoot(),
        sessionManager: null,
    });
    const sessionId = session.id;
    /** @type {string[]} */
    const types = [];
    /** @param {import('./session-runtime-events.js').SessionRuntimeEvent} event */
    const captureEvent = (event) => types.push(event.type);
    session.setEventSink({ emit: captureEvent });
    runtime.setInteractionAdapter(sessionId, {
        requestInteraction: (request) => ({
            outcome: "selected",
            value: request.options?.[0]?.value,
            valueLabel: request.options?.[0]?.label,
        }),
    });

    const response = await runtime.requestInteraction(sessionId, {
        type: "select",
        prompt: "Pick",
        options: [{ value: "a", label: "First" }],
    });

    assertEquals(response, { outcome: "selected", value: "a", valueLabel: "First" });
    assertEquals(types, [RuntimeEventTypes.INTERACTION_REQUESTED, RuntimeEventTypes.INTERACTION_RESOLVED]);
});

Deno.test("SessionRuntime emits canceled lifecycle for an already-aborted interaction", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const session = sessionHost.createSession({
        id: crypto.randomUUID(),
        cwd: runtimeProjectRoot(),
        sessionManager: null,
    });
    const sessionId = session.id;
    /** @type {string[]} */
    const types = [];
    /** @param {import('./session-runtime-events.js').SessionRuntimeEvent} event */
    const captureEvent = (event) => types.push(event.type);
    session.setEventSink({ emit: captureEvent });
    runtime.setInteractionAdapter(sessionId, {
        requestInteraction: () => new Promise(() => {}),
    });
    const controller = new AbortController();
    controller.abort();

    const response = await runtime.requestInteraction(
        sessionId,
        { type: "text", prompt: "Name?" },
        controller.signal,
    );

    assertEquals(response.outcome, "canceled");
    assertEquals(types, [RuntimeEventTypes.INTERACTION_REQUESTED, RuntimeEventTypes.INTERACTION_CANCELED]);
});

Deno.test("SessionRuntime automatically catalogs and segments legacy transcripts when loaded", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = getHomeDir();
        const home = await Deno.makeTempDir({ prefix: "runwield-runtime-load-cataloged-unmanaged-" });
        Deno.env.set("HOME", home);
        const cwd = `${home}/project`;
        await Deno.mkdir(cwd, { recursive: true });
        const store = openOwnerCoordinationStore({ dbPath: `${home}/owner.sqlite3` });
        const piSessionId = "cataloged-normal-resume";
        try {
            ensureRuntimeModelFixture();
            const sessionDir = getRunWieldSessionDir(cwd);
            await Deno.mkdir(sessionDir, { recursive: true });
            const manager = SessionManager.create(cwd, sessionDir, { id: piSessionId });
            manager.appendCustomEntry("runwield.active_agent", { agentName: "planner" });
            manager.appendMessage(
                /** @type {any} */ ({
                    role: "user",
                    timestamp: Date.now(),
                    content: [{ type: "text", text: "resume cataloged fixture" }],
                }),
            );
            manager.appendMessage(
                /** @type {any} */ ({
                    role: "assistant",
                    timestamp: Date.now(),
                    api: RUNTIME_TEST_API,
                    provider: RUNTIME_TEST_PROVIDER,
                    model: RUNTIME_TEST_MODEL,
                    usage: {},
                    cost: {},
                    stopReason: "end_turn",
                    content: [{ type: "text", text: "cataloged fixture response" }],
                }),
            );
            const transcriptPath = manager.getSessionFile();
            if (!transcriptPath) throw new Error("fixture transcript was not persisted");
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "runtime-test-owner",
            });
            try {
                const loaded = await runtime.loadSession({ cwd, sessionId: piSessionId, sessionPath: transcriptPath });
                const managed = runtime.getSessionSnapshot(loaded.sessionId)?.managed;
                const cataloged = store.findSessionByLocator({ transcriptPath });
                assertEquals(cataloged?.piSessionId, piSessionId);
                assertEquals(managed?.runwieldSessionId, cataloged?.runwieldSessionId);
                assertEquals(managed?.generation, 0);
                assertEquals(store.listProjects(), []);
                assertEquals(store.listSessionTranscriptSegments(managed?.runwieldSessionId || "").length, 1);
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
            }
        } finally {
            store.close();
            Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
});

Deno.test("SessionRuntime loadSession returns opaque metadata and redacted replay events", async () => {
    ensureRuntimeModelFixture();
    const branch = [
        {
            type: "message",
            id: "u1",
            timestamp: "2026-07-08T00:00:00.000Z",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
        },
        {
            type: "custom",
            id: "marker",
            customType: "runwield.active_agent",
            data: { agentName: "Planner" },
        },
        {
            type: "message",
            id: "a1",
            timestamp: "2026-07-08T00:00:01.000Z",
            message: {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "considering" },
                    { type: "text", text: "hi" },
                ],
            },
        },
        {
            type: "message",
            id: "t1",
            message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "bash" }] },
        },
        {
            type: "message",
            id: "tr1",
            message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "tool-1", content: "password=secret" }],
            },
        },
        {
            type: "message",
            id: "tc2",
            timestamp: "2026-07-08T00:00:03.000Z",
            message: {
                role: "assistant",
                content: [
                    { type: "toolCall", id: "tool-2", name: "read", arguments: { path: "README.md" } },
                    { type: "unknown_metadata", payload: { internal: true } },
                ],
            },
        },
        {
            type: "message",
            id: "tr2",
            timestamp: "2026-07-08T00:00:05.000Z",
            message: {
                role: "toolResult",
                toolCallId: "tool-2",
                toolName: "read",
                isError: false,
                content: [{ type: "text", text: "actual tool output" }],
                details: { fullOutputPath: "/tmp/read-output" },
            },
        },
        { type: "model_change", id: "m1", provider: "test", modelId: "initial" },
        { type: "thinking_level_change", id: "th1", thinkingLevel: "off" },
        { type: "model_change", id: "m2", provider: "test", modelId: "later" },
        { type: "thinking_level_change", id: "th2", thinkingLevel: "medium" },
    ];
    const manager = SessionManager.create(runtimeProjectRoot(), getRunWieldSessionDir(runtimeProjectRoot()), {
        id: "persisted-1",
    });
    for (const entry of branch) {
        if (entry.type === "message") manager.appendMessage(/** @type {any} */ (entry.message));
        else if (entry.type === "custom") manager.appendCustomEntry(String(entry.customType), entry.data);
        else if (entry.type === "model_change") {
            manager.appendModelChange(String(entry.provider), String(entry.modelId));
        } else if (entry.type === "thinking_level_change") {
            manager.appendThinkingLevelChange(String(entry.thinkingLevel));
        }
    }
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) throw new Error("fixture transcript was not persisted");
    const runtime = createSessionRuntime();

    const result = await runtime.loadSession({ cwd: runtimeProjectRoot(), sessionId: "persisted-1", sessionPath });

    assertEquals("hostedSession" in result, false);
    assertEquals("sessionManager" in result, false);
    assertEquals(result.sessionManagerId, "persisted-1");
    assertEquals(result.replayEvents.map((event) => event.type), [
        RuntimeEventTypes.USER_MESSAGE,
        RuntimeEventTypes.ASSISTANT_THINKING_DELTA,
        RuntimeEventTypes.ASSISTANT_THINKING_END,
        RuntimeEventTypes.ASSISTANT_TEXT_DELTA,
        RuntimeEventTypes.TOOL_START,
        RuntimeEventTypes.TOOL_END,
        RuntimeEventTypes.TOOL_START,
        RuntimeEventTypes.TOOL_END,
        RuntimeEventTypes.SYSTEM_STATUS,
        RuntimeEventTypes.SYSTEM_STATUS,
    ]);
    assertEquals(
        result.replayEvents.filter((event) => event.type === RuntimeEventTypes.SYSTEM_STATUS).map((event) =>
            event.message
        ),
        ["Model changed: test/later", "Thinking level changed: medium"],
    );
    const modernToolEnd =
        /** @type {any} */ (result.replayEvents.find((event) =>
            event.type === RuntimeEventTypes.TOOL_END && event.toolCallId === "tool-2"
        ));
    const modernToolStart =
        /** @type {any} */ (result.replayEvents.find((event) =>
            event.type === RuntimeEventTypes.TOOL_START && event.toolCallId === "tool-2"
        ));
    assertEquals(modernToolStart?.title, "read README.md");
    assertEquals(modernToolStart?.kind, "read");
    assertEquals(modernToolEnd?.output, "actual tool output");
    assertEquals(modernToolEnd?.content, [{ type: "text", text: "actual tool output" }]);
    assertEquals(modernToolEnd?.details, { fullOutputPath: "/tmp/read-output" });
    assertEquals(typeof modernToolEnd?.durationMs, "number");
    assertEquals(modernToolEnd?.durationMs >= 0, true);
    const assistantMessage = /** @type {any} */ (
        result.replayEvents.find((event) => event.type === RuntimeEventTypes.ASSISTANT_TEXT_DELTA)
    );
    assertEquals(assistantMessage?.agentName, "Planner");
    const replayThinkingEvents = result.replayEvents.filter((event) =>
        event.type === RuntimeEventTypes.ASSISTANT_THINKING_DELTA ||
        event.type === RuntimeEventTypes.ASSISTANT_THINKING_END
    );
    assertEquals(replayThinkingEvents.map((event) => /** @type {any} */ (event).agentName), ["Planner", "Planner"]);
    assertEquals(JSON.stringify(result.replayEvents).includes("secret"), false);
    assertEquals(JSON.stringify(result.replayEvents).includes("[object Object]"), false);
    assertEquals(JSON.stringify(result.replayEvents).includes("runwield.active_agent"), false);
});

Deno.test("SessionRuntime replays persisted task_completed summaries and manual QA checklists", async () => {
    ensureRuntimeModelFixture();
    const branch = [
        {
            type: "message",
            id: "tc-call",
            timestamp: "2026-07-08T00:00:01.000Z",
            message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "task-tool", name: "task_completed", arguments: {} }],
            },
        },
        {
            type: "message",
            id: "tc-result",
            timestamp: "2026-07-08T00:00:02.000Z",
            message: {
                role: "toolResult",
                toolCallId: "task-tool",
                toolName: "task_completed",
                isError: false,
                content: [],
                details: { outcome: "task_completed", message: "- Implemented the fix." },
            },
        },
        {
            type: "custom",
            id: "qa-checklist",
            timestamp: "2026-07-08T00:00:03.000Z",
            customType: "runwield.manual_qa_checklist",
            data: { agentName: "Operator", text: "Manual verification steps for fix\n- Check resume." },
        },
    ];
    const manager = SessionManager.create(runtimeProjectRoot(), getRunWieldSessionDir(runtimeProjectRoot()), {
        id: "persisted-workflow",
    });
    manager.appendCustomEntry("runwield.active_agent", { agentName: "engineer" });
    for (const entry of branch) {
        if (entry.type === "message") manager.appendMessage(/** @type {any} */ (entry.message));
        else manager.appendCustomEntry(String(entry.customType), entry.data);
    }
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) throw new Error("fixture transcript was not persisted");
    const runtime = createSessionRuntime();

    const result = await runtime.loadSession({
        cwd: runtimeProjectRoot(),
        sessionId: "persisted-workflow",
        sessionPath,
    });
    const workflowMessages = result.replayEvents.filter((event) =>
        event.type === RuntimeEventTypes.ASSISTANT_TEXT_DELTA &&
        /** @type {any} */ (event).messageKind === "workflow"
    );

    assertEquals(workflowMessages.map((event) => /** @type {any} */ (event).workflowMessage), [
        "task_completed",
        "manual_qa_checklist",
    ]);
    assertEquals(/** @type {any} */ (workflowMessages[0]).delta, "**Task completed.**\n\n- Implemented the fix.");
    assertEquals(
        /** @type {any} */ (workflowMessages[1]).delta,
        "Manual verification steps for fix\n- Check resume.",
    );
});

Deno.test("SessionRuntime close operations dispose sessions by id", async () => {
    const runtime = makeRuntime();
    const first = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });
    const second = await runtime.createInteractiveSession({ cwd: runtimeProjectRoot() });

    assertEquals(await runtime.closeSession(first.sessionId), { ok: true, closed: true });
    assertEquals(runtime.getSessionSnapshot(first.sessionId), null);
    assertEquals(await runtime.closeAllSessionsWhenIdle(), { ok: true, closed: 1 });
    assertEquals(runtime.getSessionSnapshot(second.sessionId), null);
    assertEquals(runtime.listSessions(), []);
});

Deno.test("SessionRuntime close settles cleanup when MCP pool close fails", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    const hostedSession = sessionHost.requireSession(sessionId);
    /** @type {string[]} */
    const events = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        events.push(event.type);
    });
    const pool = new McpIntegration();
    pool.close = () => Promise.reject(new Error("fixture MCP close failed"));
    await hostedSession.setMcpIntegration(pool);

    assertEquals(await runtime.closeSession(sessionId), { ok: true, closed: true });

    assertEquals(runtime.getSessionSnapshot(sessionId), null);
    assertEquals(runtime.listSessions(), []);
    assertEquals(events.includes(RuntimeEventTypes.SESSION_CLOSED), true);
});

Deno.test("SessionRuntime snapshot derives workflow context from active execution workflow fallback", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    const hostedSession = sessionHost.requireSession(sessionId);
    hostedSession.setActiveExecutionWorkflow({
        planName: "footer-plan",
        triageMeta: { classification: "FEATURE", complexity: "MEDIUM" },
        executionAgent: "engineer",
    });

    assertEquals(runtime.getSessionSnapshot(sessionId)?.workflowContext, {
        routingIntent: "PLANNED_CHANGE",
        complexity: "MEDIUM",
        planName: "footer-plan",
    });
});

Deno.test("SessionRuntime snapshot prefers explicit workflow context over active execution fallback", async () => {
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    const hostedSession = sessionHost.requireSession(sessionId);
    hostedSession.setWorkflowExecutionContext({
        planName: "explicit-plan",
        triageMeta: { routingIntent: "PROJECT", complexity: "HIGH" },
    });
    hostedSession.setActiveExecutionWorkflow({
        planName: "fallback-plan",
        triageMeta: { classification: "FEATURE", complexity: "MEDIUM" },
        executionAgent: "engineer",
    });

    assertEquals(runtime.getSessionSnapshot(sessionId)?.workflowContext, {
        routingIntent: "PROJECT",
        complexity: "HIGH",
        planName: "explicit-plan",
    });
});

Deno.test("user-authorized agent switch releases active workflows", async () => {
    ensureRuntimeModelFixture();
    const sessionHost = new SessionHost();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot(), agentName: "engineer" });
    const hostedSession = sessionHost.requireSession(sessionId);
    hostedSession.setWorkflowPlanName("release-plan");
    await runtime.setActiveExecutionWorkflow(sessionId, {
        planName: "release-plan",
        triageMeta: { classification: "PLANNED_CHANGE" },
        executionAgent: "engineer",
        executionStarted: true,
        executionAttemptStartedAtMs: 123,
        projectRoot: runtimeProjectRoot(),
        executionCwd: runtimeProjectRoot(),
    });
    /** @type {string[]} */
    const notices = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        if (event.type === RuntimeEventTypes.SYSTEM_STATUS) notices.push(event.message || "");
    });

    await runtime.switchAgent(sessionId, { agentName: "planner", releaseActiveWorkflow: true });

    const snapshot = runtime.getSessionSnapshot(sessionId);
    assertEquals(snapshot?.activeAgent, "planner");
    assertEquals(snapshot?.activeExecutionWorkflow, null);
    assertEquals(snapshot?.workflowContext?.planName, "release-plan");
    assertEquals(notices.some((message) => message.includes("/load-plan")), true);
});

Deno.test("SessionRuntime rejects image user turns before submission events", async () => {
    const runtime = makeRuntime();
    const sessionId = await runtime.createPromptReadySession({ cwd: runtimeProjectRoot() });
    /** @type {string[]} */
    const events = [];
    runtime.subscribeSessionEvents(sessionId, (event) => {
        events.push(event.type);
    });

    await assertRejects(
        () =>
            runtime.promptUserTurn(sessionId, {
                initialRequest: "look before accepting",
                initialImages: [{ base64: btoa("img"), mimeType: "image/png" }],
                modelOverride: "agy-cli/gemini-3.8-flash",
            }),
        Error,
        "Antigravity CLI sessions do not support image attachments.",
    );

    assertEquals(events.includes(RuntimeEventTypes.USER_MESSAGE), false);
    assertEquals(events.includes(RuntimeEventTypes.TURN_START), false);
});

Deno.test("notification routing follows accepted input, not the observing surface", async () => {
    const sessionHost = new SessionHost();
    const agentSession = makeSteeringAgentSession();
    const runtime = makeRuntime({ sessionHost });
    const sessionId = await attachExternalAgentSession(runtime, sessionHost, agentSession);
    const hosted = sessionHost.getSession(sessionId);
    assertExists(hosted);
    assertEquals((await runtime.steerSession(sessionId, "From the phone", [], "workspace")).queued, true);
    assertEquals(hosted.notificationSurface, "workspace");
    runtime.getSessionSnapshot(sessionId);
    assertEquals(hosted.notificationSurface, "workspace");
    assertEquals((await runtime.steerSession(sessionId, "From the terminal", [], "tui")).queued, true);
    assertEquals(hosted.notificationSurface, "tui");
    agentSession.isStreaming = false;
    assertEquals((await runtime.steerSession(sessionId, "Too late", [], "workspace")).queued, false);
    assertEquals(hosted.notificationSurface, "tui");
    runtime.queueNextTurnMessage(sessionId, "Queued in ACP", [], { inputSurface: "acp" });
    assertEquals(hosted.notificationSurface, "acp");
    assertEquals(runtime.takeNextTurnMessage(sessionId).message?.inputSurface, "acp");
});

Deno.test("Workspace gets a stop alert even when the handler suppresses its normal attention event", async () => {
    await withRuntimeCommandFixture("runtime-stop-alert-", async ({ projectRoot, setModelResponseFactory }) => {
        const sessionHost = new SessionHost();
        const runtime = makeRuntime({ sessionHost });
        try {
            const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "guide" });
            const hosted = sessionHost.getSession(sessionId);
            assertExists(hosted);
            setModelResponseFactory(() => {
                hosted.suppressNextAgentStoppedAttention();
                return fauxAssistantMessage(fauxText("Finished."));
            });
            /** @type {import('./session-runtime-events.js').RuntimeAttentionRequestedEvent[]} */
            const attention = [];
            runtime.subscribeSessionEvents(sessionId, (event) => {
                if (event.type === RuntimeEventTypes.ATTENTION_REQUESTED) attention.push(event);
            });
            await runtime.promptUserTurn(sessionId, { initialRequest: "Finish this turn", inputSurface: "workspace" });
            assertEquals(attention.filter((event) => event.reason === "agentStopped").length, 1);
            assertEquals(attention[0].notificationSurface, "workspace");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

Deno.test("managed Plan review requests persist the container before the adapter starts", async () => {
    await withRuntimeCommandFixture("runtime-review-bookmark-", async ({ homeDir, projectRoot }) => {
        const ownerStore = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const fileStore = openFileSessionStore();
        const runtime = createSessionRuntime({
            sessionStore: ownerStore,
            ownerProcessKind: "test",
            ownerInstanceId: "review-bookmark-writer",
        });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const managed = runtime.getSessionSnapshot(sessionId)?.managed;
            assert(managed);
            assertEquals(fileStore.getLastPlanReview(managed.runwieldSessionId, managed.projectId), null);
            /** @type {Array<import('./file-session-store-types.ts').LastPlanReviewReference | null>} */
            const seenAtLaunch = [];
            runtime.setInteractionAdapter(sessionId, {
                requestInteraction: () => {
                    seenAtLaunch.push(fileStore.getLastPlanReview(managed.runwieldSessionId, managed.projectId));
                    return { outcome: "canceled" };
                },
            });
            const onSurfaceReady = () => {};
            /** @param {string} planId @param {string} planName @param {Record<string, string>} [extra] */
            const request = (planId, planName, extra = {}) =>
                runtime.requestInteraction(sessionId, {
                    type: RuntimeInteractionTypes.PLAN_REVIEW,
                    prompt: `Review ${planName}`,
                    _meta: {
                        planId,
                        planName,
                        planningAgentName: "planner",
                        reviewUrl: "https://example.test/review",
                        onSurfaceReady,
                        ...extra,
                    },
                });
            assertEquals((await request("first-id", "first")).outcome, "canceled");
            assertEquals(seenAtLaunch[0]?.planId, "first-id");
            assertEquals(
                (await request("child-id", "child", {
                    reviewContainerPlanId: "sequence-id",
                    reviewContainerPlanName: "sequence",
                    planningAgentName: "architect",
                })).outcome,
                "canceled",
            );
            assertEquals(seenAtLaunch[1]?.planId, "sequence-id");
            assertEquals(fileStore.getLastPlanReview(managed.runwieldSessionId, managed.projectId), seenAtLaunch[1]);
            assertEquals(Object.keys(seenAtLaunch[1] || {}).sort(), [
                "planId",
                "planName",
                "planningAgentName",
                "requestedAt",
            ]);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            fileStore.close();
            ownerStore.close();
        }
    });
});
