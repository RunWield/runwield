import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { join } from "@std/path";
import { AGENTS } from "../constants.js";
import { WORKFLOW_CONTEXT_CUSTOM_TYPE, type WorkflowContext } from "../shared/session/workflow-context-session.js";
import { ACTIVE_AGENT_CUSTOM_TYPE } from "../shared/session/active-agent-session.js";
import { openOwnerCoordinationStore } from "../shared/owner-coordination/index.js";
import { encodeCwdForSessionDir } from "../shared/session/root-session.js";
import { createSessionRuntime } from "../shared/session/session-runtime.ts";

export type ManagedSessionFixture = Awaited<ReturnType<typeof makeManagedSessionFixture>>;
type ManagedSessionFixtureOptions = {
    home?: string;
    projectRoot?: string;
    dbPath?: string;
    assistantMessages?: string[];
    workflowContext?: WorkflowContext;
};
type RecordedModelRequest = {
    messages: string;
};
type OwnerStore = ReturnType<typeof openOwnerCoordinationStore>;
type RuntimeHandle = {
    store: OwnerStore;
    runtime: ReturnType<typeof createSessionRuntime>;
    adoptedSessionId: string;
    ownerInstanceId: string;
    ownerProcessKind: "workspace" | "tui" | "acp" | "test";
    close(): Promise<void>;
};

