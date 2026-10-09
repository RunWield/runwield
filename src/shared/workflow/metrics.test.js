import { readFile as fsReadFile, realpath as fsRealpath, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertExists } from "../../testing/assertions.ts";
import { join } from "node:path";
import { setCustomSetting } from "../settings.js";
import { git } from "../git-test-fixture.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import {
    classifyToolSubUsage,
    drainWorkflowMetrics,
    getWorkflowMetricsFilePath,
    isWorkflowMetricsEnabled,
    recordToolCallFinished,
    recordToolCallStarted,
    recordWorkflowMetric,
    sanitizeMetricDetails,
} from "./metrics.js";

test("isWorkflowMetricsEnabled honors boolean and object opt-in settings", () => {
    assertEquals(isWorkflowMetricsEnabled(undefined), false);
    assertEquals(isWorkflowMetricsEnabled(false), false);
    assertEquals(isWorkflowMetricsEnabled({ enabled: false }), false);
    assertEquals(isWorkflowMetricsEnabled(true), true);
    assertEquals(isWorkflowMetricsEnabled({ enabled: true }), true);
});

test("recordWorkflowMetric skips writes when disabled", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await setCustomSetting("workflowMetrics", false, "project", projectRoot);
        await recordWorkflowMetric(
            { category: "routing", event: "triage_reported", details: { routingIntent: "INQUIRY" } },
            projectRoot,
        );
        assertEquals(await readMetrics(), []);
    });
});

test("recordWorkflowMetric writes worktree events under the primary project", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const worktreePath = `${projectRoot}-linked`;
        try {
            await git(projectRoot, ["init", "-b", "main"]);
            await git(projectRoot, ["config", "user.email", "runwield@example.com"]);
            await git(projectRoot, ["config", "user.name", "RunWield Test"]);
            await fsWriteFile(join(projectRoot, "README.md"), "base\n");
            await git(projectRoot, ["add", "README.md"]);
            await git(projectRoot, ["commit", "-m", "base"]);
            await git(projectRoot, ["worktree", "add", "-b", "side", worktreePath, "main"]);

            const primaryRoot = await fsRealpath(projectRoot);
            await setCustomSetting("workflowMetrics", true, "project", primaryRoot);
            await recordWorkflowMetric({ category: "execution", event: "task_completed" }, worktreePath);

            await drainWorkflowMetrics();
            const contents = await fsReadFile(getWorkflowMetricsFilePath(primaryRoot), "utf8");
            const metrics = contents
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            assertEquals(metrics.length, 1);
            assertEquals(metrics[0].category, "execution");
        } finally {
            await git(projectRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
            await fsRm(worktreePath, { recursive: true }).catch(() => {});
        }
    });
});

test("recordWorkflowMetric writes sanitized JSONL when enabled", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const record = await recordWorkflowMetric(
            {
                category: "validation",
                event: "ci_attempt",
                planName: "safe-plan",
                agentName: "engineer",
                details: {
                    exitCode: 1,
                    output: "do not keep ci output",
                    worktreePath: "/Users/someone/project/worktree",
                    safeString: "ok",
                },
            },
            projectRoot,
        );
        assertExists(record);
        const [parsed] = await readMetrics();
        assertEquals(parsed.v, 1);
        assertEquals(Number.isNaN(Date.parse(parsed.ts)), false);
        assertEquals(parsed.category, "validation");
        assertEquals(parsed.event, "ci_attempt");
        assertEquals(parsed.planName, "safe-plan");
        assert(typeof parsed.cwdHash === "string" && parsed.cwdHash.length === 64);
        assertExists(parsed.details);
        assertEquals(parsed.details.output, "[redacted]");
        assertEquals(parsed.details.worktreePath, "[path-redacted]");
        assertEquals(parsed.details.safeString, "ok");
    });
});

test("recordWorkflowMetric swallows write failures", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot, readMetrics }) => {
        const runwieldPath = join(homeDir, ".wld");
        await fsRm(runwieldPath, { recursive: true }).catch(() => {});
        await fsWriteFile(runwieldPath, "blocks the metrics directory");

        const record = await recordWorkflowMetric(
            { category: "routing", event: "dispatch_selected", details: { routingIntent: "FEATURE" } },
            projectRoot,
        );

        assertExists(record);
        assertEquals(await readMetrics(), []);
    });
});

