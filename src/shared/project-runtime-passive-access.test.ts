import { test } from "node:test";
import { deepStrictEqual, strictEqual, rejects, match, doesNotMatch } from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getRunWieldRuntimeDir } from "../constants.js";
import { admitProjectIdentity, inspectProjectIdentity, type ProjectLaunchContext } from "./project-identity.ts";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import {
    checkedProjectRuntimeLayout,
    enterProjectRuntime,
    inspectProjectRuntimeReadAccess,
    withProjectRuntimeReadScope,
} from "./project-runtime-layout.ts";

const fixture = defineCommittedGitFixture({ "README.md": "# Passive runtime\n" });

test("passive fresh and legacy inspection preserves sources and does not adopt storage", async () => {
    const root = await fixture.checkout();
    try {
        const before = await readdir(root);
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "fresh");
        deepStrictEqual(await readdir(root), before);
        const legacy = join(getRunWieldRuntimeDir(root), "controller/plans");
        await mkdir(legacy, { recursive: true });
        const bytes = JSON.stringify({ version: 1, revision: 1, planName: "draft", state: { status: "draft" } });
        await writeFile(join(legacy, "name%3Adraft.json"), bytes);
        await writeFile(join(legacy, "name%3Adraft.json.lock"), "");
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "pending");
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "pending");
        deepStrictEqual(await readdir(getRunWieldRuntimeDir(root)), ["controller"]);
        strictEqual(await readFile(join(legacy, "name%3Adraft.json"), "utf8"), bytes);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("adopted passive authority ignores returning legacy input without recovering it", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        const legacy = join(getRunWieldRuntimeDir(root), "controller/plans");
        await mkdir(legacy, { recursive: true });
        await writeFile(join(legacy, "name%3Adraft.json"), "returning recovery input");
        const marker = await readFile(layout.primary.layoutMarkerPath, "utf8");
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "ready");
        strictEqual(await readFile(layout.primary.layoutMarkerPath, "utf8"), marker);
        strictEqual(await readFile(join(legacy, "name%3Adraft.json"), "utf8"), "returning recovery input");
    } finally {
        await rm(root, { recursive: true });
    }
});

