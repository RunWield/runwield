import { test } from "node:test";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { emitHostedSessionRuntimeEvent } from "../../shared/session/session-runtime-events.js";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { initRunWieldTheme } from "../theme/theme.js";
import {
    buildFooterContextStat,
    buildFooterLine1Parts,
    buildFooterLocationText,
    buildFooterWorkflowLabelParts,
    createChatFooterController,
    getFooterWorkflowLabelText,
    renderFooterWorkflowLabelParts,
    shouldShowFooterThinkingLevel,
} from "./chat-footer.ts";

initRunWieldTheme();

test("footer thinking level is hidden until a model is configured", () => {
    assertEquals(shouldShowFooterThinkingLevel("", "medium"), false);
    assertEquals(shouldShowFooterThinkingLevel("test/model", "off"), false);
    assertEquals(shouldShowFooterThinkingLevel("test/model", "medium"), true);
});

test("footer context stat shows percentage, capacity, and auto-compaction", () => {
    assertEquals(buildFooterContextStat({ contextWindow: 1_000_000, percent: 48.65 }, true), {
        text: "48.6%/1.0M (Auto-compact)",
        token: "dim",
    });
    assertEquals(buildFooterContextStat({ contextWindow: 128_000, percent: 75 }, false), {
        text: "75.0%/128k",
        token: "warning",
    });
    assertEquals(buildFooterContextStat({ contextWindow: 200_000, percent: 95 }, true), {
        text: "95.0%/200k (Auto-compact)",
        token: "error",
    });
    assertEquals(buildFooterContextStat(null, true), null);
});

test("footer workflow label formats eligible routing context", () => {
    const parts = buildFooterWorkflowLabelParts({ displayName: "Planner", agentName: "planner" }, {
        routingIntent: "FEATURE",
        complexity: "MEDIUM",
        planName: "my-awesome-plan",
    }, 80);
    assertEquals(getFooterWorkflowLabelText(parts), "Planner - Medium Planned Change - my-awesome-plan");
    assertEquals(parts.map((part) => part.token), [
        "accent",
        "dim",
        "complexityMedium",
        "dim",
        "routingFeature",
        "dim",
        "dim",
    ]);
});

test("footer location follows active worktree execution context", () => {
    const text = buildFooterLocationText({
        cwd: "/repo",
        activeExecutionWorkflow: { executionCwd: "/repo-demo", worktreeBranch: "worktree/demo" },
    }, { home: "/repo", resolveBranch: () => "main" });
    assertEquals(text, "/repo-demo (worktree/demo)");
});

test("footer location shortens RunWield-managed worktree paths", () => {
    const text = buildFooterLocationText({
        cwd: "/Users/gandazgul/Documents/web/runwield",
        activeExecutionWorkflow: {
            executionCwd:
                "/Users/gandazgul/.wld/worktrees/--Users-gandazgul-Documents-web-runwield--/runwield-frontend-framework-design-skill-51003995",
            worktreeBranch: "worktree/frontend-framework-design-skill-51003995",
        },
    }, { home: "/Users/gandazgul", resolveBranch: () => "main" });
    assertEquals(
        text,
        "runwield/runwield-frontend-framework-design-skill-51003995 (worktree/frontend-framework-design-skill-51003995)",
    );
});

test("footer line keeps location left of workflow label", () => {
    const line = buildFooterLine1Parts(
        { displayName: "Planner", agentName: "planner" },
        { routingIntent: "FEATURE", complexity: "MEDIUM", planName: "very-long-plan-name" },
        "~/project (main)",
        80,
    );
    assertEquals(line.left, "~/project (main)");
    assertEquals(getFooterWorkflowLabelText(line.rightParts), "Planner - Medium Planned Change - very-long-plan-name");
});

test("footer workflow renderer applies provided theme tokens", () => {
    const rendered = renderFooterWorkflowLabelParts(
        buildFooterWorkflowLabelParts({ displayName: "Engineer", agentName: "engineer" }, {
            routingIntent: "QUICK_FIX",
            complexity: "LOW",
        }, 80),
        { fg: (token: string, text: string) => `<${token}>${text}</${token}>` },
    );
    assertEquals(
        rendered,
        "<accent>Engineer</accent><dim> - </dim><complexityLow>Low</complexityLow><dim> </dim><routingQuickFix>Quick Fix</routingQuickFix>",
    );
});

test("live footer controller subscribes to usage and rebinds on Session replacement", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId, session, projectRoot }) => {
        let activeSessionId = sessionId;
        const second = await runtime.createInteractiveSession({ cwd: projectRoot });
        const controller = createChatFooterController({
            runtime,
            getSessionId: () => activeSessionId,
            requestRender: () => {},
        });
        try {
            emitHostedSessionRuntimeEvent(session, {
                type: "usage",
                usage: {
                    inputTokens: 1200,
                    outputTokens: 250,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costUsd: 0.125,
                },
            });
            assertStringIncludes(controller.component.render(120).join("\n"), "↑1.2k");
            activeSessionId = second.sessionId;
            controller.rebindSession(activeSessionId);
            assertEquals(controller.component.render(120).join("\n").includes("↑1.2k"), false);
            emitHostedSessionRuntimeEvent(session, {
                type: "usage",
                usage: {
                    inputTokens: 1200,
                    outputTokens: 250,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    costUsd: 0.125,
                },
            });
            assertEquals(controller.component.render(120).join("\n").includes("↑1.2k"), false);
        } finally {
            controller.dispose();
        }
    });
});

test("live footer controller reuses one snapshot across idle frames", async () => {
    await withSessionViewFixture(({ runtime, sessionId }) => {
        const controller = createChatFooterController({
            runtime,
            getSessionId: () => sessionId,
            requestRender: () => {},
        });
        try {
            assertEquals(controller.component.render(120), controller.component.render(120));
        } finally {
            controller.dispose();
        }
    });
});

test("live footer controller refreshes the snapshot after a session event", async () => {
    await withSessionViewFixture(({ runtime, sessionId, session }) => {
        const controller = createChatFooterController({
            runtime,
            getSessionId: () => sessionId,
            requestRender: () => {},
        });
        try {
            controller.component.render(120);
            session.resetAgentInfoStack("Engineer", "", "", "engineer");
            session.replaceWorkflowContext({ routingIntent: "QUICK_FIX", complexity: "LOW" });
            assertStringIncludes(controller.component.render(400).join("\n"), "Quick Fix");
        } finally {
            controller.dispose();
        }
    });
});

test("live footer controller tolerates startup before a Session exists", async () => {
    await withSessionViewFixture(({ runtime }) => {
        const controller = createChatFooterController({
            runtime,
            getSessionId: () => "pending-session",
            requestRender: () => {},
        });
        try {
            assertEquals(controller.component.render(100), ["", ""]);
        } finally {
            controller.dispose();
        }
    });
});

test("live footer controller renders and clears the Ctrl+C pending exit notice", async () => {
    await withSessionViewFixture(async ({ runtime, sessionId }) => {
        let renderRequests = 0;
        const controller = createChatFooterController({
            runtime,
            getSessionId: () => sessionId,
            requestRender: () => {
                renderRequests++;
            },
        });
        try {
            controller.markCtrlCPendingExit();
            assertEquals(controller.isCtrlCPendingExit(), true);
            assertStringIncludes(controller.component.render(100).join("\n"), "Ctrl+C - Press again to exit");
            await new Promise((resolve) => setTimeout(resolve, 1100));
            assertEquals(controller.isCtrlCPendingExit(), false);
            assertEquals(renderRequests >= 2, true);
        } finally {
            controller.dispose();
        }
    });
});
