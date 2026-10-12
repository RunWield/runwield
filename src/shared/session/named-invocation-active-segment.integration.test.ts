import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { delimiter } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    getCurrentTools,
    type TranscriptContext,
} from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../workflow/metrics.js";
import { SessionRuntime } from "./session-runtime.ts";
import { SessionHost } from "./session-host.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import type { RuntimeInteractionRequest } from "./session-runtime-interactions.js";

interface NamedInvocationPromptResult {
    ok: boolean;
    namedInvocation?: {
        profile?: {
            agentName?: string;
            model?: string;
            thinkingLevel?: string;
        };
    };
}

interface NamedInvocationImageReference {
    ref?: string;
    path?: string;
    base64?: string;
    mimeType?: string;
}

interface PersistedNamedInvocationPayload {
    imageReferences?: NamedInvocationImageReference[];
}

interface PersistedTranscriptEntry {
    id?: string;
    parentId?: string;
    type?: string;
    customType?: string;
    data?: PersistedNamedInvocationPayload;
    message?: { role?: string; content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }> };
    targetId?: string;
    replacement?: {
        content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    } | null;
}

function makeRuntime(sessionStore = openFileSessionStore()) {
    return new SessionRuntime({
        sessionHost: new SessionHost(),
        sessionStore,
        ownerProcessKind: "test",
        ownerInstanceId: crypto.randomUUID(),
    });
}

test("bundled release from Router exposes an interactive interview before release work", async () => {
    await withRuntimeCommandFixture(
        "release-structured-interview-",
        async ({ projectRoot, setModelResponseFactories }) => {
            const questions: RuntimeInteractionRequest[] = [];
            let availableTools: string[] = [];
            let canceledResult = false;
            setModelResponseFactories([
                (context: TranscriptContext) => {
                    availableTools = getCurrentTools(context.messages).map((tool) => tool.name);
                    return fauxAssistantMessage(
                        fauxToolCall("user_interview", {
                            question: {
                                type: "multiple_choice",
                                prompt: "What kind of release operation should I run?",
                                choices: [
                                    { value: "create_candidate", label: "Create Candidate" },
                                    { value: "promote_candidate", label: "Promote Candidate" },
                                    { value: "create_stable_direct", label: "Create Stable Directly" },
                                ],
                            },
                        }),
                    );
                },
                (context: TranscriptContext) => {
                    canceledResult = context.messages.some(
                        (message) =>
                            message.role === "toolResult" &&
                            message.toolName === "user_interview" &&
                            message.content.some(
                                (content) => content.type === "text" && content.text.includes("Interview canceled"),
                            ),
                    );
                    return fauxAssistantMessage(fauxText("Release canceled."));
                },
            ]);
            const runtime = makeRuntime();
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                runtime.setInteractionAdapter(created.sessionId, {
                    supportsInteraction: () => true,
                    requestInteraction: (request: RuntimeInteractionRequest) => {
                        questions.push(request);
                        return { outcome: "canceled" };
                    },
                });
                const result = (await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "/release",
                    initialImages: [],
                })) as NamedInvocationPromptResult;
                assertEquals(result.ok, true);
                assertEquals(result.namedInvocation?.profile?.agentName, "engineer");
                assert(availableTools.includes("user_interview"));
                assertEquals(questions.length, 1);
                assertEquals(questions[0].type, "select");
                assertEquals(
                    questions[0].options?.map((option) => option.value),
                    ["create_candidate", "promote_candidate", "create_stable_direct", "other"],
                );
                assertEquals(canceledResult, true);
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.activeAgent, "engineer");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        },
    );
});

async function installClaudeCliFixture(binDir: string, logPath: string): Promise<void> {
    await fsMkdir(binDir, { recursive: true });
    const fixturePath = fileURLToPath(
        new URL("./backends/claude-cli/testing/fake-claude-mcp-client.ts", import.meta.url),
    );
    await writeRuntimeExecutableFixture(join(binDir, "claude"), fixturePath);
    await fsWriteFile(logPath, "");
}

