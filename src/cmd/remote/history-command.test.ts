import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import { getRunWieldSessionsBaseDir } from "../../shared/session/root-session.js";
import { startRemoteControlService } from "../../shared/remote/control.ts";
import { RemoteSessionControl } from "../../shared/remote/session-control-client.ts";
import process from "node:process";

test("remote sessions opens committed laptop history offline while its writer remains owned", async () => {
    await withRuntimeCommandFixture("remote-offline-command-", async ({ homeDir, projectRoot }) => {
        const store = openFileSessionStore();
        const identity = { buildId: "a".repeat(64), protocol: 1 };
        const service = startRemoteControlService(identity, {
            baseDir: store.path,
            targetLabel: "offline-host:/unavailable/project",
            target: {
                host: { hostname: "offline.example", user: "tester", port: 22, hostKeyFingerprint: "SHA256:fixture" },
                cwd: "/unavailable/project",
                home: "/unavailable/home",
                os: "Linux",
                arch: "x86_64",
                gitRoot: null,
                gitDir: null,
                gitCommonDir: null,
                primaryRoot: null,
                isWorktree: false,
            },
        });
        const client = new RemoteSessionControl({ port: service.port, credential: service.credential });
        async function post(path: string, body: string) {
            const response = await fetch(`http://127.0.0.1:${service.port}/${path}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${service.credential}` },
                body,
            });
            assertEquals(response.ok, true, await response.clone().text());
            return await response.json();
        }
        try {
            await post("handshake", JSON.stringify(identity));
            await post("readiness", "");
            const id = crypto.randomUUID();
            const operation = await client.create(id, "Offline Session title");
            await post("session/request", JSON.stringify({ operation, sequence: 0, kind: "hydrate", contents: "" }));
            const user = (id: string, text: string) =>
                JSON.stringify({
                    type: "message",
                    id,
                    parentId: null,
                    timestamp: new Date().toISOString(),
                    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
                }) + "\n";
            await post(
                "session/request",
                JSON.stringify({
                    operation,
                    sequence: 1,
                    kind: "append",
                    contents: user("user", "Committed offline conversation"),
                }),
            );
            await post(
                "session/request",
                JSON.stringify({
                    operation,
                    sequence: 2,
                    kind: "append",
                    contents:
                        JSON.stringify({
                            type: "session_info",
                            id: "name",
                            parentId: "user",
                            name: "Offline Session title",
                            timestamp: new Date().toISOString(),
                        }) + "\n",
                }),
            );
            await client.checkpoint(operation);
            const owned = await client.begin(id);
            await post(
                "session/request",
                JSON.stringify({ operation: owned, sequence: 0, kind: "hydrate", contents: "" }),
            );
            await post(
                "session/request",
                JSON.stringify({
                    operation: owned,
                    sequence: 1,
                    kind: "append",
                    contents: user("tail", "UNCOMMITTED-TAIL-MUST-NOT-APPEAR"),
                }),
            );
            const before = store.inspectSessionActivation(id);
            const script = join(homeDir, "offline-child.ts");
            const command = new URL("./index.ts", import.meta.url).href;
            const tui = new URL("../../ui/tui/tui.ts", import.meta.url).href;
            const virtualTerminal = new URL("../../ui/tui/testing/virtual-terminal.js", import.meta.url).href;
            await fsWriteFile(
                script,
                `
import { runRemoteCommand } from ${JSON.stringify(command)};
import { initTUIWithPair, RunWieldTui } from ${JSON.stringify(tui)};
import { VirtualTerminal } from ${JSON.stringify(virtualTerminal)};
const terminal = new VirtualTerminal({ columns: 180, rows: 30 });
initTUIWithPair({ terminal, tui: new RunWieldTui(terminal) });
const running = runRemoteCommand(["sessions"]);
async function waitFor(text: string) {
    for (let i = 0; i < 300; i++) {
        await terminal.flush();
        if (terminal.getScreenText().includes(text)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Missing " + text + ": " + terminal.getScreenText());
}
await waitFor("Offline Session title");
const list = terminal.getScreenText();
terminal.pressEnter();
await waitFor("Committed offline conversation");
const replay = terminal.getScreenText();
terminal.input("q");
await running;
console.log("\\n" + JSON.stringify({ list, replay }));
`,
            );
            const result = await captureForegroundProcess(process.execPath, {
                args: runtimeSourceArgs([
                    "run",
                    "-A",
                    "--quiet",
                    "--config",
                    new URL("../../../deno.json", import.meta.url).pathname,
                    script,
                ]),
                cwd: projectRoot,
                env: {
                    HOME: homeDir,
                    WLD_TEST_SANDBOX_HOME: homeDir,
                    WLD_REMOTE_MODEL_PROOF: "invalid-proof",
                    PATH: "",
                    MNEMOTECA_DB_PATH: join(homeDir, "offline-memory.db"),
                },
            });
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
            const report = JSON.parse(new TextDecoder().decode(result.stdout).trim().split("\n").at(-1) || "{}");
            assertStringIncludes(report.list, "Offline Session title");
            assertStringIncludes(report.list, "offline-host:/unavailable/project");
            assertStringIncludes(report.replay, "Committed offline conversation");
            assertStringIncludes(report.replay, "then /resume.");
            assertEquals(report.replay.includes("UNCOMMITTED-TAIL-MUST-NOT-APPEAR"), false);
            assertEquals(store.inspectSessionActivation(id), before);
            assertEquals(store.path, getRunWieldSessionsBaseDir());
            await client.markUncertain(owned);
        } finally {
            await service.close();
            store.close();
        }
    });
});
