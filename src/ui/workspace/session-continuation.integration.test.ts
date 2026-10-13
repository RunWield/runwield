import { fileURLToPath } from "node:url";
import { openNativeFileLock } from "../../shared/native-file-lock.ts";
// @ts-nocheck: Workspace service is JavaScript and returns projected event records.
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { makeTempFile } from "../../testing/temp-file.ts";
import { test } from "node:test";
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
import fs from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import {
    ownerNotificationsStreamApi,
    ownerProjectSessionsApi,
    ownerSessionArchiveApi,
    ownerSessionContinuationStartApi,
    ownerSessionCreateApi,
    ownerSessionUnarchiveApi,
} from "./routes/owner-session-api.js";
import { associatedPlanSession } from "./routes/owner-api.js";
import { createOwnerConnectionRegistry } from "./server/owner-connections.ts";
import { AGENTS } from "../../constants.js";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { setCustomSetting } from "../../shared/settings.js";
import { lockPath, manifestPath } from "../../shared/session/file-session-storage.ts";
import {
    appendTranscriptEntry,
    makeManagedSessionFixture,
    readTranscriptEvidence,
} from "../../testing/managed-session-fixture.ts";
import {
    disposeOperationBrowserNotifications,
    observeOperationBrowserNotifications,
    syncOperationBrowserNotificationLifecycle,
} from "./islands/SessionSurface.jsx";
import { readSessionName, WorkspaceSessionContinuationService } from "./server/session-continuation.js";

class BrowserNotification {
    static permission = "granted";
    static created = [];
    closed = false;
    onclick = null;

    constructor(title, options = {}) {
        this.title = title;
        this.options = options;
        BrowserNotification.created.push(this);
    }

    close() {
        this.closed = true;
    }
}

function installBrowserNotifications() {
    BrowserNotification.created = [];
    Reflect.set(globalThis, "Notification", BrowserNotification);
    Reflect.set(globalThis, "document", { visibilityState: "hidden", hasFocus: () => false });
    Reflect.set(globalThis, "focus", () => {});
    return {
        created: BrowserNotification.created,
        cleanup() {
            disposeOperationBrowserNotifications();
            Reflect.deleteProperty(globalThis, "Notification");
            Reflect.deleteProperty(globalThis, "document");
            Reflect.deleteProperty(globalThis, "focus");
        },
    };
}