async function readNamedInvocationPayloads(transcriptPath: string): Promise<PersistedNamedInvocationPayload[]> {
    const text = await fsReadFile(transcriptPath, "utf8");
    return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PersistedTranscriptEntry)
        .filter((entry) => entry.type === "custom" && entry.customType === "runwield.named_invocation")
        .map((entry) => entry.data || {});
}

test("Prompt Template invocation sends active Segment history plus the exact expansion", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-active-segment-",
        async ({ projectRoot, setModelResponseFactories }) => {
            await setCustomSetting("workflowMetrics", true, "project", projectRoot);
            const promptDir = join(projectRoot, ".wld", "prompts");
            await fsMkdir(promptDir, { recursive: true });
            await fsWriteFile(
                join(promptDir, "use-active-fact.md"),
                [
                    "---",
                    "agent: operator",
                    "---",
                    "Use the active-session fact to answer this request: {{input}}",
                    "",
                ].join("\n"),
            );

            const modelRequests: string[] = [];
            const recordToolRequest = (context: TranscriptContext) => {
                modelRequests.push(JSON.stringify(context.messages));
                return fauxAssistantMessage(
                    fauxToolCall("write", {
                        path: "tool-proof.txt",
                        content: "ACTIVE-TOOL-EXCHANGE\n",
                    }),
                );
            };
            const recordTextRequest = (context: TranscriptContext) => {
                modelRequests.push(JSON.stringify(context.messages));
                return fauxAssistantMessage(fauxText(`fixture response ${modelRequests.length}`));
            };
            setModelResponseFactories([recordTextRequest, recordToolRequest, recordTextRequest, recordTextRequest]);

            const store = openFileSessionStore();
            const runtime = makeRuntime(store);
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                const sessionId = created.sessionId;
                await runtime.switchAgent(sessionId, { agentName: "engineer" });

                const predecessor = await runtime.promptSession(sessionId, {
                    initialRequest: "SEALED-PREDECESSOR-SENTINEL must stay out of the active segment.",
                    initialImages: [],
                });
                assertEquals(predecessor.ok, true);
                const managedBeforeRoll = runtime.getSessionSnapshot(sessionId)?.managed;
                if (!managedBeforeRoll) throw new Error("expected managed Session metadata");
                await runtime.rollManagedSessionSegment(sessionId, {
                    kind: "semantic_repair",
                    continuation: { agentName: "engineer" },
                    expectedGeneration: managedBeforeRoll.generation,
                });
                await runtime.switchAgent(sessionId, { agentName: "engineer" });
                const managedAfterRoll = runtime.getSessionSnapshot(sessionId)?.managed;
                if (!managedAfterRoll) throw new Error("expected managed Session metadata after rollover");
                const segments = store.listSessionTranscriptSegments(managedAfterRoll.runwieldSessionId);
                assertEquals(segments.length, 2);
                assertEquals(typeof segments[0].sealedAt, "string");
                assertEquals(segments[1].segmentId, managedAfterRoll.currentSegmentId);
                assertEquals(segments[1].sealedAt, null);

                const active = await runtime.promptUserTurn(sessionId, {
                    initialRequest: "Remember active fact ACTIVE-SEGMENT-ALPHA.",
                    initialImages: [],
                });
                assertEquals(active.ok, true);

                const second = await runtime.promptUserTurn(sessionId, {
                    initialRequest: "/use-active-fact What fact did I give you?",
                    initialImages: [],
                });
                assertEquals(second.ok, true);
                await drainWorkflowMetrics();
                const metrics = (await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8"))
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line));
                const invocation = metrics.filter(
                    (row) => row.event === "command_started" && row.command === "use-active-fact",
                );
                assertEquals(invocation.length, 1);
                assertEquals(
                    metrics.filter(
                        (row) => row.event === "command_finished" && row.commandId === invocation[0].commandId,
                    ).length,
                    1,
                );
                assertEquals(
                    metrics.filter(
                        (row) => row.event === "execution_started" && row.commandId === invocation[0].commandId,
                    ).length > 0,
                    true,
                );
                assertEquals(
                    metrics.filter(
                        (row) =>
                            row.event === "execution_started" &&
                            row.commandId !== null &&
                            row.commandId !== invocation[0].commandId,
                    ).length,
                    0,
                );
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "operator");
                assertEquals(modelRequests.length, 4);

                const templateRequest = modelRequests[3];
                assertStringIncludes(templateRequest, "Remember active fact ACTIVE-SEGMENT-ALPHA.");
                assertStringIncludes(templateRequest, "ACTIVE-TOOL-EXCHANGE");
                assertStringIncludes(templateRequest, "fixture response 3");
                assertStringIncludes(
                    templateRequest,
                    "Use the active-session fact to answer this request: {{input}}\\n\\nWhat fact did I give you?",
                );
                assert(
                    !templateRequest.includes("SEALED-PREDECESSOR-SENTINEL"),
                    "the model does not receive sealed predecessor segment text",
                );
                assert(
                    !templateRequest.includes("/use-active-fact What fact did I give you?"),
                    "the model receives the resolved expansion, not the compact slash command",
                );
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
                store.close();
            }
        },
    );
});

