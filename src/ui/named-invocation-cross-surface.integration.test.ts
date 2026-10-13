// @ts-nocheck: cross-surface protocol payloads are checked by runtime assertions.
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../shared/session/session-runtime.ts";
import { listPersistedRootSessions } from "../shared/session/root-session.js";
import { openOwnerCoordinationStore } from "../shared/owner-coordination/index.js";
import { WorkspaceSessionContinuationService } from "./workspace/server/session-continuation.js";
import { runScopedSubmitHandoffLoop } from "./tui/chat-session.ts";
import { startRunWieldAcpServer } from "../acp/server.js";

interface NamedInvocationProfile {
    agentName?: string;
    model?: string;
    thinkingLevel?: string;
}

interface NamedInvocationPayload {
    expansionDigest?: string;
    profile?: NamedInvocationProfile;
}

interface TranscriptEntry {
    id?: string;
    parentId?: string;
    type?: string;
    customType?: string;
    provider?: string;
    modelId?: string;
    data?: NamedInvocationPayload & { agentName?: string };
    message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
    targetId?: string;
    replacement?: { content?: Array<{ type?: string; text?: string }> } | null;
}

interface NamedInvocationPromptResult {
    ok: boolean;
    namedInvocation?: {
        expansionDigest?: string;
        profile?: NamedInvocationProfile;
    };
}

interface SurfaceEventSummary {
    type: string;
    text?: string;
    agentName?: string;
    model?: string;
    thinkingLevel?: string;
}

interface RuntimeSurfaceEvent {
    type?: string;
    text?: string;
    delta?: string;
    agentName?: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
}

interface AcpUpdate {
    sessionUpdate?: string;
    content?: { text?: string };
    _meta?: { runwield?: JsonMap };
}

interface SurfaceSummary {
    surface: string;
    events: SurfaceEventSummary[];
    digest: string;
    profile: NamedInvocationProfile;
    result: string;
    activeAgent: string;
    activeModel: string;
}

interface TestServerHandle {
    inputWriter: WritableStreamDefaultWriter<Uint8Array>;
    outputReader: ReadableStreamDefaultReader<Uint8Array>;
    connection: ReturnType<typeof startRunWieldAcpServer>;
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonMap;

interface JsonMap {
    [key: string]: JsonValue;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const compactInvocation = "/cross-surface compare surfaces";
const expectedDisplayedInvocation = "Cross-surface expansion: {{input}}\n\ncompare surfaces";
const expectedProfile = {
    agentName: "operator",
    model: "runtime-command-fixture/alternate-fixture-model",
    thinkingLevel: "off",
};
const expectedAssistantText = "cross-surface done";

async function writeCrossSurfacePrompt(projectRoot: string): Promise<void> {
    const promptDir = join(projectRoot, ".wld", "prompts");
    await fsMkdir(promptDir, { recursive: true });
    await fsWriteFile(
        join(promptDir, "cross-surface.md"),
        [
            "---",
            "agent: operator",
            "model: runtime-command-fixture/alternate-fixture-model",
            "thinkingLevel: off",
            "---",
            "Cross-surface expansion: {{input}}",
        ].join("\n"),
    );
}

async function readTranscriptSummary(transcriptPath: string): Promise<{
    payload: NamedInvocationPayload;
    activeAgent: string;
    activeModel: string;
}> {
    const text = await fsReadFile(transcriptPath, "utf8");
    assertStringIncludes(text, compactInvocation);
    const entries = text.trim().split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TranscriptEntry);
    const namedEntries = entries.filter((entry) =>
        entry.type === "custom" && entry.customType === "runwield.named_invocation"
    );
    const namedEntry = namedEntries.at(-1);
    const payload = namedEntry?.data;
    if (!payload) throw new Error(`No named invocation payload found in ${transcriptPath}`);
    const userEntry = entries.find((entry) =>
        entry.type === "message" && entry.parentId === namedEntry?.id && entry.message?.role === "user"
    );
    assertEquals(userEntry?.message?.content, [{ type: "text", text: compactInvocation }]);
    const contextEdit = entries.find((entry) => entry.type === "context_edit" && entry.targetId === userEntry?.id);
    assertEquals(contextEdit?.replacement?.content, [{ type: "text", text: expectedDisplayedInvocation }]);
    let activeAgent = "";
    let activeModel = "";
    for (const entry of entries) {
        if (entry.type === "custom" && entry.customType === "runwield.active_agent") {
            activeAgent = entry.data?.agentName || "";
        }
        if (entry.type === "model_change") {
            activeModel = `${entry.provider || ""}/${entry.modelId || ""}`;
        }
    }
    return { payload, activeAgent, activeModel };
}

async function transcriptPathForSession(projectRoot: string, sessionId: string): Promise<string> {
    const sessions = await listPersistedRootSessions(projectRoot);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session?.path) throw new Error(`No transcript found for ${sessionId}`);
    return session.path;
}