async function waitForOperation(service, operationId) {
    for (let index = 0; index < 400; index++) {
        const operation = service.getOperation(operationId);
        if (operation.status !== "running" && operation.status !== "accepted") return operation;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return service.getOperation(operationId);
}

test("Workspace Session names prefer saved renames and fall back to the first user message", async () => {
    const namedPath = await makeTempFile({ prefix: "runwield-named-session-", suffix: ".jsonl" });
    const fallbackPath = await makeTempFile({ prefix: "runwield-fallback-session-", suffix: ".jsonl" });
    try {
        await fsWriteFile(
            namedPath,
            [
                { type: "session", id: "pi-1", name: "Real Session Name", timestamp: "2026-01-01T00:00:00.000Z" },
                { type: "message", message: { role: "user", content: "first message text" } },
                { type: "session_info", name: "Renamed Session" },
            ].map((entry) => JSON.stringify(entry)).join("\n"),
        );
        await fsWriteFile(
            fallbackPath,
            [
                { type: "session", id: "pi-2", timestamp: "2026-01-01T00:00:00.000Z" },
                {
                    type: "message",
                    message: { role: "user", content: [{ type: "text", text: "fallback first message" }] },
                },
            ].map((entry) => JSON.stringify(entry)).join("\n"),
        );

        assertEquals(await readSessionName(namedPath), "Renamed Session");
        await fsWriteFile(namedPath, '\n{"type":"session_info","name":"Renamed again"}\n{"type":', { flag: "a" });
        assertEquals(await readSessionName(namedPath), "Renamed again");
        assertEquals(await readSessionName(fallbackPath), "fallback first message");
        await fsWriteFile(
            fallbackPath,
            JSON.stringify({
                type: "message",
                message: { role: "user", content: "/commit these changes" },
            }) + "\n",
        );
        assertEquals(await readSessionName(fallbackPath), "/commit these changes");
    } finally {
        await fsRm(namedPath).catch(() => undefined);
        await fsRm(fallbackPath).catch(() => undefined);
    }
});

test("Workspace Session list prefers transcript name before stale catalog fallback", async () => {
    const fixture = await makeManagedSessionFixture();
    const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
    try {
        const path = manifestPath(fixture.sessionDir, fixture.session.runwieldSessionId);
        const manifest = JSON.parse(await fsReadFile(path, "utf8"));
        manifest.displayName = "Hello";
        await fsWriteFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

        const result = await service.listSessions(fixture.project.projectId);
        assertEquals(result.sessions[0].displayName, "Managed fixture");
    } finally {
        service.close();
        service.store.close();
        await fixture.cleanup();
    }
});

test("Workspace hides only unnamed empty Sessions and paginates the visible list", async () => {
    const fixture = await makeManagedSessionFixture();
    const store = fixture.openStore();
    const service = new WorkspaceSessionContinuationService({ store });
    try {
        for (const [index, name, content] of [[1, "", ""], [2, "Named empty", ""], [3, "", "Hello"]]) {
            const transcriptPath = `${fixture.sessionDir}/2026-01-0${index + 1}T00-00-00-000Z_list-${index}.jsonl`;
            const entries = [{
                type: "session",
                id: `list-${index}`,
                cwd: fixture.projectRoot,
                timestamp: `2026-01-0${index + 1}T00:00:00.000Z`,
            }];
            if (name) entries.push({ type: "session_info", name });
            if (content) entries.push({ type: "message", message: { role: "user", content } });
            await fsWriteFile(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
            await store.ensureSessionCatalogRecord({
                projectId: fixture.project.projectId,
                piSessionId: `list-${index}`,
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
                source: "catalog",
            });
        }
        const readFile = fs.readFile;
        const transcriptsRead = [];
        fs.readFile = (path, options) => {
            if (String(path).endsWith(".jsonl")) transcriptsRead.push(String(path));
            return readFile(path, options);
        };
        try {
            const recent = await service.listSessions(fixture.project.projectId, { pageSize: 1, includeTotal: false });
            assertEquals(recent.sessions.map((session) => session.displayName), ["Hello"]);
            assertEquals(recent.hasNext, true);
            assertEquals(recent.total, null);
            assertEquals(transcriptsRead.length, 2);
            transcriptsRead.length = 0;
            const response = await ownerProjectSessionsApi({
                params: { projectId: fixture.project.projectId },
                url: new URL("http://workspace.local/sessions?pageSize=1&includeTotal=false"),
                state: { store, sessionContinuation: service },
            });
            assertEquals(response.status, 200);
            const navigation = await response.json();
            assertEquals(navigation.total, null);
            assertEquals(navigation.hasNext, true);
            assertEquals(navigation.sessions.map((session) => session.displayName), ["Hello"]);
            assert(transcriptsRead.length <= 2);
        } finally {
            fs.readFile = readFile;
        }
        const first = await service.listSessions(fixture.project.projectId, { pageSize: 1 });
        const second = await service.listSessions(fixture.project.projectId, { pageSize: 1, page: 1 });
        const third = await service.listSessions(fixture.project.projectId, { pageSize: 1, page: 2 });
        assertEquals(first.total, 3);
        assertEquals(first.sessions[0].displayName, "Hello");
        assertEquals(second.sessions[0].displayName, "Named empty");
        assertEquals(third.sessions[0].displayName, "Managed fixture");
        assertEquals(third.hasNext, false);
        const recentLast = await service.listSessions(fixture.project.projectId, {
            pageSize: 1,
            page: 2,
            includeTotal: false,
        });
        assertEquals(recentLast.sessions, third.sessions);
        assertEquals(recentLast.hasNext, false);
        assertEquals((await service.listSessions(fixture.project.projectId, { includeEmpty: true })).total, 4);
    } finally {
        service.close();
        store.close();
        await fixture.cleanup();
    }
});

test("Workspace snapshots deliver Agent-stop browser notifications once through the Session observer", async () => {
    const fixture = await makeManagedSessionFixture();
    const browser = installBrowserNotifications();
    await setCustomSetting(
        "notifications",
        {
            enabled: true,
            events: { agentStopped: true, userInterview: false },
            suppressWhenFocused: false,
            terminalBell: false,
        },
        "project",
        fixture.projectRoot,
    );
    const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
    try {
        service.setOperation("operation-full", { status: "running", projectId: fixture.project.projectId, events: [] });
        for (let index = 0; index < 1100; index += 1) {
            service.appendOperationEvent("operation-full", { type: "system_status", message: `event ${index}` });
        }
        service.appendOperationEvent("operation-full", { type: "system_status", message: "latest progress" });
        service.appendOperationEvent("operation-full", {
            type: "attention_requested",
            reason: "agentStopped",
            agentName: "Guide",
            sessionName: "Managed fixture",
        });

        const getSnapshot = service.getOperation("operation-full");
        assertEquals(getSnapshot.browserNotificationPolicy, {
            enabled: true,
            events: { agentStopped: true },
            suppressWhenFocused: false,
        });
        assertEquals(getSnapshot.events.length, 1000);
        assertEquals(getSnapshot.events.at(-1), {
            type: "attention_requested",
            reason: "agentStopped",
            agentName: "Guide",
            sessionName: "Managed fixture",
        });

        let streamed = null;
        const unsubscribe = service.subscribeOperation("operation-full", (snapshot) => streamed = snapshot);
        unsubscribe();
        assertEquals(streamed.events.length, 1000);
        assertEquals(streamed.events.at(-1), getSnapshot.events.at(-1));

        const cursorRef = { current: null };
        const operationKeyRef = { current: null };
        const scopeKey = fixture.project.projectId;
        const current = { operationId: "operation-full", attempts: 0, scopeKey };
        syncOperationBrowserNotificationLifecycle({
            operationId: current.operationId,
            scopeKey,
            operationKeyRef,
            cursorRef,
        });
        observeOperationBrowserNotifications(current, streamed, cursorRef);
        observeOperationBrowserNotifications(current, streamed, cursorRef);
        observeOperationBrowserNotifications({ ...current, attempts: 1 }, getSnapshot, cursorRef);
        assertEquals(browser.created.length, 1);
        assertEquals(browser.created[0].title, "Guide: Agent stopped — Managed fixture");

        observeOperationBrowserNotifications(
            { ...current, operationId: "operation-restored", restored: true },
            getSnapshot,
            { current: null },
        );
        assertEquals(browser.created.length, 1);

        for (let index = 0; index < 1100; index++) {
            service.appendOperationEvent("operation-full", { type: "system_status", message: `later ${index}` });
        }
        service.appendOperationEvent("operation-full", {
            type: "attention_requested",
            reason: "agentStopped",
            agentName: "Guide",
            sessionName: "Done",
        });
        const terminalSnapshot = service.getOperation("operation-full");
        observeOperationBrowserNotifications(current, terminalSnapshot, cursorRef);
        syncOperationBrowserNotificationLifecycle({ operationId: null, scopeKey, operationKeyRef, cursorRef });
        assertEquals(browser.created.length, 2);
        assertEquals(browser.created[1].closed, false);

        syncOperationBrowserNotificationLifecycle({
            operationId: "operation-next",
            scopeKey,
            operationKeyRef,
            cursorRef,
        });
        assertEquals(browser.created[1].closed, true);
    } finally {
        browser.cleanup();
        service.close();
        service.store.close();
        await fixture.cleanup();
    }
});

test("Workspace continuation publishes once and a TUI observer resumes from the new cursor", async () => {
    await withRuntimeCommandFixture(
        "workspace-continuation-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const workspaceStore = fixture.openStore();
            const service = new WorkspaceSessionContinuationService({ store: workspaceStore });
            const tuiObserver = fixture.openStore();
            try {
                setModelResponseFactory(fixture.recordedModelResponse("Workspace turn."));
                const initialActivation = workspaceStore.inspectSessionActivation(fixture.session.runwieldSessionId);
                const initialTimeline = await service.timeline(fixture.session.runwieldSessionId, {
                    projectId: fixture.project.projectId,
                    limit: 20,
                });
                assertEquals(initialTimeline.snapshot.sessionStats, {
                    userMessages: 1,
                    assistantMessages: 1,
                    toolCalls: 0,
                    compactionCount: 0,
                });
                assertEquals(
                    workspaceStore.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state,
                    initialActivation.activation?.state,
                );

                await assertRejects(
                    () =>
                        service.startContinuation({
                            runwieldSessionId: fixture.session.runwieldSessionId,
                            projectId: fixture.project.projectId,
                            expectedGeneration: 99,
                            requestId: "stale-generation",
                            deviceId: "workspace-device",
                            text: "Stale view.",
                        }),
                    Error,
                    "exact committed generation",
                );
                const activeProof = workspaceStore.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "workspace-negative-owner",
                    ownerProcessKind: "workspace",
                    operationId: "workspace-negative-active",
                    expectedGeneration: 0,
                    expectedCurrentSegmentId: initialActivation.generation?.currentSegmentId ?? null,
                    phase: "preparing",
                });
                await assertRejects(
                    () =>
                        service.startContinuation({
                            runwieldSessionId: fixture.session.runwieldSessionId,
                            projectId: fixture.project.projectId,
                            expectedGeneration: 0,
                            requestId: "not-idle",
                            deviceId: "workspace-device",
                            text: "Not idle.",
                        }),
                    Error,
                    "still busy",
                );
                workspaceStore.releaseUnchangedActivation(activeProof);

                const pending = workspaceStore.createOrGetOperationReceipt({
                    deviceId: "workspace-device",
                    requestId: "pending-after-process-loss",
                    requestHash: "pending-hash",
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    expectedGeneration: 0,
                    kind: "continuation",
                });
                const recoveryService = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
                try {
                    const recoveredPending = recoveryService.getOperation(pending.operationId);
                    assertEquals(recoveredPending.status, "unknown");
                    assertEquals(recoveredPending.error, "operation_not_running");
                } finally {
                    recoveryService.close();
                    recoveryService.store.close();
                }

                const started = await service.startContinuation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    expectedGeneration: 0,
                    requestId: "continue-once",
                    deviceId: "workspace-device",
                    text: "Continue from Workspace.",
                });
                const duplicate = await service.startContinuation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    expectedGeneration: 0,
                    requestId: "continue-once",
                    deviceId: "workspace-device",
                    text: "Continue from Workspace.",
                });
                assertEquals(duplicate.operationId, started.operationId);

                const completed = await waitForOperation(service, started.operationId);
                assertEquals(completed.status, "completed", JSON.stringify(completed));
                assertEquals(completed.runwieldSessionId, fixture.session.runwieldSessionId);
                assertEquals(fixture.modelRequests.length, 1);

                const observedGeneration =
                    tuiObserver.inspectSessionActivation(fixture.session.runwieldSessionId).generation;
                const resumed = await service.timeline(fixture.session.runwieldSessionId, {
                    projectId: fixture.project.projectId,
                    cursorEventId: initialTimeline.nextCursor,
                    limit: 20,
                });
                const restartedService = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
                try {
                    const recovered = restartedService.getOperation(started.operationId);
                    assertEquals(recovered.status, "completed");
                    assertEquals(recovered.runwieldSessionId, fixture.session.runwieldSessionId);
                } finally {
                    restartedService.close();
                    restartedService.store.close();
                }

                assertEquals(observedGeneration?.generation, 1);
                assertEquals(resumed.generation, 1);
                assertEquals(resumed.events.some((event) => JSON.stringify(event).includes("Workspace turn.")), true);
            } finally {
                service.close();
                workspaceStore.close();
                tuiObserver.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace Session options and timeline expose supported Agy model facts", async () => {
    await withRuntimeCommandFixture("workspace-agy-options-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        const workspaceStore = fixture.openStore();
        const service = new WorkspaceSessionContinuationService({ store: workspaceStore });
        try {
            const options = await service.listSessionOptions(fixture.project.projectId);
            assertEquals(
                options.models
                    .filter((model) => model.provider === "agy-cli")
                    .map((model) => ({ id: model.id, backend: model.executionBackend })),
                [
                    { id: "gemini-3.8-flash", backend: "agy-cli" },
                    { id: "gemini-3.1-pro", backend: "agy-cli" },
                ],
            );
            assertEquals(options.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

            const activation = workspaceStore.inspectSessionActivation(fixture.session.runwieldSessionId);
            const proof = workspaceStore.acquireSessionActivation({
                runwieldSessionId: fixture.session.runwieldSessionId,
                projectId: fixture.project.projectId,
                ownerInstanceId: "workspace-agy-facts",
                ownerProcessKind: "workspace",
                expectedGeneration: 0,
                expectedCurrentSegmentId: activation.generation?.currentSegmentId ?? null,
                phase: "checkpointing",
            });
            await fsWriteFile(
                fixture.transcriptPath,
                [
                    { type: "model_change", id: "agy-model", provider: "agy-cli", modelId: "gemini-3.8-flash" },
                    { type: "thinking_level_change", id: "agy-thinking", thinkingLevel: "high" },
                    {
                        type: "custom",
                        id: "agy-backend",
                        customType: "runwield.execution_backend",
                        data: {
                            version: 1,
                            backend: "agy-cli",
                            provider: "agy-cli",
                            model: "gemini-3.8-flash",
                            thinkingLevel: "high",
                            effort: "high",
                            backendModel: "gemini-3.8-flash-high",
                        },
                    },
                ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
                { flag: "a" },
            );
            workspaceStore.publishGenerationAndRelease(proof, {
                generation: 1,
                currentSegmentId: activation.generation?.currentSegmentId ?? null,
                ...await readTranscriptEvidence(fixture.transcriptPath),
            });

            const timeline = await service.timeline(fixture.session.runwieldSessionId, {
                projectId: fixture.project.projectId,
                limit: 20,
            });
            assertEquals(timeline.snapshot.provider, "agy-cli");
            assertEquals(timeline.snapshot.model, "gemini-3.8-flash");
            assertEquals(timeline.snapshot.thinkingLevel, "high");
            assertEquals(timeline.snapshot.executionBackend, {
                backend: "agy-cli",
                provider: "agy-cli",
                model: "gemini-3.8-flash",
                thinkingLevel: "high",
                effort: "high",
                backendModel: "gemini-3.8-flash-high",
            });
            assertEquals(JSON.stringify(timeline.events).includes("_meta"), false);
        } finally {
            service.close();
            workspaceStore.close();
            await fixture.cleanup();
        }
    });
});