test("Prompt Template invocation sends active Segment history plus the exact expansion through Claude CLI", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-claude-cli-",
        async ({ projectRoot, homeDir, setModelResponseFactories }) => {
            const promptDir = join(projectRoot, ".wld", "prompts");
            await fsMkdir(promptDir, { recursive: true });
            await fsWriteFile(
                join(promptDir, "claude-template.md"),
                [
                    "---",
                    "agent: operator",
                    "model: claude-cli/sonnet",
                    "thinkingLevel: off",
                    "---",
                    "Use the Claude CLI expansion: {{input}}",
                    "",
                ].join("\n"),
            );
            const binDir = join(homeDir, "claude-bin");
            const logPath = join(homeDir, "claude-log.jsonl");
            await installClaudeCliFixture(binDir, logPath);
            const previousPath = process.env["PATH"];
            const previousLog = process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"];
            process.env["PATH"] = `${binDir}${delimiter}${previousPath || ""}`;
            process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"] = logPath;

            const modelRequests: string[] = [];
            const recordToolRequest = (context: TranscriptContext) => {
                modelRequests.push(JSON.stringify(context.messages));
                return fauxAssistantMessage(
                    fauxToolCall("write", {
                        path: "claude-tool-proof.txt",
                        content: "ACTIVE-CLI-TOOL-EXCHANGE\n",
                    }),
                );
            };
            const recordTextRequest = (context: TranscriptContext) => {
                modelRequests.push(JSON.stringify(context.messages));
                return fauxAssistantMessage(fauxText(`claude fixture response ${modelRequests.length}`));
            };
            setModelResponseFactories([recordTextRequest, recordToolRequest, recordTextRequest]);

            const store = openFileSessionStore();
            const runtime = makeRuntime(store);
            const events: Array<{ type: string; model?: string; provider?: string; thinkingLevel?: string }> = [];
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                const sessionId = created.sessionId;
                await runtime.switchAgent(sessionId, { agentName: "engineer" });
                const predecessor = await runtime.promptSession(sessionId, {
                    initialRequest: "SEALED-CLI-PREDECESSOR-SENTINEL must stay out of the active segment.",
                    initialImages: [],
                });
                assertEquals(predecessor.ok, true);
                const managedBeforeRoll = runtime.getSessionSnapshot(sessionId)?.managed;
                if (!managedBeforeRoll) throw new Error("expected managed Session metadata");
                await runtime.rollManagedSessionSegment(sessionId, {
                    kind: "semantic_repair",
                    continuation: { agentName: "engineer" },
                    expectedGeneration: managedBeforeRoll.generation,
                });
                await runtime.switchAgent(sessionId, { agentName: "engineer" });
                const managedAfterRoll = runtime.getSessionSnapshot(sessionId)?.managed;
                if (!managedAfterRoll) throw new Error("expected managed Session metadata after rollover");
                const segments = store.listSessionTranscriptSegments(managedAfterRoll.runwieldSessionId);
                assertEquals(segments.length, 2);
                assertEquals(typeof segments[0].sealedAt, "string");
                assertEquals(segments[1].segmentId, managedAfterRoll.currentSegmentId);
                assertEquals(segments[1].sealedAt, null);

                const active = await runtime.promptUserTurn(sessionId, {
                    initialRequest: "Remember active Claude fact ACTIVE-CLI-SEGMENT-ALPHA.",
                    initialImages: [],
                });
                assertEquals(active.ok, true);
                runtime.subscribeSessionEvents(sessionId, (event) => {
                    if (
                        event.type === "agent_changed" ||
                        event.type === "model_changed" ||
                        event.type === "thinking_level_changed"
                    )
                        events.push(event);
                });

                const result: NamedInvocationPromptResult = await runtime.promptUserTurn(sessionId, {
                    initialRequest: "/claude-template inspect this fixture",
                    initialImages: [],
                });

                assertEquals(result.ok, true);
                assertEquals(result.namedInvocation?.profile, {
                    agentName: "operator",
                    model: "claude-cli/sonnet",
                    thinkingLevel: "off",
                });
                assertEquals(modelRequests.length, 3);
                const log = JSON.parse((await fsReadFile(logPath, "utf8")).trim().split("\n")[0]);
                assertStringIncludes(log.stdin, "Remember active Claude fact ACTIVE-CLI-SEGMENT-ALPHA.");
                assertStringIncludes(log.stdin, "Tool call write");
                assertStringIncludes(log.stdin, "ACTIVE-CLI-TOOL-EXCHANGE");
                assertStringIncludes(log.stdin, "Tool result write");
                assertStringIncludes(log.stdin, "claude fixture response 3");
                assertStringIncludes(log.stdin, "Use the Claude CLI expansion: {{input}}\n\ninspect this fixture");
                assert(
                    !log.stdin.includes("SEALED-CLI-PREDECESSOR-SENTINEL"),
                    "Claude CLI does not receive sealed predecessor segment text",
                );
                assert(
                    !log.stdin.includes("/claude-template inspect this fixture"),
                    "Claude CLI receives the expanded request, not the compact command",
                );
                assertEquals(
                    events.some(
                        (event) =>
                            event.type === "model_changed" &&
                            event.provider === "claude-cli" &&
                            (event.model === "sonnet" || event.model === "claude-cli/sonnet"),
                    ),
                    true,
                );
                assertEquals(
                    events.some((event) => event.type === "thinking_level_changed" && event.thinkingLevel === "off"),
                    true,
                );
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "operator");
                assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, {
                    provider: "claude-cli",
                    model: "sonnet",
                });
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
                store.close();
                if (previousPath === undefined) delete process.env["PATH"];
                else process.env["PATH"] = previousPath;
                if (previousLog === undefined) delete process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"];
                else process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"] = previousLog;
            }
        },
    );
});

