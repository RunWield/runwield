import { writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import type { SessionRuntimeEvent } from "../session/session-runtime-events.js";
import { __resetSettingsForTests } from "../settings.js";
import type { PlanStatus } from "./plan-lifecycle.js";
import {
    beginSlicerContextPhase,
    createSlicerFinalizeTool,
    openSlicerDecomposition,
    runSlicerAgent,
} from "./workflow-slicer.ts";

interface SlicerSessionFixture {
    hostedSession: HostedSession;
    sessionManager: SessionManager;
}

type SlicerFinalizeParams = {
    confirmation: string;
    children?: Array<{
        title: string;
        order: number;
        summary: string;
        dependencies: string[];
        affectedPaths: string[];
        tickets?: Array<{ url: string }>;
        executionAgent: "engineer" | "frontend-engineer";
        collaborationRecommendation: "pair" | "autonomous";
        worktreeBaseBranch?: string | null;
        workKind?: "BUG_FIX" | "FEATURE" | "REFACTOR" | "MAINTENANCE" | "DOCUMENTATION";
        content: string;
    }>;
};

type ToolExecute = NonNullable<ToolDefinition["execute"]>;
type ToolExecutionContext = Parameters<ToolExecute>[4];
interface SlicerFinalizeDetails {
    status: string;
    children: string[];
    writeResults: Array<{ name: string }>;
    error: string;
}

interface SlicerFinalizeResult {
    content: Array<{ type: "text"; text: string }>;
    details: SlicerFinalizeDetails;
}

function createSessionFixture(projectRoot: string, rootAgent = "architect"): SlicerSessionFixture {
    const sessionManager = SessionManager.inMemory(projectRoot);
    const hostedSession = new HostedSession({
        id: `workflow-slicer-${crypto.randomUUID()}`,
        cwd: projectRoot,
    });
    // Pi's concrete manager implements the HostedSession runtime contract.
    hostedSession.setRootSessionManager(sessionManager);
    hostedSession.setRootAgentName(rootAgent);
    return { hostedSession, sessionManager };
}

async function saveEpic(projectRoot: string, status: PlanStatus = "approved"): Promise<string> {
    return await savePlan(projectRoot, "epic-a", "# Epic A", {
        classification: "PROJECT",
        complexity: "HIGH",
        summary: "Epic A",
        affectedPaths: ["src/epic.ts"],
        status,
        targetBranch: "feature-base",
        planId: `epic-${crypto.randomUUID()}`,
    });
}

async function executeFinalizeTool(
    tool: ToolDefinition,
    params: SlicerFinalizeParams,
): Promise<SlicerFinalizeResult> {
    return await tool.execute(
        `slicer-finalize-${crypto.randomUUID()}`,
        params,
        new AbortController().signal,
        () => {},
        {} as ToolExecutionContext,
    ) as SlicerFinalizeResult;
}

test("Slicer starts a clean context phase and receives persisted Epic and child evidence", async () => {
    await withRuntimeCommandFixture(
        "workflow-slicer-agent-",
        async ({ projectRoot, setModelResponseFactory }) => {
            await saveEpic(projectRoot);
            await savePlan(projectRoot, "epic-a/01-child", "# Child", {
                classification: "PLANNED_CHANGE",
                status: "draft",
                parentPlan: "epic-a",
                order: 1,
                summary: "Child slice",
                affectedPaths: ["src/child.ts"],
                tickets: [{ url: "https://tracker.example/TICKET-1" }],
            });
            let modelContext = "";
            setModelResponseFactory((context) => {
                modelContext = JSON.stringify(context.messages);
                return fauxAssistantMessage(fauxText("The Epic needs another decomposition turn."));
            });
            const fixture = createSessionFixture(projectRoot);
            fixture.sessionManager.appendMessage({
                role: "user",
                content: [{ type: "text", text: "architect deliberation that must be omitted" }],
                timestamp: Date.now(),
            });

            try {
                const result = await runSlicerAgent({
                    planName: "epic-a",
                    triageMeta: {
                        classification: "PROJECT",
                        complexity: "HIGH",
                        summary: "Epic A",
                        affectedPaths: ["src/epic.ts"],
                    },
                    reviewFeedback: "Keep the approved boundary.",
                    reviewImages: [{ base64: "YXBwcm92ZWQ=", mimeType: "image/png" }],
                    hostedSession: fixture.hostedSession,
                    sessionManager: fixture.sessionManager,
                });

                assertEquals(result, { ok: true });
                assertEquals(fixture.hostedSession.getRootAgentName(), "slicer");
                assertStringIncludes(modelContext, "Keep the approved boundary.");
                assertStringIncludes(modelContext, "Direct Ticket references: https://tracker.example/TICKET-1");
                assertEquals(modelContext.includes("architect deliberation that must be omitted"), false);
                assertEquals(
                    fixture.sessionManager.buildSessionContext().messages.some((message) =>
                        message.role === "compactionSummary" &&
                        JSON.stringify(message).includes("Slicer phase context boundary")
                    ),
                    true,
                );
            } finally {
                fixture.hostedSession.dispose();
            }
        },
    );
});

test("Slicer restores the prior Agent and reports an external model failure", async () => {
    await withRuntimeCommandFixture(
        "workflow-slicer-failure-",
        async ({ projectRoot, settingsPath }) => {
            await saveEpic(projectRoot);
            await fsWriteFile(
                settingsPath,
                JSON.stringify({ defaultProvider: "missing-fixture-provider", defaultModel: "missing-model" }),
            );
            __resetSettingsForTests();
            const fixture = createSessionFixture(projectRoot);
            fixture.sessionManager.appendMessage({
                role: "user",
                content: [{ type: "text", text: "architect handoff" }],
                timestamp: Date.now(),
            });
            const statuses: string[] = [];
            fixture.hostedSession.setEventSink((event: SessionRuntimeEvent) => {
                if (event.type === "system_status") statuses.push(event.message);
            });

            try {
                const result = await runSlicerAgent({
                    planName: "epic-a",
                    hostedSession: fixture.hostedSession,
                    sessionManager: fixture.sessionManager,
                });

                assertEquals(result.ok, false);
                assertStringIncludes(result.error ?? "", "Unknown settings default model");
                assertEquals(fixture.hostedSession.getRootAgentName(), "architect");
                assert(statuses.some((status) => status.includes("Slicer failed: Unknown settings default model")));
            } finally {
                fixture.hostedSession.dispose();
            }
        },
    );
});

test("Slicer finalize commits child Plans and the Epic lifecycle transition together", async () => {
    await withRuntimeCommandFixture("workflow-slicer-finalize-", async ({ projectRoot }) => {
        await saveEpic(projectRoot);
        const tool = createSlicerFinalizeTool({ planName: "epic-a", cwd: projectRoot });
        const result = await executeFinalizeTool(tool, {
            confirmation: "yes, finalize",
            children: [{
                order: 1,
                title: "Child",
                summary: "Child summary",
                affectedPaths: ["src/child.ts"],
                dependencies: [],
                tickets: [{ url: "https://tracker.example/TICKET-2" }],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                workKind: "DOCUMENTATION",
                content: "# Child",
            }],
        });

        assertEquals(result.details.status, "ready_for_work");
        assertEquals(result.details.children, ["epic-a/01-child"]);
        const epic = await loadPlan(projectRoot, "epic-a");
        const child = await loadPlan(projectRoot, "epic-a/01-child");
        assertEquals(epic?.attrs.status, "ready_for_work");
        assertEquals(child?.attrs.parentPlan, "epic-a");
        assertEquals(child?.attrs.targetBranch, "feature-base");
        assertEquals(child?.attrs.workKind, "DOCUMENTATION");
        assertEquals(child?.attrs.tickets, [{ url: "https://tracker.example/TICKET-2" }]);
    });
});

test("Slicer finalize reuses existing children and is idempotent after the Epic is ready", async () => {
    await withRuntimeCommandFixture("workflow-slicer-idempotent-", async ({ projectRoot }) => {
        await saveEpic(projectRoot, "ready_for_decomposition");
        await savePlan(projectRoot, "epic-a/01-child", "# Child", {
            classification: "PLANNED_CHANGE",
            status: "draft",
            parentPlan: "epic-a",
            order: 1,
        });
        const tool = createSlicerFinalizeTool({ planName: "epic-a", cwd: projectRoot });
        const first = await executeFinalizeTool(tool, { confirmation: "yes, finalize" });
        const ready = await loadPlan(projectRoot, "epic-a");
        const second = await executeFinalizeTool(tool, { confirmation: "yes, finalize again" });
        const replayed = await loadPlan(projectRoot, "epic-a");

        assertEquals(first.details.status, "ready_for_work");
        assertEquals(first.details.writeResults, []);
        assertEquals(second.details.status, "ready_for_work");
        assertEquals(second.details.writeResults, []);
        assertEquals(replayed?.revision, ready?.revision);
    });
});

test("openSlicerDecomposition reads the persisted Plan and invokes the real Slicer machinery", async () => {
    await withRuntimeCommandFixture(
        "workflow-slicer-open-",
        async ({ projectRoot, setModelMessages }) => {
            const planPath = await saveEpic(projectRoot);
            setModelMessages([fauxAssistantMessage(fauxText("Continue decomposing the persisted Epic."))]);
            const fixture = createSessionFixture(projectRoot);

            try {
                const result = await openSlicerDecomposition({
                    planName: "epic-a",
                    planPath,
                    hostedSession: fixture.hostedSession,
                    sessionManager: fixture.sessionManager,
                });

                assertEquals(result, { ok: true, slicerInvoked: true });
                assertEquals(fixture.hostedSession.getRootAgentName(), "slicer");
            } finally {
                fixture.hostedSession.dispose();
            }
        },
    );
});

test("openSlicerDecomposition returns the real Slicer model failure at the Slicer stage", async () => {
    await withRuntimeCommandFixture(
        "workflow-slicer-open-failure-",
        async ({ projectRoot, settingsPath }) => {
            const planPath = await saveEpic(projectRoot);
            await fsWriteFile(
                settingsPath,
                JSON.stringify({ defaultProvider: "missing-fixture-provider", defaultModel: "missing-model" }),
            );
            __resetSettingsForTests();
            const fixture = createSessionFixture(projectRoot);

            try {
                const result = await openSlicerDecomposition({
                    planName: "epic-a",
                    planPath,
                    hostedSession: fixture.hostedSession,
                    sessionManager: fixture.sessionManager,
                });

                assertEquals(result.ok, false);
                if (result.ok) throw new Error("Expected Slicer failure");
                assertEquals(result.stage, "slicer");
                assertStringIncludes(result.error ?? "", "Unknown settings default model");
            } finally {
                fixture.hostedSession.dispose();
            }
        },
    );
});

test("beginSlicerContextPhase leaves an already-active Slicer boundary unchanged", async () => {
    await withRuntimeCommandFixture("workflow-slicer-boundary-", async ({ projectRoot }) => {
        await Promise.resolve();
        const fixture = createSessionFixture(projectRoot, "architect");
        fixture.sessionManager.appendMessage({
            role: "user",
            content: [{ type: "text", text: "architect context" }],
            timestamp: Date.now(),
        });

        try {
            const first = beginSlicerContextPhase({
                planName: "epic-a",
                hostedSession: fixture.hostedSession,
                sessionManager: fixture.sessionManager,
            });
            fixture.hostedSession.setRootAgentName("slicer");
            const second = beginSlicerContextPhase({
                planName: "epic-a",
                hostedSession: fixture.hostedSession,
                sessionManager: fixture.sessionManager,
            });

            assertEquals(first?.manager, fixture.sessionManager);
            assertEquals(second, null);
            assertEquals(
                fixture.sessionManager.buildContextEntries().filter((entry) => entry.type === "compaction").length,
                1,
            );
        } finally {
            fixture.hostedSession.dispose();
        }
    });
});
