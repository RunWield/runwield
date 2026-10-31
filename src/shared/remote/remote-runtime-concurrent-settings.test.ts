import { stdinStream } from "../../testing/stdin-stream.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../foreground-process.ts";
import { writeFile as fsWriteFile, readFile as fsReadFile, copyFile as fsCopyFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionRuntime } from "../session/session-runtime.ts";
import { SessionHost } from "../session/session-host.ts";
import { summarizeProjectedEntries } from "../session/session-transcript-projection.js";
import { configureRemotePersonalResources } from "./personal-resources.ts";
import { configureRemoteModelConnection } from "../models/model-registry.ts";
import { configureRemoteSettingsConnection } from "./settings-bridge.ts";
import { configureRemoteMemoryConnection } from "./memory-bridge.ts";
import { RemoteSessionControl } from "./session-control-client.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { type RuntimeClientInput } from "./remote-runtime-test-client.ts";
import { type RuntimeFixture, within, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

import process from "node:process";

interface SettingsCommand {
    kind: "turn" | "load" | "switch" | "model" | "thinking" | "compact" | "cycle" | "pending" | "close";
    sessionId?: string;
    agentName?: string;
    model?: string;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
}
interface SettingsReport {
    ok: boolean;
    error?: string;
    savedId?: string;
    agentName?: string | null;
    model?: string | null;
    thinkingLevel?: string | null;
    dormant: boolean;
}
interface SettingsProcess {
    command(command: SettingsCommand): Promise<SettingsReport>;
    close(): Promise<void>;
}

// A separate process runs real Runtime operations; only model replies are synthetic.
async function runSettingsClient() {
    const lines = processLines(stdinStream());
    const input: RuntimeClientInput = JSON.parse((await lines.read()).value || "{}");
    configureRemotePersonalResources({ globalRoot: input.resources });
    configureRemoteSettingsConnection(input.connection);
    const clearMemory = configureRemoteMemoryConnection({ ...input.connection, collection: input.memoryCollection });
    const clearModels = await configureRemoteModelConnection(input.connection);
    const host = new SessionHost();
    const runtime = new SessionRuntime({
        sessionHost: host,
        sessionStore: null,
        remoteSessionControl: new RemoteSessionControl(input.connection),
        ownerProcessKind: "test",
        ownerInstanceId: crypto.randomUUID(),
    });
    let id = await runtime.createPromptReadySession({ cwd: input.cwd, agentName: "remote-runtime" });
    function report(ok = true, error?: string) {
        const managed = host.getSession(id)?.getManagedMetadata();
        console.log(
            JSON.stringify({
                ok,
                error,
                savedId: managed?.runwieldSessionId,
                agentName: managed?.activeAgent,
                model: managed?.model,
                thinkingLevel: managed?.thinkingLevel,
                dormant: runtime.isManagedSessionDormant(id),
            }),
        );
    }
    try {
        report();
        while (true) {
            const next = await lines.read();
            if (next.done) break;
            const command: SettingsCommand = JSON.parse(next.value);
            if (command.kind === "close") break;
            try {
                if (command.kind === "load") {
                    await runtime.closeAllSessionsWhenIdle();
                    id = (await runtime.loadSession({ cwd: input.cwd, sessionId: command.sessionId || "" })).sessionId;
                } else if (command.kind === "pending") {
                    host.getSession(id)!.mergePendingManagedTurnIntent({
                        agentName: command.agentName,
                        model: command.model,
                        provider: "runtime-command-fixture",
                        manualModel: true,
                        thinkingLevel: command.thinkingLevel,
                    });
                } else {
                    const result =
                        command.kind === "turn"
                            ? await runtime.promptUserTurn(id, { initialRequest: "Remember durable amber-741." })
                            : command.kind === "switch"
                              ? await runtime.switchAgent(id, { agentName: command.agentName || "remote-runtime" })
                              : command.kind === "model"
                                ? await runtime.reconfigureSessionModel(
                                      id,
                                      command.model || "fixture-model",
                                      "runtime-command-fixture",
                                  )
                                : command.kind === "thinking"
                                  ? await runtime.setSessionThinkingLevel(id, command.thinkingLevel || "off")
                                  : command.kind === "cycle"
                                    ? await runtime.cycleSessionThinkingLevel(id)
                                    : await runtime.compactSession(id, "Keep durable amber-741.");
                    if ("ok" in result && !result.ok) {
                        report(false, result.error);
                        continue;
                    }
                }
                report();
            } catch (error) {
                report(false, String(error));
            }
        }
    } finally {
        await runtime.closeAllSessionsWhenIdle();
        clearModels();
        clearMemory();
        await lines.cancel();
        lines.releaseLock();
    }
}

async function startSettingsProcess(f: RuntimeFixture): Promise<SettingsProcess> {
    const child = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs([
            "run",
            "-A",
            "--quiet",
            "--config",
            new URL("../../../deno.json", import.meta.url).pathname,
            new URL(import.meta.url).pathname,
            "--settings-client",
        ]),
        cwd: f.remoteProject,
        env: {
            HOME: f.remoteHome,
            WLD_TEST_SANDBOX_HOME: f.remoteHome,
            MNEMOTECA_DB_PATH: join(f.remoteHome, "memory.db"),
        },
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const writer = child.stdin.getWriter();
    const reader = processLines(child.stdout);
    const stderr = new Response(child.stderr).text();
    async function send(value: RuntimeClientInput | SettingsCommand) {
        await writer.write(new TextEncoder().encode(JSON.stringify(value) + "\n"));
    }
    async function read(): Promise<SettingsReport> {
        const next = await within(reader.read());
        if (next.done) throw new Error(`Settings client exited: ${await stderr}`);
        return JSON.parse(next.value);
    }
    await send({
        connection: f.control.connection,
        resources: f.resources,
        cwd: f.remoteProject,
        memoryCollection: f.memoryCollection,
    });
    const ready = await read();
    assertEquals(ready.ok, true, ready.error);
    return {
        async command(command) {
            await send(command);
            const result = await read();
            assertEquals(result.ok, true, result.error);
            assertEquals(result.dormant, true);
            return result;
        },
        async close() {
            await send({ kind: "close" }).catch(() => {});
            await writer.close().catch(() => {});
            writer.releaseLock();
            try {
                const status = await within(child.status, 5000);
                assertEquals(status.code, 0, await stderr);
            } finally {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* Already exited. */
                }
                await child.status;
                await reader.cancel().catch(() => {});
                reader.releaseLock();
                await stderr;
            }
        },
    };
}

