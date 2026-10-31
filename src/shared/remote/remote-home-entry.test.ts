import process from "node:process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { spawnNativeProcess } from "../foreground-process.ts";
import { makeControlFixture, within } from "./session-save-test-fixture.ts";

const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));

test(
    "piped remote home startup offers directory consent and respects declining it",
    {
        skip: process.platform === "win32" && "The remote server entry requires Unix absolute paths",
    },
    async () => {
        const fixture = await makeControlFixture();
        await fixture.ready();
        const child = spawnNativeProcess(process.execPath, {
            args: ["run", cli, "--remote-view"],
            cwd: fixture.home,
            env: {
                HOME: fixture.home,
                WLD_TEST_SANDBOX_HOME: fixture.home,
                MNEMOTECA_DB_PATH: join(fixture.home, "mnemoteca.db"),
            },
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });
        let exited = false;
        const status = child.status.then((result) => {
            exited = true;
            return result;
        });
        const stderr = new Response(child.stderr).text();
        const writer = child.stdin.getWriter();
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let screen = "";
        try {
            await writer.write(
                new TextEncoder().encode(
                    JSON.stringify({
                        view: {
                            host: "remote-home",
                            cwd: fixture.home,
                            status: "Connected",
                            trust: "OpenSSH SFTP exposes laptop-account files, not a sandbox.",
                            readiness: "Ready",
                        },
                        cwd: fixture.home,
                        connection: { port: fixture.control.port, credential: fixture.control.credential },
                        resources: { globalRoot: fixture.mount },
                        memoryCollection: "remote-home-consent",
                        review: {
                            socketPath: `/tmp/wld-remote-${"a".repeat(32)}/review.sock`,
                            origin: "http://127.0.0.1:43127",
                        },
                    }) + "\n",
                ),
            );
            await within(
                (async () => {
                    while (!screen.includes("Quit")) {
                        const chunk = await reader.read();
                        if (chunk.done) throw new Error(`Remote home consent was not offered: ${await stderr}`);
                        screen += decoder.decode(chunk.value, { stream: true });
                    }
                })(),
                15_000,
            );
            assertStringIncludes(screen, "System or home folder detected");
            assertStringIncludes(screen, "OpenSSH SFTP exposes laptop-account files");
            assertEquals(
                screen.indexOf("OpenSSH SFTP exposes") < screen.indexOf("System or home folder detected"),
                true,
            );
            assertStringIncludes(screen, "Continue");
            // Quit is the default: Enter must not silently accept broad directory access.
            await writer.write(new TextEncoder().encode("\r"));
            await writer.close();
            assertEquals((await within(status)).code, 1);
            assertStringIncludes(await stderr, "Project startup canceled");
            assertEquals(await readdir(fixture.home), []);
        } finally {
            if (!exited) child.kill("SIGKILL");
            await status;
            reader.releaseLock();
            writer.releaseLock();
            await fixture.close();
        }
    },
);