test("sanitizeMetricDetails redacts sensitive keys, paths, and long strings", () => {
    const long = "x".repeat(400);
    const sanitized = /** @type {any} */ (
        sanitizeMetricDetails({
            prompt: "secret prompt",
            token: "abc",
            cwd: "/Users/example/project",
            nested: { diffText: "patch", value: long },
        })
    );
    assertEquals(sanitized.prompt, "[redacted]");
    assertEquals(sanitized.token, "[redacted]");
    assertEquals(sanitized.cwd, "[path-redacted]");
    assertEquals(sanitized.nested.diffText, "[redacted]");
    assert(sanitized.nested.value.length < long.length);
});

test("sanitizeMetricDetails redacts generic relative paths but preserves affectedPaths metadata", () => {
    const sanitized = /** @type {any} */ (
        sanitizeMetricDetails({
            path: "src/private/file.js",
            file: "docs/plans/secret.md",
            affectedPaths: ["src/visible.js", "docs/visible.md", "/Users/example/project/secret.js"],
        })
    );
    assertEquals(sanitized.path, "[path-redacted]");
    assertEquals(sanitized.file, "[path-redacted]");
    assertEquals(sanitized.affectedPaths, ["src/visible.js", "docs/visible.md", "[path-redacted]"]);
});

test("sanitizeMetricDetails omits non-plain objects instead of stringifying them", () => {
    const sanitized = /** @type {any} */ (
        sanitizeMetricDetails({
            ok: true,
            error: new Error("/Users/example/project/secret.js failed with private output"),
            url: new URL("file:///Users/example/project/secret.js"),
            items: ["safe", new Error("unsafe output")],
        })
    );
    assertEquals(sanitized.ok, true);
    assertEquals("error" in sanitized, false);
    assertEquals("url" in sanitized, false);
    assertEquals(sanitized.items, ["safe"]);
});

test("recordWorkflowMetric accepts each workflow metric category", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const categories = [
            "routing",
            "planning",
            "execution",
            "validation",
            "recovery",
            "model_selection",
            "tool_usage",
        ];
        for (const category of categories) {
            await recordWorkflowMetric(
                { category: /** @type {any} */ (category), event: `${category}_event`, details: { ok: true } },
                projectRoot,
            );
        }
        const metrics = await readMetrics();
        assertEquals(metrics.length, categories.length);
        assertEquals(
            metrics.map((metric) => metric.category),
            categories,
        );
    });
});

test("classifyToolSubUsage returns coarse categories only", () => {
    assertEquals(classifyToolSubUsage("bash", { command: "deno task ci --filter secret" }), "validation_command");
    assertEquals(classifyToolSubUsage("bash", { command: "git status --short" }), "git");
    assertEquals(classifyToolSubUsage("code_search", { query: "private query" }), "search");
    assertEquals(classifyToolSubUsage("memory", { action: "recall", query: "private query" }), "read");
    assertEquals(classifyToolSubUsage("memory", { action: "store", content: "private memory text" }), "write");
    assertEquals(classifyToolSubUsage("memory", { action: "delete", id: 42 }), "delete");
    assertEquals(classifyToolSubUsage("memory_store", { content: "private memory text" }), "write");
    assertEquals(classifyToolSubUsage("write", { content: "file contents" }), "write");
    assertEquals(classifyToolSubUsage("write_docs", { content: "file contents" }), "write");
    assertEquals(classifyToolSubUsage("edit_docs", { oldText: "before", newText: "after" }), "edit");
});

test("tool usage metrics omit raw commands, queries, file contents, messages, and results", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await recordToolCallStarted(
            "tool-1",
            "bash",
            { command: "grep -R private-query src && cat secret.txt" },
            projectRoot,
            "Engineer",
        );
        await recordToolCallFinished("tool-1", "bash", true, projectRoot, "Engineer");

        const metrics = await readMetrics();
        assertEquals(metrics.length, 2);
        assertEquals(metrics[0].category, "tool_usage");
        assertEquals(metrics[0].details, { toolName: "bash", subUsage: "filesystem" });
        const finishedDetails = metrics[1].details;
        assertExists(finishedDetails);
        assertEquals(finishedDetails.toolName, "bash");
        assertEquals(finishedDetails.subUsage, "filesystem");
        assertEquals(finishedDetails.isError, true);
        const durationMs = finishedDetails.durationMs;
        assert(typeof durationMs === "number");
        assertEquals(Number.isSafeInteger(durationMs), true);
        assert(durationMs >= 0);
        const serialized = JSON.stringify(metrics);
        assertEquals(serialized.includes("private-query"), false);
        assertEquals(serialized.includes("secret.txt"), false);
        assertEquals(serialized.includes("grep -R"), false);
    });
});

