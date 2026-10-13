import { equal, match, notEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { chdir, cwd, env, execPath } from "node:process";
import { test } from "node:test";

import { CATPPUCCIN_MOCHA_THEME_PATH, getCwd, getHomeDir, getRunWieldRuntimeDir } from "./constants.js";
import { withProcessGlobalTestLock } from "./testing/process-global-lock.ts";

test("portable HOME and cwd accessors observe changes after import", async () => {
    await withProcessGlobalTestLock(async () => {
        const beforeHome = env.HOME;
        const beforeCwd = cwd();
        const home = await realpath(await mkdtemp(join(tmpdir(), "portable-home-")));
        const work = await realpath(await mkdtemp(join(tmpdir(), "portable-cwd-")));
        try {
            env.HOME = home;
            chdir(work);
            equal(getHomeDir(), home);
            notEqual(getHomeDir(), beforeHome);
            equal(getCwd(), work);
            equal(getRunWieldRuntimeDir("/a/project").startsWith(env.WLD_TEST_SANDBOX_HOME + sep), true);
        } finally {
            chdir(beforeCwd);
            if (beforeHome === undefined) delete env.HOME;
            else env.HOME = beforeHome;
            await Promise.all([home, work].map((path) => rm(path, { recursive: true, force: true })));
        }
        equal(getHomeDir(), beforeHome || "");
        equal(getCwd(), beforeCwd);
    });
});

test("source resource paths remain readable under each runtime", async () => {
    match(await readFile(CATPPUCCIN_MOCHA_THEME_PATH, "utf8"), /catppuccin-mocha/);
});

test("portable constants reject a test entrypoint before unsandboxed code can run", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "portable-guard-"));
    try {
        const path = join(fixture, "guard.test.ts");
        await writeFile(
            path,
            `await import(${JSON.stringify(
                new URL("./constants.js", import.meta.url).href,
            )}); console.log("BODY_RAN");`,
        );
        const child = spawn(execPath, [path], {
            env: { ...env, WLD_TEST_SANDBOX_HOME: "" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk.toString()));
        child.stderr.on("data", (chunk) => (output += chunk.toString()));
        const code = await new Promise<number | null>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", resolve);
        });
        notEqual(code, 0, output);
        match(output, /Refusing to load RunWield modules in an unsandboxed test run/);
        equal(output.includes("\nBODY_RAN\n"), false);
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
});
