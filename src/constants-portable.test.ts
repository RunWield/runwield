import { equal, match, notEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { chdir, cwd, env, execPath } from "node:process";
import { test } from "node:test";

import { getCwd, getHomeDir, getRunWieldRuntimeDir } from "./constants.ts";
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

for (const entrypoint of [
    "guard.test.js",
    "guard_test.js",
    "test.js",
    "guard.test.ts",
    "guard_test.tsx",
    "init-state_test.js",
    "production.ts",
]) {
    test(`portable constants gate unsandboxed entrypoint ${entrypoint}`, async () => {
        const fixture = await mkdtemp(join(tmpdir(), "portable-guard-"));
        try {
            const path = join(fixture, entrypoint);
            await writeFile(
                path,
                `await import(${JSON.stringify(
                    new URL("./constants.ts", import.meta.url).href,
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
            if (entrypoint === "production.ts") {
                equal(code, 0, output);
                match(output, /BODY_RAN/);
            } else {
                notEqual(code, 0, output);
                match(output, /Refusing to load RunWield modules in an unsandboxed test run/);
                equal(output.includes("BODY_RAN"), false);
            }
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });
}

test("home resolution refuses losing sandbox authorization after module import", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "portable-home-guard-"));
    try {
        const path = join(fixture, "home.test.ts");
        await writeFile(
            path,
            `
            const { getHomeDir } = await import(${JSON.stringify(new URL("./constants.ts", import.meta.url).href)});
            delete process.env.WLD_TEST_SANDBOX_HOME;
            process.env.HOME = ${JSON.stringify(fixture)};
            if (getHomeDir() !== process.env.HOME) throw new Error("Temporary HOME must remain usable");
            process.env.HOME = "/";
            getHomeDir();
            console.log("UNSAFE_HOME_ALLOWED");
        `,
        );
        const child = spawn(execPath, [path], { env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk.toString()));
        child.stderr.on("data", (chunk) => (output += chunk.toString()));
        const code = await new Promise<number | null>((resolve, reject) => {
            child.on("error", reject);
            child.on("close", resolve);
        });
        notEqual(code, 0, output);
        match(output, /Refusing to resolve a home directory/);
        equal(output.includes("\nUNSAFE_HOME_ALLOWED\n"), false);
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
});