test("dedicated Frontend Engineer metrics strip identity and content", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "frontend_runtime_style_resolved",
                sessionId: "session-secret",
                planName: "private-plan",
                agentName: "frontend-engineer",
                details: {
                    policySource: "canonical",
                    recommendation: "pair",
                    runtimeStyle: "autonomous",
                    pairCapable: false,
                    resolutionReason: "canonical_pair_unavailable",
                    route: "https://example.test/path?token=secret",
                    summary: "Rendered user profile",
                    evidence: ["/tmp/screenshot.png"],
                    diagnostics: { console: "error output" },
                    source: "function secret() {}",
                    report: "- final report",
                },
            },
            projectRoot,
        );
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "pair_checkpoint_decided",
                sessionId: "session-secret",
                planName: "private-plan",
                agentName: "frontend-engineer",
                details: {
                    checkpointNumber: 2,
                    decision: "revise",
                    reason: "revision_feedback_required",
                    feedback: "make the dashboard calmer",
                    screenshotPath: "/Users/me/project/shot.png",
                    browserPayload: { url: "http://localhost:3000?token=abc" },
                },
            },
            projectRoot,
        );
        await recordWorkflowMetric(
            {
                category: "execution",
                event: "frontend_execution_completed",
                sessionId: "session-secret",
                planName: "private-plan",
                agentName: "frontend-engineer",
                details: {
                    phase: "validation_repair",
                    runtimeStyle: "pair",
                    checkpointCount: 3,
                    switchedToAutonomous: true,
                    capabilityLost: false,
                    browserPreflightOutcome: "externally_blocked",
                    elapsedMs: 1234,
                    message: "- report with URL http://localhost:5173/secret",
                    file: "src/private/file.js",
                },
            },
            projectRoot,
        );

        const lines = await readMetrics();
        assertEquals(
            lines.map((line) => line.event),
            ["frontend_runtime_style_resolved", "pair_checkpoint_decided", "frontend_execution_completed"],
        );
        assertEquals(lines[0].details, {
            policySource: "canonical",
            recommendation: "pair",
            runtimeStyle: "autonomous",
            pairCapable: false,
            resolutionReason: "canonical_pair_unavailable",
        });
        assertEquals(lines[1].details, {
            checkpointNumber: 2,
            decision: "revise",
            reason: "revision_feedback_required",
        });
        assertEquals(lines[2].details, {
            phase: "validation_repair",
            runtimeStyle: "pair",
            checkpointCount: 3,
            switchedToAutonomous: true,
            capabilityLost: false,
            browserPreflightOutcome: "externally_blocked",
            elapsedMs: 1234,
        });
        const serialized = JSON.stringify(lines);
        for (const forbidden of [
            "session-secret",
            "private-plan",
            "frontend-engineer",
            "dashboard",
            "localhost",
            "token",
            "screenshot",
            "browserPayload",
            "function secret",
            "final report",
            "src/private",
        ]) {
            assertEquals(serialized.includes(forbidden), false, forbidden);
        }
    });
});

test("dedicated Frontend Engineer metrics omit invalid values", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const record = await recordWorkflowMetric(
            {
                category: "execution",
                event: "frontend_execution_completed",
                details: {
                    phase: "free text",
                    runtimeStyle: "pair",
                    checkpointCount: -1,
                    switchedToAutonomous: "yes",
                    capabilityLost: true,
                    browserPreflightOutcome: "succeeded",
                    elapsedMs: Infinity,
                },
            },
            projectRoot,
        );
        assertEquals(record?.details, {
            runtimeStyle: "pair",
            capabilityLost: true,
            browserPreflightOutcome: "succeeded",
        });
    });
});
