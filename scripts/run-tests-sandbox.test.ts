import { test } from "node:test";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { createSandboxEnv } from "./run-tests.js";
import { withProcessGlobalTestLock } from "../src/testing/process-global-lock.ts";

for (const installed of [true, false]) {
    test(`sandbox preserves database isolation with ML dependencies ${installed ? "installed" : "absent"}`, async () => {
        await withProcessGlobalTestLock(async () => {
            const root = await mkdtemp(join(tmpdir(), "runner-sandbox-"));
            const previousHome = process.env.HOME;
            try {
                const sourceHome = join(root, "source");
                const source = join(sourceHome, ".local/share/mnemoteca");
                await mkdir(source, { recursive: true });
                await writeFile(join(source, "mnemoteca.db"), "private database");
                if (installed) {
                    for (const name of ["lib", "models"]) {
                        await mkdir(join(source, name));
                        await writeFile(join(source, name, "dependency"), name);
                    }
                }
                process.env.HOME = sourceHome;
                const env = await createSandboxEnv(join(root, "sandboxes"), "one");
                const runtime = join(env.HOME, ".local/share/mnemoteca");
                deepStrictEqual((await readdir(runtime)).sort(), installed ? ["lib", "models"] : []);
                if (installed) {
                    for (const name of ["lib", "models"]) {
                        equal(await realpath(join(runtime, name)), await realpath(join(source, name)));
                        equal(await readFile(join(runtime, name, "dependency"), "utf8"), name);
                    }
                }
                equal(env.MNEMOTECA_DB_PATH, join(env.HOME, "mnemoteca-test.db"));
                await rejects(stat(join(runtime, "mnemoteca.db")), { code: "ENOENT" });
                await writeFile(env.MNEMOTECA_DB_PATH, "test database");
                equal(await readFile(join(source, "mnemoteca.db"), "utf8"), "private database");
            } finally {
                if (previousHome === undefined) delete process.env.HOME;
                else process.env.HOME = previousHome;
                await rm(root, { recursive: true, force: true });
            }
        });
    });
}

test("isolated runner forwards display access without private environment or sandbox overrides", async () => {
    const { captureScriptProcess } = await import("./script-process.ts");
    const root = await mkdtemp(join(tmpdir(), "runner-display-"));
    try {
        const file = join(root, "display.test.ts");
        await writeFile(
            file,
            `
            import { test } from "node:test";
            import { equal, notEqual } from "node:assert/strict";
            import { join } from "node:path";
            test("display access and private state", () => {
                equal(process.env.DISPLAY, ":93");
                equal(process.env.XAUTHORITY, "/tmp/runner-display-auth");
                for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ELECTRON_DISABLE_SANDBOX"])
                    equal(process.env[key], undefined);
                notEqual(process.env.HOME, ${JSON.stringify(process.env.HOME)});
                equal(process.env.HOME, process.env.WLD_TEST_SANDBOX_HOME);
                equal(process.env.MNEMOTECA_DB_PATH, join(process.env.HOME, "mnemoteca-test.db"));
                notEqual(process.env.MNEMOTECA_DB_PATH, "/private/owner.db");
            });
        `,
        );
        const result = await captureScriptProcess(process.execPath, {
            args: ["scripts/run-tests.js", file, "--report-dir", join(root, "reports")],
            env: {
                DISPLAY: ":93",
                XAUTHORITY: "/tmp/runner-display-auth",
                OPENAI_API_KEY: "private",
                ANTHROPIC_API_KEY: "private",
                ELECTRON_DISABLE_SANDBOX: "1",
                MNEMOTECA_DB_PATH: "/private/owner.db",
            },
            stdout: "piped",
            stderr: "piped",
        });
        equal(result.code, 0, new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