async function withConcurrentSettings(
    run: (f: RuntimeFixture, a: SettingsProcess, b: SettingsProcess, id: string) => Promise<void>,
) {
    await withRemoteRuntimeFixture(
        async (f) => {
            await fsWriteFile(
                join(f.resources, "agents", "remote-new.md"),
                "---\nname: Remote New\ndescription: New conversation Agent\ntools:\n    - read\n---\nNEW-AGENT-CONTEXT. Keep durable amber-741.\n",
            );
            const settings = JSON.parse(await fsReadFile(f.settingsPath, "utf8"));
            settings.compaction = { enabled: false, keepRecentTokens: 64, reserveTokens: 1024 };
            await fsWriteFile(f.settingsPath, JSON.stringify(settings));
            await fsCopyFile(f.settingsPath, join(f.resources, "settings.json"));
            f.setModelResponse("Durable amber-741 remains. " + "Earlier conversation context. ".repeat(80));
            const a = await startSettingsProcess(f);
            const b = await startSettingsProcess(f);
            try {
                const first = await b.command({ kind: "turn" });
                assert(first.savedId);
                f.setModelResponse("Durable amber-741 remains.");
                await b.command({ kind: "turn" });
                await b.command({ kind: "thinking", thinkingLevel: "low" });
                const loaded = await a.command({ kind: "load", sessionId: first.savedId });
                assertEquals(loaded.agentName, "remote-runtime");
                assertEquals(loaded.thinkingLevel, "low");
                await b.command({ kind: "switch", agentName: "remote-new" });
                await b.command({ kind: "model", model: "new-model" });
                await b.command({ kind: "thinking", thinkingLevel: "medium" });
                assertEquals(f.store.inspectSessionActivation(first.savedId).activation?.state, "idle");
                await run(f, a, b, first.savedId);
            } finally {
                await a.close();
                await b.close();
            }
        },
        { reasoning: true, additionalModels: [{ id: "new-model", name: "New Model", reasoning: true }] },
    );
}

