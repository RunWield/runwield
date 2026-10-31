import stripAnsi from "strip-ansi";
import process from "node:process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assertStringIncludes } from "../../testing/assertions.ts";
import { spawnNativeProcess } from "../foreground-process.ts";
import { makeControlFixture, within } from "./session-save-test-fixture.ts";

const cli = fileURLToPath(new URL("../../cli.ts", import.meta.url));

test(
    "ordinary remote startup displays laptop-account access before setup choices",
    { skip: process.platform === "win32" && "The remote server entry requires Unix absolute paths" },
    async () => {
        const fixture = await makeControlFixture();
        await fixture.ready();
        const child = spawnNativeProcess(process.execPath, {
            args: ["run", cli, "--remote-view"],
            cwd: fixture.remoteProject,
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
        let screen = "";
        const decoder = new TextDecoder();
        const notice = "OpenSSH SFTP exposes laptop-account files, not a sandbox.";
        try {
            await writer.write(
                new TextEncoder().encode(
                    JSON.stringify({
                        view: {
                            host: "remote-notice",
                            cwd: fixture.remoteProject,
                            status: "Connected",
                            trust: notice,
                            readiness: "Ready",
                        },
                        cwd: fixture.remoteProject,
                        connection: { port: fixture.control.port, credential: fixture.control.credential },
                        resources: { globalRoot: fixture.mount },
                        memoryCollection: "remote-notice",
                        review: {
                            socketPath: `/tmp/wld-remote-${"a".repeat(32)}/review.sock`,
                            origin: "http://127.0.0.1:43127",
                        },
                    }) + "\n",
                ),
            );
            await within(
                (async () => {
                    while (!screen.includes("not a sandbox.")) {
                        const chunk = await reader.read();
                        if (chunk.done) throw new Error(`Remote notice was not displayed: ${await stderr}`);
                        screen += decoder.decode(chunk.value, { stream: true });
                    }
                })(),
                10_000,
            );
            assertStringIncludes(stripAnsi(screen), "laptop-account files");
            for (const choice of ["Only showing models", "Start tutorial", "Would you like to run /init"]) {
                const choiceIndex = screen.indexOf(choice);
                if (choiceIndex >= 0 && screen.indexOf("OpenSSH SFTP exposes") >= choiceIndex) {
                    throw new Error(`Laptop-account disclosure followed setup: ${choice}`);
                }
            }
        } catch (error) {
            throw new Error(`${error}\nRecent terminal: ${stripAnsi(screen).slice(-4000)}`);
        } finally {
            if (!exited) child.kill("SIGTERM");
            await within(status);
            reader.releaseLock();
            writer.releaseLock();
            await fixture.close();
        }
    },
);
