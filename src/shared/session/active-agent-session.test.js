import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENTS } from "../../constants.js";
import {
    ACTIVE_AGENT_CUSTOM_TYPE,
    readPersistedActiveAgentName,
    readPersistedManualModelState,
    readPersistedModelState,
    recordActiveAgent,
    recordManualModelSelection,
    resolveResumeAgentName,
} from "./active-agent-session.js";

/** @param {Array<Record<string, unknown>>} entries */
function makeSessionManager(entries = []) {
    return /** @type {import('@earendil-works/pi-coding-agent').SessionManager} */ (/** @type {unknown} */ ({
        getBranch: () => entries,
        /** @param {string} customType @param {unknown} data */
        appendCustomEntry: (customType, data) => {
            entries.push({ type: "custom", customType, data });
        },
    }));
}

test("recordActiveAgent stores and reads the latest active root agent", () => {
    const sessionManager = makeSessionManager();

    recordActiveAgent(sessionManager, AGENTS.ROUTER, "Router");
    recordActiveAgent(sessionManager, AGENTS.PLANNER, "Planner");

    assertEquals(readPersistedActiveAgentName(sessionManager), AGENTS.PLANNER);
});

test("recordActiveAgent persists display name with canonical root agent", () => {
    /** @type {Array<Record<string, unknown>>} */
    const entries = [];
    const sessionManager = makeSessionManager(entries);

    recordActiveAgent(sessionManager, "project-operator", "Project Operator");

    assertEquals(entries, [
        {
            type: "custom",
            customType: ACTIVE_AGENT_CUSTOM_TYPE,
            data: { agentName: "project-operator", displayName: "Project Operator" },
        },
    ]);
    assertEquals(readPersistedActiveAgentName(sessionManager), "project-operator");
});

test("recordActiveAgent skips duplicate adjacent markers", () => {
    /** @type {Array<Record<string, unknown>>} */
    const entries = [];
    const sessionManager = makeSessionManager(entries);

    recordActiveAgent(sessionManager, AGENTS.PLANNER);
    recordActiveAgent(sessionManager, AGENTS.PLANNER);

    assertEquals(entries.length, 1);
    assertEquals(entries[0].customType, ACTIVE_AGENT_CUSTOM_TYPE);
});

test("readPersistedModelState returns the latest persisted model", () => {
    const sessionManager = makeSessionManager([
        { type: "model_change", provider: "first-provider", modelId: "first-model" },
        { type: "model_change", provider: "last-provider", modelId: "last-model" },
    ]);

    assertEquals(readPersistedModelState(sessionManager), {
        provider: "last-provider",
        model: "last-model",
    });
});

test("readPersistedModelState ignores malformed model entries", () => {
    const sessionManager = makeSessionManager([
        { type: "model_change", provider: "valid-provider", modelId: "valid-model" },
        { type: "model_change", provider: "broken-provider", modelId: "" },
    ]);

    assertEquals(readPersistedModelState(sessionManager), {
        provider: "valid-provider",
        model: "valid-model",
    });
});

test("manual model selection persists and reads the latest explicit choice", () => {
    const sessionManager = makeSessionManager();

    recordManualModelSelection(sessionManager, "openai-codex", "gpt-5.5");
    recordManualModelSelection(sessionManager, "openai-codex", "gpt-5.6-luna");

    assertEquals(readPersistedManualModelState(sessionManager), {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
    });
});

test("readPersistedManualModelState ignores malformed markers", () => {
    const sessionManager = makeSessionManager([
        { type: "custom", customType: "runwield.manual_model", data: { provider: "openai-codex", model: "gpt-5.5" } },
        { type: "custom", customType: "runwield.manual_model", data: { provider: "openai-codex", model: "" } },
    ]);

    assertEquals(readPersistedManualModelState(sessionManager), {
        provider: "openai-codex",
        model: "gpt-5.5",
    });
});

test("manual model belongs to the active Agent and does not return after switching away and back", () => {
    const sessionManager = SessionManager.inMemory("/tmp");
    recordActiveAgent(sessionManager, "router");
    recordManualModelSelection(sessionManager, "test-provider", "manual");
    assertEquals(readPersistedManualModelState(sessionManager, "router"), {
        provider: "test-provider",
        model: "manual",
    });
    assertEquals(readPersistedManualModelState(sessionManager, "planner"), null);
    recordActiveAgent(sessionManager, "Router");
    assertEquals(readPersistedManualModelState(sessionManager)?.model, "manual");
    recordActiveAgent(sessionManager, "planner");
    assertEquals(readPersistedManualModelState(sessionManager), null);
    recordActiveAgent(sessionManager, "router");
    assertEquals(readPersistedManualModelState(sessionManager), null);
    recordManualModelSelection(sessionManager, "test-provider", "new-choice");
    assertEquals(readPersistedManualModelState(sessionManager)?.model, "new-choice");
});

test("manual model selected before the first Agent marker survives initial activation only", () => {
    const sessionManager = SessionManager.inMemory("/tmp");
    recordManualModelSelection(sessionManager, "test-provider", "manual");
    recordActiveAgent(sessionManager, "router");
    assertEquals(readPersistedManualModelState(sessionManager)?.model, "manual");
    recordActiveAgent(sessionManager, "guide");
    assertEquals(readPersistedManualModelState(sessionManager), null);
});

test("resolveResumeAgentName returns persisted valid agent", async () => {
    const sessionManager = makeSessionManager([
        { type: "custom", customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { agentName: AGENTS.PLANNER } },
    ]);

    assertEquals(await resolveResumeAgentName(sessionManager), AGENTS.PLANNER);
});

test("resolveResumeAgentName preserves the persistent workflow-only Slicer", async () => {
    const sessionManager = makeSessionManager([
        { type: "custom", customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { agentName: AGENTS.ARCHITECT } },
        { type: "custom", customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { agentName: AGENTS.SLICER } },
    ]);

    assertEquals(await resolveResumeAgentName(sessionManager), AGENTS.SLICER);
});

test("resolveResumeAgentName returns canonical filename identity instead of display casing", async () => {
    const sessionManager = makeSessionManager([
        { type: "custom", customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { agentName: "Router" } },
    ]);

    assertEquals(await resolveResumeAgentName(sessionManager), AGENTS.ROUTER);
});

test("resolveResumeAgentName skips stale invalid markers and uses the latest valid agent", async () => {
    const sessionManager = makeSessionManager([
        { type: "custom", customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { agentName: AGENTS.PLANNER } },
        { type: "custom", customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { agentName: "not-real" } },
    ]);

    assertEquals(await resolveResumeAgentName(sessionManager), AGENTS.PLANNER);
});

test("resolveResumeAgentName falls back to router for missing or invalid markers", async () => {
    assertEquals(await resolveResumeAgentName(makeSessionManager()), AGENTS.ROUTER);
    assertEquals(
        await resolveResumeAgentName(
            makeSessionManager([
                { type: "custom", customType: ACTIVE_AGENT_CUSTOM_TYPE, data: { agentName: "not-real" } },
            ]),
        ),
        AGENTS.ROUTER,
    );
});
