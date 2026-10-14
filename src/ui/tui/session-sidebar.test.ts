import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import stripAnsi from "strip-ansi";
import {
    composePinnedSessionSidebar,
    isSessionArtifactOpenKey,
    isSessionSidebarActionKey,
    isSessionSidebarCycleKey,
    TuiSessionSidebar,
    tuiSessionSidebarProjection,
} from "./session-sidebar.ts";
import { initRunWieldTheme } from "../theme/theme.js";

initRunWieldTheme();

const ARTIFACT = {
    artifactId: "artifact-1",
    kind: "prd" as const,
    path: "docs/prd/session-sidebar.md",
    title: "Session Sidebar",
    registeredAt: "2026-01-01T00:00:00.000Z",
    registeredBy: "Ideator",
    sourceSegmentId: "segment-1",
};

test("TUI Session Sidebar defaults to workflow and cycles through shared tabs", () => {
    const snapshot = {
        name: "Demo Session",
        busy: true,
        activeAgent: "frontend-engineer",
        activeModel: { model: "demo-model", provider: "demo-provider" },
        thinkingLevel: "high",
        workflowContext: {
            routingIntent: "PLANNED_CHANGE",
            planName: "workspace-epic/session-sidebar",
            parentPlan: "workspace-epic",
        },
        managed: { generation: 2 },
        sessionStats: { userMessages: 4, assistantMessages: 3, toolCalls: 6, compactionCount: 1 },
        contextUsage: { tokens: 96_000, contextWindow: 128_000, percent: 75 },
        systemContextTokens: 24_000,
        artifacts: [ARTIFACT],
    };
    const sidebar = new TuiSessionSidebar(() => "session-1", () => snapshot);

    const workflow = stripAnsi(sidebar.render(34).join("\n"));
    assertStringIncludes(workflow, "EPIC");
    assertStringIncludes(workflow, "workspace-epic");
    assertStringIncludes(workflow, "PLAN");
    assertStringIncludes(workflow, "session-sidebar");
    assertEquals(workflow.includes("workspace-epic/session-sidebar"), false);
    assertStringIncludes(workflow, "Artifacts");

    sidebar.cycleTab();
    const session = stripAnsi(sidebar.render(34).join("\n"));
    assertStringIncludes(session, "Demo Session");
    assertStringIncludes(session, "7 · 4 user / 3 assistant");
    assertStringIncludes(session, "TOOL CALLS");
    assertStringIncludes(session, "COMPACTIONS");
    assertStringIncludes(session, "96,000 / 128,000 · 75.0%");
    assertStringIncludes(session, "SYSTEM & SETUP");
    assertStringIncludes(session, "~24,000 · 25.0% of used");
    assertStringIncludes(session, "CONVERSATION");
    assertStringIncludes(session, "~72,000 · 75.0% of used");
    assertEquals(session.includes("STATE"), false);
    assertEquals(session.includes("GENERATION"), false);
    assertEquals(session.includes("demo-model"), false);
    assertEquals(session.includes("frontend-engineer"), false);

    sidebar.cycleTab();
    const artifacts = stripAnsi(sidebar.render(34).join("\n"));
    assertStringIncludes(artifacts, "Session Sidebar");
    assertStringIncludes(artifacts, "PRD");
    assertStringIncludes(artifacts, "alt+] open artifact");
});

test("TUI Session Sidebar shows the saved triage type and full summary", () => {
    const sidebar = new TuiSessionSidebar(
        () => "triaged-session",
        () => ({
            managed: { generation: 1 },
            workflowContext: {
                routingIntent: "QUICK_FIX",
                summary: "Add the triage report type and summary to the Session sidebar without changing other fields.",
            },
        }),
    );
    sidebar.render(34);
    sidebar.cycleTab();
    const session = stripAnsi(sidebar.render(34).join("\n"));
    assertStringIncludes(session, "TRIAGE TYPE");
    assertStringIncludes(session, "QUICK FIX");
    assertStringIncludes(session, "TRIAGE SUMMARY");
    assertStringIncludes(session, "Add the triage report type and");
    assertStringIncludes(session, "without changing other fields.");
});

