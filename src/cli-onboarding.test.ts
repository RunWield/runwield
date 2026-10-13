import { delimiter } from "node:path";
import { doesNotMatch, equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, execPath, platform } from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertWorkflowBinaryCallsSupported, writeWorkflowBinaryFixtures } from "./testing/workflow-binary-fixtures.ts";

test(
    "source CLI opens model setup and restores the terminal when cancelled",
    { skip: platform === "win32" },
    async () => {
        const root = await mkdtemp(join(tmpdir(), "runwield-onboarding-cli-"));
        const home = join(root, "home");
        const project = join(root, "project");
        await Promise.all([mkdir(home), mkdir(project)]);
        try {
            const bin = await writeWorkflowBinaryFixtures(root);
            const child = spawn(
                execPath,
                [
                    ...["--no-env-file", "--no-install"],
                    fileURLToPath(new URL("./cli.ts", import.meta.url)),
                    "Runtime migration startup qualification",
                ],
                {
                    cwd: project,
                    env: {
                        HOME: home,
                        USERPROFILE: home,
                        WLD_TEST_SANDBOX_HOME: home,
                        MNEMOTECA_DB_PATH: join(home, "mnemoteca.db"),
                        TMPDIR: root,
                        PATH: `${bin}${delimiter}${env.PATH || ""}`,
                        DENO_DIR: env.DENO_DIR,
                        NO_COLOR: "1",
                    },
                    stdio: ["pipe", "pipe", "pipe"],
                },
            );
            let output = "";
            let reachedPicker = false;
            let timedOut = false;
            const append = (chunk: string) => {
                output += chunk;
                if (!reachedPicker && output.includes("Use an API key")) {
                    reachedPicker = true;
                    child.stdin.write("\x1b");
                }
            };
            child.stdout.setEncoding("utf8").on("data", append);
            child.stderr.setEncoding("utf8").on("data", append);
            const finished = new Promise<number | null>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", resolve);
            });
            const timeout = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, 20_000);
            try {
                equal(await finished, 0, output.slice(-4000));
                equal(timedOut, false);
                ok(reachedPicker, output.slice(-4000));
                doesNotMatch(output, /Deno is not defined|Fatal error|ReferenceError/);
                ok(output.includes("\x1b[?1049l")); // Leave the alternate screen.
                ok(output.includes("\x1b[?25h")); // Restore the cursor.
                await assertWorkflowBinaryCallsSupported(root);
            } finally {
                clearTimeout(timeout);
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
                await finished;
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
