import { assertEquals } from "../testing/assertions.ts";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { makeManagedSessionFixture, readTranscriptEvidence } from "../testing/managed-session-fixture.ts";
import { startRunWieldAcpServer } from "./server.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function startTestServer() {
    const input = new TransformStream();
    const output = new TransformStream();
    const diagnostics: string[] = [];
    const connection = startRunWieldAcpServer(input.readable, output.writable, {
        diagnostic: (message: string) => {
            diagnostics.push(message);
        },
    });
    return {
        inputWriter: input.writable.getWriter(),
        outputReader: output.readable.getReader(),
        connection,
        diagnostics,
    };
}

async function sendMessage(handle: ReturnType<typeof startTestServer>, message: Record<string, unknown>) {
    await handle.inputWriter.write(encoder.encode(`${JSON.stringify(message)}\n`));
}

async function readMessage(handle: ReturnType<typeof startTestServer>) {
    const chunk = await handle.outputReader.read();
    assert(!chunk.done, "server should write a message");
    return JSON.parse(decoder.decode(chunk.value).trim().split("\n")[0]) as Record<
        string,
        { runwield?: Record<string, string | number> } | string | number | Record<string, string>
    >;
}

async function readThroughResponse(handle: ReturnType<typeof startTestServer>, requestId: string) {
    const messages: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 80; index++) {
        const message = await readMessage(handle);
        messages.push(message);
        if (message.id === requestId) return { response: message, messages };
    }
    throw new Error(`ACP response ${requestId} was not received`);
}

async function closeTestServer(handle: ReturnType<typeof startTestServer>) {
    await handle.inputWriter.close();
    handle.connection.close();
    await handle.connection.closed;
    handle.outputReader.releaseLock();
}

async function writeAcpSuccessorTranscript(
    projectRoot: string,
    piSessionId: string,
    sessionDir: string,
): Promise<string> {
    const timestamp = "2026-01-01T00:03:00.000Z";
    const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    const header = { type: "session", id: piSessionId, timestamp, cwd: projectRoot, name: "ACP successor" };
    await fsWriteFile(path, `${JSON.stringify(header)}\n`);
    return path;
}