test("TUI quick fix workflow shows its current CI step without Plan stages or an unrelated prompt", () => {
    const snapshot = {
        managed: { generation: 1 },
        busy: true,
        workflowContext: { routingIntent: "QUICK_FIX", liveQuestion: false },
        validationProgress: {
            kind: "mechanical",
            outcome: "running",
            stage: "ci",
            checks: { ci: "running", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" },
        },
    } as const;
    const sidebar = new TuiSessionSidebar(() => "quick-fix-session", () => snapshot);
    const projection = tuiSessionSidebarProjection(snapshot);
    assertEquals(projection.workflow.currentStage?.label, "Verification Command");
    assertEquals(projection.workflow.action, null);
    const workflow = stripAnsi(sidebar.render(34).join("\n"));
    assertStringIncludes(workflow, "QUICK FIX");
    assertStringIncludes(workflow, "● Verification Command");
    assertEquals(workflow.includes("Planning"), false);
    assertEquals(workflow.includes("AI review"), false);
    assertEquals(workflow.includes("Answer agent"), false);
});

test("quick fix workflow follows repair and manual QA progress", () => {
    const base = {
        managed: { generation: 1 },
        busy: true,
        workflowContext: { routingIntent: "QUICK_FIX" },
    } as const;
    assertEquals(tuiSessionSidebarProjection(base).workflow.currentStage?.label, "Implementation");
    const checks = { ci: "failed", semanticReview: "skipped", humanReview: "skipped", merge: "skipped" } as const;
    assertEquals(
        tuiSessionSidebarProjection({
            ...base,
            validationProgress: { kind: "mechanical", outcome: "running", stage: "engineer_repair", checks },
        }).workflow.currentStage?.label,
        "Repair",
    );
    assertEquals(
        tuiSessionSidebarProjection({
            ...base,
            validationProgress: {
                kind: "mechanical",
                outcome: "running",
                stage: "manual_qa",
                checks: { ...checks, ci: "passed" },
            },
        }).workflow.currentStage?.label,
        "Manual QA",
    );
});

test("workflow sidebar follows question state independently of running CI", () => {
    for (const routingIntent of ["QUICK_FIX", "PLANNED_CHANGE"]) {
        const snapshot = {
            managed: { generation: 1 },
            busy: true,
            workflowContext: { routingIntent, planName: "example", liveQuestion: true },
            validationProgress: {
                kind: "workflow",
                outcome: "running",
                stage: "ci",
                checks: { ci: "running", semanticReview: "pending", humanReview: "pending", merge: "pending" },
            },
        } as const;
        const waiting = tuiSessionSidebarProjection(snapshot);
        assertEquals(waiting.workflow.action, null);
        assertEquals(
            waiting.workflow.currentStage?.detail,
            "The agent needs your answer in the Session before continuing.",
        );
        const answered = tuiSessionSidebarProjection({
            ...snapshot,
            workflowContext: { ...snapshot.workflowContext, liveQuestion: false },
        });
        assertEquals(answered.workflow.currentStage?.id, "mechanical");
        assertEquals(answered.workflow.action, null);
        assertEquals(
            answered.workflow.currentStage?.detail,
            "Run the configured verification command.",
        );
    }
});

test("artifact reader shortcut does not consume the sidebar cycle key or ordinary typing", () => {
    assertEquals(isSessionArtifactOpenKey("\u001b]"), true);
    assertEquals(isSessionArtifactOpenKey("\u001d"), false);
    assertEquals(isSessionArtifactOpenKey("]"), false);
});

test("TUI Session Sidebar reuses the snapshot already loaded for the frame", () => {
    let snapshotReads = 0;
    const sidebar = new TuiSessionSidebar(
        () => "session-1",
        () => {
            snapshotReads += 1;
            return null;
        },
    );
    const lines = sidebar.render(34, { managed: { generation: 0 }, name: "Cached Session" });
    assertEquals(snapshotReads, 0);
    assertStringIncludes(stripAnsi(lines.join("\n")), "Cached Session");
});

test("shared TUI projection defaults idle Sessions without a Plan to Session", () => {
    const projection = tuiSessionSidebarProjection({ managed: { generation: 0 }, artifacts: [] });
    assertEquals(projection.defaultTab, "session");
    assertEquals(projection.workflow.active, false);
    assertEquals(projection.workflow.epic, null);
    assertEquals(projection.session.generation, "0");
});

test("TUI Session Sidebar hides Epic for a standalone Plan", () => {
    const sidebar = new TuiSessionSidebar(
        () => "session-standalone",
        () => ({
            managed: { generation: 1 },
            workflowContext: { routingIntent: "PLANNED_CHANGE", planName: "standalone-plan" },
        }),
    );

    const workflow = stripAnsi(sidebar.render(34).join("\n"));
    assertStringIncludes(workflow, "PLAN");
    assertStringIncludes(workflow, "standalone-plan");
    assertEquals(workflow.includes("EPIC"), false);
});

test("TUI Session Sidebar cycles once for ctrl+] key-down only", () => {
    assertEquals(isSessionSidebarCycleKey("\x1d"), true);
    assertEquals(isSessionSidebarCycleKey("\x1b[93;5u"), true);
    assertEquals(isSessionSidebarCycleKey("\x1b[93;5:1u"), true);
    assertEquals(isSessionSidebarCycleKey("\x1b[93;5:2u"), false);
    assertEquals(isSessionSidebarCycleKey("\x1b[93;5:3u"), false);
    assertEquals(isSessionSidebarCycleKey("]"), false);
});

test("TUI Session Sidebar exposes a keyboard action without changing draft keys", () => {
    assertEquals(isSessionSidebarActionKey("\x1b[13;5u"), true);
    assertEquals(isSessionSidebarActionKey("\r"), false);
    const sidebar = new TuiSessionSidebar(
        () => "session-action",
        () => ({
            managed: { generation: 1 },
            workflowContext: { planName: "needs-answer", liveQuestion: true },
        }),
    );
    assertEquals(sidebar.currentAction(), null);
    assertEquals(stripAnsi(sidebar.render(42).join("\n")).includes("ctrl+enter"), false);
});

test("TUI Session Sidebar stays at the top of the visible transcript viewport", () => {
    const mainLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const lines = composePinnedSessionSidebar(mainLines, ["sidebar top", "sidebar detail"], 12, 5);

    assertEquals(lines.length, 12);
    assertEquals(lines[0].includes("sidebar"), false);
    assertEquals(lines[6].includes("sidebar"), false);
    assertEquals(lines[7].endsWith("sidebar top"), true);
    assertEquals(lines[8].endsWith("sidebar detail"), true);
});

test("TUI Session Sidebar reserves a full-width composer and footer below both panes", () => {
    const mainLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const lines = composePinnedSessionSidebar(
        mainLines,
        ["sidebar top", "sidebar detail"],
        12,
        5,
        ["full width composer", "full width footer"],
    );

    assertEquals(lines.length, 14);
    assertEquals(lines[9].endsWith("sidebar top"), true);
    assertEquals(lines[10].endsWith("sidebar detail"), true);
    assertEquals(lines[12], "full width composer");
    assertEquals(lines[13], "full width footer");
});