test("Workspace Agent defaults follow presets and manual choices expire on an Agent change", async () => {
    await withRuntimeCommandFixture("workspace-agent-defaults-", async ({ homeDir, projectRoot, setModelResponse }) => {
        const modelsPath = `${homeDir}/.wld/models.json`;
        const modelConfiguration = JSON.parse(await fsReadFile(modelsPath, "utf8"));
        for (const model of modelConfiguration.providers["runtime-command-fixture"].models) model.reasoning = true;
        await fsWriteFile(modelsPath, JSON.stringify(modelConfiguration));
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
        try {
            await setCustomSetting(
                "agents",
                {
                    ideator: { model: "runtime-command-fixture/fixture-model", thinkingLevel: "low" },
                    guide: { model: "runtime-command-fixture/alternate-model", thinkingLevel: "medium" },
                },
                "project",
                projectRoot,
            );
            await setCustomSetting(
                "modelPresets",
                {
                    chosen: {
                        agents: {
                            ideator: { model: "runtime-command-fixture/alternate-model", thinkingLevel: "high" },
                        },
                    },
                },
                "project",
                projectRoot,
            );
            await setCustomSetting("activeModelPreset", "chosen", "project", projectRoot);
            const options = await service.listSessionOptions(fixture.project.projectId);
            assert(options.agents.some((agent) => agent.name === AGENTS.ROUTER));
            assertEquals(options.agents.find((agent) => agent.name === AGENTS.IDEATOR).defaults, {
                model: "alternate-model",
                provider: "runtime-command-fixture",
                thinkingLevel: "high",
            });
            assertEquals(options.agents.find((agent) => agent.name === AGENTS.GUIDE).defaults, {
                model: "alternate-model",
                provider: "runtime-command-fixture",
                thinkingLevel: "medium",
            });
            assert(options.commands.some((command) => command.name === "agent"));
            assert(options.commands.some((command) => command.name.startsWith("skill:")));
            setModelResponse("Ready.");
            const created = await service.createSession({
                projectId: fixture.project.projectId,
                requestId: "agent-defaults",
                text: "Start here.",
                agentName: AGENTS.IDEATOR,
            });
            const completed = await waitForOperation(service, created.operationId);
            assertEquals(completed.status, "completed", JSON.stringify(completed));
            const readTimeline = () =>
                service.timeline(completed.runwieldSessionId, { projectId: fixture.project.projectId });
            let timeline = await readTimeline();
            assertEquals(timeline.snapshot.model, "alternate-model");
            assertEquals(timeline.snapshot.thinkingLevel, "high");
            await service.configureSession({
                projectId: fixture.project.projectId,
                runwieldSessionId: completed.runwieldSessionId,
                expectedGeneration: timeline.generation,
                provider: "runtime-command-fixture",
                model: "fixture-model",
                thinkingLevel: "low",
            });
            timeline = await readTimeline();
            const continuation = await service.startContinuation({
                projectId: fixture.project.projectId,
                runwieldSessionId: completed.runwieldSessionId,
                expectedGeneration: timeline.generation,
                requestId: "manual-follow-up",
                text: "Continue here.",
            });
            assertEquals((await waitForOperation(service, continuation.operationId)).status, "completed");
            timeline = await readTimeline();
            assertEquals(timeline.snapshot.model, "fixture-model");
            assertEquals(timeline.snapshot.thinkingLevel, "low");
            await service.configureSession({
                projectId: fixture.project.projectId,
                runwieldSessionId: completed.runwieldSessionId,
                expectedGeneration: timeline.generation,
                agentName: AGENTS.GUIDE,
            });
            timeline = await readTimeline();
            assertEquals(timeline.snapshot.activeAgent, AGENTS.GUIDE);
            assertEquals(timeline.snapshot.model, "alternate-model");
            assertEquals(timeline.snapshot.thinkingLevel, "medium");
        } finally {
            await service.runtime.closeAllSessionsWhenIdle();
            service.close();
            service.store.close();
            await fixture.cleanup();
        }
    }, { additionalModels: [{ id: "alternate-model", name: "Alternate" }] });
});

