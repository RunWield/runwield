import { test } from "node:test";
import { equal } from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath, platform } from "node:process";
import { fileURLToPath } from "node:url";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(
        `initialized ACP exits on ${signal} while client stdin remains open`,
        { skip: platform === "win32" },
        async () => {
            const entry = fileURLToPath(new URL("../../cli.ts", import.meta.url));
            const args = ["run", entry, "acp"];
            const child = spawn(execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
            let output = "";
            let diagnostics = "";
            let startupTimer: ReturnType<typeof setTimeout> | undefined;
            let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
            const exited = new Promise<number | null>((resolve, reject) => {
                child.once("error", reject);
                child.once("exit", resolve);
            });
            child.stderr.on("data", (chunk) => (diagnostics += String(chunk)));
            try {
                const initialized = new Promise<void>((resolve, reject) => {
                    startupTimer = setTimeout(
                        () => reject(new Error(`ACP initialization timed out: ${diagnostics}`)),
                        30_000,
                    );
                    child.stdout.on("data", (chunk) => {
                        output += String(chunk);
                        for (const line of output.split("\n").slice(0, -1)) {
                            try {
                                const response = JSON.parse(line);
                                if (response.id === 1 && response.result?.protocolVersion === 1) resolve();
                            } catch {
                                /* Wait for the complete protocol frame. */
                            }
                        }
                    });
                    exited.then(
                        (code) => reject(new Error(`ACP exited ${code} before initialization: ${diagnostics}`)),
                        reject,
                    );
                });
                child.stdin.write(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "initialize",
                        params: { protocolVersion: 1, clientCapabilities: {} },
                    }) + "\n",
                );
                await initialized;
                clearTimeout(startupTimer);
                equal(child.stdin.writableEnded, false);
                equal(child.exitCode, null);
                child.kill(signal);
                const result = await Promise.race([
                    exited,
                    new Promise<never>((_, reject) => {
                        shutdownTimer = setTimeout(
                            () => reject(new Error(`ACP did not settle after ${signal}: ${diagnostics}`)),
                            5000,
                        );
                    }),
                ]);
                equal(result, 0, diagnostics);
                equal(child.stdin.writableEnded, false, "the client must not end stdin to enable shutdown");
            } finally {
                clearTimeout(startupTimer);
                clearTimeout(shutdownTimer);
                if (child.exitCode === null) child.kill("SIGKILL");
                child.stdin.destroy();
                await exited;
            }
        },
    );
}