async function savedSettings(f: RuntimeFixture, id: string) {
    const saved = (await f.control.list(id))[0];
    assert(saved.contents);
    return summarizeProjectedEntries(
        saved.contents
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
    );
}

if (process.argv.slice(2).includes("--settings-client")) {
    await runSettingsClient();
} else {
    test("stale remote compact uses fresh laptop Agent, manual model and thinking without overwriting them", async () => {
        await withConcurrentSettings(async (f, a, _b, id) => {
            const contexts: string[] = [];
            f.setModelResponseFactory((context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxText("Compacted durable amber-741."));
            });
            const before = f.saves.length;
            const compacted = await a.command({ kind: "compact" });
            assertEquals(compacted.agentName, "remote-new");
            assertEquals(compacted.model, "new-model");
            assertEquals(compacted.thinkingLevel, "medium");
            assertEquals(contexts.length, 1, "Compaction must issue one model request, not replay the turn");
            assertStringIncludes(contexts[0], "durable amber-741");
            assertEquals(f.modelRequests.at(-1)?.model, "new-model");
            assert(
                f.saves
                    .slice(before)
                    .some((entry) => entry.kind === "append" && entry.contents.includes('"type":"compaction"')),
            );
            const saved = await savedSettings(f, id);
            assertEquals(saved.activeAgent, "remote-new");
            assertEquals(saved.thinkingLevel, "medium");
            assertEquals(f.store.inspectSessionActivation(id).activation?.state, "idle");
        });
    });

    test("stale remote thinking cycle starts from the freshly committed laptop level and keeps the new Agent", async () => {
        await withConcurrentSettings(async (f, a, _b, id) => {
            const cycled = await a.command({ kind: "cycle" });
            assertEquals(cycled.agentName, "remote-new");
            assertEquals(cycled.model, "new-model");
            assertEquals(cycled.thinkingLevel, "high");
            const saved = await savedSettings(f, id);
            assertEquals(saved.activeAgent, "remote-new");
            assertEquals(saved.thinkingLevel, "high");
        });
    });

    test("fresh remote provider context uses committed settings while explicit pending settings still win", async () => {
        await withConcurrentSettings(async (f, a, b, id) => {
            // Change the laptop evidence after prompt's metadata read, but before
            // its fresh admission. A pre-admission synchronize is not authority.
            await b.command({ kind: "switch", agentName: "remote-runtime" });
            await b.command({ kind: "thinking", thinkingLevel: "low" });
            let changeAtAdmission = true;
            f.policy.before = async (request, path) => {
                if (path === "/session/control" && request.kind === "begin" && changeAtAdmission) {
                    changeAtAdmission = false;
                    await b.command({ kind: "switch", agentName: "remote-new" });
                    await b.command({ kind: "model", model: "new-model" });
                    await b.command({ kind: "thinking", thinkingLevel: "medium" });
                }
                return undefined;
            };
            const contexts: string[] = [];
            f.setModelResponseFactory((context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxText("Durable amber-741 remains."));
            });
            const resumed = await a.command({ kind: "turn" });
            assertEquals(resumed.agentName, "remote-new");
            assertEquals(resumed.thinkingLevel, "medium");
            assertStringIncludes(contexts[0], "NEW-AGENT-CONTEXT");
            assertStringIncludes(contexts[0], "Durable amber-741 remains.");
            assertEquals(f.modelRequests.at(-1)?.model, "new-model");
            assertStringIncludes(JSON.stringify(f.modelRequests.at(-1)?.options), '"reasoning":"medium"');
            f.setModelResponse("Compacted durable amber-741.");
            await a.command({
                kind: "pending",
                agentName: "remote-runtime",
                model: "fixture-model",
                thinkingLevel: "low",
            });
            const overridden = await a.command({ kind: "compact" });
            assertEquals(overridden.agentName, "remote-runtime");
            assertEquals(overridden.model, "fixture-model");
            assertEquals(overridden.thinkingLevel, "low");
            assertEquals(f.modelRequests.at(-1)?.model, "fixture-model");
            const saved = await savedSettings(f, id);
            assertEquals(saved.activeAgent, "remote-runtime");
            assertEquals(saved.thinkingLevel, "low");
        });
    });
}