test("Workspace configuration stages Agent changes during a local active operation", async () => {
    await withRuntimeCommandFixture(
        "workspace-active-config-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const workspaceStore = fixture.openStore();
            const service = new WorkspaceSessionContinuationService({ store: workspaceStore });
            let releaseTurn = () => {};
            const turnReleased = new Promise((resolve) => {
                releaseTurn = resolve;
            });
            try {
                setModelResponseFactory(async (context) => {
                    fixture.recordFixtureModelRequest({ messages: JSON.stringify(context.messages) });
                    await turnReleased;
                    return fixture.recordedModelResponse("Workspace turn after staged config.")(context);
                });
                const started = await service.startContinuation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    expectedGeneration: 0,
                    requestId: "stage-agent-during-turn",
                    deviceId: "workspace-device",
                    text: "Continue while settings change.",
                });
                const staged = await service.configureSession({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    expectedGeneration: 0,
                    agentName: AGENTS.ROUTER,
                });
                assertEquals(staged.status, "staged");
                assertEquals(staged.pendingConfiguration?.agentName, AGENTS.ROUTER);
                assertEquals(service.getOperation(started.operationId).pendingConfiguration?.agentName, AGENTS.ROUTER);

                const thinkingChanged = await service.configureSession({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    expectedGeneration: 0,
                    thinkingLevel: "low",
                });
                assertEquals(thinkingChanged.status, "staged");
                assertEquals(thinkingChanged.pendingConfiguration?.agentName, AGENTS.ROUTER);

                releaseTurn();
                const completed = await waitForOperation(service, started.operationId);
                assertEquals(completed.status, "completed", JSON.stringify(completed));
                assertEquals(completed.pendingConfiguration, null);
                const timeline = await service.timeline(fixture.session.runwieldSessionId, {
                    projectId: fixture.project.projectId,
                    limit: 20,
                });
                assertEquals(timeline.snapshot.activeAgent, AGENTS.ROUTER);
                assertEquals(timeline.snapshot.thinkingLevel, "low");
                assertEquals(timeline.generation > 1, true);
            } finally {
                releaseTurn();
                service.close();
                workspaceStore.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace answers a live question in a separate TUI process", async () => {
    await withRuntimeCommandFixture("workspace-live-tui-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
        const storeUrl = new URL("../../shared/owner-coordination/index.js", import.meta.url).href;
        const runtimeUrl = new URL("../../shared/session/session-runtime.ts", import.meta.url).href;
        const code = `
            import { openOwnerCoordinationStore } from ${JSON.stringify(storeUrl)};
            import { createSessionRuntime } from ${JSON.stringify(runtimeUrl)};
            const store = openOwnerCoordinationStore({ dbPath: ${JSON.stringify(fixture.dbPath)} });
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "tui" });
            const session = store.getSessionById(${JSON.stringify(fixture.session.runwieldSessionId)});
            const adopted = runtime.adoptManagedSession({ session, generation: 0 });
            let dismissed = false;
            runtime.setInteractionAdapter(adopted.sessionId, {
                supportsInteraction: () => true,
                requestInteraction: (_request, signal) => new Promise(resolve => {
                    signal.addEventListener("abort", () => { dismissed = true; resolve({ outcome: "canceled" }); }, { once: true });
                }),
            });
            try {
                const answer = await runtime.requestInteraction(adopted.sessionId, { type: "text", prompt: "What should we build?" });
                console.log(JSON.stringify({ answer, dismissed }));
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        `;
        const child = spawnNativeProcess(process.execPath, {
            args: runtimeSourceArgs([
                "eval",
                "--config",
                fileURLToPath(new URL("../../../deno.json", import.meta.url)),
                code,
            ]),
            cwd: projectRoot,
            stdout: "piped",
            stderr: "piped",
            stdin: "null",
        });
        const outputPromise = collectProcessOutput(child);
        let finished = false;
        try {
            let live;
            for (let index = 0; index < 400; index++) {
                live = await service.liveSession(fixture.project.projectId, fixture.session.runwieldSessionId);
                if (live.operation?.liveInteraction) break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert(live?.operation?.liveInteraction, "The TUI question should appear in Workspace.");
            const operation = live.operation;
            assertEquals(operation.remote, true);
            const answer = {
                projectId: fixture.project.projectId,
                runwieldSessionId: fixture.session.runwieldSessionId,
                operationId: operation.operationId,
                interactionId: operation.liveInteraction.interactionId,
                requestId: "phone-answer",
                response: { outcome: "text", value: "A simple session screen." },
            };
            assertEquals((await service.answerInteraction(answer)).status, "accepted");
            // A lost HTTP response can retry without answering twice.
            assertEquals((await service.answerInteraction(answer)).status, "accepted");
            const output = await outputPromise;
            finished = true;
            assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
            assertEquals(JSON.parse(new TextDecoder().decode(output.stdout).trim()), {
                answer: { outcome: "text", value: "A simple session screen." },
                dismissed: true,
            });
            assertEquals((await service.refreshOperation(operation.operationId)).status, "completed");
            assertEquals(
                (await service.liveSession(fixture.project.projectId, fixture.session.runwieldSessionId)).operation,
                null,
            );
            await assertRejects(
                () => service.answerInteraction({ ...answer, requestId: "late-answer" }),
                Error,
                "not available",
            );
        } finally {
            if (!finished) {
                try {
                    child.kill();
                } catch { /* already stopped */ }
                await outputPromise;
            }
            await service.runtime.closeAllSessionsWhenIdle();
            service.close();
            service.store.close();
            await fixture.cleanup();
        }
    });
});