test("passive operation reuse never admits a writer and expires before the next request", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        const marker = await readFile(layout.primary.layoutMarkerPath, "utf8");
        await withProjectRuntimeReadScope(async () => {
            const first = inspectProjectRuntimeReadAccess(root);
            strictEqual(inspectProjectRuntimeReadAccess(root), first);
            await first;
            await writeFile(layout.primary.layoutMarkerPath, JSON.stringify({ version: 999 }));
            await rejects(() => enterProjectRuntime(root), /newer/);
        });
        strictEqual((await inspectProjectRuntimeReadAccess(root)).kind, "blocked");
        await writeFile(layout.primary.layoutMarkerPath, marker);
        strictEqual((await checkedProjectRuntimeLayout(root)).primary.checkoutRoot, layout.primary.checkoutRoot);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("adopted passive inspection blocks unsupported registry versions", async () => {
    const root = await fixture.checkout();
    try {
        const layout = await enterProjectRuntime(root);
        await writeFile(layout.primary.worktreeRegistryPath, JSON.stringify({ version: 999, entries: [] }));
        const result = await inspectProjectRuntimeReadAccess(root);
        strictEqual(result.kind, "blocked");
        if (result.kind === "blocked") {
            strictEqual(result.reason, "malformed_registry");
            strictEqual(/999|unsupported|schema/i.test(result.message), true);
        }
    } finally {
        await rm(root, { recursive: true });
    }
});

async function snapshotTree(root: string): Promise<string[]> {
    const entries: string[] = [];
    async function visit(path: string) {
        const stat = await lstat(path);
        const contents = stat.isFile()
            ? await readFile(path, "base64")
            : stat.isSymbolicLink()
              ? await readlink(path)
              : "";
        entries.push(`${path}:${stat.mode}:${stat.mtimeMs}:${contents}`);
        if (stat.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    }
    await visit(root);
    return entries;
}

async function invokePassiveCli(root: string, home: string, args: string[]): Promise<string> {
    const child = spawn(
        process.execPath,
        ["--no-env-file", "--no-install", fileURLToPath(new URL("../cli.ts", import.meta.url)), "plans", ...args],
        {
            cwd: root,
            env: { ...process.env, HOME: home, USERPROFILE: home, WLD_TEST_SANDBOX_HOME: home },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let output = "";
    let closing: Promise<void> | undefined;
    let html = "";
    const append = (chunk: string) => {
        output += chunk;
        const surface = output.match(/Plan read-only view: (http:\/\/\S+)/);
        if (surface && !closing) {
            closing = (async () => {
                const url = new URL(surface[1]);
                const response = await fetch(url);
                strictEqual(response.status, 200);
                html = await response.text();
                const token = url.searchParams.get("token");
                if (!token) throw new Error("Plan read URL omitted its access token");
                const exitUrl = new URL(`/api/review/exit${url.search}`, url);
                const closed = await fetch(exitUrl, {
                    method: "POST",
                    headers: { "content-type": "application/json", "x-runwield-review-token": token },
                    body: JSON.stringify({ reviewType: "plan" }),
                });
                strictEqual(closed.status, 200);
            })();
            // Keep failures observable after the child exits without an unhandled rejection.
            void closing.catch(() => child.kill("SIGKILL"));
        }
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    const finished = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
    try {
        const code = await finished;
        await closing;
        strictEqual(code, 0, output);
        doesNotMatch(output, /Project clone-link choice required|matches known Projects|Fatal error/);
        if (args[0] === "read") match(html, /CLI passive document/);
        return output;
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await finished;
    }
}

const passiveCliCommands = [
    { name: "list", args: [] },
    { name: "read", args: ["read", "passive", "--no-open"] },
    { name: "check-only Doctor", args: ["doctor", "--check"] },
    { name: "archive listing", args: ["archive"] },
];
for (const state of ["fresh", "matching clone", "legacy runtime"] as const) {
    for (const command of passiveCliCommands) {
        test(`actual CLI ${command.name} preserves ${state} identity, runtime, Git and home evidence`, async () => {
            const home = await mkdtemp(join(tmpdir(), "passive-cli-home-"));
            const source = await fixture.checkout();
            const root = state === "matching clone" ? join(home, "pending") : source;
            const context: ProjectLaunchContext = {
                executionAccountHome: home,
                personalOwner: { kind: "execution-account", identity: home },
            };
            try {
                if (state === "matching clone") {
                    const known = join(home, "known");
                    await git(source, ["clone", source, known]);
                    await git(source, ["clone", source, root]);
                    strictEqual((await admitProjectIdentity(known, { context })).kind, "existing");
                    strictEqual(inspectProjectIdentity(root, { context }).kind, "pending");
                }
                await mkdir(join(root, "docs", "plans"), { recursive: true });
                await writeFile(join(root, "docs", "plans", "passive.md"), "# CLI passive document\n");
                await writeFile(join(root, ".gitignore"), "# User-owned ignore\n.wld/controller/\n");
                if (state === "legacy runtime") {
                    await mkdir(join(root, ".wld"));
                    await writeFile(join(root, ".wld", "worktrees.json"), '{"version":2,"entries":[]}\n');
                }
                const before = [...(await snapshotTree(home)), ...(await snapshotTree(source))];
                const output = await invokePassiveCli(root, home, command.args);
                if (command.name === "list") match(output, /passive/);
                if (command.name === "check-only Doctor" && state === "legacy runtime") {
                    match(output, /adoption.*pending|pending.*adoption/i);
                    match(output, /No files changed/);
                }
                deepStrictEqual([...(await snapshotTree(home)), ...(await snapshotTree(source))], before);
                strictEqual(
                    inspectProjectIdentity(root, { context }).kind,
                    state === "matching clone" ? "pending" : "fresh",
                );
            } finally {
                await rm(home, { recursive: true, force: true });
                await rm(source, { recursive: true, force: true });
            }
        });
    }
}
