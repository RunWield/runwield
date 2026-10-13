import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { AGENTS } from "../../constants.js";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { getRunWieldSessionDir } from "../../shared/session/root-session.js";
import { __resetSettingsForTests } from "../../shared/settings.js";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { getResumeModelSelection, runResumeCommand } from "./index.ts";

const FIXTURE_PROVIDER = "runtime-command-fixture";
const FIXTURE_MODEL = "fixture-model";

interface ResumeSelectItem {
    value: string;
    label: string;
    description?: string;
}

interface ResumeSelectHooks {
    layout?: {
        maxPrimaryColumnWidth?: number;
        truncatePrimary?(context: { text: string; maxWidth: number }): string;
    };
}

interface SeededSession {
    id: string;
    path: string;
}

interface ResumeSelectOffer {
    title: string;
    options: ResumeSelectItem[];
    hooks?: ResumeSelectHooks;
}

interface ResumeUiFixture {
    clears: number;
    editor: {
        disableSubmit: boolean;
        setText(text: string): void;
    };
    messages: string[];
    prompts: string[];
    selectOffers: ResumeSelectOffer[];
    uiAPI: {
        appendSystemMessage(message: string): void;
        clearMessages(): void;
        promptSelect(
            title: string,
            options: ResumeSelectItem[],
            hooks?: ResumeSelectHooks,
        ): Promise<string | null>;
    };
}

function makeUi(selections: string[]): ResumeUiFixture {
    const fixture: ResumeUiFixture = {
        clears: 0,
        messages: [],
        prompts: [],
        selectOffers: [],
        editor: {
            disableSubmit: true,
            setText: () => {},
        },
        uiAPI: {
            appendSystemMessage: (message) => fixture.messages.push(message),
            clearMessages: () => fixture.clears += 1,
            promptSelect: (title, options, hooks) => {
                fixture.prompts.push(title);
                fixture.selectOffers.push({ title, options, hooks });
                const selection = selections.shift() ?? null;
                if (selection && !options.some((option) => option.value === selection)) {
                    throw new Error(`Fixture selection was not offered: ${selection}`);
                }
                return Promise.resolve(selection);
            },
        },
    };
    return fixture;
}

function userMessage(text: string) {
    return {
        role: "user" as const,
        timestamp: Date.now(),
        content: [{ type: "text" as const, text }],
    };
}

function seedPersistedSession(projectRoot: string, content = "continue the fixture work"): SeededSession {
    const id = crypto.randomUUID();
    const manager = SessionManager.create(projectRoot, getRunWieldSessionDir(projectRoot), { id });
    manager.appendModelChange(FIXTURE_PROVIDER, FIXTURE_MODEL);
    manager.appendCustomEntry("runwield.active_agent", { agentName: "Router" });
    const chunks = content.match(/[\s\S]{1,12000}/g) || [content];
    for (const chunk of chunks) {
        manager.appendMessage(userMessage(chunk));
        manager.appendMessage(fauxAssistantMessage(fauxText("fixture response")));
    }
    const path = manager.getSessionFile();
    if (!path) throw new Error("Fixture session was not persisted");
    return { id, path };
}

async function writeResumeThreshold(settingsPath: string, threshold: number): Promise<void> {
    const settings = JSON.parse(await fsReadFile(settingsPath, "utf8"));
    settings.compactOnResumeThresholdPercent = threshold;
    await fsWriteFile(settingsPath, JSON.stringify(settings));
    __resetSettingsForTests();
}

test("getResumeModelSelection preserves supported Agy CLI references with the conservative context window", () => {
    assertEquals(getResumeModelSelection({ provider: "agy-cli", modelId: "gemini-3.8-flash" }), {
        modelOverride: "agy-cli/gemini-3.8-flash",
        contextWindow: 128000,
    });
});

test("runResumeCommand loads, replaces, and replays a real persisted session", async () => {
    await withRuntimeCommandFixture("runwield-resume-command-", async ({ homeDir, projectRoot }) => {
        const seeded = seedPersistedSession(projectRoot);
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store });
        const current = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const ui = makeUi([seeded.path]);
        let replacementId = "";
        try {
            await runResumeCommand([], {
                uiAPI: ui.uiAPI,
                editor: ui.editor,
                sessionId: current.sessionId,
                sessionRuntime: runtime,
                replaceRuntimeSession: (sessionId) => replacementId = sessionId,
            });

            assertEquals(runtime.getSessionSnapshot(replacementId)?.sessionManagerId, seeded.id);
            assertEquals(runtime.getSessionSnapshot(replacementId)?.activeAgent, AGENTS.ROUTER);
            assertEquals(ui.clears, 1);
            assertEquals(ui.messages, ["Conversation restored."]);
        } finally {
            runtime.closeAllSessions();
            store.close();
        }
    });
});

