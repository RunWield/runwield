import { inspectPlanFixtureController, seedPlanController } from "./testing/plan-state-fixture.ts";
import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdir, readFile, writeFile, lstat, rm, mkdtemp, readdir, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getHomeDir, getRunWieldRuntimeDir } from "../constants.js";
import { defineCommittedGitFixture, git } from "./git-test-fixture.ts";
import {
    enterProjectRuntime,
    resolveProjectRuntimeLayout,
    inspectProjectRuntimeReadAccess,
} from "./project-runtime-layout.ts";

import { DatabaseSync } from "./sqlite.ts";
import { admitProjectIdentity, inspectProjectIdentity } from "./project-identity.ts";

const fixture = defineCommittedGitFixture({ "README.md": "base\n" });
async function put(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
}

test("ordinary admission preserves controller decisions and all hidden legacy bytes in home", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const base = getRunWieldRuntimeDir(root);
        const controller = {
            version: 1,
            revision: 4,
            planId: "one",
            planName: "demo",
            state: { humanReviewDecision: "approved" },
        };
        await put(join(base, "internal", "controller", "plans", "one.json"), JSON.stringify(controller));
        await put(join(base, "internal", ".unrecognized", "hidden"), "preserve me\0");
        await put(join(root, ".wld", "settings.json"), '{ "exact": true }\n');
        const layout = await enterProjectRuntime(root);
        ok(layout.primary.controllerPlansDir.startsWith(join(getHomeDir(), ".wld", "projects")));
        deepEqual(await inspectPlanFixtureController(root, { planId: "one", planName: "demo" }), controller);
        await rejects(() => lstat(join(base, "internal")), { code: "ENOENT" });
        equal(await readFile(join(root, ".wld", "settings.json"), "utf8"), '{ "exact": true }\n');
        const identity = inspectProjectIdentity(root);
        ok(identity.kind === "existing");
        equal(
            await readFile(
                join(
                    layout.primary.internalRoot,
                    "legacy-recovery",
                    identity.identity.checkoutId,
                    "internal",
                    ".unrecognized",
                    "hidden",
                ),
                "utf8",
            ),
            "preserve me\0",
        );
        await seedPlanController(root, { planId: "one", planName: "demo" }, { validationCiAttempts: 2 });
        equal((await inspectPlanFixtureController(root, { planId: "one", planName: "demo" }))?.revision, 5);
        deepEqual(await enterProjectRuntime(root), layout);
        await rejects(() => lstat(join(base, "internal")), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("linked checkouts share a registry while keeping transition and lock ownership distinct", async () => {
    const root = await realpath(await fixture.checkout());
    const linked = await realpath(await mkdtemp(join(tmpdir(), "runtime-linked-")));
    try {
        await git(root, ["worktree", "add", "-b", "linked-runtime", linked]);
        await put(join(getRunWieldRuntimeDir(root), "internal", "plan-transitions", "same.json"), "primary");
        await put(join(getRunWieldRuntimeDir(linked), "internal", "plan-transitions", "same.json"), "linked");
        const selected = await enterProjectRuntime(linked);
        const primary = resolveProjectRuntimeLayout(root);
        equal(selected.primary.worktreeRegistryPath, primary.primary.worktreeRegistryPath);
        ok(selected.selected.planLocksDir !== primary.selected.planLocksDir);
        equal(await readFile(join(selected.selected.transitionJournalsDir, "same.json"), "utf8"), "linked");
        equal(await readFile(join(primary.selected.transitionJournalsDir, "same.json"), "utf8"), "primary");
        await rejects(() => lstat(join(getRunWieldRuntimeDir(linked), "internal")), { code: "ENOENT" });
    } finally {
        await rm(linked, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("populated fallback worktree retains HEAD, staged, unstaged and untracked work after Git relocation", async () => {
    const root = await realpath(await fixture.checkout());
    const old = join(getRunWieldRuntimeDir(root), "internal", "worktrees", "attempt");
    try {
        await mkdir(dirname(old), { recursive: true });
        await git(root, ["worktree", "add", "-b", "runtime-dirty", old]);
        await writeFile(join(old, "README.md"), "staged\n");
        await git(old, ["add", "README.md"]);
        await writeFile(join(old, "README.md"), "unstaged\n");
        await writeFile(join(old, "untracked"), "untracked\0");
        const before = await Promise.all(
            [
                ["rev-parse", "HEAD"],
                ["diff", "--cached", "--binary"],
                ["diff", "--binary"],
            ].map((args) => git(old, args)),
        );
        const layout = await enterProjectRuntime(root);
        const moved = join(layout.primary.fallbackWorktreesRoot, "attempt");
        deepEqual(
            await Promise.all(
                [
                    ["rev-parse", "HEAD"],
                    ["diff", "--cached", "--binary"],
                    ["diff", "--binary"],
                ].map((args) => git(moved, args)),
            ),
            before,
        );
        equal(await readFile(join(moved, "untracked"), "utf8"), "untracked\0");
        ok((await git(root, ["worktree", "list", "--porcelain"])).includes(moved));
        await rejects(() => lstat(old), { code: "ENOENT" });
        await enterProjectRuntime(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("identity-free passive inspection does not admit a Project", async () => {
    const root = await fixture.checkout();
    try {
        const before = await readdir(root);
        equal((await inspectProjectRuntimeReadAccess(root)).kind, "fresh");
        deepEqual(await readdir(root), before);
        equal(inspectProjectIdentity(root).kind, "fresh");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("home authority rejects newer legacy markers and preserves the source", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const path = join(getRunWieldRuntimeDir(root), "internal", "layout.json");
        await put(path, JSON.stringify({ version: 999 }));
        await rejects(() => enterProjectRuntime(root), /newer/);
        equal(await readFile(path, "utf8"), JSON.stringify({ version: 999 }));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ordinary admission refuses symlinked current controller authority", async () => {
    const root = await realpath(await fixture.checkout());
    const outside = await mkdtemp(join(tmpdir(), "runtime-outside-"));
    try {
        const layout = await enterProjectRuntime(root);
        await symlink(outside, dirname(layout.primary.controllerPlansDir));
        await rejects(() => enterProjectRuntime(root), /symbolic link/);
        equal((await inspectProjectRuntimeReadAccess(root)).kind, "blocked");
        deepEqual(await readdir(outside), []);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test("ordinary admission rejects tracked collaboration secrets and preserves Git and bytes", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        await put(join(root, ".wld", "internal", "collaboration-secrets.json"), "private secret");
        await git(root, ["add", "-f", ".wld/internal/collaboration-secrets.json"]);
        const index = await git(root, ["diff", "--cached", "--binary"]);
        await rejects(() => enterProjectRuntime(root), /rotate the capability/);
        equal(await git(root, ["diff", "--cached", "--binary"]), index);
        equal(await readFile(join(root, ".wld", "internal", "collaboration-secrets.json"), "utf8"), "private secret");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ordinary admission refuses changed stale-lock proof in an old journal", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const base = getRunWieldRuntimeDir(root);
        const lock = join(base, "plan-locks", "one.lock");
        await put(lock, "new evidence");
        await put(
            join(base, "internal", "layout-migration.json"),
            JSON.stringify({
                version: 1,
                primaryCheckoutRoot: root,
                selectedCheckoutRoots: [root],
                operations: [
                    { action: "retire", source: lock, completed: false, proof: { text: "old", size: 3, mtime: 0 } },
                ],
            }),
        );
        await rejects(() => enterProjectRuntime(root), /lock changed/);
        equal(await readFile(lock, "utf8"), "new evidence");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ordinary admission finishes already-applied old journal without recreating checkout storage", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const base = getRunWieldRuntimeDir(root);
        const source = join(base, "controller");
        const destination = join(base, "internal", "controller");
        await put(
            join(destination, "plans", "one.json"),
            JSON.stringify({ version: 1, revision: 1, planId: "one", planName: "demo", state: {} }),
        );
        await put(
            join(base, "internal", "layout-migration.json"),
            JSON.stringify({
                version: 1,
                primaryCheckoutRoot: root,
                selectedCheckoutRoots: [root],
                operations: [{ action: "rename", source, destination, completed: false }],
            }),
        );
        const layout = await enterProjectRuntime(root);
        equal((await inspectPlanFixtureController(root, { planId: "one", planName: "demo" }))?.revision, 1);
        await rejects(() => lstat(join(base, "internal")), { code: "ENOENT" });
        await rejects(() => lstat(source), { code: "ENOENT" });
        equal((await enterProjectRuntime(root)).primary.controllerPlansDir, layout.primary.controllerPlansDir);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("ordinary admission preserves both byte-distinct authorities on destination conflict", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        await admitProjectIdentity(root);
        const layout = resolveProjectRuntimeLayout(root);
        const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
        const destination = join(layout.primary.debugRoot, "trace");
        await put(source, "source");
        await put(destination, "destination");
        await rejects(() => enterProjectRuntime(root), /destination differs/);
        equal(await readFile(source, "utf8"), "source");
        equal(await readFile(destination, "utf8"), "destination");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("non-Git runtime home remains stable after Git adoption", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-nongit-")));
    try {
        const before = await enterProjectRuntime(root);
        await put(join(before.primary.debugRoot, "trace"), "nongit");
        await git(root, ["init"]);
        const after = await enterProjectRuntime(root);
        equal(after.primary.debugRoot, before.primary.debugRoot);
        equal(await readFile(join(after.primary.debugRoot, "trace"), "utf8"), "nongit");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("explicit managed owner keeps versioned runtime and never adopts ordinary home storage", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const context = {
            executionAccountHome: getHomeDir(),
            personalOwner: { kind: "managed-remote" as const, identity: "laptop-account" },
        };
        const layout = await enterProjectRuntime(root, { context });
        equal(layout.primary.internalRoot, join(getRunWieldRuntimeDir(root), "internal"));
        const identity = inspectProjectIdentity(root, { context });
        ok(identity.kind === "existing");
        await rejects(() => lstat(join(getHomeDir(), ".wld", "projects", identity.identity.projectId)), {
            code: "ENOENT",
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("SQLite projection is quiesced and retained in the home index", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const source = join(getRunWieldRuntimeDir(root), "internal", "work-records.sqlite3");
        await mkdir(dirname(source), { recursive: true });
        const index = new DatabaseSync(source);
        index.exec("CREATE TABLE records (name TEXT); INSERT INTO records VALUES ('retained');");
        index.close();
        const layout = await enterProjectRuntime(root);
        const copied = new DatabaseSync(layout.primary.workRecordIndexDatabasePath);
        try {
            equal(copied.prepare("SELECT name FROM records").get()?.name, "retained");
        } finally {
            copied.close();
        }
        await rejects(() => lstat(source), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("explicitly linked clones share Project identity and isolate execution and legacy controllers", async () => {
    const remote = await fixture.checkout();
    const one = await realpath(await mkdtemp(join(tmpdir(), "runtime-clone-one-")));
    const two = await realpath(await mkdtemp(join(tmpdir(), "runtime-clone-two-")));
    try {
        await git(remote, ["clone", remote, one]);
        await git(remote, ["clone", remote, two]);
        const first = await enterProjectRuntime(one);
        const pending = inspectProjectIdentity(two);
        ok(pending.kind === "pending");
        const second = await enterProjectRuntime(two, {
            choice: { kind: "link", candidates: pending.candidates, projectId: pending.candidates[0].projectId },
        });
        ok(first.primary.worktreeRegistryPath !== second.primary.worktreeRegistryPath);
        ok(first.primary.controllerPlansDir !== second.primary.controllerPlansDir);
        equal(first.primary.projectSecretStorePath, second.primary.projectSecretStorePath);
        await seedPlanController(one, { planId: "one", planName: "demo" }, { validationCiAttempts: 3 });
        equal(await inspectPlanFixtureController(two, { planId: "one", planName: "demo" }), null);
    } finally {
        for (const root of [one, two, remote]) await rm(root, { recursive: true, force: true });
    }
});

test("unavailable account home preserves checkout runtime and reports the prerequisite", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const home = join(root, "unavailable-home");
        await writeFile(home, "file, not a home directory");
        const source = join(getRunWieldRuntimeDir(root), "internal", "debug", "trace");
        await put(source, "preserve");
        await rejects(
            () =>
                enterProjectRuntime(root, {
                    context: {
                        executionAccountHome: home,
                        personalOwner: { kind: "execution-account", identity: home },
                    },
                }),
            /directory|ENOTDIR/,
        );
        equal(await readFile(source, "utf8"), "preserve");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("returning legacy controller input cannot revert adopted home decisions", async () => {
    const root = await realpath(await fixture.checkout());
    try {
        const source = join(getRunWieldRuntimeDir(root), "internal", "controller", "plans", "one.json");
        await put(
            source,
            JSON.stringify({
                version: 1,
                revision: 4,
                planId: "one",
                planName: "demo",
                state: { humanReviewDecision: "approved" },
            }),
        );
        await enterProjectRuntime(root);
        await seedPlanController(root, { planId: "one", planName: "demo" }, { validationCiAttempts: 2 });
        const adopted = await inspectPlanFixtureController(root, { planId: "one", planName: "demo" });
        await put(
            source,
            JSON.stringify({
                version: 1,
                revision: 99,
                planId: "one",
                planName: "demo",
                state: { humanReviewDecision: "rejected" },
            }),
        );
        await enterProjectRuntime(root);
        deepEqual(await inspectPlanFixtureController(root, { planId: "one", planName: "demo" }), adopted);
        await rejects(() => lstat(join(getRunWieldRuntimeDir(root), "internal")), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("primary entry makes a newly attached checkout readable without another admission", async () => {
    const root = await realpath(await fixture.checkout());
    const linked = await realpath(await mkdtemp(join(tmpdir(), "runtime-new-linked-")));
    try {
        await seedPlanController(root, { planId: "new-linked", planName: "demo" }, { validationCiAttempts: 2 });
        await git(root, ["worktree", "add", "-b", "new-linked", linked]);
        await enterProjectRuntime(root);
        equal((await inspectProjectRuntimeReadAccess(linked)).kind, "ready");
        equal((await inspectPlanFixtureController(linked, { planId: "new-linked", planName: "demo" }))?.revision, 1);
    } finally {
        await rm(linked, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
    }
});
