import process from "node:process";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { AGENTS } from "../../constants.js";
import {
    assertModelExecutionBackendSupported,
    UnsupportedModelExecutionBackendError,
} from "../models/model-execution.ts";
import { getModelRegistry } from "../models/model-registry.ts";
import { __resetSettingsForTests, getSettingsManager } from "../settings.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { setActiveModel } from "../../ui/tui/chat-session.ts";

test("configured Claude CLI model is supported by typed execution backend dispatch", () => {
    const model = getModelRegistry().find("claude-cli", "sonnet");
    assert(model);
    assertModelExecutionBackendSupported(model);
});

test("explicit Claude CLI selection defers without changing defaults or current runtime Session", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = process.env["HOME"];
        const home = await fsMkdtemp(join(tmpdir(), "runwield-claude-cli-selection-home-"));
        const project = await fsMkdtemp(join(tmpdir(), "runwield-claude-cli-selection-project-"));
        try {
            process.env["HOME"] = home;
            __resetSettingsForTests();
            await fsMkdir(join(home, ".wld"), { recursive: true });
            const calls: Array<{ model: string; provider: string }> = [];
            const runtime = {
                getSessionSnapshot: () => ({
                    id: "session-1",
                    cwd: project,
                    activeModel: { model: "sonnet", provider: "anthropic" },
                    activeAgent: { agentName: AGENTS.ENGINEER },
                }),
                reconfigureSessionModel(_sessionId: string, model: string, provider: string) {
                    calls.push({ model, provider });
                    return Promise.reject(
                        new UnsupportedModelExecutionBackendError({
                            provider,
                            id: model,
                            name: model,
                            api: "anthropic-messages",
                            baseUrl: "",
                            reasoning: true,
                            input: ["text"],
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                            contextWindow: 200000,
                            maxTokens: 16384,
                            executionBackend: "claude-cli",
                        }),
                    );
                },
            };

            const result = await setActiveModel(runtime as never, "session-1", "opus", "claude-cli");
            assertEquals(result.status, "deferred");
            assertStringIncludes(result.message || "", "current Session was not switched");
            assertEquals(calls, [{ model: "opus", provider: "claude-cli" }]);
            const settings = getSettingsManager(project);
            assertEquals(settings.getDefaultProvider(), undefined);
            assertEquals(settings.getDefaultModel(), undefined);
        } finally {
            __resetSettingsForTests();
            if (previousHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = previousHome;
            await fsRm(home, { recursive: true });
            await fsRm(project, { recursive: true });
        }
    });
});
