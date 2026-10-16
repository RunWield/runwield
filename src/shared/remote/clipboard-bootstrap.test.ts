import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { listProjectsFromDisk } from "../session/file-session-storage.ts";
import { startRemoteControlService } from "./control.ts";
import { laptopClipboardFixture } from "./clipboard-test-fixture.ts";

Deno.test({
    name: "production remote TUI ctrl-v previews laptop clipboard input before creating a transcript",
    ignore: Deno.build.os !== "darwin",
    async fn() {
        await withRuntimeCommandFixture("remote-bootstrap-", async ({ homeDir, projectRoot }) => {
            const resources = join(homeDir, ".wld");
            const settings = JSON.parse(await Deno.readTextFile(join(resources, "settings.json")));
            await Deno.writeTextFile(
                join(resources, "settings.json"),
                JSON.stringify({
                    ...settings,
                    defaultProvider: "laptop-http",
                    defaultModel: "remote-model",
                }),
            );
            await Deno.writeTextFile(
                join(resources, "models.json"),
                JSON.stringify({
                    providers: {
                        "laptop-http": {
                            api: "openai-completions",
                            apiKey: "laptop-only-secret",
                            baseUrl: "http://127.0.0.1:1/v1",
                            models: [{
                                id: "remote-model",
                                name: "Remote Model",
                                input: ["text", "image"],
                                contextWindow: 10000,
                                maxTokens: 1000,
                            }],
                        },
                    },
                }),
            );
            const remoteHome = join(homeDir, "remote-account");
            await Deno.mkdir(join(remoteHome, ".wld"), { recursive: true });
            const sentinel = "This remote profile must never be read";
            await Deno.writeTextFile(join(remoteHome, ".wld", "settings.json"), sentinel);
            const baseDir = join(homeDir, "laptop-history");
            const store = openFileSessionStore({ baseDir });
            const identity = { buildId: "a".repeat(64), protocol: 1 };
            const hardware = await laptopClipboardFixture();
            await Deno.writeTextFile(join(hardware.root, "remote-clipboard"), "none");
            const oldPath = Deno.env.get("PATH");
            const oldClipboardMode = Deno.env.get("CLIPBOARD_MODE_PATH");
            const oldClipboardPng = Deno.env.get("CLIPBOARD_PNG_PATH");
            Deno.env.set("PATH", `${hardware.root}:${oldPath}`);
            Deno.env.set("CLIPBOARD_MODE_PATH", hardware.modePath);
            Deno.env.set("CLIPBOARD_PNG_PATH", join(hardware.root, "clipboard.png"));
            const service = startRemoteControlService(identity, {
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
            }, "clipboard-bootstrap");
            const entry = new URL("./entry.ts", import.meta.url).href;
            const tui = new URL("../../ui/tui/tui.ts", import.meta.url).href;
            const terminalModule = new URL("../../ui/tui/testing/virtual-terminal.js", import.meta.url).href;
            const script = join(homeDir, "bootstrap-child.ts");
            await Deno.writeTextFile(
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
await new Promise((resolve) => setTimeout(resolve, 500));
terminal.input("\\x16");
const pasteDeadline = Date.now() + 4000;
while (!terminal.getScreenText().includes("image/png") && Date.now() < pasteDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await terminal.flush();
}
terminal.typeText("Unsubmitted production prompt");
await new Promise((resolve) => setTimeout(resolve, 200));
await terminal.flush();
console.log(JSON.stringify({ returned, screen: terminal.getScreenText(), home: (await import(${
                    JSON.stringify(new URL("../../constants.js", import.meta.url).href)
                })).getHomeDir() }));
await running;
console.log("RETURNED_AFTER_TERMINATION");
`,
            );
            let child: Deno.ChildProcess | undefined;
            try {
                for (const [path, body] of [["handshake", JSON.stringify(identity)], ["readiness", ""]]) {
                    const response = await fetch(`http://127.0.0.1:${service.port}/${path}`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${service.credential}` },
                        body,
                    });
                    await response.text();
                    assertEquals(response.ok, true);
                }
                child = new Deno.Command(Deno.execPath(), {
                    args: [
                        "run",
                        "-A",
                        "--quiet",
                        "--config",
                        new URL("../../../deno.json", import.meta.url).pathname,
                        script,
                    ],
                    cwd: projectRoot,
                    env: {
                        HOME: remoteHome,
                        WLD_TEST_SANDBOX_HOME: remoteHome,
                        MNEMOTECA_DB_PATH: join(remoteHome, "memory.db"),
                        PI_IMAGE_PROTOCOL: "none",
                        CLIPBOARD_MODE_PATH: join(hardware.root, "remote-clipboard"),
                    },
                    stdin: "piped",
                    stdout: "piped",
                    stderr: "piped",
                }).spawn();
                const writer = child.stdin.getWriter();
                await writer.write(new TextEncoder().encode(
                    JSON.stringify({
                        connection: { port: service.port, credential: service.credential },
                        resources: { globalRoot: resources },
                        cwd: projectRoot,
                        memoryCollection: "clipboard-bootstrap",
                        view: {
                            host: "host",
                            cwd: projectRoot,
                            status: "Connected",
                            trust: "Trusted",
                            readiness: "Ready",
                        },
                    }) + "\n",
                ));
                // Keep the terminal input pipe open during the normal interactive lifetime.
                const stderr = new Response(child.stderr).text();
                const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
                let timeout: ReturnType<typeof setTimeout> | undefined;
                const first = await Promise.race([
                    reader.read(),
                    new Promise<never>((_, reject) =>
                        timeout = setTimeout(() => reject(new Error("Bootstrap timeout")), 15000)
                    ),
                ]).finally(() => clearTimeout(timeout));
                const report = JSON.parse(first.value || "{}");
                assertEquals(report.returned, false);
                assertEquals(report.home, remoteHome);
                assertStringIncludes(report.screen, "laptop-http/remote-model");
                assertStringIncludes(report.screen, "Unsubmitted production prompt");
                assertStringIncludes(report.screen, "image/png");
                assertEquals(report.screen.includes("Cannot attach"), false);
                assertEquals(listProjectsFromDisk(baseDir), []);
                assertEquals(Array.from(Deno.readDirSync(baseDir)), []);
                assertEquals(await Deno.readTextFile(join(remoteHome, ".wld", "settings.json")), sentinel);
                // Core bundled Skill materialization is a remote runtime cache, not a personal profile or transcript.
                assertEquals(Array.from(Deno.readDirSync(join(remoteHome, ".wld"))).map((entry) => entry.name).sort(), [
                    "bundled-skills",
                    "settings.json",
                ]);
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
                } catch { /* Already exited. */ }
                await child?.status;
                await service.close();
                store.close();
                if (oldPath === undefined) Deno.env.delete("PATH");
                else Deno.env.set("PATH", oldPath);
                if (oldClipboardMode === undefined) Deno.env.delete("CLIPBOARD_MODE_PATH");
                else Deno.env.set("CLIPBOARD_MODE_PATH", oldClipboardMode);
                if (oldClipboardPng === undefined) Deno.env.delete("CLIPBOARD_PNG_PATH");
                else Deno.env.set("CLIPBOARD_PNG_PATH", oldClipboardPng);
                await hardware.close();
            }
        });
    },
});