test("long Workspace history stays sendable and an open TUI continues the new conversation", async () => {
    await withRuntimeCommandFixture(
        "workspace-long-history-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            let tui;
            try {
                let proof = fixture.store.acquireSessionActivation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "history-fixture",
                    ownerProcessKind: "test",
                    expectedGeneration: 0,
                    phase: "bootstrap",
                });
                const entries = Array.from({ length: 1700 }, (_, index) => ({
                    type: "message",
                    id: `long-${index}`,
                    parentId: index ? `long-${index - 1}` : "entry-assistant",
                    timestamp: new Date(1700000000000 + index).toISOString(),
                    message: {
                        role: index % 2 ? "assistant" : "user",
                        content: [{ type: "text", text: `History message ${index}` }],
                    },
                }));
                await fsWriteFile(
                    fixture.transcriptPath,
                    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
                    { flag: "a" },
                );
                proof = fixture.store.changeSessionActivationPhase(proof, "checkpointing");
                fixture.store.publishGenerationAndRelease(proof, {
                    generation: 1,
                    currentSegmentId:
                        fixture.store.getCurrentSessionSegment(fixture.session.runwieldSessionId).segmentId,
                    ...await readTranscriptEvidence(fixture.transcriptPath),
                });
                tui = fixture.openRuntime("tui", "idle-tui");
                const latest = await service.timeline(fixture.session.runwieldSessionId, {
                    projectId: fixture.project.projectId,
                    latest: true,
                    limit: 200,
                });
                assertEquals(latest.events.length, 200);
                assert(latest.previousCursor);
                assertEquals(latest.complete, false);
                assert(JSON.stringify(latest.events).includes("History message 1699"));
                const earlier = await service.timeline(fixture.session.runwieldSessionId, {
                    projectId: fixture.project.projectId,
                    beforeEventId: latest.previousCursor,
                    limit: 200,
                });
                assertEquals(earlier.events.length, 200);
                assertEquals(
                    earlier.events.some((event) => latest.events.some((next) => event.eventId === next.eventId)),
                    false,
                );
                setModelResponseFactory(fixture.recordedModelResponse("I replied from Workspace."));
                const started = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: 1,
                    requestId: "long-history-message",
                    text: "Continue from my phone.",
                });
                assertEquals((await waitForOperation(service, started.operationId)).status, "completed");
                setModelResponseFactory(fixture.recordedModelResponse("Back at the terminal."));
                const result = await tui.runtime.promptUserTurn(tui.adoptedSessionId, {
                    initialRequest: "Continue here.",
                });
                assertEquals(result.ok, true);
                assertEquals(fixture.modelRequests.length, 2);
                assert(fixture.modelRequests[1].messages.includes("I replied from Workspace."));
                assert(fixture.modelRequests[1].messages.includes("Continue from my phone."));
                assertEquals(
                    fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation.generation,
                    3,
                );
            } finally {
                await tui?.close();
                await service.runtime.closeAllSessionsWhenIdle();
                service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace steering reaches the running Agent once and appears in the conversation", async () => {
    await withRuntimeCommandFixture(
        "workspace-steering-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            let release = () => {};
            const held = new Promise((resolve) => {
                release = resolve;
            });
            let modelStarted = false;
            try {
                setModelResponseFactories([async (context) => {
                    if (!modelStarted) {
                        modelStarted = true;
                        await held;
                    }
                    return fixture.recordedModelResponse("Starting your work.")(context);
                }, fixture.recordedModelResponse("Responding to your direction.")]);
                const started = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    requestId: "start-steer-turn",
                    expectedGeneration: 0,
                    text: "Start working.",
                });
                for (let index = 0; index < 400 && !modelStarted; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(modelStarted, JSON.stringify(service.getOperation(started.operationId)));
                const request = {
                    projectId: fixture.project.projectId,
                    operationId: started.operationId,
                    requestId: "steer-once",
                    text: "Use the existing implementation.",
                    images: [],
                };
                const results = await Promise.all([service.steerOperation(request), service.steerOperation(request)]);
                assertEquals(results.map((result) => result.queued), [true, true]);
                const live = await service.liveSession(fixture.project.projectId, fixture.session.runwieldSessionId);
                assertEquals(live.operation.queuedMessages.filter((message) => message.delivery === "steer").length, 1);
                release();
                assertEquals((await waitForOperation(service, started.operationId)).status, "completed");
                assertEquals(fixture.modelRequests.length, 2);
                assert(fixture.modelRequests[1].messages.includes("Use the existing implementation."));
                const timeline = await service.timeline(fixture.session.runwieldSessionId, {
                    projectId: fixture.project.projectId,
                });
                assertEquals(
                    timeline.events.filter((event) => event.type === "user_message" && event.text === request.text)
                        .length,
                    1,
                );
            } finally {
                release();
                await service.runtime.closeAllSessionsWhenIdle();
                service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("a new Workspace Session is discoverable before its first response finishes", async () => {
    await withRuntimeCommandFixture(
        "workspace-first-message-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const modelsPath = `${homeDir}/.wld/models.json`;
            const modelConfiguration = JSON.parse(await fsReadFile(modelsPath, "utf8"));
            modelConfiguration.providers["runtime-command-fixture"].models[0].reasoning = true;
            await fsWriteFile(modelsPath, JSON.stringify(modelConfiguration));
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            let release = () => {};
            const held = new Promise((resolve) => {
                release = resolve;
            });
            const requestedThinking: (string | undefined)[] = [];
            try {
                setModelResponseFactory(async (context, options) => {
                    requestedThinking.push(options?.reasoning);
                    await held;
                    return fixture.recordedModelResponse("Your new Session is ready.")(context);
                });
                const notifications = [];
                service.subscribeNotifications((event) => notifications.push(event));
                const started = await service.createSession({
                    projectId: fixture.project.projectId,
                    requestId: "first-message",
                    text: "Start here.",
                    agentName: AGENTS.IDEATOR,
                    thinkingLevel: "low",
                });
                let operation;
                for (let index = 0; index < 400; index++) {
                    operation = service.getOperation(started.operationId);
                    if ((operation.runwieldSessionId && requestedThinking.length) || operation.status !== "running") {
                        break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(operation.runwieldSessionId, JSON.stringify(operation));
                assertEquals(operation.status, "running");
                assertEquals(operation.sessionInfo.activeAgent, AGENTS.IDEATOR);
                assertEquals(operation.sessionInfo.activeModel.model, "runtime-command-fixture/fixture-model");
                assertEquals(operation.sessionInfo.thinkingLevel, "low");
                const observer = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
                try {
                    const attached = await observer.liveSession(fixture.project.projectId, operation.runwieldSessionId);
                    assertEquals(attached.operation.remote, true);
                    assertEquals(attached.operation.sessionInfo.activeAgent, AGENTS.IDEATOR);
                    assertEquals(attached.operation.sessionInfo.activeModel, operation.sessionInfo.activeModel);
                    assertEquals(attached.operation.sessionInfo.thinkingLevel, "low");
                    assertEquals(attached.operation.sessionInfo.planAssociations, []);
                } finally {
                    observer.close();
                    observer.store.close();
                }
                assertEquals(
                    (await service.liveSession(fixture.project.projectId, operation.runwieldSessionId)).operation
                        .operationId,
                    started.operationId,
                );
                release();
                assertEquals((await waitForOperation(service, started.operationId)).status, "completed");
                const timeline = await service.timeline(operation.runwieldSessionId, {
                    projectId: fixture.project.projectId,
                });
                assert(timeline.events.some((event) => event.type === "user_message" && event.text === "Start here."));
                assertEquals(timeline.snapshot.thinkingLevel, "low");
                assertEquals(requestedThinking, ["low"]);
                assertEquals(notifications.filter((item) => item.event.reason === "agentStopped").length, 1);
                assertEquals(notifications[0].event.notificationSurface, "workspace");
                assertEquals(
                    notifications[0].url,
                    `/projects/${fixture.project.projectId}/sessions/${operation.runwieldSessionId}`,
                );
            } finally {
                release();
                await service.runtime.closeAllSessionsWhenIdle();
                service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace opens an interrupted Session directly from its saved conversation", async () => {
    await withRuntimeCommandFixture("workspace-restart-", async ({ homeDir, projectRoot, setModelResponseFactory }) => {
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        const writer = fixture.openStore();
        let writerClosed = false;
        const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
        try {
            writer.acquireSessionActivation({
                runwieldSessionId: fixture.session.runwieldSessionId,
                projectId: fixture.project.projectId,
                expectedGeneration: 0,
                ownerInstanceId: "stopped-container",
                ownerProcessKind: "tui",
                operationId: "interrupted-turn",
                phase: "preparing",
            });
            await appendTranscriptEntry(
                fixture.transcriptPath,
                "last-saved-message",
                "Saved before the process stopped.",
            );
            writer.close();
            writerClosed = true;
            const timeline = await service.timeline(fixture.session.runwieldSessionId, {
                projectId: fixture.project.projectId,
                latest: true,
            });
            assertEquals(timeline.state, "idle");
            assertEquals(timeline.generation, 1);
            assert(
                timeline.events.some((event) => JSON.stringify(event).includes("Saved before the process stopped.")),
            );
            setModelResponseFactory(fixture.recordedModelResponse("Continuing after restart."));
            const started = await service.startContinuation({
                projectId: fixture.project.projectId,
                runwieldSessionId: fixture.session.runwieldSessionId,
                expectedGeneration: timeline.generation,
                requestId: "continue-after-restart",
                text: "Continue from here.",
            });
            const completed = await waitForOperation(service, started.operationId);
            assertEquals(completed.status, "completed", JSON.stringify(completed));
            assert(fixture.modelRequests[0].messages.includes("Saved before the process stopped."));
        } finally {
            if (!writerClosed) writer.close();
            await service.runtime.closeAllSessionsWhenIdle();
            service.close();
            service.store.close();
            await fixture.cleanup();
        }
    });
});

test("Workspace new image Session deduplicates concurrent prepared requests", async () => {
    let releasePreflight = () => {};
    const preflightStarted = new Promise((resolve) => {
        releasePreflight = resolve;
    });
    let shellCount = 0;
    const submittedModels = [];
    const service = new WorkspaceSessionContinuationService({
        store: {
            getProjectById: () => ({ id: "project-1", lifecycle: "enabled", currentRoot: "/tmp/project" }),
            requireEnabledProjectRoot: () => "/tmp/project",
        },
    });
    service.listSessionOptions = () =>
        Promise.resolve({
            agents: [{ name: AGENTS.ROUTER }],
            models: [],
            thinkingLevels: ["off"],
        });
    service.runtime = {
        createInteractiveSession: () => {
            shellCount += 1;
            return Promise.resolve({ sessionId: `shell-${shellCount}` });
        },
        preflightUserTurnImages: async () => {
            await preflightStarted;
            return { ok: true, mode: "direct", preparedModelOverride: "runtime-command-fixture/fixture-model" };
        },
        closeSessionWhenIdle: () => {},
        getSessionSnapshot: () => ({ managed: { runwieldSessionId: "rw-1" } }),
        getSessionBackgroundTaskState: () => null,
        setInteractionAdapter: () => {},
        subscribeSessionEvents: () => () => {},
        promptUserTurn: (_sessionId, options) => {
            submittedModels.push(options.preparedModelOverride || "");
            return Promise.resolve({ ok: true });
        },
    };

    const first = service.createSession({
        projectId: "project-1",
        requestId: "request-1",
        deviceId: "device-1",
        text: "look",
        images: [{ base64: btoa("img"), mimeType: "image/png" }],
    });
    const second = service.createSession({
        projectId: "project-1",
        requestId: "request-1",
        deviceId: "device-1",
        text: "look",
        images: [{ base64: btoa("img"), mimeType: "image/png" }],
    });
    releasePreflight();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    for (let index = 0; index < 20 && submittedModels.length === 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(firstResult.operationId, secondResult.operationId);
    assertEquals(shellCount, 1);
    assertEquals(submittedModels, ["runtime-command-fixture/fixture-model"]);
});

test("Workspace receives the final stop from TUI and ACP turns after steering, without polling", async () => {
    for (const ownerProcessKind of ["tui", "acp"]) {
        await withRuntimeCommandFixture(
            `workspace-alert-${ownerProcessKind}-`,
            async ({ homeDir, projectRoot, setModelResponseFactories }) => {
                const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
                const runtimeStore = fixture.openStore();
                const runtime = createSessionRuntime({ sessionStore: runtimeStore, ownerProcessKind });
                const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
                const notifications = [];
                service.subscribeNotifications((event) => notifications.push(event));
                let release = () => {};
                const held = new Promise((resolve) => release = resolve);
                let modelStarted = false;
                let turn;
                try {
                    setModelResponseFactories([async (context) => {
                        modelStarted = true;
                        await held;
                        return fixture.recordedModelResponse("First answer.")(context);
                    }, fixture.recordedModelResponse("Steering accepted.")]);
                    const adopted = runtime.adoptManagedSession({ session: fixture.session, generation: 0 });
                    turn = runtime.promptUserTurn(adopted.sessionId, {
                        initialRequest: "Start from the original surface.",
                    });
                    for (let index = 0; index < 400 && !modelStarted; index++) {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    assert(modelStarted);
                    const live = await service.liveSession(
                        fixture.project.projectId,
                        fixture.session.runwieldSessionId,
                    );
                    assert(live.operation?.remote);
                    const steered = await service.steerOperation({
                        projectId: fixture.project.projectId,
                        operationId: live.operation.operationId,
                        requestId: "phone-direction",
                        text: "Continue from Workspace.",
                        images: [],
                    });
                    assertEquals(steered.queued, true);
                    release();
                    await turn;
                    const settled = await service.refreshOperation(live.operation.operationId);
                    assertEquals(settled.status, "completed");
                    assertEquals(service.remoteNotificationStreams.size, 0);
                    assertEquals(service.operations.get(live.operation.operationId)?.events.length, 0);
                    // No Session page or operation polling is involved in alert delivery.
                    for (let index = 0; index < 100 && notifications.length === 0; index++) {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    assertEquals(notifications.filter((item) => item.event.reason === "agentStopped").length, 1);
                    assertEquals(notifications[0].event.notificationSurface, "workspace");
                    assertEquals(
                        notifications[0].url,
                        `/projects/${fixture.project.projectId}/sessions/${fixture.session.runwieldSessionId}`,
                    );
                } finally {
                    release();
                    await turn?.catch(() => {});
                    service.close();
                    await runtime.closeAllSessionsWhenIdle();
                    runtimeStore.close();
                    service.store.close();
                    await fixture.cleanup();
                }
            },
        );
    }
});

test("Workspace notification stream routes live events and closes when its device is revoked", async () => {
    const fixture = await makeManagedSessionFixture();
    const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
    const connections = createOwnerConnectionRegistry();
    try {
        service.setOperation("notification-operation", {
            status: "running",
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            events: [],
        });
        const response = ownerNotificationsStreamApi({
            state: {
                sessionContinuation: service,
                ownerDevice: { deviceId: "paired-browser" },
                ownerConnections: connections,
            },
        });
        const reader = response.body.getReader();
        assertEquals(new TextDecoder().decode((await reader.read()).value), ": connected\n\n");
        service.appendOperationEvent("notification-operation", {
            type: "attention_requested",
            reason: "agentStopped",
            notificationSurface: "tui",
            sessionName: "Terminal only",
        });
        service.appendOperationEvent("notification-operation", {
            type: "attention_requested",
            reason: "agentStopped",
            notificationSurface: "workspace",
            sessionName: "History",
            eventId: "saved:1",
        });
        service.appendOperationEvent("notification-operation", {
            type: "attention_requested",
            reason: "agentStopped",
            notificationSurface: "workspace",
            sessionName: "Live Workspace stop",
        });
        const frame = new TextDecoder().decode((await reader.read()).value);
        const notification = JSON.parse(frame.slice(6));
        assertEquals(notification.event.sessionName, "Live Workspace stop");
        assertEquals(
            notification.url,
            `/projects/${fixture.project.projectId}/sessions/${fixture.session.runwieldSessionId}`,
        );
        assertEquals(connections.closeDevice("paired-browser"), 1);
        assertEquals((await reader.read()).done, true);
        assertEquals(service.notificationListeners.size, 0);
    } finally {
        connections.closeAll();
        service.close();
        service.store.close();
        await fixture.cleanup();
    }
});

test("Workspace image rejection returns 422 before accepting new or resumed turns", async () => {
    await withRuntimeCommandFixture(
        "workspace-image-http-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            const state = { store: service.store, sessionContinuation: service };
            const params = {
                projectId: fixture.project.projectId,
                runwieldSessionId: fixture.session.runwieldSessionId,
            };
            const body = {
                requestId: "image-request",
                expectedGeneration: 0,
                text: "  inspect image  ",
                agentName: AGENTS.IDEATOR,
                images: [{ base64: btoa("img"), mimeType: "image/png" }],
            };
            const request = () =>
                new Request("http://localhost/image", {
                    method: "POST",
                    body: JSON.stringify(body),
                    headers: { "content-type": "application/json" },
                });
            try {
                setModelResponseFactory(fixture.recordedModelResponse("Ready for images."));
                const initial = await service.createSession({
                    projectId: params.projectId,
                    requestId: "initial-text",
                    text: "Start a conversation.",
                    agentName: AGENTS.IDEATOR,
                });
                const completed = await waitForOperation(service, initial.operationId);
                assertEquals(completed.status, "completed");
                params.runwieldSessionId = completed.runwieldSessionId;
                body.expectedGeneration = completed.generation;
                const saved = service.store.getSessionById(params.runwieldSessionId);
                // Persist the model change through the real service, as the browser does.
                await service.configureSession({
                    projectId: params.projectId,
                    runwieldSessionId: params.runwieldSessionId,
                    expectedGeneration: body.expectedGeneration,
                    model: "gemini-3.8-flash",
                    provider: "agy-cli",
                });
                body.expectedGeneration =
                    service.store.inspectSessionActivation(params.runwieldSessionId).generation.generation;
                const beforeRejection = await readTranscriptEvidence(saved.transcriptPath);
                await setCustomSetting(
                    "agents",
                    { [AGENTS.IDEATOR]: { model: "agy-cli/gemini-3.8-flash" } },
                    "project",
                    projectRoot,
                );
                for (const route of [ownerSessionCreateApi, ownerSessionContinuationStartApi]) {
                    const response = await route({ state, params, req: request() });
                    assertEquals(response.status, 422, await response.clone().text());
                    assertEquals(await response.json(), {
                        error: "Antigravity CLI sessions do not support image attachments.",
                    });
                }
                assertEquals(await readTranscriptEvidence(saved.transcriptPath), beforeRejection);
                assertEquals(
                    service.store.inspectSessionActivation(params.runwieldSessionId).generation.generation,
                    body.expectedGeneration,
                );
                assertEquals(service.operations.size, 1);
                assertEquals(service.createRequests.size, 1);
                await setCustomSetting(
                    "agents",
                    { [AGENTS.IDEATOR]: { model: "runtime-command-fixture/fixture-model" } },
                    "project",
                    projectRoot,
                );
                await service.configureSession({
                    projectId: params.projectId,
                    runwieldSessionId: params.runwieldSessionId,
                    expectedGeneration: body.expectedGeneration,
                    model: "fixture-model",
                    provider: "runtime-command-fixture",
                });
                body.expectedGeneration =
                    service.store.inspectSessionActivation(params.runwieldSessionId).generation.generation;
                setModelResponseFactory(fixture.recordedModelResponse("Image received."));
                const accepted = await ownerSessionContinuationStartApi({ state, params, req: request() });
                assertEquals(accepted.status, 202, await accepted.clone().text());
                const operation = await accepted.json();
                const replay = await ownerSessionContinuationStartApi({ state, params, req: request() });
                assertEquals((await replay.json()).operationId, operation.operationId);
                assertEquals((await waitForOperation(service, operation.operationId)).status, "completed");
                assertEquals(fixture.modelRequests.length, 2);
            } finally {
                await service.runtime.closeAllSessionsWhenIdle();
                service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("sidebar expansion reads only five unseen matching Session names plus lookahead", async () => {
    const fixture = await makeManagedSessionFixture();
    const store = fixture.openStore();
    const service = new WorkspaceSessionContinuationService({ store });
    const ids = new Map();
    const readFile = fs.readFile;
    try {
        for (let i = 1; i <= 20; i++) {
            const timestamp = `2026-09-${String(i).padStart(2, "0")}T00:00:00.000Z`;
            const transcriptPath = `${fixture.sessionDir}/${timestamp.replace(/[:.]/g, "-")}_expand-${i}.jsonl`;
            const entries = [{ type: "session", id: `expand-${i}`, cwd: fixture.projectRoot, timestamp }, {
                type: "session_info",
                id: `name-${i}`,
                name: `Recent ${i}`,
            }];
            await fsWriteFile(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
            const session = await store.ensureSessionCatalogRecord({
                projectId: fixture.project.projectId,
                piSessionId: `expand-${i}`,
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
                source: "catalog",
            });
            ids.set(i, session.runwieldSessionId);
            if (i === 15) {
                const segmentId = store.getCurrentSessionSegment(session.runwieldSessionId).segmentId;
                await fsWriteFile(
                    transcriptPath,
                    JSON.stringify({
                        type: "custom",
                        id: "association",
                        customType: "runwield.plan_association",
                        data: {
                            planId: "nested-plan",
                            planName: "Nested",
                            purpose: "planning",
                            segmentId,
                            segmentKind: "session",
                            recordedAt: timestamp,
                        },
                    }) + "\n",
                    { flag: "a" },
                );
                let proof = store.acquireSessionActivation({
                    runwieldSessionId: session.runwieldSessionId,
                    projectId: fixture.project.projectId,
                    ownerInstanceId: "test",
                    ownerProcessKind: "test",
                    expectedGeneration: null,
                    phase: "bootstrap",
                });
                store.stagePlanAssociation(proof, {
                    planId: "nested-plan",
                    planName: "Nested",
                    purpose: "planning",
                    segmentId,
                    segmentKind: "session",
                    recordedAt: timestamp,
                });
                proof = store.changeSessionActivationPhase(proof, "checkpointing");
                store.publishGenerationAndRelease(proof, {
                    generation: 0,
                    currentSegmentId: segmentId,
                    ...await readTranscriptEvidence(transcriptPath),
                });
            }
        }
        const reads = [];
        fs.readFile = (path, options) => {
            if (String(path).endsWith(".jsonl")) reads.push(String(path));
            return readFile(path, options);
        };
        const query = new URLSearchParams({
            pageSize: "5",
            includeTotal: "false",
            excludeAssociated: "true",
            nestedPlan: "nested-plan",
        });
        for (let i = 16; i <= 20; i++) query.append("excludeSession", ids.get(i));
        const response = await ownerProjectSessionsApi({
            params: { projectId: fixture.project.projectId },
            url: new URL(`http://workspace.local/sessions?${query}`),
            state: { store, sessionContinuation: service },
        });
        assertEquals(response.status, 200);
        const result = await response.json();
        assertEquals(result.sessions.map((session) => session.displayName), [
            "Recent 14",
            "Recent 13",
            "Recent 12",
            "Recent 11",
            "Recent 10",
        ]);
        assertEquals(result.hasNext, true);
        assertEquals(result.total, null);
        assertEquals(reads.length, 6);
        assertEquals(reads.some((path) => path.endsWith("expand-15.jsonl")), false);
    } finally {
        fs.readFile = readFile;
        service.close();
        store.close();
        await fixture.cleanup();
    }
});

function archiveRouteContext(service, fixture, body = {}, projectId = fixture.project.projectId) {
    return {
        req: new Request("http://localhost/archive", { method: "POST", body: JSON.stringify(body) }),
        params: { projectId, runwieldSessionId: fixture.session.runwieldSessionId },
        state: { store: service.store, sessionContinuation: service },
    };
}

test("Workspace archive API persists across restart and filters before pagination", async () => {
    const fixture = await makeManagedSessionFixture();
    let service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
    try {
        const lock = openNativeFileLock(lockPath(fixture.sessionDir, fixture.session.runwieldSessionId));
        try {
            lock.lockSync(true);
            assertEquals((await ownerSessionArchiveApi(archiveRouteContext(service, fixture))).status, 409);
            assertEquals(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt, null);
        } finally {
            lock.unlockSync();
            lock.close();
        }
        const originalSegments = service.store.listSessionTranscriptSegments(fixture.session.runwieldSessionId);
        const originalGeneration = service.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation;
        const archivedIds = [fixture.session.runwieldSessionId];
        for (let index = 0; index < 3; index++) {
            const transcriptPath = `${fixture.sessionDir}/2026-01-0${index + 2}T00-00-00-000Z_archive-${index}.jsonl`;
            await fsWriteFile(
                transcriptPath,
                JSON.stringify({
                    type: "session",
                    id: `archive-${index}`,
                    cwd: fixture.projectRoot,
                    timestamp: `2026-01-0${index + 2}T00:00:00.000Z`,
                    name: `Session ${index}`,
                }) + "\n",
            );
            const session = await service.store.ensureSessionCatalogRecord({
                projectId: fixture.project.projectId,
                piSessionId: `archive-${index}`,
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
            });
            if (index < 2) {
                await service.archiveSession({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: session.runwieldSessionId,
                });
                archivedIds.push(session.runwieldSessionId);
            }
        }
        const response = await ownerSessionArchiveApi(archiveRouteContext(service, fixture));
        assertEquals(response.status, 200);
        const archivedAt = (await response.json()).archivedAt;
        assert(archivedAt);
        service.close();
        service.store.close();
        service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
        assertEquals(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt, archivedAt);
        for (const includeTotal of [true, false]) {
            const seen = [];
            for (let page = 0; page < 3; page++) {
                const result = await ownerProjectSessionsApi({
                    ...archiveRouteContext(service, fixture),
                    url: new URL(
                        `http://localhost/sessions?archiveState=archived&page=${page}&pageSize=1&includeTotal=${includeTotal}`,
                    ),
                });
                assertEquals(result.status, 200);
                const body = await result.json();
                assertEquals(body.total, includeTotal ? 3 : null);
                assertEquals(body.hasNext, page < 2);
                assertEquals(body.sessions.length, 1);
                assert(body.sessions[0].archivedAt);
                seen.push(body.sessions[0].runwieldSessionId);
            }
            assertEquals(seen.sort(), [...archivedIds].sort());
        }
        assertEquals((await service.listSessions(fixture.project.projectId)).total, 1);
        assertEquals((await service.listSessions(fixture.project.projectId, { archiveState: "all" })).total, 4);
        assertEquals(
            (await ownerProjectSessionsApi({
                ...archiveRouteContext(service, fixture),
                url: new URL("http://localhost/sessions?archiveState=invalid"),
            })).status,
            400,
        );
        assertEquals((await ownerSessionUnarchiveApi(archiveRouteContext(service, fixture))).status, 200);
        service.close();
        service.store.close();
        service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
        assertEquals(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt, null);
        assertEquals((await service.listSessions(fixture.project.projectId)).total, 2);
        assertEquals(service.store.listSessionTranscriptSegments(fixture.session.runwieldSessionId), originalSegments);
        assertEquals(
            service.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation,
            originalGeneration,
        );
    } finally {
        service.close();
        service.store.close();
        await fixture.cleanup();
    }
});

test("Workspace archive rejects foreign and disabled Projects before stopping work", async () => {
    const fixture = await makeManagedSessionFixture();
    const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
    let proof;
    try {
        proof = fixture.store.acquireSessionActivation({
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            expectedGeneration: 0,
            operationId: "inaccessible-owner",
            ownerInstanceId: "test-owner",
            ownerProcessKind: "test",
        });
        const foreignRoot = `${fixture.projectRoot}/foreign`;
        await fsMkdir(foreignRoot);
        const foreign = service.store.registerProject({ root: foreignRoot });
        for (const projectId of [foreign.projectId, "missing-project"]) {
            assertEquals(
                (await ownerSessionArchiveApi(archiveRouteContext(service, fixture, { confirmed: true }, projectId)))
                    .status,
                409,
            );
            assertEquals(
                (await ownerSessionUnarchiveApi(archiveRouteContext(service, fixture, {}, projectId))).status,
                409,
            );
        }
        service.store.setProjectEnabled(fixture.project.projectId, false);
        assertEquals(
            (await ownerSessionArchiveApi(archiveRouteContext(service, fixture, { confirmed: true }))).status,
            409,
        );
        assertEquals(
            fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation.state,
            "active",
        );
        assertEquals(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt, null);
        service.store.setProjectEnabled(fixture.project.projectId, true);
        // A confirmed stop cannot reach this owner. The archive must not change.
        assertEquals(
            (await ownerSessionArchiveApi(archiveRouteContext(service, fixture, { confirmed: true }))).status,
            409,
        );
        assertEquals(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt, null);
    } finally {
        if (proof) fixture.store.releaseUnchangedActivation(proof);
        service.close();
        service.store.close();
        await fixture.cleanup();
    }
});

test("Workspace busy archive requires boolean confirmation and waits for settlement", async () => {
    await withRuntimeCommandFixture(
        "workspace-archive-busy-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            let release = () => {};
            const held = new Promise((resolve) => {
                release = resolve;
            });
            let started = false;
            let cancelCount = 0;
            const cancelSession = service.runtime.cancelSession.bind(service.runtime);
            service.runtime.cancelSession = async (sessionId) => {
                cancelCount += 1;
                return await cancelSession(sessionId);
            };
            try {
                setModelResponseFactory(async (context) => {
                    started = true;
                    await held;
                    return fixture.recordedModelResponse("Stopped work.")(context);
                });
                const operation = await service.startContinuation({
                    projectId: fixture.project.projectId,
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    expectedGeneration: 0,
                    requestId: "archive-busy",
                    text: "Work until stopped.",
                });
                for (let index = 0; index < 400 && !started; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(started);
                for (const body of [{}, { confirmed: false }, { confirmed: "true" }, { confirmed: 1 }]) {
                    assertEquals(
                        (await ownerSessionArchiveApi(archiveRouteContext(service, fixture, body))).status,
                        409,
                    );
                    assertEquals(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt, null);
                    assertEquals(
                        service.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation.state,
                        "active",
                    );
                    assertEquals(service.getOperation(operation.operationId).status, "running");
                    assertEquals(cancelCount, 0);
                }
                const pending = ownerSessionArchiveApi(archiveRouteContext(service, fixture, { confirmed: true }));
                await new Promise((resolve) => setTimeout(resolve, 50));
                assertEquals(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt, null);
                release();
                assertEquals((await pending).status, 200);
                assert(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt);
                assertEquals(
                    service.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation.state,
                    "idle",
                );
                assertEquals((await service.listSessions(fixture.project.projectId)).total, 0);
            } finally {
                release();
                await service.runtime.closeAllSessionsWhenIdle();
                service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace archive stops a remote surface through the live connection", async () => {
    await withRuntimeCommandFixture(
        "workspace-archive-remote-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
            const owner = fixture.openRuntime("tui", "archive-remote-owner");
            const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
            let release = () => {};
            const held = new Promise((resolve) => {
                release = resolve;
            });
            let started = false;
            try {
                setModelResponseFactory(async (context) => {
                    started = true;
                    await held;
                    return fixture.recordedModelResponse("Remote work.")(context);
                });
                const turn = owner.runtime.promptUserTurn(owner.adoptedSessionId, {
                    initialRequest: "Start remote work.",
                });
                for (let index = 0; index < 400 && !started; index++) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                assert(started);
                assertEquals((await ownerSessionArchiveApi(archiveRouteContext(service, fixture))).status, 409);
                assertEquals(service.operations.size, 0);
                const pending = ownerSessionArchiveApi(archiveRouteContext(service, fixture, { confirmed: true }));
                await new Promise((resolve) => setTimeout(resolve, 50));
                assertEquals(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt, null);
                release();
                assertEquals((await pending).status, 200);
                await turn;
                assert(service.store.getSessionById(fixture.session.runwieldSessionId).archivedAt);
                assertEquals(
                    service.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation.state,
                    "idle",
                );
            } finally {
                release();
                await owner.close();
                service.close();
                service.store.close();
                await fixture.cleanup();
            }
        },
    );
});

test("Workspace Plan-filtered Session API explicitly includes archived associations", async () => {
    const fixture = await makeManagedSessionFixture();
    const service = new WorkspaceSessionContinuationService({ store: fixture.openStore() });
    try {
        const segmentId = fixture.store.getCurrentSessionSegment(fixture.session.runwieldSessionId).segmentId;
        let proof = fixture.store.acquireSessionActivation({
            projectId: fixture.project.projectId,
            runwieldSessionId: fixture.session.runwieldSessionId,
            expectedGeneration: 0,
            operationId: "archive-association",
            ownerInstanceId: "test-owner",
            ownerProcessKind: "test",
        });
        fixture.store.stagePlanAssociation(proof, {
            planId: "archived-plan",
            planName: "Archived Plan",
            purpose: "planning",
            segmentId,
            segmentKind: "session",
            recordedAt: "2026-01-01T00:00:00.000Z",
        });
        proof = fixture.store.changeSessionActivationPhase(proof, "hydrated");
        proof = fixture.store.changeSessionActivationPhase(proof, "checkpointing");
        fixture.store.publishGenerationAndRelease(proof, {
            generation: 1,
            currentSegmentId: segmentId,
            ...await readTranscriptEvidence(fixture.transcriptPath),
        });
        assertEquals((await ownerSessionArchiveApi(archiveRouteContext(service, fixture))).status, 200);
        for (const includeTotal of [true, false]) {
            const response = await ownerProjectSessionsApi({
                ...archiveRouteContext(service, fixture),
                url: new URL(`http://localhost/sessions?plan=archived-plan&includeTotal=${includeTotal}`),
            });
            assertEquals(response.status, 200);
            const body = await response.json();
            assertEquals(body.sessions.length, 1);
            assertEquals(body.sessions[0].runwieldSessionId, fixture.session.runwieldSessionId);
            assert(body.sessions[0].archivedAt);
        }
        assertEquals((await service.listSessions(fixture.project.projectId)).sessions, []);
        assertEquals(
            await associatedPlanSession(service.store, fixture.project.projectId, "archived-plan"),
            fixture.session.runwieldSessionId,
        );
    } finally {
        service.close();
        service.store.close();
        await fixture.cleanup();
    }
});

test("Workspace Session options honor merged mascot visibility", async () => {
    await withRuntimeCommandFixture("workspace-mascot-options-", async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({ home: homeDir, projectRoot });
        const store = fixture.openStore();
        const service = new WorkspaceSessionContinuationService({ store });
        try {
            assertEquals((await service.listSessionOptions(fixture.project.projectId)).mascot, true);
            await setCustomSetting("mascot", false, "global", projectRoot);
            assertEquals((await service.listSessionOptions(fixture.project.projectId)).mascot, false);
            await setCustomSetting("mascot", true, "project", projectRoot);
            assertEquals((await service.listSessionOptions(fixture.project.projectId)).mascot, true);
            const settingsPath = `${projectRoot}/.wld/settings.json`;
            const settings = JSON.parse(await fsReadFile(settingsPath, "utf8"));
            await fsWriteFile(settingsPath, JSON.stringify({ ...settings, mascot: false }));
            assertEquals((await service.listSessionOptions(fixture.project.projectId)).mascot, false);
        } finally {
            service.close();
            store.close();
        }
    });
});