test("Prompt Template invocation rejects unsupported Claude CLI thinking before process launch", async () => {
    await withRuntimeCommandFixture("named-invocation-claude-cli-thinking-", async ({ projectRoot, homeDir }) => {
        const promptDir = join(projectRoot, ".wld", "prompts");
        await fsMkdir(promptDir, { recursive: true });
        await fsWriteFile(
            join(promptDir, "claude-deep.md"),
            [
                "---",
                "agent: operator",
                "model: claude-cli/sonnet",
                "thinkingLevel: high",
                "---",
                "Think deeply through Claude CLI about {{input}}",
                "",
            ].join("\n"),
        );
        const binDir = join(homeDir, "claude-thinking-bin");
        const logPath = join(homeDir, "claude-thinking-log.jsonl");
        await installClaudeCliFixture(binDir, logPath);
        const previousPath = process.env["PATH"];
        const previousLog = process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"];
        process.env["PATH"] = `${binDir}${delimiter}${previousPath || ""}`;
        process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"] = logPath;

        const store = openFileSessionStore();
        const runtime = makeRuntime(store);
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const sessionId = created.sessionId;
            await runtime.switchAgent(sessionId, { agentName: "engineer" });
            const beforeSnapshot = runtime.getSessionSnapshot(sessionId);

            await assertRejects(
                () =>
                    runtime.promptUserTurn(sessionId, {
                        initialRequest: "/claude-deep this fixture",
                        initialImages: [],
                    }),
                Error,
                'does not support thinkingLevel "high" for RunWield named invocations',
            );

            assertEquals(await fsReadFile(logPath, "utf8"), "");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, beforeSnapshot?.activeAgent);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeModel, beforeSnapshot?.activeModel);
            assertEquals(
                runtime.getSessionSnapshot(sessionId)?.activeExecutionWorkflow,
                beforeSnapshot?.activeExecutionWorkflow,
            );
        } finally {
            await runtime.closeAllSessionsWhenIdle?.();
            store.close();
            if (previousPath === undefined) delete process.env["PATH"];
            else process.env["PATH"] = previousPath;
            if (previousLog === undefined) delete process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"];
            else process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"] = previousLog;
        }
    });
});