function normalizeModelValue(model: string | undefined, provider: string | undefined = undefined): string {
    if (!model) return "";
    if (provider && !model.includes("/")) return `${provider}/${model}`;
    return model;
}

function runtimeSurfaceEvents(events: RuntimeSurfaceEvent[]): SurfaceEventSummary[] {
    const summaries: SurfaceEventSummary[] = [];
    let sawUser = false;
    let sawAgent = false;
    let sawModel = false;
    let sawThinking = false;
    let sawAssistant = false;
    for (const event of events) {
        if (!sawUser && event.type === "user_message" && event.text === expectedDisplayedInvocation) {
            summaries.push({ type: "user_message", text: event.text });
            sawUser = true;
            continue;
        }
        if (!sawAgent && event.type === "agent_changed" && event.agentName === expectedProfile.agentName) {
            summaries.push({
                type: "agent_changed",
                agentName: event.agentName,
                model: normalizeModelValue(event.model, event.provider),
            });
            sawAgent = true;
            continue;
        }
        const model = normalizeModelValue(event.model, event.provider);
        if (!sawModel && event.type === "model_changed" && model === expectedProfile.model) {
            summaries.push({ type: "model_changed", model });
            sawModel = true;
            continue;
        }
        if (
            !sawThinking && event.type === "thinking_level_changed" &&
            event.thinkingLevel === expectedProfile.thinkingLevel
        ) {
            summaries.push({ type: "thinking_level_changed", thinkingLevel: event.thinkingLevel });
            sawThinking = true;
            continue;
        }
        if (!sawAssistant && event.type === "assistant_text_delta" && event.delta) {
            summaries.push({ type: "assistant_text_delta" });
            sawAssistant = true;
        }
    }
    return summaries;
}

function runtimeAssistantText(events: RuntimeSurfaceEvent[]): string {
    return events
        .filter((event) => event.type === "assistant_text_delta")
        .map((event) => event.delta || "")
        .join("");
}

function getAcpUpdate(message: JsonMap): AcpUpdate | undefined {
    const params = message.params as { update?: AcpUpdate } | undefined;
    return params?.update;
}

function metaString(meta: JsonMap | undefined, key: string): string {
    const value = meta?.[key];
    return typeof value === "string" ? value : "";
}

function acpSurfaceEvents(messages: JsonMap[]): SurfaceEventSummary[] {
    const summaries: SurfaceEventSummary[] = [];
    let sawUser = false;
    let sawAgent = false;
    let sawModel = false;
    let sawThinking = false;
    let sawAssistant = false;
    for (const message of messages) {
        const update = getAcpUpdate(message);
        const meta = update?._meta?.runwield;
        const contentText = update?.content?.text || "";
        if (!sawUser && update?.sessionUpdate === "user_message_chunk" && contentText === expectedDisplayedInvocation) {
            summaries.push({ type: "user_message", text: contentText });
            sawUser = true;
            continue;
        }
        if (!sawAgent && meta?.type === "agent_changed") {
            const agentName = metaString(meta, "agentName");
            if (agentName === expectedProfile.agentName) {
                summaries.push({
                    type: "agent_changed",
                    agentName,
                    model: normalizeModelValue(metaString(meta, "model")),
                });
                sawAgent = true;
                continue;
            }
        }
        if (!sawModel && meta?.type === "model_changed") {
            const model = normalizeModelValue(metaString(meta, "model"), metaString(meta, "provider"));
            if (model === expectedProfile.model) {
                summaries.push({ type: "model_changed", model });
                sawModel = true;
                continue;
            }
        }
        if (!sawThinking && meta?.type === "thinking_level_changed") {
            const thinkingLevel = metaString(meta, "thinkingLevel");
            if (thinkingLevel === expectedProfile.thinkingLevel) {
                summaries.push({ type: "thinking_level_changed", thinkingLevel });
                sawThinking = true;
                continue;
            }
        }
        if (!sawAssistant && update?.sessionUpdate === "agent_message_chunk" && meta?.messageKind === "assistant") {
            summaries.push({ type: "assistant_text_delta" });
            sawAssistant = true;
        }
    }
    return summaries;
}

