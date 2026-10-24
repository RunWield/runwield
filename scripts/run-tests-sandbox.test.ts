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