test("Prompt Template invocation uses ordinary Claude CLI handling for large requests", async () => {
    await withRuntimeCommandFixture("named-invocation-claude-capacity-", async ({ projectRoot, homeDir }) => {
        const promptDir = join(projectRoot, ".wld", "prompts");
        await fsMkdir(promptDir, { recursive: true });
        await fsWriteFile(
            join(promptDir, "too-large.md"),
            ["---", "agent: operator", "model: claude-cli/sonnet", "---", "x ".repeat(900_000)].join("\n"),
        );
        const binDir = join(homeDir, "claude-capacity-bin");
        const logPath = join(homeDir, "claude-capacity-log.jsonl");
        await installClaudeCliFixture(binDir, logPath);
        const previousPath = process.env["PATH"];
        const previousLog = process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"];
        process.env["PATH"] = `${binDir}${delimiter}${previousPath || ""}`;
        process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"] = logPath;
        const runtime = makeRuntime();
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const result = await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "/too-large",
                initialImages: [],
            });
            assertEquals(result.ok, true);
            const log = JSON.parse((await fsReadFile(logPath, "utf8")).trim().split("\n")[0]);
            assertStringIncludes(log.stdin, "x ".repeat(100));
        } finally {
            await runtime.closeAllSessionsWhenIdle?.();
            if (previousPath === undefined) delete process.env["PATH"];
            else process.env["PATH"] = previousPath;
            if (previousLog === undefined) delete process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"];
            else process.env["RUNWIELD_CLAUDE_FIXTURE_LOG"] = previousLog;
        }
    });
});

test("Prompt Template expansion survives a file-backed resume and follow-up", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-file-resume-",
        async ({ projectRoot, setModelResponseFactories }) => {
            const promptDir = join(projectRoot, ".wld", "prompts");
            await fsMkdir(promptDir, { recursive: true });
            await fsWriteFile(
                join(promptDir, "resume-template.md"),
                ["---", "agent: operator", "---", "Persisted expansion for {{input}}"].join("\n"),
            );
            const requests: string[] = [];
            setModelResponseFactories([
                (context) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("first response"));
                },
                (context) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("follow-up response"));
                },
                (context) => {
                    requests.push(JSON.stringify(context.messages));
                    return fauxAssistantMessage(fauxText("repeated invocation response"));
                },
            ]);

            const store = openFileSessionStore();
            const firstRuntime = makeRuntime(store);
            let runwieldSessionId = "";
            let transcriptPath = "";
            try {
                const created = await firstRuntime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                const result = await firstRuntime.promptUserTurn(created.sessionId, {
                    initialRequest: "/resume-template saved work",
                    initialImages: [],
                });
                assertEquals(result.ok, true);
                const managed = firstRuntime.getSessionSnapshot(created.sessionId)?.managed;
                if (!managed) throw new Error("expected managed Session metadata");
                runwieldSessionId = managed.runwieldSessionId;
                const segment = store.getCurrentSessionSegment(runwieldSessionId);
                if (!segment) throw new Error("expected active segment");
                transcriptPath = segment.transcriptPath;
            } finally {
                await firstRuntime.closeAllSessionsWhenIdle?.();
            }

            const resumedRuntime = makeRuntime(store);
            try {
                const resumed = await resumedRuntime.createInteractiveSession({
                    cwd: projectRoot,
                    mode: "continue",
                    resumeSessionId: runwieldSessionId,
                });
                const result = await resumedRuntime.promptUserTurn(resumed.sessionId, {
                    initialRequest: "Continue without repeating the earlier action.",
                    initialImages: [],
                });
                assertEquals(result.ok, true);
                const repeated = await resumedRuntime.promptUserTurn(resumed.sessionId, {
                    initialRequest: "/resume-template saved work",
                    initialImages: [],
                });
                assertEquals(repeated.ok, true);
            } finally {
                await resumedRuntime.closeAllSessionsWhenIdle?.();
                store.close();
            }

            assertEquals(requests.length, 3);
            for (const request of requests) {
                assertStringIncludes(request, "Persisted expansion for {{input}}\\n\\nsaved work");
                assertEquals(request.includes("/resume-template saved work"), false);
            }
            const transcriptEntries = (await fsReadFile(transcriptPath, "utf8"))
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as PersistedTranscriptEntry);
            const edits = transcriptEntries.filter((entry) => entry.type === "context_edit");
            assertEquals(edits.length, 2);
            assertEquals(new Set(edits.map((entry) => entry.targetId)).size, 2);
        },
    );
});

