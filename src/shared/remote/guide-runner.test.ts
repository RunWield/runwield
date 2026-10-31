import process from "node:process";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { runRemoteGuideCommand } from "./guide-runner.ts";
import type { GuidedReviewUsage } from "../../cmd/guided-review/protocol.ts";

// The model is the external boundary. Agent admission and Session ownership stay real.
test("in-process guide returns model output and usage without creating a managed Session", async () => {
    await withRuntimeCommandFixture("in-process-guide-", async ({ projectRoot, setModelResponseFactory }) => {
        setModelResponseFactory(() => fauxAssistantMessage(fauxText("Guide from model")));
        const events: GuidedReviewUsage[] = [];
        const result = await runRemoteGuideCommand("Explain the diff.", new AbortController().signal, projectRoot, {
            onUsage: (usage) => {
                events.push(usage);
            },
        });
        assert.equal(result.stdout, "Guide from model");
        assert.equal(result.provider, "runtime-command-fixture");
        assert.equal(result.model, "fixture-model");
        assert.equal(events.length, 1);
        assert.ok(events[0].inputTokens > 0);
        assert.deepEqual(result.usage, events[0]);
        assert.equal(result.cost?.usd, events[0].costUsd);
        const store = openFileSessionStore();
        try {
            assert.equal(
                store.listSessionProjects().filter((project) => project.registeredRoot === projectRoot).length,
                0,
            );
        } finally {
            store.close();
        }
    });
});

test("in-process guide rejects a pre-aborted job before model admission", async () => {
    await assert.rejects(() => runRemoteGuideCommand("Explain.", AbortSignal.abort(), "/not-admitted"), /abort/i);
});

test("explicit guide command keeps subprocess output and failures", async () => {
    await withRuntimeCommandFixture("custom-remote-guide-", async ({ projectRoot }) => {
        const previous = process.env.RUNWIELD_GUIDED_REVIEW_COMMAND;
        try {
            process.env.RUNWIELD_GUIDED_REVIEW_COMMAND = "printf custom-guide";
            const result = await runRemoteGuideCommand("Explain.", new AbortController().signal, projectRoot);
            assert.equal(result.stdout, "custom-guide");
            assert.equal(result.provider, "custom");
            process.env.RUNWIELD_GUIDED_REVIEW_COMMAND = "echo guide-command-failed >&2; exit 7";
            await assert.rejects(
                () => runRemoteGuideCommand("Explain.", new AbortController().signal, projectRoot),
                /guide-command-failed/,
            );
        } finally {
            if (previous === undefined) delete process.env.RUNWIELD_GUIDED_REVIEW_COMMAND;
            else process.env.RUNWIELD_GUIDED_REVIEW_COMMAND = previous;
        }
    });
});

test("remote guide uses the laptop model bridge with remote files and no remote Session storage", async () => {
    const { withRemoteRuntimeFixture, assertRemoteStorageAbsent } = await import("./remote-runtime-test-fixture.ts");
    const { spawnNativeProcess } = await import("../foreground-process.ts");
    const { join } = await import("node:path");
    const { fauxToolCall } = await import("@earendil-works/pi-ai");
    await withRemoteRuntimeFixture(async (f) => {
        let turns = 0;
        f.setModelResponseFactories([
            () => {
                turns++;
                return fauxAssistantMessage(fauxToolCall("read", { path: "sentinel.txt" }));
            },
            (context) => {
                turns++;
                assert.ok(JSON.stringify(context.messages).includes("remote initial"));
                return fauxAssistantMessage(fauxText("Laptop model read the remote worktree."));
            },
        ]);
        const moduleUrl = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
        const script = `
            import { configureRemotePersonalResources } from ${moduleUrl("./personal-resources.ts")};
            import { configureRemoteSettingsConnection } from ${moduleUrl("./settings-bridge.ts")};
            import { configureRemoteMcpConnection } from ${moduleUrl("./mcp-bridge.ts")};
            import { configureRemoteMemoryConnection } from ${moduleUrl("./memory-bridge.ts")};
            import { configureRemoteModelConnection } from ${moduleUrl("../models/model-registry.ts")};
            import { runRemoteGuideCommand } from ${moduleUrl("./guide-runner.ts")};
            const input = JSON.parse(await Bun.stdin.text());
            configureRemotePersonalResources({ globalRoot: input.resources });
            configureRemoteSettingsConnection(input.connection);
            const clearMcp = configureRemoteMcpConnection(input.connection);
            const clearMemory = configureRemoteMemoryConnection({ ...input.connection, collection: input.memoryCollection });
            const clearModels = await configureRemoteModelConnection(input.connection);
            try {
                const result = await runRemoteGuideCommand("Read sentinel.txt and explain its content.", AbortSignal.timeout(15000), input.cwd);
                console.log(JSON.stringify(result));
            } finally { clearModels(); clearMemory(); clearMcp(); }
        `;
        const child = spawnNativeProcess(process.execPath, {
            args: ["--eval", script],
            cwd: f.remoteProject,
            env: {
                HOME: f.remoteHome,
                TMPDIR: join(f.remoteHome, "tmp"),
                WLD_TEST_SANDBOX_HOME: f.remoteHome,
                MNEMOTECA_DB_PATH: join(f.remoteHome, "memory.db"),
                PATH: `${join(f.remoteHome, "bin")}:/usr/bin:/bin`,
            },
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });
        const writer = child.stdin.getWriter();
        await writer.write(
            new TextEncoder().encode(
                JSON.stringify({
                    resources: f.resources,
                    connection: f.connection,
                    memoryCollection: f.memoryCollection,
                    cwd: f.remoteProject,
                }),
            ),
        );
        await writer.close();
        writer.releaseLock();
        const [status, stdout, stderr] = await Promise.all([
            child.status,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        assert.equal(status.success, true, stderr);
        assert.ok(stdout.includes("Laptop model read the remote worktree."), stdout);
        assert.equal(f.modelRequests.length, 2);
        assert.equal(turns, 2);
        assert.equal(f.saves.length, 0);
        await assertRemoteStorageAbsent(f);
    });
});

test("in-process guide rejects empty assistant output", async () => {
    await withRuntimeCommandFixture("empty-in-process-guide-", async ({ projectRoot, setModelResponseFactory }) => {
        setModelResponseFactory(() => fauxAssistantMessage(fauxText("")));
        await assert.rejects(
            () => runRemoteGuideCommand("Explain.", new AbortController().signal, projectRoot),
            /no assistant output/,
        );
    });
});

test("in-process guide reports model failures instead of returning stale output", async () => {
    await withRuntimeCommandFixture("failed-in-process-guide-", async ({ projectRoot, setModelResponseFactory }) => {
        setModelResponseFactory(() => {
            throw new Error("Model unavailable");
        });
        await assert.rejects(
            () => runRemoteGuideCommand("Explain.", new AbortController().signal, projectRoot),
            /Model unavailable/,
        );
    });
});