test("runResumeCommand falls back to read-only when another terminal claims a listed conversation", async () => {
    await withRuntimeCommandFixture("runwield-resume-command-", async ({ homeDir, projectRoot }) => {
        const seeded = seedPersistedSession(projectRoot);
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({
            sessionStore: store,
            ownerInstanceId: "resuming-tui",
            ownerProcessKind: "tui",
        });
        let replacementId = "";
        try {
            const cataloged = await runtime.loadSession({
                cwd: projectRoot,
                sessionId: seeded.id,
                sessionPath: seeded.path,
            });
            const managed = runtime.getSessionSnapshot(cataloged.sessionId)?.managed;
            if (!managed) throw new Error("Fixture Session was not cataloged");
            await runtime.closeSession(cataloged.sessionId);

            const current = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const ui = makeUi([seeded.path]);
            const selectListedSession = ui.uiAPI.promptSelect;
            let claimed = false;
            ui.uiAPI.promptSelect = (title, options, hooks) => {
                if (!claimed) {
                    claimed = true;
                    const state = store.inspectSessionActivation(managed.runwieldSessionId);
                    store.acquireSessionActivation({
                        runwieldSessionId: managed.runwieldSessionId,
                        projectId: managed.projectId,
                        ownerInstanceId: "older-tui",
                        ownerProcessKind: "tui",
                        expectedGeneration: state.generation?.generation ?? null,
                        expectedCurrentSegmentId: managed.currentSegmentId,
                        phase: "turning",
                    });
                }
                return selectListedSession(title, options, hooks);
            };
            await runResumeCommand([], {
                uiAPI: ui.uiAPI,
                editor: ui.editor,
                sessionId: current.sessionId,
                sessionRuntime: runtime,
                replaceRuntimeSession: (sessionId) => replacementId = sessionId,
            });

            assertEquals(runtime.getSessionSnapshot(replacementId)?.managed?.syncState?.status, "active_elsewhere");
            assertEquals(
                ui.messages,
                [
                    "Conversation restored in read-only mode because it is still running in another terminal. Continue there, or wait for its current turn to finish; this screen will become available automatically.",
                ],
            );
            assertEquals(
                runtime.getUserTurnSubmissionBlockMessage(replacementId),
                "This conversation is still running in another terminal. Continue there, or wait for its current turn to finish before sending here.",
            );
        } finally {
            runtime.closeAllSessions();
            store.close();
        }
    });
});

test("runResumeCommand recovers an interrupted checkpoint and replays the committed conversation", async () => {
    await withRuntimeCommandFixture("runwield-resume-command-", async ({ homeDir, projectRoot }) => {
        const seeded = seedPersistedSession(projectRoot, "conversation restored after interruption");
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store });
        let unsubscribe = () => {};
        try {
            const firstLoad = await runtime.loadSession({
                cwd: projectRoot,
                sessionId: seeded.id,
                sessionPath: seeded.path,
            });
            const managed = runtime.getSessionSnapshot(firstLoad.sessionId)?.managed;
            if (!managed) throw new Error("Fixture Session was not cataloged");
            await runtime.closeSession(firstLoad.sessionId);

            const state = store.inspectSessionActivation(managed.runwieldSessionId);
            const proof = store.acquireSessionActivation({
                runwieldSessionId: managed.runwieldSessionId,
                projectId: managed.projectId,
                ownerInstanceId: "interrupted-resume-fixture",
                ownerProcessKind: "test",
                expectedGeneration: state.generation?.generation ?? null,
                expectedCurrentSegmentId: managed.currentSegmentId,
            });
            await fsWriteFile(
                seeded.path,
                `${
                    JSON.stringify({
                        type: "custom",
                        id: crypto.randomUUID(),
                        customType: "runwield.request_attempt",
                        data: { status: "failed" },
                    })
                }\n`,
                { flag: "a" },
            );
            store.markSessionUncertain(proof, { reason: "interrupted after a failed request" });

            const current = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const ui = makeUi([seeded.path]);
            const replayed: string[] = [];
            await runResumeCommand([], {
                uiAPI: ui.uiAPI,
                editor: ui.editor,
                sessionId: current.sessionId,
                sessionRuntime: runtime,
                replaceRuntimeSession: (sessionId) => {
                    unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
                        if (event.type === RuntimeEventTypes.USER_MESSAGE) replayed.push(event.text);
                        if (event.type === RuntimeEventTypes.ASSISTANT_TEXT_DELTA) replayed.push(event.delta);
                    });
                },
            });

            assert(replayed.some((text) => text.includes("conversation restored after interruption")));
            assert(replayed.some((text) => text.includes("fixture response")));
            const recovered = store.inspectSessionActivation(managed.runwieldSessionId);
            assertEquals(recovered.activation?.state, "idle");
            assertEquals(recovered.generation?.generation, (state.generation?.generation ?? 0) + 1);
        } finally {
            unsubscribe();
            runtime.closeAllSessions();
            store.close();
        }
    });
});

