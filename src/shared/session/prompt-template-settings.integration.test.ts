import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseFactory, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { setCustomSetting } from "../settings.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../workflow/metrics.js";
import { SessionRuntime } from "./session-runtime.ts";
import { SessionHost } from "./session-host.ts";
import { openFileSessionStore } from "./file-session-store.ts";
import type { RuntimeInteractionRequest } from "./session-runtime-interactions.js";

function makeRuntime() {
    return new SessionRuntime({
        sessionHost: new SessionHost(),
        sessionStore: openFileSessionStore(),
        ownerProcessKind: "test",
        ownerInstanceId: crypto.randomUUID(),
    });
}

async function writeTemplate(root: string, fields: string[] = []) {
    const dir = join(root, ".wld", "prompts");
    await fsMkdir(dir, { recursive: true });
    await fsWriteFile(join(dir, "fixture.md"), ["---", ...fields, "---", "TEMPLATE BODY"].join("\n"));
}

test("new template sessions use Operator configuration and keep it on follow-up", async () => {
    await withRuntimeCommandFixture(
        "template-operator-defaults-",
        async ({ projectRoot, setModelResponseFactories }) => {
            await writeTemplate(projectRoot);
            await setCustomSetting(
                "agents",
                {
                    operator: { model: "runtime-command-fixture/operator-model", thinkingLevel: "high" },
                },
                "global",
                projectRoot,
            );
            const models: string[] = [];
            setModelResponseFactories(
                Array.from({ length: 8 }, (): FauxResponseFactory => (_context, _options, _state, model) => {
                    models.push(model.id);
                    return fauxAssistantMessage(fauxText("done"));
                }),
            );
            const runtime = makeRuntime();
            try {
                for (const deferred of [false, true]) {
                    const id = await runtime.createPromptReadySession({
                        cwd: projectRoot,
                        deferPersistenceUntilFirstMessage: deferred,
                    });
                    const result = await runtime.promptUserTurn(id, { initialRequest: "/fixture" });
                    assertEquals(result.namedInvocation?.profile, {
                        agentName: "operator",
                        model: "runtime-command-fixture/operator-model",
                        thinkingLevel: "high",
                    });
                    await runtime.promptUserTurn(id, { initialRequest: "continue" });
                    assertEquals(runtime.getSessionSnapshot(id)?.activeAgent, "operator");
                    assertEquals(runtime.getSessionSnapshot(id)?.thinkingLevel, "high");
                }
                assertEquals(models, Array(4).fill("operator-model"));
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        },
        { reasoning: true, additionalModels: [{ id: "operator-model", name: "Operator model", reasoning: true }] },
    );
});

test("template omissions keep explicit new-session selections and ongoing Session settings", async () => {
    await withRuntimeCommandFixture("template-inherit-settings-", async ({ projectRoot, setModelResponse }) => {
        await writeTemplate(projectRoot);
        setModelResponse("done");
        const runtime = makeRuntime();
        try {
            for (const agentName of ["router", "planner"]) {
                const id = await runtime.createPromptReadySession({
                    cwd: projectRoot,
                    agentName,
                    deferPersistenceUntilFirstMessage: true,
                });
                await runtime.reconfigureSessionModel(id, "alternate", "runtime-command-fixture");
                await runtime.setSessionThinkingLevel(id, "high");
                const first = await runtime.promptUserTurn(id, { initialRequest: "/fixture" });
                assertEquals(first.namedInvocation?.profile, {
                    agentName,
                    model: "runtime-command-fixture/alternate",
                    thinkingLevel: "high",
                });
                const second = await runtime.promptUserTurn(id, { initialRequest: "/fixture again" });
                assertEquals(second.namedInvocation?.profile, first.namedInvocation?.profile);
            }
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    }, { reasoning: true, additionalModels: [{ id: "alternate", name: "Alternate", reasoning: true }] });
});

test("template settings override manual selections and survive resume", async () => {
    await withRuntimeCommandFixture("template-override-resume-", async ({ projectRoot, setModelResponse }) => {
        await writeTemplate(projectRoot, ["model: runtime-command-fixture/alternate", "thinkingLevel: high"]);
        setModelResponse("done");
        const runtime = makeRuntime();
        try {
            const id = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "operator" });
            await runtime.reconfigureSessionModel(id, "fixture-model", "runtime-command-fixture");
            await runtime.setSessionThinkingLevel(id, "low");
            await runtime.promptUserTurn(id, { initialRequest: "/fixture" });
            const saved = runtime.getSessionSnapshot(id);
            assert(saved?.managed);
            await runtime.closeSessionWhenIdle(id);
            const resumed = await runtime.createInteractiveSession({
                cwd: projectRoot,
                mode: "continue",
                resumeSessionId: saved.managed.runwieldSessionId,
            });
            await runtime.promptUserTurn(resumed.sessionId, { initialRequest: "continue" });
            const after = runtime.getSessionSnapshot(resumed.sessionId);
            assertEquals(after?.activeAgent, "operator");
            assertEquals(after?.activeModel, { provider: "runtime-command-fixture", model: "alternate" });
            assertEquals(after?.thinkingLevel, "high");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    }, { reasoning: true, additionalModels: [{ id: "alternate", name: "Alternate", reasoning: true }] });
});

test("a conflicting template can be canceled without changing planning or sending its body", async () => {
    await withRuntimeCommandFixture("template-planning-cancel-", async ({ projectRoot, setModelResponseFactories }) => {
        await writeTemplate(projectRoot, ["agent: engineer"]);
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        const requests: string[] = [];
        setModelResponseFactories(Array.from({ length: 8 }, (): FauxResponseFactory => (context) => {
            requests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxText("Planning in progress."));
        }));
        const runtime = makeRuntime();
        try {
            const id = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "planner" });
            await runtime.promptUserTurn(id, { initialRequest: "Plan this change." });
            const before = runtime.getSessionSnapshot(id);
            const questions: RuntimeInteractionRequest[] = [];
            runtime.setInteractionAdapter(id, {
                supportsInteraction: () => true,
                requestInteraction: (request) => {
                    questions.push(request);
                    return { outcome: "canceled" };
                },
            });
            const result = await runtime.promptUserTurn(id, { initialRequest: "/fixture" });
            assertEquals(result.ok, false);
            assertEquals(result.restoreDraft, true);
            assertEquals(questions.length, 1);
            assertStringIncludes(questions[0].prompt, "unfinished planning");
            assertEquals(questions[0].options?.map((choice) => choice.label), ["Open in new session", "Cancel"]);
            assertEquals(requests.length, 1);
            await drainWorkflowMetrics();
            const commandRows = (await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8")).trim()
                .split("\n").map((line) => JSON.parse(line))
                .filter((row) => row.category === "command" && row.command === "fixture");
            assertEquals(commandRows.map((row) => [row.event, row.outcome]), [["command_started", undefined], [
                "command_finished",
                "canceled",
            ]]);
            const after = runtime.getSessionSnapshot(id);
            assertEquals(after?.activeAgent, before?.activeAgent);
            assertEquals(after?.activeModel, before?.activeModel);
            assertEquals(after?.workflowContext, before?.workflowContext);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("a conflicting template opens an ordinary new Session and preserves planning for resume", async () => {
    await withRuntimeCommandFixture("template-planning-new-", async ({ projectRoot, setModelResponseFactories }) => {
        await writeTemplate(projectRoot, ["agent: engineer"]);
        await setCustomSetting("workflowMetrics", true, "project", projectRoot);
        const requests: string[] = [];
        setModelResponseFactories(Array.from({ length: 8 }, (): FauxResponseFactory => (context) => {
            requests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(fauxText("done"));
        }));
        const runtime = makeRuntime();
        try {
            const id = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "planner" });
            await runtime.promptUserTurn(id, { initialRequest: "PLANNING-SENTINEL" });
            const before = runtime.getSessionSnapshot(id);
            let announcedId = "";
            let surfaceListening = false;
            let cleanups = 0;
            runtime.subscribeSessionEvents(id, (event) => {
                if (event.type === "session_replaced") {
                    assert(surfaceListening, "surface subscription must survive the workflow guard settlement");
                    announcedId = event.newSessionId;
                }
            });
            runtime.setInteractionAdapter(id, {
                supportsInteraction: () => true,
                requestInteraction: () => ({ outcome: "selected", value: "new_session" }),
            });
            const result = await runtime.promptUserTurn(id, {
                initialRequest: "/fixture",
                onTurnStarted: () => {
                    surfaceListening = true;
                    return () => {
                        surfaceListening = false;
                        cleanups++;
                    };
                },
            });
            assertEquals(cleanups, 1);
            assert(result.replacementSessionId);
            assertEquals(announcedId, result.replacementSessionId);
            assertEquals(result.ok, true);
            assertEquals(runtime.getSessionSnapshot(id)?.activeAgent, "planner");
            assertEquals(runtime.getSessionSnapshot(id)?.workflowContext, before?.workflowContext);
            assertEquals(runtime.getSessionSnapshot(result.replacementSessionId)?.activeAgent, "engineer");
            await drainWorkflowMetrics();
            const metrics = (await fsReadFile(getWorkflowMetricsFilePath(projectRoot), "utf8")).trim()
                .split("\n").map((line) => JSON.parse(line));
            const commands = metrics.filter((row) => row.category === "command" && row.command === "fixture");
            assertEquals(commands.map((row) => row.event), ["command_started", "command_finished"]);
            assertEquals(commands[0].commandId, commands[1].commandId);
            assertEquals(
                metrics.some((row) =>
                    row.event === "execution_started" &&
                    row.commandId === commands[0].commandId
                ),
                true,
            );
            assertStringIncludes(requests[1], "TEMPLATE BODY");
            assert(!requests[1].includes("PLANNING-SENTINEL"));
            await runtime.promptUserTurn(result.replacementSessionId, { initialRequest: "follow-up" });
            assertEquals(runtime.getSessionSnapshot(result.replacementSessionId)?.activeAgent, "engineer");
            await runtime.promptUserTurn(id, { initialRequest: "Resume planning." });
            assertStringIncludes(requests[3], "PLANNING-SENTINEL");
            assert(!requests[3].includes("TEMPLATE BODY"));
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("a conflicting execution Agent is protected and invalid settings do not submit a message", async () => {
    await withRuntimeCommandFixture("template-invalid-settings-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("done");
        const runtime = makeRuntime();
        try {
            const id = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "engineer" });
            await runtime.setActiveExecutionWorkflow(id, {
                planName: "",
                triageMeta: { classification: "QUICK_FIX" },
                executionAgent: "engineer",
                executionCwd: projectRoot,
            });
            await writeTemplate(projectRoot, ["agent: operator"]);
            await assertRejects(
                () => runtime.promptUserTurn(id, { initialRequest: "/fixture" }),
                Error,
                "Open a new session",
            );
            assertEquals(runtime.getSessionSnapshot(id)?.activeAgent, "engineer");
            let messages = 0;
            runtime.subscribeSessionEvents(id, (event) => {
                if (event.type === "user_message") messages++;
            });
            await writeTemplate(projectRoot, ["model: missing/model"]);
            await assertRejects(() => runtime.promptUserTurn(id, { initialRequest: "/fixture" }), Error);
            assertEquals(messages, 0);
            assertEquals(runtime.getSessionSnapshot(id)?.activeAgent, "engineer");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

test("changing Agent through a template uses that Agent defaults, while a manual Router choice is retained", async () => {
    await withRuntimeCommandFixture("template-agent-defaults-", async ({ projectRoot, setModelResponse }) => {
        await writeTemplate(projectRoot, ["agent: engineer"]);
        await setCustomSetting(
            "agents",
            {
                engineer: { model: "runtime-command-fixture/engineer-model", thinkingLevel: "low" },
            },
            "global",
            projectRoot,
        );
        setModelResponse("done");
        const runtime = makeRuntime();
        try {
            const id = await runtime.createPromptReadySession({
                cwd: projectRoot,
                agentName: "operator",
                deferPersistenceUntilFirstMessage: true,
            });
            await runtime.reconfigureSessionModel(id, "fixture-model", "runtime-command-fixture");
            await runtime.setSessionThinkingLevel(id, "high");
            const result = await runtime.promptUserTurn(id, { initialRequest: "/fixture" });
            assertEquals(result.namedInvocation?.profile, {
                agentName: "engineer",
                model: "runtime-command-fixture/engineer-model",
                thinkingLevel: "low",
            });
            await writeTemplate(projectRoot);
            const router = await runtime.createPromptReadySession({ cwd: projectRoot });
            await runtime.switchAgent(router, { agentName: "router", releaseActiveWorkflow: true });
            const selected = await runtime.promptUserTurn(router, { initialRequest: "/fixture" });
            assertEquals(selected.namedInvocation?.profile.agentName, "router");
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    }, { reasoning: true, additionalModels: [{ id: "engineer-model", name: "Engineer", reasoning: true }] });
});
