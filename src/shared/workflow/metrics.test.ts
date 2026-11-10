import { readFile as fsReadFile, realpath as fsRealpath, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import type { WorkflowMetricCategory, WorkflowMetricRecord } from "./metrics.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertExists } from "../../testing/assertions.ts";
import { join } from "node:path";
import { setCustomSetting } from "../settings.js";
import { git } from "../git-test-fixture.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import {
    getWorkflowMetricsFilePath,
    recordToolCallFinished,
    recordToolCallStarted,
    recordWorkflowMetric,
} from "./metrics.ts";

type SanitizedPathDetails = {
    path: string;
    file: string;
    affectedPaths: string[];
};

type SanitizedPlainDetails = {
    ok: boolean;
    items: string[];
};

test("metrics persist only for explicit boolean or object opt-in", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const settings = [
            { value: null, saved: 0 },
            { value: false, saved: 0 },
            { value: { enabled: false }, saved: 0 },
            { value: true, saved: 1 },
            { value: { enabled: true }, saved: 2 },
        ];
        for (const { value, saved } of settings) {
            await setCustomSetting("workflowMetrics", value, "project", projectRoot);
            await recordWorkflowMetric(
                { category: "routing", event: "triage_reported", details: { routingIntent: "INQUIRY" } },
                projectRoot,
            );
            assertEquals((await readMetrics()).length, saved);
        }
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

            const contents = await fsReadFile(getWorkflowMetricsFilePath(primaryRoot), "utf8");
            const metrics = contents
                .trim()
                .split("\n")
                .map((line): WorkflowMetricRecord => JSON.parse(line))
                .filter((record) => record.event !== "collection_epoch");
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

test("recordWorkflowMetric reports write failures without throwing", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot, readMetrics }) => {
        const runwieldPath = join(homeDir, ".wld");
        await fsRm(runwieldPath, { recursive: true }).catch(() => {});
        await fsWriteFile(runwieldPath, "blocks the metrics directory");

        const record = await recordWorkflowMetric(
            { category: "routing", event: "dispatch_selected", details: { routingIntent: "FEATURE" } },
            projectRoot,
        );

        assertEquals(record.persisted, false);
        assertEquals(record.reason, "storage_failure");
        assertEquals(await readMetrics(), []);
    });
});

test("persisted metrics redacts sensitive keys, paths, and long strings", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const long = "x".repeat(400);
        await recordWorkflowMetric(
            {
                category: "routing",
                event: "triage_reported",
                details: {
                    prompt: "secret prompt",
                    token: "abc",
                    cwd: "/Users/example/project",
                    nested: { diffText: "patch", value: long },
                },
            },
            projectRoot,
        );
        const sanitized = (await readMetrics())[0].details;
        assert(sanitized);
        assertEquals(sanitized.prompt, "[redacted]");
        assertEquals(sanitized.token, "[redacted]");
        assertEquals(sanitized.cwd, "[path-redacted]");
        const nested = sanitized.nested;
        assert(nested && typeof nested === "object" && !Array.isArray(nested));
        assertEquals(nested.diffText, "[redacted]");
        assert(typeof nested.value === "string");
        assert(nested.value.length < long.length);
    });
});

test("persisted metrics redacts generic relative paths but preserves affectedPaths metadata", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await recordWorkflowMetric(
            {
                category: "routing",
                event: "triage_reported",
                details: {
                    path: "src/private/file.js",
                    file: "docs/plans/secret.md",
                    affectedPaths: ["src/visible.js", "docs/visible.md", "/Users/example/project/secret.js"],
                },
            },
            projectRoot,
        );
        const sanitized = (await readMetrics())[0].details as SanitizedPathDetails;
        assertEquals(sanitized.path, "[path-redacted]");
        assertEquals(sanitized.file, "[path-redacted]");
        assertEquals(sanitized.affectedPaths, ["src/visible.js", "docs/visible.md", "[path-redacted]"]);
    });
});

test("persisted metrics omits non-plain objects instead of stringifying them", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        await recordWorkflowMetric(
            {
                category: "routing",
                event: "triage_reported",
                details: {
                    ok: true,
                    error: new Error("/Users/example/project/secret.js failed with private output"),
                    url: new URL("file:///Users/example/project/secret.js"),
                    items: ["safe", new Error("unsafe output")],
                },
            },
            projectRoot,
        );
        const sanitized = (await readMetrics())[0].details as SanitizedPlainDetails;
        assertEquals(sanitized.ok, true);
        assertEquals("error" in sanitized, false);
        assertEquals("url" in sanitized, false);
        assertEquals(sanitized.items, ["safe"]);
    });
});

test("recordWorkflowMetric accepts each workflow metric category", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const categories: WorkflowMetricCategory[] = [
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
                { category: category, event: `${category}_event`, details: { ok: true } },
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

test("saved tool calls retain only coarse usage categories", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot, readMetrics }) => {
        const cases = [
            { tool: "bash", args: { command: "deno task ci --filter secret" }, expected: "validation_command" },
            { tool: "bash", args: { command: "git status --short" }, expected: "git" },
            { tool: "code_search", args: { query: "private query" }, expected: "search" },
            { tool: "memory", args: { action: "recall", query: "private query" }, expected: "read" },
            { tool: "memory", args: { action: "store", content: "private memory text" }, expected: "write" },
            { tool: "memory", args: { action: "delete", id: 42 }, expected: "delete" },
            { tool: "memory_store", args: { content: "private memory text" }, expected: "write" },
            { tool: "write", args: { content: "file contents" }, expected: "write" },
            { tool: "write_docs", args: { content: "file contents" }, expected: "write" },
            { tool: "edit_docs", args: { oldText: "before", newText: "after" }, expected: "edit" },
        ];
        for (const [index, sample] of cases.entries()) {
            await recordToolCallStarted("category-" + index, sample.tool, sample.args, projectRoot, "Engineer");
            await recordToolCallFinished("category-" + index, sample.tool, false, projectRoot, "Engineer");
        }
        const rows = await readMetrics();
        assertEquals(
            rows.filter((row) => row.event === "tool_call_started").map((row) => row.details?.subUsage),
            cases.map((sample) => sample.expected),
        );
        assertEquals(JSON.stringify(rows).includes("private"), false);
    });
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
