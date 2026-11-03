import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdir, writeFile, readFile, lstat, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineCommittedGitFixture } from "./git-test-fixture.ts";
import { runtimeSourceArgs } from "../testing/runtime-source-args.ts";
import { getHomeDir, getRunWieldRuntimeDir } from "../constants.js";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "./project-runtime-layout.ts";

const fixture = defineCommittedGitFixture();
const driver = fileURLToPath(new URL("./testing/project-runtime-home-process-driver.ts", import.meta.url));
async function run(root: string, boundary = "") {
    const child = spawn(process.execPath, runtimeSourceArgs(["run", driver, "enter", root, boundary]), {
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
        output += chunk;
    });
    child.stderr.on("data", (chunk) => {
        output += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
    });
    return { code, output };
}
for (const boundary of ["copy", "copying", "verified", "published", "retirement", "marker", "cleanup"]) {
    test(`home transfer resumes after ${boundary} with bytes and one authority intact`, async () => {
        const root = await realpath(await fixture.checkout());
        try {
            const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
            await mkdir(dirname(source), { recursive: true });
            await writeFile(source, "retained\0bytes");
            const interrupted = await run(root, boundary);
            equal(interrupted.code, 86, interrupted.output);
            ok(interrupted.output.includes(`reached:${boundary}`), interrupted.output);
            const resumed = await run(root);
            equal(resumed.code, 0, resumed.output);
            const layout = resolveProjectRuntimeLayout(root);
            equal(await readFile(join(layout.primary.debugRoot, "trace"), "utf8"), "retained\0bytes");
            await rejects(() => lstat(join(getRunWieldRuntimeDir(root), "internal")), { code: "ENOENT" });
            const marker = await readFile(layout.primary.layoutMarkerPath, "utf8");
            equal((await run(root)).code, 0);
            equal(await readFile(layout.primary.layoutMarkerPath, "utf8"), marker);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}
for (const resource of [
    "controller/plans/one.json.lock",
    "plan-locks/one.lock",
    "work-record-supersession.lock",
    "worktrees.lock",
]) {
    test(`home adoption preserves source while a real writer holds ${resource}`, async () => {
        const root = await realpath(await fixture.checkout());
        const child = spawn(
            process.execPath,
            runtimeSourceArgs([
                "run",
                driver,
                resource === "worktrees.lock" ? "hold-registry" : "hold",
                root,
                resource,
            ]),
            {
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        try {
            await new Promise<void>((resolve, reject) => {
                child.stdout.once("data", () => resolve());
                child.once("error", reject);
                child.once("exit", () => reject(new Error("Writer exited before holding lock")));
            });
            await rejects(() => enterProjectRuntime(root), /writer is active/);
            ok(await lstat(join(getRunWieldRuntimeDir(root), "internal", resource)));
            child.kill("SIGTERM");
            await new Promise((resolve) => child.once("exit", resolve));
            await enterProjectRuntime(root);
            await rejects(() => lstat(join(getRunWieldRuntimeDir(root), "internal")), { code: "ENOENT" });
        } finally {
            if (child.exitCode === null) child.kill("SIGTERM");
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("simultaneous home transfers converge without extra copies", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
        await mkdir(dirname(source), { recursive: true });
        await writeFile(source, "one copy");
        const results = await Promise.all([run(root), run(root)]);
        for (const result of results) equal(result.code, 0, result.output);
        equal(await readFile(join(resolveProjectRuntimeLayout(root).primary.debugRoot, "trace"), "utf8"), "one copy");
        await rejects(() => lstat(source), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ordinary subprocess ignores manual SSH environment when selecting its account home", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const child = spawn(process.execPath, runtimeSourceArgs(["run", driver, "enter", root]), {
            env: { ...process.env, SSH_CONNECTION: "192.0.2.1 1000 192.0.2.2 22", SSH_TTY: "/dev/pts/99" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stderr.on("data", (chunk) => {
            output += chunk;
        });
        equal(await new Promise((resolve) => child.on("exit", resolve)), 0, output);
        ok(resolveProjectRuntimeLayout(root).primary.internalRoot.startsWith(join(getHomeDir(), ".wld", "projects")));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

interface TransferFixture {
    mappings: Array<{ source: string; destination: string }>;
    files: Array<{ source: string; destination: string }>;
}
test("escaped transfer mappings preserve source and never write outside the Project home", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
        await mkdir(dirname(source), { recursive: true });
        await writeFile(source, "preserved");
        equal((await run(root, "copying")).code, 86);
        const layout = resolveProjectRuntimeLayout(root);
        const journal: TransferFixture = JSON.parse(await readFile(layout.primary.layoutMigrationJournalPath, "utf8"));
        const mapping = journal.mappings.find((entry) => entry.source.endsWith("debug"));
        ok(mapping);
        mapping.destination = join(root, "escaped");
        await writeFile(layout.primary.layoutMigrationJournalPath, JSON.stringify(journal));
        await rejects(() => enterProjectRuntime(root), /escapes/);
        equal(await readFile(source, "utf8"), "preserved");
        await rejects(() => lstat(join(root, "escaped")), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("changed published destination preserves the original source on restart", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
        await mkdir(dirname(source), { recursive: true });
        await writeFile(source, "original");
        equal((await run(root, "published")).code, 86);
        const destination = join(resolveProjectRuntimeLayout(root).primary.debugRoot, "trace");
        await writeFile(destination, "conflicting");
        const resumed = await run(root);
        ok(resumed.code !== 0, resumed.output);
        ok(resumed.output.includes("destination changed before retirement"), resumed.output);
        equal(await readFile(source, "utf8"), "original");
        equal(await readFile(destination, "utf8"), "conflicting");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