test("ACP load queues a prompt while Workspace owns activation and sends it after release", async () => {
    await withRuntimeCommandFixture(
        "acp-managed-session-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const workspace = fixture.openStore();
            const server = startTestServer();
            try {
                setModelResponseFactories([
                    fixture.recordedModelResponse("ACP first queued turn."),
                    fixture.recordedModelResponse("ACP second queued turn."),
                    fixture.recordedModelResponse("ACP accepted turn."),
                ]);
                const initial = workspace.inspectSessionActivation(fixture.session.runwieldSessionId).generation;
                const predecessorId = initial?.currentSegmentId ?? "";
                let rolloverProof = workspace.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "workspace-rollover-owner",
                    ownerProcessKind: "workspace",
                    operationId: "workspace-rollover-before-acp-load",
                    expectedGeneration: 0,
                    expectedCurrentSegmentId: predecessorId,
                    phase: "preparing",
                });
                rolloverProof = workspace.changeSessionActivationPhase(rolloverProof, "hydrated");
                rolloverProof = workspace.changeSessionActivationPhase(rolloverProof, "turning");
                rolloverProof = workspace.changeSessionActivationPhase(rolloverProof, "checkpointing");
                const successorPath = await writeAcpSuccessorTranscript(
                    fixture.projectRoot,
                    "pi-acp-successor",
                    fixture.sessionDir,
                );
                const successorSafeLocator = await workspace.validateSuccessorSegmentLocator({
                    projectId: fixture.project.projectId,
                    piSessionId: "pi-acp-successor",
                    transcriptPath: successorPath,
                    transcriptCwd: fixture.projectRoot,
                });
                workspace.commitSegmentRolloverAndPublish(rolloverProof, {
                    predecessorSegmentId: predecessorId,
                    predecessorEvidence: await readTranscriptEvidence(fixture.transcriptPath),
                    successor: {
                        runwieldSessionId: fixture.session.runwieldSessionId,
                        projectId: fixture.project.projectId,
                        piSessionId: "pi-acp-successor",
                        transcriptPath: successorPath,
                        transcriptCwd: fixture.projectRoot,
                        kind: "execution",
                        idFactory: () => "acp-successor-segment",
                    },
                    successorSafeLocator,
                    generationEvidence: {
                        generation: 1,
                        currentSegmentId: "acp-successor-segment",
                        ...(await readTranscriptEvidence(successorPath)),
                    },
                });

                const loadId = fixture.session.piSessionId;
                await sendMessage(server, {
                    jsonrpc: "2.0",
                    id: "load",
                    method: "session/load",
                    params: {
                        sessionId: loadId,
                        cwd: fixture.projectRoot,
                        mcpServers: [],
                        _meta: { runwield: { sessionPath: fixture.transcriptPath } },
                    },
                });
                const loaded = await readThroughResponse(server, "load");
                const loadResponse = loaded.response;
                assert(loadResponse.result, JSON.stringify(loadResponse));
                const loadMeta = loadResponse.result as { _meta?: { runwield?: Record<string, string | number> } };
                assertEquals(loadMeta._meta?.runwield?.persistedSessionId, fixture.session.runwieldSessionId);

                const currentSegmentId =
                    workspace.inspectSessionActivation(fixture.session.runwieldSessionId).generation
                        ?.currentSegmentId ?? null;
                assertEquals(currentSegmentId, "acp-successor-segment");
                const proof = workspace.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "workspace-owner",
                    ownerProcessKind: "workspace",
                    operationId: "workspace-active",
                    expectedGeneration: 1,
                    expectedCurrentSegmentId: currentSegmentId,
                    phase: "preparing",
                });
                await sendMessage(server, {
                    jsonrpc: "2.0",
                    id: "blocked-prompt",
                    method: "session/prompt",
                    params: { sessionId: loadId, prompt: [{ type: "text", text: "blocked" }] },
                });
                const blocked = await readThroughResponse(server, "blocked-prompt");
                assert(blocked.response.result, JSON.stringify(blocked.response));
                const blockedResult = blocked.response.result as {
                    _meta?: { runwield?: { queued?: boolean; queuedMessageId?: string } };
                };
                assertEquals(blockedResult._meta?.runwield?.queued, true);
                await sendMessage(server, {
                    jsonrpc: "2.0",
                    id: "second-blocked-prompt",
                    method: "session/prompt",
                    params: { sessionId: loadId, prompt: [{ type: "text", text: "second blocked" }] },
                });
                const secondBlocked = await readThroughResponse(server, "second-blocked-prompt");
                assert(secondBlocked.response.result, JSON.stringify(secondBlocked.response));
                assertEquals(fixture.modelRequests.length, 0);
                workspace.releaseUnchangedActivation(proof);
                for (let index = 0; index < 200; index++) {
                    const idle =
                        workspace.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state ===
                            "idle";
                    if (fixture.modelRequests.length === 2 && idle) break;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assertEquals(fixture.modelRequests.length, 2);
                assert(fixture.modelRequests[0]?.messages.includes("blocked"));
                assert(!fixture.modelRequests[0]?.messages.includes("second blocked"));
                assert(fixture.modelRequests[1]?.messages.includes("second blocked"));

                await sendMessage(server, {
                    jsonrpc: "2.0",
                    id: "accepted-prompt",
                    method: "session/prompt",
                    params: { sessionId: loadId, prompt: [{ type: "text", text: "accepted" }] },
                });
                const accepted = await readThroughResponse(server, "accepted-prompt");
                assert(accepted.response.result, JSON.stringify(accepted.response));
                for (let index = 0; index < 200; index++) {
                    const idle =
                        workspace.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state ===
                            "idle";
                    if (fixture.modelRequests.length === 3 && idle) break;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assertEquals(fixture.modelRequests.length, 3);
                const acceptedGeneration =
                    workspace.inspectSessionActivation(fixture.session.runwieldSessionId).generation;
                assertEquals(acceptedGeneration?.generation, 4);
                assertEquals(acceptedGeneration?.currentSegmentId, "acp-successor-segment");
                assertEquals(server.diagnostics.every((message) => !message.trim().startsWith("{")), true);
            } finally {
                await closeTestServer(server).catch(() => {});
                workspace.close();
                await fixture.cleanup();
            }
        },
    );
});
