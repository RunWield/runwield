import { test } from "node:test";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdir, writeFile, readFile, lstat, realpath, rm, utimes, symlink, readlink, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import { runtimeSourceArgs } from "../testing/runtime-source-args.ts";
import { getHomeDir, getRunWieldRuntimeDir } from "../constants.js";
import {
    enterProjectRuntime,
    resolveProjectRuntimeLayout,
    inspectProjectRuntimeReadAccess,
} from "./project-runtime-layout.ts";

const fixture = defineCommittedGitFixture();
const driver = fileURLToPath(new URL("./testing/project-runtime-home-process-driver.ts", import.meta.url));
async function run(root: string, boundary = "", command = "enter") {
    const child = spawn(process.execPath, runtimeSourceArgs(["run", driver, command, root, boundary]), {
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
for (const boundary of ["copying", "marker"]) {
    test(`passive inspection survives transfer completion after observing the ${boundary} journal`, async () => {
        const root = await realpath(await fixture.checkout());
        try {
            const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
            await mkdir(dirname(source), { recursive: true });
            await writeFile(source, "retained during read");
            const interrupted = await run(root, boundary);
            equal(interrupted.code, 86, interrupted.output);
            equal((await inspectProjectRuntimeReadAccess(root)).kind, "pending");
            const inspected = await run(root, "", "inspect-after-transfer");
            ok(inspected.output.includes("transfer-completed-before-read"), inspected.output);
            equal(inspected.code, 0, inspected.output);
            equal(JSON.parse(inspected.output.trim().split("\n").at(-1)!).kind, "ready");
            const layout = resolveProjectRuntimeLayout(root);
            equal(await readFile(join(layout.primary.debugRoot, "trace"), "utf8"), "retained during read");
            await rejects(() => lstat(layout.primary.layoutMigrationJournalPath), { code: "ENOENT" });
            equal((await inspectProjectRuntimeReadAccess(root)).kind, "ready");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

for (const problem of ["malformed", "unreadable"]) {
    test(`passive inspection preserves ${problem} transfer journal errors`, async () => {
        const root = await realpath(await fixture.checkout());
        try {
            const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
            await mkdir(dirname(source), { recursive: true });
            await writeFile(source, "preserved");
            equal((await run(root, "copying")).code, 86);
            const path = resolveProjectRuntimeLayout(root).primary.layoutMigrationJournalPath;
            if (problem === "malformed") {
                await writeFile(path, "{");
                await rejects(() => inspectProjectRuntimeReadAccess(root), SyntaxError);
                equal(await readFile(path, "utf8"), "{");
            } else {
                await rm(path);
                await mkdir(path);
                await rejects(() => inspectProjectRuntimeReadAccess(root), { code: "EISDIR" });
                ok((await lstat(path)).isDirectory());
            }
            equal(await readFile(source, "utf8"), "preserved");
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
    "aged-worktrees.lock",
]) {
    test(`home adoption preserves source while a real writer holds ${resource}`, async () => {
        const root = await realpath(await fixture.checkout());
        const child = spawn(
            process.execPath,
            runtimeSourceArgs([
                "run",
                driver,
                resource.endsWith("worktrees.lock") ? "hold-registry" : "hold",
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
            const lockPath = join(getRunWieldRuntimeDir(root), "internal", resource.replace("aged-", ""));
            if (resource.startsWith("aged-")) await utimes(lockPath, new Date(0), new Date(0));
            await rejects(() => enterProjectRuntime(root), /writer is active/);
            ok(await lstat(lockPath));
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

for (const boundary of ["verified", "published"])
    test(`changed ${boundary} destination preserves the original source on restart`, async () => {
        const root = await realpath(await fixture.checkout());
        try {
            const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
            await mkdir(dirname(source), { recursive: true });
            await writeFile(source, "original");
            equal((await run(root, boundary)).code, 86);
            const destination = join(resolveProjectRuntimeLayout(root).primary.debugRoot, "trace");
            await writeFile(destination, "conflicting");
            const resumed = await run(root);
            ok(resumed.code !== 0, resumed.output);
            ok(/destination (changed|differs)/.test(resumed.output), resumed.output);
            equal(await readFile(source, "utf8"), "original");
            equal(await readFile(destination, "utf8"), "conflicting");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

for (const linkedOrigin of [false, true])
    for (const boundary of ["mapping-intent", "mapping", "published"]) {
        test(`registered fallback worktree from ${linkedOrigin ? "linked" : "primary"} checkout resumes after ${boundary}`, async () => {
            const root = await realpath(await fixture.checkout());
            const origin = linkedOrigin ? `${root}-linked` : root;
            const old = join(getRunWieldRuntimeDir(origin), "internal", "worktrees", "attempt");
            try {
                if (linkedOrigin) await git(root, ["worktree", "add", "-b", "linked-origin", origin]);
                await mkdir(dirname(old), { recursive: true });
                await mkdir(join(getRunWieldRuntimeDir(root), "internal"), { recursive: true });
                await git(root, ["worktree", "add", "-b", "repair-restart", old]);
                await writeFile(join(old, "dirty"), "keep repair");
                const head = await git(old, ["rev-parse", "HEAD"]);
                await writeFile(
                    join(getRunWieldRuntimeDir(root), "internal", "worktrees.json"),
                    JSON.stringify({
                        version: 2,
                        entries: [
                            {
                                id: "attempt",
                                planName: "demo",
                                planId: "demo-id",
                                baseBranch: "main",
                                baseRef: "HEAD",
                                baseCommit: head,
                                branch: "repair-restart",
                                path: old,
                                status: "active",
                                createdAt: "2026-01-01T00:00:00Z",
                                updatedAt: "2026-01-01T00:00:00Z",
                            },
                        ],
                    }),
                );
                const interrupted = await run(root, boundary);
                equal(interrupted.code, 86, interrupted.output);
                const resumed = await run(root);
                equal(resumed.code, 0, resumed.output);
                const layout = resolveProjectRuntimeLayout(root);
                const destination = join(layout.primary.fallbackWorktreesRoot, "attempt");
                equal(await git(destination, ["rev-parse", "HEAD"]), head);
                equal(await readFile(join(destination, "dirty"), "utf8"), "keep repair");
                ok((await git(root, ["worktree", "list", "--porcelain"])).includes(destination));
                ok((await readFile(layout.primary.worktreeRegistryPath, "utf8")).includes(destination));
                equal((await run(root)).code, 0);
                await rejects(() => lstat(old), { code: "ENOENT" });
            } finally {
                if (linkedOrigin) await rm(origin, { recursive: true, force: true });
                await rm(root, { recursive: true, force: true });
            }
        });
    }

for (const repository of ["worktrees", "plan-staging"])
    for (const boundary of ["", "payload-link", "early-payload-link", "staged-payload-link"]) {
        test(`${repository} payload symlinks survive home transfer${boundary ? ` restart after ${boundary}` : ""}`, async () => {
            const root = await realpath(await fixture.checkout());
            const old = join(getRunWieldRuntimeDir(root), "internal", repository, "attempt");
            try {
                await mkdir(dirname(old), { recursive: true });
                if (repository === "worktrees") await git(root, ["worktree", "add", "-b", "link-transfer", old]);
                else await git(root, ["clone", root, old]);
                await symlink("tracked-target", join(old, "tracked-link"));
                await git(old, ["add", "tracked-link"]);
                await symlink("missing-target", join(old, "payload-link"));
                await symlink("early-missing-target", join(old, "!link"));
                if (boundary) {
                    const interrupted = await run(root, boundary);
                    equal(interrupted.code, 86, interrupted.output);
                    if (boundary === "early-payload-link" || boundary === "staged-payload-link") {
                        const layout = resolveProjectRuntimeLayout(root).primary;
                        const destination = join(
                            repository === "worktrees" ? layout.fallbackWorktreesRoot : layout.publicationStagingRoot,
                            "attempt",
                        );
                        const link = boundary === "staged-payload-link" ? "!link.runtime-copy" : "!link";
                        equal(await readlink(join(destination, link)), "early-missing-target");
                        if (boundary === "staged-payload-link")
                            await rejects(() => lstat(join(destination, "!link")), { code: "ENOENT" });
                        await rejects(() => lstat(join(destination, ".git")), { code: "ENOENT" });
                    }
                }
                const resumed = await run(root);
                equal(resumed.code, 0, resumed.output);
                const layout = resolveProjectRuntimeLayout(root).primary;
                const destination = join(
                    repository === "worktrees" ? layout.fallbackWorktreesRoot : layout.publicationStagingRoot,
                    "attempt",
                );
                equal(await readlink(join(destination, "payload-link")), "missing-target");
                equal(await readlink(join(destination, "!link")), "early-missing-target");
                await rejects(() => lstat(join(destination, "!link.runtime-copy")), { code: "ENOENT" });
                equal(await readlink(join(destination, "tracked-link")), "tracked-target");
                ok((await git(destination, ["ls-files", "--stage"])).includes("120000"));
                await rejects(() => lstat(old), { code: "ENOENT" });
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }

for (const altered of [false, true]) {
    test(`home transfer retains source when a staged payload link is ${altered ? "changed" : "unrecorded"}`, async () => {
        const root = await realpath(await fixture.checkout());
        const old = join(getRunWieldRuntimeDir(root), "internal", "worktrees", "attempt");
        try {
            await mkdir(dirname(old), { recursive: true });
            await git(root, ["worktree", "add", "-b", "staged-link-conflict", old]);
            await symlink("original-target", join(old, "!link"));
            const interrupted = await run(root, "staged-payload-link");
            equal(interrupted.code, 86, interrupted.output);
            const destination = join(resolveProjectRuntimeLayout(root).primary.fallbackWorktreesRoot, "attempt");
            const stage = join(destination, "!link.runtime-copy");
            equal(await readlink(stage), "original-target");
            await rejects(() => lstat(join(destination, ".git")), { code: "ENOENT" });
            const conflict = altered ? stage : join(destination, "!unrecorded.runtime-copy");
            if (altered) await rm(stage);
            await symlink("conflicting-target", conflict);
            await rejects(() => enterProjectRuntime(root), /symbolic link|unsupported file type/);
            equal(await readlink(join(old, "!link")), "original-target");
            equal(await readlink(conflict), "conflicting-target");
            await rejects(() => lstat(join(destination, "!link")), { code: "ENOENT" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test("fallback checkout keeps separately owned transition bytes across restart", () =>
    withProcessGlobalTestLock(async () => {
        const sandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const previousHome = process.env.HOME;
        const home = await mkdtemp(join(tmpdir(), "runtime-nested-home-"));
        process.env.HOME = home;
        delete process.env["WLD_TEST_SANDBOX_HOME"];
        const root = await realpath(await fixture.checkout());
        const old = join(getRunWieldRuntimeDir(root), "internal", "worktrees", "attempt");
        try {
            await mkdir(dirname(old), { recursive: true });
            await git(root, ["worktree", "add", "-b", "nested-runtime", old]);
            const source = join(getRunWieldRuntimeDir(old), "internal", "plan-transitions", "event.json");
            await mkdir(dirname(source), { recursive: true });
            await writeFile(source, "checkout-owned transition");
            const interrupted = await run(root, "copying");
            equal(interrupted.code, 86, interrupted.output);
            const selected = resolveProjectRuntimeLayout(old).selected;
            const resumed = await run(root);
            equal(resumed.code, 0, resumed.output);
            equal(
                await readFile(join(selected.transitionJournalsDir, "event.json"), "utf8"),
                "checkout-owned transition",
            );
            const moved = join(resolveProjectRuntimeLayout(root).primary.fallbackWorktreesRoot, "attempt");
            equal(resolveProjectRuntimeLayout(moved).selected.transitionJournalsDir, selected.transitionJournalsDir);
            await rejects(() => lstat(join(getRunWieldRuntimeDir(moved), "internal")), { code: "ENOENT" });
            equal((await run(root)).code, 0);
        } finally {
            if (sandboxHome !== undefined) process.env["WLD_TEST_SANDBOX_HOME"] = sandboxHome;
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            await rm(home, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    }));

test("unknown lock-suffixed payload is verified and retained before retirement", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const source = join(getRunWieldRuntimeDir(root), "internal", "unrecognized", "package.lock");
        await mkdir(dirname(source), { recursive: true });
        await writeFile(source, "dependency lock bytes\0");
        const interrupted = await run(root, "published");
        equal(interrupted.code, 86, interrupted.output);
        const layout = resolveProjectRuntimeLayout(root);
        const journal: TransferFixture = JSON.parse(await readFile(layout.primary.layoutMigrationJournalPath, "utf8"));
        const saved = journal.files.find((file) => file.source === source);
        ok(saved);
        equal(await readFile(saved.destination, "utf8"), "dependency lock bytes\0");
        equal(await readFile(source, "utf8"), "dependency lock bytes\0");
        const resumed = await run(root);
        equal(resumed.code, 0, resumed.output);
        equal(await readFile(saved.destination, "utf8"), "dependency lock bytes\0");
        await rejects(() => lstat(source), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