function idFactory(prefix: string): () => string {
    let index = 0;
    return () => `${prefix}-${++index}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digestInput = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(digestInput).set(bytes);
    const digest = await crypto.subtle.digest("SHA-256", digestInput);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readTranscriptEvidence(transcriptPath: string) {
    const bytes = await Deno.readFile(transcriptPath);
    const lines = new TextDecoder().decode(bytes).trim().split("\n").filter(Boolean);
    const last = lines.length > 0 ? JSON.parse(lines.at(-1) ?? "{}") as { id?: string } : {};
    return {
        byteLength: bytes.length,
        digestHex: await sha256Hex(bytes),
        terminalEntryId: last.id ?? null,
    };
}

export async function appendTranscriptEntry(transcriptPath: string, entryId: string, content: string): Promise<void> {
    const entry = {
        type: "message",
        id: entryId,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: content }] },
    };
    await Deno.writeTextFile(transcriptPath, `${JSON.stringify(entry)}\n`, { append: true });
}

async function writeManagedTranscript(
    sessionBaseDir: string,
    root: string,
    piSessionId: string,
    assistantMessages: string[] = [],
    workflowContext?: WorkflowContext,
): Promise<string> {
    const canonicalRoot = await Deno.realPath(root);
    const sessionDir = join(sessionBaseDir, encodeCwdForSessionDir(canonicalRoot));
    await Deno.mkdir(sessionDir, { recursive: true });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const transcriptPath = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    const entries = [
        { type: "session", id: piSessionId, timestamp, cwd: root, name: "Managed fixture" },
        {
            type: "custom",
            id: "entry-agent",
            timestamp,
            customType: ACTIVE_AGENT_CUSTOM_TYPE,
            data: { agentName: AGENTS.IDEATOR },
        },
        { type: "message", id: "entry-user", timestamp, message: { role: "user", content: "Hello" } },
        {
            type: "message",
            id: "entry-assistant",
            timestamp,
            message: { role: "assistant", content: [{ type: "text", text: "Committed hello." }] },
        },
        ...(workflowContext
            ? [{
                type: "custom",
                id: "entry-workflow",
                timestamp,
                customType: WORKFLOW_CONTEXT_CUSTOM_TYPE,
                data: workflowContext,
            }]
            : []),
    ];
    const savedEntries = assistantMessages.length
        ? [
            ...entries.map((entry, index) => ({
                ...entry,
                ...(index === 0 ? { version: 3 } : { parentId: index === 1 ? null : entries[index - 1].id }),
            })),
            ...assistantMessages.map((text, index) => ({
                type: "message",
                id: `saved-reply-${index}`,
                parentId: index === 0 ? entries.at(-1)?.id : `saved-reply-${index - 1}`,
                timestamp: "2026-01-01T00:00:05.000Z",
                message: fauxAssistantMessage(fauxText(text)),
            })),
        ]
        : entries;
    await Deno.writeTextFile(transcriptPath, `${savedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return transcriptPath;
}

export async function makeManagedSessionFixture(options: ManagedSessionFixtureOptions = {}) {
    const createdHome = options.home ? null : await Deno.makeTempDir({ prefix: "runwield-managed-session-fixture-" });
    const home = options.home ?? createdHome ?? "";
    const projectRoot = options.projectRoot ?? join(home, "project");
    const dbPath = options.dbPath ?? join(home, ".wld", "owner-coordination.sqlite3");
    const sessionBaseDir = join(home, ".wld", "sessions");
    await Deno.mkdir(projectRoot, { recursive: true });
    const canonicalProjectRoot = await Deno.realPath(projectRoot);
    const sessionDir = join(sessionBaseDir, encodeCwdForSessionDir(canonicalProjectRoot));
    const modelRequests: RecordedModelRequest[] = [];
    const store = openOwnerCoordinationStore({ dbPath, sessionBaseDir });
    const project = store.registerProject({ root: projectRoot, idFactory: idFactory("project"), now: () => "t0" });
    const piSessionId = "pi-managed-fixture";
    const transcriptPath = await writeManagedTranscript(
        sessionBaseDir,
        projectRoot,
        piSessionId,
        options.assistantMessages,
        options.workflowContext,
    );
    const session = await store.ensureSessionCatalogRecord({
        projectId: project.projectId,
        piSessionId,
        transcriptPath,
        transcriptCwd: projectRoot,
        source: "catalog",
        idFactory: idFactory(`session-${crypto.randomUUID()}`),
        now: () => "t1",
    });
    let proof = store["acquireSessionActivation"]({
        runwieldSessionId: session.runwieldSessionId,
        projectId: project.projectId,
        ownerInstanceId: "fixture-bootstrap",
        ownerProcessKind: "test",
        operationId: "fixture-bootstrap-op",
        expectedGeneration: null,
        phase: "bootstrap",
        now: () => "2026-01-01T00:00:02.000Z",
    });
    proof = store["changeSessionActivationPhase"](proof, "checkpointing", {
        now: () => "2026-01-01T00:00:03.000Z",
    });
    const evidence = await readTranscriptEvidence(transcriptPath);
    store["publishGenerationAndRelease"](proof, {
        generation: 0,
        currentSegmentId: store.getCurrentSessionSegment(session.runwieldSessionId)?.segmentId ?? null,
        ...evidence,
    }, {
        now: () => "2026-01-01T00:00:04.000Z",
    });

    const openStore = () => openOwnerCoordinationStore({ dbPath, sessionBaseDir });
    const openRuntime = (
        ownerProcessKind: "workspace" | "tui" | "acp" | "test",
        ownerInstanceId: string,
    ): RuntimeHandle => {
        const runtimeStore = openStore();
        const runtime = createSessionRuntime({
            sessionStore: runtimeStore,
            ownerProcessKind,
            ownerInstanceId,
        });
        const activation = runtimeStore.inspectSessionActivation(session.runwieldSessionId);
        const adopted = runtime.adoptManagedSession({
            session,
            generation: activation.generation?.generation ?? 0,
            hostedSessionId: session.runwieldSessionId,
        });
        return {
            store: runtimeStore,
            runtime,
            adoptedSessionId: adopted.sessionId,
            ownerInstanceId,
            ownerProcessKind,
            async close() {
                await runtime.closeAllSessionsWhenIdle?.();
                runtimeStore.close();
            },
        };
    };
    const restartRuntime = async (previous: RuntimeHandle, ownerInstanceId = previous.ownerInstanceId) => {
        await previous.close();
        return openRuntime(previous.ownerProcessKind, ownerInstanceId);
    };
    const recordFixtureModelRequest = (request: RecordedModelRequest) => {
        modelRequests.push(request);
    };
    const recordedModelResponse = (text: string) => (context: { messages: Array<unknown> }) => {
        recordFixtureModelRequest({ messages: JSON.stringify(context.messages) });
        return fauxAssistantMessage(fauxText(text));
    };

    return {
        home,
        projectRoot,
        dbPath,
        sessionDir,
        project,
        session,
        transcriptPath,
        store,
        modelRequests,
        recordFixtureModelRequest,
        recordedModelResponse,
        openStore,
        openRuntime,
        restartRuntime,
        registerArtifact(path: string, title: string) {
            const proof = store["acquireSessionActivation"]({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "fixture-artifact",
                ownerProcessKind: "test",
                operationId: `fixture-artifact-${title}`,
                expectedGeneration: 0,
            });
            const artifact = store["registerSessionArtifact"](proof, {
                kind: "plan",
                path,
                title,
                registeredBy: "managed-session-fixture",
            });
            store["releaseUnchangedActivation"](proof);
            return artifact;
        },
        async readCanonicalFacts() {
            return {
                activation: store.inspectSessionActivation(session.runwieldSessionId),
                currentSegment: store.getCurrentSessionSegment(session.runwieldSessionId),
                transcriptEvidence: await readTranscriptEvidence(transcriptPath),
            };
        },
        async cleanup() {
            store.close();
            if (createdHome) await Deno.remove(createdHome, { recursive: true });
        },
    };
}

export async function makeLongReplayFixture(home: string, projectRoot: string) {
    const texts = Array.from({ length: 450 }, (_, index) => `Saved reply ${String(index + 1).padStart(3, "0")}.`);
    const fixture = await makeManagedSessionFixture({ home, projectRoot, assistantMessages: texts });
    return { ...fixture, texts };
}