test("Prompt Template invocation stores persisted image references", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-image-reference-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const promptDir = join(projectRoot, ".wld", "prompts");
            await fsMkdir(promptDir, { recursive: true });
            await fsWriteFile(
                join(promptDir, "inspect-image.md"),
                ["---", "agent: operator", "---", "Inspect the attached image."].join("\n"),
            );
            let modelRequest = "";
            setModelResponseFactory((context) => {
                modelRequest = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxText("image inspected"));
            });
            const imageData =
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
            const store = openFileSessionStore();
            const runtime = makeRuntime(store);
            try {
                const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
                const result = await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "/inspect-image",
                    initialImages: [{ base64: imageData, mimeType: "image/png" }],
                });
                assertEquals(result.ok, true);
                const managed = runtime.getSessionSnapshot(created.sessionId)?.managed;
                if (!managed) throw new Error("expected managed Session metadata");
                const segment = store.getCurrentSessionSegment(managed.runwieldSessionId);
                if (!segment) throw new Error("expected active segment");
                const payloads = await readNamedInvocationPayloads(segment.transcriptPath);
                assertEquals(payloads.length, 1);
                const reference = payloads[0].imageReferences?.[0];
                assertEquals(reference?.mimeType, "image/png");
                assertStringIncludes(reference?.ref || "", "attachment:");
                assertStringIncludes(reference?.path || "", ".wld");
                assertStringIncludes(modelRequest, "Inspect the attached image.");
                assertStringIncludes(modelRequest, imageData);

                const transcriptEntries = (await fsReadFile(segment.transcriptPath, "utf8"))
                    .trim()
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => JSON.parse(line) as PersistedTranscriptEntry);
                const metadata = transcriptEntries.find(
                    (entry) => entry.type === "custom" && entry.customType === "runwield.named_invocation",
                );
                const userEntry = transcriptEntries.find(
                    (entry) =>
                        entry.type === "message" && entry.parentId === metadata?.id && entry.message?.role === "user",
                );
                assertEquals(userEntry?.message?.content?.[0], { type: "text", text: "/inspect-image" });
                assertEquals(userEntry?.message?.content?.[1], {
                    type: "image",
                    data: imageData,
                    mimeType: "image/png",
                });
                const contextEdit = transcriptEntries.find(
                    (entry) => entry.type === "context_edit" && entry.targetId === userEntry?.id,
                );
                assertEquals(contextEdit?.replacement?.content?.[0], {
                    type: "text",
                    text: "Inspect the attached image.",
                });
                assertEquals(contextEdit?.replacement?.content?.[1], {
                    type: "image",
                    data: imageData,
                    mimeType: "image/png",
                });
            } finally {
                await runtime.closeAllSessionsWhenIdle?.();
                store.close();
            }
        },
    );
});

