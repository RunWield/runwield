import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";

test("remote root calls laptop personal and remote project tools with distinct owning directories", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const fixtureServer = fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url));
        const personalLog = join(f.homeDir, "personal-mcp.log");
        const serverLog = join(f.remoteHome, "server-personal-mcp.log");
        const projectLog = join(f.remoteProject, "project-mcp.log");
        const definition = (log: string) => ({
            command: process.execPath,
            args: runtimeSourceArgs(["run", "-A", fixtureServer, "synthetic-secret-arg"]),
            env: { RUNWIELD_MCP_FIXTURE_LOG: log, LAPTOP_SECRET: "laptop-only-secret" },
        });
        await writeFile(
            join(f.homeDir, ".wld", "mcp.json"),
            JSON.stringify({
                mcpServers: {
                    personal: definition(personalLog),
                    overridden: definition(serverLog),
                    disabled: definition(serverLog),
                },
            }),
            { mode: 0o600 },
        );
        await writeFile(
            join(f.remoteHome, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { serverPersonal: definition(serverLog) } }),
            { mode: 0o600 },
        );
        await mkdir(join(f.remoteProject, ".wld"));
        await writeFile(join(f.remoteProject, ".gitignore"), ".wld/mcp.json\n");
        await writeFile(
            join(f.remoteProject, ".wld", "mcp.json"),
            JSON.stringify({ mcpServers: { overridden: definition(projectLog), disabled: { enabled: false } } }),
            { mode: 0o600 },
        );
        const snapshot = await fetch(`http://127.0.0.1:${f.connection.port}/mcp/config`, {
            headers: { Authorization: `Bearer ${f.connection.credential}` },
        });
        const text = await snapshot.text();
        assertEquals(text.includes("laptop-only-secret"), false);
        const contexts: string[] = [];
        f.setModelResponseFactories([
            () =>
                fauxAssistantMessage([
                    fauxToolCall("mcp__personal__fixture_echo", { marker: "placement" }),
                    fauxToolCall("mcp__overridden__fixture_echo", { marker: "project-call" }),
                ]),
            (context) => {
                contexts.push(JSON.stringify(context));
                return fauxAssistantMessage(fauxText("Both tools ran."));
            },
        ]);
        const child = await f.start();
        await child.read();
        await child.send({ kind: "mcp" });
        const status = await child.read();
        assertStringIncludes(JSON.stringify(status.notices), "personal: laptop");
        assertStringIncludes(JSON.stringify(status.notices), "overridden: remote");
        assertEquals(JSON.stringify(status).includes("serverPersonal"), false);
        for (const secret of ["synthetic-secret-arg", "laptop-only-secret", f.connection.credential]) {
            assertEquals(JSON.stringify(status).includes(secret), false);
            assertEquals(JSON.stringify(f.mcpTraffic).includes(secret), false);
        }
        assertEquals(
            f.projectRoot === f.remoteProject,
            false,
            "Shared local Memory collection must not select laptop checkout cwd",
        );
        assertStringIncludes(
            await readFile(projectLog, "utf8"),
            `"cwd":${JSON.stringify(await realpath(f.remoteProject))}`,
        );
        await child.send({ kind: "turn", text: "Call both MCP tools." });
        const turn = await child.read();
        assertEquals(turn.ok, true, turn.error);
        assertEquals(contexts.length, 1);
        assertStringIncludes(contexts[0], "laptop-only-secret");
        assertStringIncludes(contexts[0], "fixture-result:project-call");
        const personal = await readFile(personalLog, "utf8");
        assertStringIncludes(personal, `"cwd":${JSON.stringify(await realpath(f.homeDir))}`);
        assertEquals(personal.split('"marker":"placement"').length - 1, 1);
        for (const secret of ["synthetic-secret-arg", "laptop-only-secret", f.connection.credential]) {
            assertEquals(JSON.stringify(f.mcpTraffic).includes(secret), false);
        }
        await assertRejects(() => stat(serverLog), Error, "ENOENT");
    });
});

test("remote turn abort reaches a running laptop MCP call and prevents its delayed effect", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const log = join(f.homeDir, "cancel-mcp.log");
        await writeFile(
            join(f.homeDir, ".wld", "mcp.json"),
            JSON.stringify({
                mcpServers: {
                    personal: {
                        command: process.execPath,
                        args: runtimeSourceArgs([
                            "run",
                            "-A",
                            fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url)),
                        ]),
                        env: { RUNWIELD_MCP_FIXTURE_LOG: log },
                    },
                },
            }),
            { mode: 0o600 },
        );
        f.setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("mcp__personal__fixture_echo", { marker: "cooperative-slow" })),
            () => fauxAssistantMessage(fauxText("Stopped.")),
        ]);
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn-start" });
        assertEquals((await child.read()).kind, "turn-started");
        let started = false;
        for (let i = 0; i < 200; i++) {
            if ((await readFile(log, "utf8").catch(() => "")).includes('"event":"call"')) {
                started = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assertEquals(started, true);
        await child.send({ kind: "cancel" });
        const reports = [await child.read(), await child.read()];
        assertEquals(
            reports.some((report) => report.kind === "cancel" && report.ok),
            true,
        );
        assertEquals(
            reports.some((report) => report.kind === "turn" && report.dormant),
            true,
        );
        assertEquals(f.modelRequests.length, 1, "Aborted work must not resume with a second model request");
        await new Promise((resolve) => setTimeout(resolve, 600));
        const evidence = await readFile(log, "utf8");
        assertStringIncludes(evidence, '"event":"cancelled"');
        assertEquals(evidence.includes("delayed-effect"), false);
    });
});