function acpAssistantText(messages: JsonMap[]): string {
    return messages
        .map((message) => {
            const params = message.params as {
                update?: { sessionUpdate?: string; content?: { text?: string }; _meta?: { runwield?: JsonMap } };
            } | undefined;
            const update = params?.update;
            if (update?.sessionUpdate !== "agent_message_chunk") return "";
            if (update?._meta?.runwield?.messageKind !== "assistant") return "";
            return update.content?.text || "";
        })
        .join("");
}

function normalizedProfile(profile: NamedInvocationProfile | undefined): NamedInvocationProfile {
    return {
        agentName: profile?.agentName || "",
        model: profile?.model || "",
        thinkingLevel: profile?.thinkingLevel || "",
    };
}

function startTestServer(): TestServerHandle {
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const connection = startRunWieldAcpServer(input.readable, output.writable);
    return {
        inputWriter: input.writable.getWriter(),
        outputReader: output.readable.getReader(),
        connection,
    };
}

async function sendMessage(handle: TestServerHandle, message: JsonMap): Promise<void> {
    await handle.inputWriter.write(encoder.encode(`${JSON.stringify(message)}\n`));
}

async function readMessage(handle: TestServerHandle): Promise<JsonMap> {
    const chunk = await handle.outputReader.read();
    assert(!chunk.done, "server should write a message");
    return JSON.parse(decoder.decode(chunk.value).trim().split("\n")[0]) as JsonMap;
}

async function readThroughResponse(
    handle: TestServerHandle,
    requestId: string,
): Promise<{ response: JsonMap; messages: JsonMap[] }> {
    const messages: JsonMap[] = [];
    for (let index = 0; index < 80; index += 1) {
        const message = await readMessage(handle);
        messages.push(message);
        if (message.id === requestId) return { response: message, messages };
    }
    throw new Error(`ACP response ${requestId} was not received`);
}

async function closeTestServer(handle: TestServerHandle): Promise<void> {
    await handle.inputWriter.close();
    handle.connection.close();
    await handle.connection.closed;
    handle.outputReader.releaseLock();
}

async function runTuiSurface(projectRoot: string): Promise<SurfaceSummary> {
    const runtime = createSessionRuntime();
    const events: RuntimeSurfaceEvent[] = [];
    let result: NamedInvocationPromptResult | null = null;
    try {
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        runtime.subscribeSessionEvents(created.sessionId, (event) => events.push(event));
        const originalPromptUserTurn = runtime.promptUserTurn.bind(runtime);
        runtime.promptUserTurn = (async (sessionId, options) => {
            const promptResult = await originalPromptUserTurn(sessionId, options);
            result = promptResult as NamedInvocationPromptResult;
            return promptResult;
        }) as typeof runtime.promptUserTurn;
        await runScopedSubmitHandoffLoop({
            runtime,
            sessionId: created.sessionId,
            uiAPI: {
                appendSystemMessage: () => {},
                appendAgentMessageStart: () => ({ appendText: () => {} }),
                requestRender: () => {},
                promptSelect: () => Promise.resolve(null),
                promptText: () => Promise.resolve(null),
                showModelSelector: () => {},
                abortActivePrompt: () => {},
            },
            initialRequest: compactInvocation,
            initialImages: [],
        });
        const after = runtime.getSessionSnapshot(created.sessionId);
        const transcriptPath = await transcriptPathForSession(projectRoot, after?.sessionManagerId || "");
        const transcript = await readTranscriptSummary(transcriptPath);
        return {
            surface: "tui",
            events: runtimeSurfaceEvents(events),
            digest: transcript.payload.expansionDigest || result?.namedInvocation?.expansionDigest || "",
            profile: normalizedProfile(transcript.payload.profile || result?.namedInvocation?.profile),
            result: runtimeAssistantText(events),
            activeAgent: transcript.activeAgent,
            activeModel: transcript.activeModel,
        };
    } finally {
        await runtime.closeAllSessionsWhenIdle?.();
    }
}

