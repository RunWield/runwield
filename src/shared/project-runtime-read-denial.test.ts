import { test } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { defineCommittedGitFixture } from "./git-test-fixture.ts";
import { captureForegroundProcess } from "./captured-process.ts";
import { spawnNativeProcess } from "./foreground-process.ts";
import { enterProjectRuntime } from "./project-runtime-layout.ts";
import { getRunWieldRuntimeDir } from "../constants.js";

const fixture = defineCommittedGitFixture({
    "README.md": "# Passive read denial\n",
    "docs/plans/example.md": "---\nplanId: example-id\nstatus: draft\n---\n# Example\n",
});
const storeUrl = new URL("../plan-store.js", import.meta.url).href;
const registryUrl = new URL("./worktree-registry.js", import.meta.url).href;
const doctorUrl = new URL("../cmd/plans/doctor.ts", import.meta.url).href;

async function tree(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(root, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
    })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            result[`${entry.name}/`] = "directory";
            for (const [name, bytes] of Object.entries(await tree(path))) result[`${entry.name}/${name}`] = bytes;
        } else result[entry.name] = (await readFile(path)).toString("base64");
    }
    return result;
}

for (const state of ["fresh", "legacy", "ready", "returning-legacy"]) {
    test(
        `passive ${state} readers work under enforced filesystem write denial`,
        { skip: process.platform !== "darwin" },
        async () => {
            const root = await fixture.checkout();
            const traceRoot = await realpath(await mkdtemp(join(tmpdir(), "passive-git-trace-")));
            const tracePath = join(traceRoot, "git.trace");
            await writeFile(tracePath, "");
            try {
                if (["ready", "returning-legacy"].includes(state)) await enterProjectRuntime(root);
                if (["legacy", "returning-legacy"].includes(state)) {
                    const path = join(getRunWieldRuntimeDir(root), "controller/plans/name%3Aexample.json");
                    await mkdir(dirname(path), { recursive: true });
                    await writeFile(path, JSON.stringify({ version: 1, revision: 1, planName: "example", state: {} }));
                    await writeFile(`${path}.lock`, "");
                }
                const before = { project: await tree(root), runtime: await tree(getRunWieldRuntimeDir(root)) };
                const denied = await captureForegroundProcess("/usr/bin/sandbox-exec", {
                    cwd: root,
                    args: [
                        "-p",
                        '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))',
                        process.execPath,
                        "--eval",
                        `await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(join(root, "forbidden"))}, 'no'));`,
                    ],
                });
                ok(!denied.success, "the operating system must reject a deliberate write");
                ok(new TextDecoder().decode(denied.stderr).includes("EPERM"), new TextDecoder().decode(denied.stderr));
                const code = `
                import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
                const store = await import(${JSON.stringify(storeUrl)});
                const { runPlansDoctor } = await import(${JSON.stringify(doctorUrl)});
                const root = ${JSON.stringify(root)};
                for (let repeat=0; repeat<2; repeat++) {
                    const resources = await store.listPlanResources(root);
                    strictEqual(resources.length, 1);
                    strictEqual(resources[0].body.trim(), '# Example');
                    strictEqual(resources[0].readAvailability.kind, ${JSON.stringify(state === "legacy" ? "pending" : "ready")});
                    strictEqual((await store.loadPlanBodyById(root, 'example-id')).body.trim(), '# Example');
                    strictEqual((await store.listArchivedPlans(root)).length, 0);
                    await runPlansDoctor(root, false);
                }
                console.log('read-denial-ok');
            `;
                const read = await captureForegroundProcess("/usr/bin/sandbox-exec", {
                    cwd: root,
                    args: [
                        "-p",
                        `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null") (literal ${JSON.stringify(tracePath)}))`,
                        process.execPath,
                        "--eval",
                        code,
                    ],
                    env: { GIT_TRACE: tracePath, GIT_TRACE2_EVENT: "0" },
                    timeoutMs: 10_000,
                });
                const output = new TextDecoder().decode(read.stdout);
                const trace = await readFile(tracePath, "utf8");
                const errors = new TextDecoder().decode(read.stderr);
                strictEqual(read.code, 0, errors);
                ok(output.includes("read-denial-ok"));
                ok(trace.includes("worktree list"), `real Git reads must be traced: ${trace} ${errors}`);
                strictEqual(
                    /\b(?:fetch|clone|update-ref|checkout|switch)\b|worktree (?:add|remove)/.test(trace),
                    false,
                    trace,
                );
                deepStrictEqual(
                    { project: await tree(root), runtime: await tree(getRunWieldRuntimeDir(root)) },
                    before,
                );
            } finally {
                await rm(root, { recursive: true, force: true });
                await rm(traceRoot, { recursive: true, force: true });
            }
        },
    );
}

test("passive reads do not wait for catalog and registry locks held by another process", async () => {
    const root = await fixture.checkout();
    let holder: ReturnType<typeof spawnNativeProcess> | undefined;
    try {
        await enterProjectRuntime(root);
        const driver = `
            const { withPlanCatalogLock } = await import(${JSON.stringify(storeUrl)});
            const { withWorktreeRegistryLock } = await import(${JSON.stringify(registryUrl)});
            await withPlanCatalogLock(${JSON.stringify(root)}, () =>
                withWorktreeRegistryLock(${JSON.stringify(root)}, async () => {
                    console.log('locked');
                    await Bun.stdin.text();
                }));
        `;
        holder = spawnNativeProcess(process.execPath, {
            cwd: root,
            args: ["--eval", driver],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        });
        const reader = holder.stdout.getReader();
        const ready = await reader.read();
        ok(new TextDecoder().decode(ready.value).includes("locked"));
        reader.releaseLock();
        const read = await captureForegroundProcess(process.execPath, {
            cwd: root,
            args: [
                "--eval",
                `const { listPlanResources } = await import(${JSON.stringify(storeUrl)}); console.log((await listPlanResources(${JSON.stringify(root)}))[0].planId);`,
            ],
            timeoutMs: 3_000,
        });
        strictEqual(read.code, 0, new TextDecoder().decode(read.stderr));
        strictEqual(new TextDecoder().decode(read.stdout).trim(), "example-id");
        const writer = holder.stdin.getWriter();
        await writer.close();
        strictEqual((await holder.status).code, 0);
        holder = undefined;
    } finally {
        holder?.kill();
        await rm(root, { recursive: true, force: true });
    }
});