test("a personal call cancelled behind a sequential Agent tool is never dispatched", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        const log = join(f.homeDir, "queued-mcp.log");
        await writeFile(
            join(f.homeDir, ".wld/mcp.json"),
            JSON.stringify({
                mcpServers: {
                    personal: {
                        command: process.execPath,
                        args: runtimeSourceArgs([
                            "run",
                            "-A",
                            fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url)),
                        ]),
                        env: { RUNWIELD_MCP_FIXTURE_LOG: log },
                    },
                },
            }),
            { mode: 0o600 },
        );
        f.setModelResponseFactories([() => fauxAssistantMessage(fauxText("Ready."))]);
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Initialize the root." });
        assertEquals((await child.read()).ok, true);
        await child.send({ kind: "blocker" });
        assertEquals((await child.read()).ok, true);
        f.setModelResponseFactories([
            () =>
                fauxAssistantMessage([
                    fauxToolCall("fixture_blocker", {}),
                    fauxToolCall("mcp__personal__fixture_echo", { marker: "must-stay-queued" }),
                ]),
        ]);
        try {
            await child.send({ kind: "turn-start" });
            await child.read();
            let blocked = false;
            for (let i = 0; i < 200; i++) {
                if (
                    await stat(join(f.remoteProject, "block-started")).then(
                        () => true,
                        () => false,
                    )
                ) {
                    blocked = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assertEquals(blocked, true);
            await child.send({ kind: "cancel" });
            assertEquals((await child.read()).ok, true);
        } finally {
            await writeFile(join(f.remoteProject, "block-release"), "release");
        }
        assertEquals((await child.read()).kind, "turn");
        const evidence = await readFile(log, "utf8");
        assertEquals(evidence.includes('"event":"call"'), false);
    });
});

test("Cancel during personal discovery on a resumed Session prevents model and tool dispatch", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        f.setModelResponseFactories([() => fauxAssistantMessage(fauxText("Saved."))]);
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Create saved history." });
        const saved = await child.read();
        assertEquals(saved.ok, true);
        await child.send({ kind: "load", sessionId: saved.savedId });
        assertEquals((await child.read()).ok, true);
        const log = join(f.homeDir, "startup.log");
        const release = join(f.homeDir, "init-release");
        await writeFile(
            join(f.homeDir, ".wld/mcp.json"),
            JSON.stringify({
                mcpServers: {
                    personal: {
                        command: process.execPath,
                        args: runtimeSourceArgs([
                            "run",
                            "-A",
                            fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url)),
                        ]),
                        env: { RUNWIELD_MCP_FIXTURE_LOG: log, RUNWIELD_MCP_FIXTURE_INIT_RELEASE: release },
                    },
                },
            }),
            { mode: 0o600 },
        );
        const requestsBefore = f.modelRequests.length;
        f.setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("mcp__personal__fixture_echo", { marker: "must-not-run" })),
            () => fauxAssistantMessage(fauxText("Done.")),
        ]);
        await child.send({ kind: "turn-start" });
        await child.read();
        try {
            let initializing = false;
            for (let i = 0; i < 200; i++) {
                if ((await readFile(log, "utf8").catch(() => "")).includes('"event":"initializing"')) {
                    initializing = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assertEquals(initializing, true);
            await child.send({ kind: "cancel" });
            assertEquals((await child.read()).ok, true);
        } finally {
            await writeFile(release, "release");
        }
        const turn = await child.read();
        assertEquals(turn.kind, "turn");
        assertEquals(turn.dormant, true);
        assertEquals(f.modelRequests.length, requestsBefore);
        assertEquals((await readFile(log, "utf8")).includes('"event":"call"'), false);
    });
});

interface SavedOutputDetails {
    fullOutputPath?: string;
}
test("Pi saves personal oversized output in remote storage and the remote read tool consumes it", async () => {
    await withRemoteRuntimeFixture(async (f) => {
        await writeFile(
            join(f.homeDir, ".wld/mcp.json"),
            JSON.stringify({
                mcpServers: {
                    personal: {
                        command: process.execPath,
                        args: runtimeSourceArgs([
                            "run",
                            "-A",
                            fileURLToPath(new URL("../mcp/fixture-server.ts", import.meta.url)),
                        ]),
                    },
                },
            }),
            { mode: 0o600 },
        );
        let savedPath = "";
        let consumed = false;
        f.setModelResponseFactories([
            () => fauxAssistantMessage(fauxToolCall("mcp__personal__fixture_echo", { marker: "resource-link" })),
            (context) => {
                const result = context.messages.find(
                    (message) => message.role === "toolResult" && message.toolName === "mcp__personal__fixture_echo",
                );
                if (!result || result.role !== "toolResult") throw new Error("Missing MCP result");
                savedPath = (result.details as SavedOutputDetails).fullOutputPath || "";
                assertEquals(savedPath.startsWith(join(f.remoteHome, "tmp") + "/"), true, savedPath);
                return fauxAssistantMessage(fauxToolCall("read", { path: savedPath, limit: 1 }));
            },
            (context) => {
                const result = context.messages.find(
                    (message) => message.role === "toolResult" && message.toolName === "read",
                );
                if (!result || result.role !== "toolResult") throw new Error("Missing remote read result");
                assertEquals(result.isError, false);
                assertStringIncludes(JSON.stringify(result.content), "t".repeat(1000));
                consumed = true;
                return fauxAssistantMessage(fauxText("Read the remote output."));
            },
        ]);
        const child = await f.start();
        await child.read();
        await child.send({ kind: "turn", text: "Read oversized personal output." });
        assertEquals((await child.read()).ok, true);
        assertEquals(consumed, true);
    });
});