test("runResumeCommand offers full session names with date-only descriptions", async () => {
    await withRuntimeCommandFixture("runwield-resume-command-", async ({ homeDir, projectRoot }) => {
        const longMessage = "inspect the workspace sidebar rendering path ".repeat(4).trim();
        const seeded = seedPersistedSession(projectRoot, longMessage);
        const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
        const runtime = createSessionRuntime({ sessionStore: store });
        const current = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const ui = makeUi([]);
        try {
            await runResumeCommand([], {
                uiAPI: ui.uiAPI,
                editor: ui.editor,
                sessionId: current.sessionId,
                sessionRuntime: runtime,
                replaceRuntimeSession: () => {},
            });

            const offer = ui.selectOffers[0];
            const item = offer?.options.find((option) => option.value === seeded.path);
            assertEquals(item?.label, longMessage);
            assert(!item?.description?.includes("Modified:"));
            assertStringIncludes(item?.description ?? "", "| Messages: 2");

            const layout = offer?.hooks?.layout;
            assertEquals(typeof layout?.maxPrimaryColumnWidth, "number");
            assert(layout?.truncatePrimary);
            assertEquals(layout.truncatePrimary({ text: "abcdefghij", maxWidth: 5 }), "abcd…");
        } finally {
            runtime.closeAllSessions();
            store.close();
        }
    });
});

test("runResumeCommand offers compaction from real transcript size and fixture settings", async () => {
    await withRuntimeCommandFixture(
        "runwield-resume-command-",
        async ({ homeDir, projectRoot, settingsPath }) => {
            await writeResumeThreshold(settingsPath, 1);
            const seeded = seedPersistedSession(projectRoot, "large fixture context ".repeat(2000));
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store });
            const current = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const ui = makeUi([seeded.path, "cancel"]);
            let replacementId = "";
            try {
                await runResumeCommand([], {
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                    sessionId: current.sessionId,
                    sessionRuntime: runtime,
                    replaceRuntimeSession: (sessionId) => replacementId = sessionId,
                });

                assertEquals(ui.prompts.length, 2);
                assertEquals(typeof replacementId, "string");
            } finally {
                runtime.closeAllSessions();
                store.close();
            }
        },
    );
});

test("runResumeCommand compacts a real loaded session through the faux model boundary", async () => {
    await withRuntimeCommandFixture(
        "runwield-resume-command-",
        async ({ homeDir, projectRoot, setModelResponse, settingsPath }) => {
            await writeResumeThreshold(settingsPath, 1);
            setModelResponse("Summary of the fixture session.");
            const seeded = seedPersistedSession(projectRoot, "compaction fixture context ".repeat(24000));
            const store = openOwnerCoordinationStore({ dbPath: `${homeDir}/owner.sqlite3` });
            const runtime = createSessionRuntime({ sessionStore: store });
            const current = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const ui = makeUi([seeded.path, "compact"]);
            let replacementId = "";
            const replayedStatuses: string[] = [];
            let unsubscribe = () => {};
            try {
                await runResumeCommand([], {
                    uiAPI: ui.uiAPI,
                    editor: ui.editor,
                    sessionId: current.sessionId,
                    sessionRuntime: runtime,
                    replaceRuntimeSession: (sessionId) => {
                        replacementId = sessionId;
                        unsubscribe = runtime.subscribeSessionEvents(sessionId, (event) => {
                            if (event.type === RuntimeEventTypes.SYSTEM_STATUS) replayedStatuses.push(event.message);
                        });
                    },
                });

                assertEquals(runtime.getSessionSnapshot(replacementId)?.sessionManagerId, seeded.id);
                assertStringIncludes(
                    ui.messages.at(-1) || "",
                    "Conversation compacted and restored.",
                );
                assert(replayedStatuses.some((message) => message.includes("Summary of the fixture session.")));
            } finally {
                unsubscribe();
                runtime.closeAllSessions();
                store.close();
            }
        },
    );
});