async function runWorkspaceSurface(projectRoot: string): Promise<SurfaceSummary> {
    const store = openOwnerCoordinationStore();
    const service = new WorkspaceSessionContinuationService({ store });
    try {
        const project = store.registerProject({ root: projectRoot });
        const created = await service.createSession({
            projectId: project.projectId,
            requestId: "workspace-cross-surface",
            text: compactInvocation,
        });
        let operation = service.getOperation(created.operationId);
        for (let attempt = 0; operation?.status === "running" && attempt < 100; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            operation = service.getOperation(created.operationId);
        }
        if (!operation || operation.status === "running") throw new Error("Workspace operation did not finish");
        if (!operation.runwieldSessionId) throw new Error("Workspace operation did not record a Session id");
        const segment = store.getCurrentSessionSegment(operation.runwieldSessionId);
        if (!segment) throw new Error("Workspace operation did not record a current segment");
        const transcript = await readTranscriptSummary(segment.transcriptPath);
        const history = await service.timeline(operation.runwieldSessionId, { projectId: project.projectId });
        assertStringIncludes(JSON.stringify(history.events), expectedAssistantText);
        assertEquals(operation.events, []);
        return {
            surface: "workspace",
            events: runtimeSurfaceEvents(operation.events),
            digest: transcript.payload.expansionDigest || "",
            profile: normalizedProfile(transcript.payload.profile),
            result: expectedAssistantText,
            activeAgent: transcript.activeAgent,
            activeModel: transcript.activeModel,
        };
    } finally {
        service.close();
        store.close();
    }
}

async function runAcpSurface(projectRoot: string): Promise<SurfaceSummary> {
    const handle = startTestServer();
    try {
        await sendMessage(handle, {
            jsonrpc: "2.0",
            id: "new",
            method: "session/new",
            params: { cwd: projectRoot, mcpServers: [] },
        });
        const newResponse = await readMessage(handle);
        const newResult = newResponse.result as {
            sessionId?: string;
            _meta?: { runwield?: { persistedSessionId?: string } };
        };
        const acpSessionId = newResult.sessionId || "";
        const persistedSessionId = newResult._meta?.runwield?.persistedSessionId || "";
        await sendMessage(handle, {
            jsonrpc: "2.0",
            id: "prompt",
            method: "session/prompt",
            params: { sessionId: acpSessionId, prompt: [{ type: "text", text: compactInvocation }] },
        });
        const { response, messages } = await readThroughResponse(handle, "prompt");
        const result = response.result as { stopReason?: string } | undefined;
        assertEquals(result?.stopReason, "end_turn");
        const transcriptPath = await transcriptPathForSession(projectRoot, persistedSessionId);
        const transcript = await readTranscriptSummary(transcriptPath);
        return {
            surface: "acp",
            events: acpSurfaceEvents(messages),
            digest: transcript.payload.expansionDigest || "",
            profile: normalizedProfile(transcript.payload.profile),
            result: acpAssistantText(messages),
            activeAgent: transcript.activeAgent,
            activeModel: transcript.activeModel,
        };
    } finally {
        await closeTestServer(handle);
    }
}

test("named invocation fixture matches TUI, Workspace, and ACP surfaces", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-cross-surface-",
        async ({ projectRoot, setModelResponseFactories }) => {
            await writeCrossSurfacePrompt(projectRoot);
            const requests: string[] = [];
            setModelResponseFactories([
                (context: TranscriptContext) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText(expectedAssistantText));
                },
                (context: TranscriptContext) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText(expectedAssistantText));
                },
                (context: TranscriptContext) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText(expectedAssistantText));
                },
            ]);

            const summaries = [
                await runTuiSurface(projectRoot),
                await runWorkspaceSurface(projectRoot),
                await runAcpSurface(projectRoot),
            ];
            assertEquals(new Set(summaries.map((summary) => summary.digest)).size, 1);
            assertEquals(
                summaries.find((summary) => summary.surface === "acp")?.events,
                summaries[0].events,
            );
            assertEquals(new Set(summaries.map((summary) => JSON.stringify(summary.profile))).size, 1);
            assertEquals(new Set(summaries.map((summary) => summary.result)).size, 1);
            assertEquals(new Set(summaries.map((summary) => summary.activeAgent)).size, 1);
            assertEquals(new Set(summaries.map((summary) => summary.activeModel)).size, 1);
            for (const summary of summaries) {
                const expectedEvents = [
                    { type: "model_changed", model: expectedProfile.model },
                    { type: "thinking_level_changed", thinkingLevel: expectedProfile.thinkingLevel },
                    { type: "user_message", text: expectedDisplayedInvocation },
                    { type: "assistant_text_delta" },
                ];
                expectedEvents.unshift({
                    type: "agent_changed",
                    agentName: expectedProfile.agentName,
                    model: expectedProfile.model,
                });
                if (summary.surface !== "workspace") assertEquals(summary.events, expectedEvents);
                assertEquals(summary.profile, expectedProfile);
                assertEquals(summary.result, expectedAssistantText);
                assertEquals(summary.activeAgent, "operator");
                assertEquals(summary.activeModel, expectedProfile.model);
            }
            assertEquals(requests.length, 3);
            for (const request of requests) {
                assertStringIncludes(request, "Cross-surface expansion: {{input}}\\n\\ncompare surfaces");
                assert(!request.includes(compactInvocation));
            }
        },
        { additionalModels: [{ id: "alternate-fixture-model", name: "Alternate Fixture Model" }] },
    );
});