test("Prompt Template invocation rejects unsupported thinking before a model call", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-unsupported-thinking-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const promptDir = join(projectRoot, ".wld", "prompts");
            await fsMkdir(promptDir, { recursive: true });
            await fsWriteFile(
                join(promptDir, "deep.md"),
                ["---", "agent: operator", "thinkingLevel: high", "---", "Think deeply about {{input}}"].join("\n"),
            );
            let modelCalls = 0;
            setModelResponseFactory((context: TranscriptContext) => {
                modelCalls += 1;
                return fauxAssistantMessage(fauxText(JSON.stringify(context.messages)));
            });

            const runtime = makeRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await assertRejects(
                () =>
                    runtime.promptUserTurn(created.sessionId, {
                        initialRequest: "/deep this fixture",
                        initialImages: [],
                    }),
                Error,
                'does not support thinkingLevel "high"',
            );
            assertEquals(modelCalls, 0);
        },
    );
});

test("Prompt Templates use the current workflow tools and ordinary execution path", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-workflow-authority-",
        async ({ projectRoot, setModelResponseFactory }) => {
            const promptDir = join(projectRoot, ".wld", "prompts");
            await fsMkdir(promptDir, { recursive: true });
            await fsWriteFile(
                join(promptDir, "finish-work.md"),
                ["---", "agent: engineer", "---", "Try to complete the workflow."].join("\n"),
            );
            let availableTools: string[] = [];
            setModelResponseFactory((context) => {
                availableTools = getCurrentTools(context.messages).map((tool) => tool.name);
                return fauxAssistantMessage(fauxText("Working within the current workflow."));
            });

            const runtime = makeRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const sessionId = created.sessionId;
            await runtime.switchAgent(sessionId, { agentName: "engineer" });
            await runtime.setActiveExecutionWorkflow(sessionId, {
                planName: "fixture-plan",
                triageMeta: { classification: "QUICK_FIX" },
                executionAgent: "engineer",
                executionCwd: projectRoot,
            });
            await runtime.promptUserTurn(sessionId, {
                initialRequest: "/finish-work",
                initialImages: [],
            });

            assert(availableTools.includes("task_completed"));
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeExecutionWorkflow?.executionAgent, "engineer");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.activeAgent, "engineer");
        },
    );
});

test("Prompt Template model override persists for ordinary follow-ups", async () => {
    await withRuntimeCommandFixture(
        "named-invocation-one-shot-model-",
        async ({ projectRoot, setModelResponseFactories }) => {
            const promptDir = join(projectRoot, ".wld", "prompts");
            await fsMkdir(promptDir, { recursive: true });
            await fsWriteFile(
                join(promptDir, "alt-model.md"),
                [
                    "---",
                    "agent: operator",
                    "model: runtime-command-fixture/alternate-fixture-model",
                    "---",
                    "Use the alternate model for {{input}}",
                ].join("\n"),
            );
            const usedModels: string[] = [];
            const respond: import("@earendil-works/pi-ai").FauxResponseFactory = (
                _context,
                _options,
                _state,
                model,
            ) => {
                usedModels.push(`${model.provider}/${model.id}`);
                return fauxAssistantMessage(fauxText("alternate model response"));
            };
            setModelResponseFactories([respond, respond]);

            const runtime = makeRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.switchAgent(created.sessionId, { agentName: "operator" });

            const result = await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "/alt-model this turn",
                initialImages: [],
            });

            assertEquals(result.ok, true);
            assertEquals(usedModels, ["runtime-command-fixture/alternate-fixture-model"]);
            assertEquals(runtime.getSessionSnapshot(created.sessionId)?.activeModel, {
                provider: "runtime-command-fixture",
                model: "alternate-fixture-model",
            });
            await runtime.promptUserTurn(created.sessionId, { initialRequest: "Continue with that model." });
            assertEquals(usedModels, [
                "runtime-command-fixture/alternate-fixture-model",
                "runtime-command-fixture/alternate-fixture-model",
            ]);
        },
        { additionalModels: [{ id: "alternate-fixture-model", name: "Alternate Fixture Model" }] },
    );
});
