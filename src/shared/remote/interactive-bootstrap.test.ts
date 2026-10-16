import { decodeTextStream } from "../../testing/decode-text-stream.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, stat as fsStat } from "node:fs/promises";
import { spawnNativeProcess } from "../foreground-process.ts";
import { readdirSync } from "node:fs";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { listProjectsFromDisk } from "../session/file-session-storage.ts";
import { startRemoteControlService } from "./control.ts";
import process from "node:process";

test("production remote bootstrap uses the laptop catalog and mounted settings, then waits for TUI lifetime", async () => {
    await withRuntimeCommandFixture("remote-bootstrap-", async ({ homeDir, projectRoot }) => {
        const resources = join(homeDir, ".wld");
        const settings = JSON.parse(await fsReadFile(join(resources, "settings.json"), "utf8"));
        await fsWriteFile(
            join(resources, "settings.json"),
            JSON.stringify({
                ...settings,
                defaultProvider: "laptop-http",
                defaultModel: "remote-model",
            }),
        );
        await fsWriteFile(
            join(resources, "models.json"),
            JSON.stringify({
                providers: {
                    "laptop-http": {
                        api: "openai-completions",
                        apiKey: "laptop-only-secret",
                        baseUrl: "http://127.0.0.1:1/v1",
                        models: [{ id: "remote-model", name: "Remote Model", contextWindow: 10000, maxTokens: 1000 }],
                    },
                },
            }),
        );
        const remoteHome = join(homeDir, "remote-account");
        await fsMkdir(join(remoteHome, ".wld"), { recursive: true });
        const sentinel = "This remote profile must never be read";
        await fsWriteFile(join(remoteHome, ".wld", "settings.json"), sentinel);
        const baseDir = join(homeDir, "laptop-history");
        const store = openFileSessionStore({ baseDir });
        const identity = { buildId: "a".repeat(64), protocol: 1 };
        const service = startRemoteControlService(
            identity,
            {
                baseDir: store.path,
                targetLabel: `host:${projectRoot}`,
                target: {
                    host: { hostname: "host.example", user: "tester", port: 22, hostKeyFingerprint: "SHA256:fixture" },
                    cwd: projectRoot,
                    home: remoteHome,
                    os: "Linux",
                    arch: "x86_64",
                    gitRoot: null,
                    gitDir: null,
                    gitCommonDir: null,
                    primaryRoot: null,
                    isWorktree: false,
                },
            },
            "fixture@host-1234",
        );
        const entry = new URL("./entry.ts", import.meta.url).href;
        const tui = new URL("../../ui/tui/tui.ts", import.meta.url).href;
        const terminalModule = new URL("../../ui/tui/testing/virtual-terminal.js", import.meta.url).href;
        const script = join(homeDir, "bootstrap-child.ts");
        await fsWriteFile(
            script,
            `
import { runRemoteView } from ${JSON.stringify(entry)};
import { initTUIWithPair, RunWieldTui } from ${JSON.stringify(tui)};
import { VirtualTerminal } from ${JSON.stringify(terminalModule)};
const terminal = new VirtualTerminal({ columns: 120, rows: 30 });
initTUIWithPair({ terminal, tui: new RunWieldTui(terminal) });
let returned = false;
const running = runRemoteView().then(() => { returned = true; });
const deadline = Date.now() + 10000;
while (!terminal.getScreenText().includes("laptop-http/remote-model") && Date.now() < deadline && !returned) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await terminal.flush();
}
await (await import(${JSON.stringify(
                new URL("../../ui/tui/chat-session.ts", import.meta.url).href,
            )})).persistThinkingLevel("high", ${JSON.stringify(projectRoot)});
terminal.typeText("Unsubmitted production prompt");
await new Promise((resolve) => setTimeout(resolve, 200));
await terminal.flush();
console.log(JSON.stringify({ returned, screen: terminal.getScreenText(), home: (await import(${JSON.stringify(
                new URL("../../constants.js", import.meta.url).href,
            )})).getHomeDir() }));
await running;
console.log("RETURNED_AFTER_TERMINATION");
`,
        );
        let child: import("../foreground-process.ts").NativeProcess | undefined;
        try {
            for (const [path, body] of [
                ["handshake", JSON.stringify(identity)],
                ["readiness", ""],
            ]) {
                const response = await fetch(`http://127.0.0.1:${service.port}/${path}`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${service.credential}` },
                    body,
                });
                await response.text();
                assertEquals(response.ok, true);
            }
            child = spawnNativeProcess(process.execPath, {
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
                    HOME: remoteHome,
                    WLD_TEST_SANDBOX_HOME: remoteHome,
                    MNEMOTECA_DB_PATH: join(remoteHome, "memory.db"),
                },
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
            });
            const writer = child.stdin.getWriter();
            await writer.write(
                new TextEncoder().encode(
                    JSON.stringify({
                        connection: { port: service.port, credential: service.credential },
                        resources: { globalRoot: resources },
                        memoryCollection: "fixture@host-1234",
                        cwd: projectRoot,
                        view: {
                            host: "host",
                            cwd: projectRoot,
                            status: "Connected",
                            trust: "Trusted",
                            readiness: "Ready",
                        },
                    }) + "\n",
                ),
            );
            // Keep the terminal input pipe open during the normal interactive lifetime.
            const stderr = new Response(child.stderr).text();
            const reader = child.stdout.pipeThrough(decodeTextStream()).getReader();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            const first = await Promise.race([
                reader.read(),
                new Promise<never>(
                    (_, reject) => (timeout = setTimeout(() => reject(new Error("Bootstrap timeout")), 15000)),
                ),
            ]).finally(() => clearTimeout(timeout));
            const report = JSON.parse(first.value || "{}");
            assertEquals(report.returned, false);
            assertEquals(report.home, remoteHome);
            assertStringIncludes(report.screen, "laptop-http/remote-model");
            assertStringIncludes(report.screen, "Unsubmitted production prompt");
            assertEquals(
                JSON.parse(await fsReadFile(join(resources, "settings.json"), "utf8")).defaultThinkingLevel,
                "high",
            );
            assertEquals(listProjectsFromDisk(baseDir), []);
            assertEquals(Array.from(readdirSync(baseDir, { withFileTypes: true })), []);
            assertEquals(await fsReadFile(join(remoteHome, ".wld", "settings.json"), "utf8"), sentinel);
            const bundledSkillsPath = join(remoteHome, ".wld", "bundled-skills");
            const skillsDeadline = Date.now() + 10_000;
            while (Date.now() < skillsDeadline) {
                try {
                    await fsStat(bundledSkillsPath);
                    break;
                } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
            }
            // Core bundled Skill materialization is a remote runtime cache, not a personal profile or transcript.
            assertEquals(
                Array.from(readdirSync(join(remoteHome, ".wld"), { withFileTypes: true }))
                    .map((entry) => entry.name)
                    .sort(),
                ["bundled-skills", "settings.json"],
            );
            child.kill("SIGTERM");
            let remainder = "";
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                remainder += next.value;
            }
            assertEquals(remainder.includes("RETURNED_AFTER_TERMINATION"), false);
            reader.releaseLock();
            await writer.close();
            assertEquals((await child.status).code, 143, await stderr);
        } finally {
            try {
                child?.kill("SIGKILL");
            } catch {
                /* Already exited. */
            }
            await child?.status;
            await service.close();
            store.close();
        }
    });
});