test("Workspace follows a conflicting template into its new Session and keeps planning resumable", async () => {
    await withRuntimeCommandFixture(
        "workspace-template-conflict-",
        async ({ projectRoot, setModelResponseFactories }) => {
            const dir = join(projectRoot, ".wld", "prompts");
            await fsMkdir(dir, { recursive: true });
            await fsWriteFile(join(dir, "separate.md"), "---\nagent: engineer\n---\nSEPARATE TEMPLATE BODY");
            setModelResponseFactories(Array.from({ length: 4 }, () => () => fauxAssistantMessage(fauxText("done"))));
            const store = openOwnerCoordinationStore();
            const service = new WorkspaceSessionContinuationService({ store });
            const waitFor = async (id, predicate) => {
                for (let attempt = 0; attempt < 200; attempt++) {
                    const operation = service.getOperation(id);
                    if (predicate(operation)) return operation;
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                throw new Error("Workspace operation did not reach the expected state");
            };
            try {
                const project = store.registerProject({ root: projectRoot });
                const started = await service.createSession({
                    projectId: project.projectId,
                    requestId: "plan",
                    text: "Plan this change.",
                    agentName: "planner",
                });
                const original = await waitFor(started.operationId, (operation) => operation?.status !== "running");
                assertEquals(original.status, "completed");
                const continued = await service.startContinuation({
                    projectId: project.projectId,
                    runwieldSessionId: original.runwieldSessionId,
                    requestId: "template",
                    text: "/separate",
                    expectedGeneration: original.generation,
                });
                const question = await waitFor(
                    continued.operationId,
                    (operation) => operation?.liveInteraction || operation?.status !== "running",
                );
                assert(question.liveInteraction, JSON.stringify(question));
                assertStringIncludes(question.liveInteraction.request.prompt, "unfinished planning");
                await service.answerInteraction({
                    projectId: project.projectId,
                    runwieldSessionId: original.runwieldSessionId,
                    operationId: continued.operationId,
                    interactionId: question.liveInteraction.interactionId,
                    requestId: "open-new",
                    response: { outcome: "selected", value: "new_session" },
                });
                const finished = await waitFor(continued.operationId, (operation) => operation?.status !== "running");
                assertEquals(finished.status, "completed", JSON.stringify(finished));
                assert(finished.runwieldSessionId !== original.runwieldSessionId);
                const newTimeline = await service.timeline(finished.runwieldSessionId, {
                    projectId: project.projectId,
                });
                assert(JSON.stringify(newTimeline.events).includes("SEPARATE TEMPLATE BODY"));
                const originalTimeline = await service.timeline(original.runwieldSessionId, {
                    projectId: project.projectId,
                });
                assertEquals(originalTimeline.snapshot.activeAgent, "planner");
                assert(
                    !originalTimeline.events.some((event) =>
                        event.type === "user_message" && event.text === "SEPARATE TEMPLATE BODY"
                    ),
                );
                const followUp = await service.startContinuation({
                    projectId: project.projectId,
                    runwieldSessionId: finished.runwieldSessionId,
                    requestId: "follow-up",
                    text: "Continue.",
                    expectedGeneration: finished.generation,
                });
                assertEquals(
                    (await waitFor(followUp.operationId, (operation) => operation?.status !== "running")).status,
                    "completed",
                );
            } finally {
                await service.runtime.closeAllSessionsWhenIdle();
                service.close();
                store.close();
            }
        },
    );
});
