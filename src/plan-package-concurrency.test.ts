import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { create, read, packageFixture, startDriver } from "./shared/testing/plan-package-fixture.ts";
import { listPlanPackages } from "./plan-store.js";
import { admitProjectIdentity, inspectProjectIdentity } from "./shared/project-identity.ts";
import { git } from "./shared/git-test-fixture.ts";

for (const command of ["metadata", "document"] as const)
    test(`two processes using one ${command} revision have exactly one winner`, async () => {
        const f = await packageFixture();
        try {
            await create(f.identity);
            const barrier = join(f.root, "release");
            const writers = [
                startDriver({ identity: f.identity, command, barrier }),
                startDriver({ identity: f.identity, command, barrier }),
            ];
            await Promise.all(writers.map((w) => w.ready()));
            await fs.writeFile(barrier, "go");
            const results = await Promise.all(writers.map((w) => w.done));
            equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results));
            equal(results.filter((r) => r.output.includes("StalePlanWriteError")).length, 1);
        } finally {
            await f.cleanup();
        }
    });

test("a metadata writer and a document writer both commit from the same observation", async () => {
    const f = await packageFixture();
    try {
        await create(f.identity);
        const barrier = join(f.root, "release");
        const writers = (["metadata", "document"] as const).map((command) =>
            startDriver({ identity: f.identity, command, barrier }),
        );
        await Promise.all(writers.map((w) => w.ready()));
        await fs.writeFile(barrier, "go");
        const results = await Promise.all(writers.map((w) => w.done));
        ok(
            results.every((r) => r.code === 0),
            JSON.stringify(results),
        );
        const p = await read(f.identity);
        equal(p.metadata.controller.validationCiAttempts, 3);
        equal(new TextDecoder().decode(p.documents[0].bytes), "# Concurrent edit\n");
    } finally {
        await f.cleanup();
    }
});

for (const collision of ["name", "ID"] as const)
    test(`simultaneous creation by equal ${collision} publishes one package`, async () => {
        const f = await packageFixture();
        try {
            const barrier = join(f.root, "release");
            const writers = [0, 1].map((index) =>
                startDriver({
                    identity: f.identity,
                    command: "create",
                    barrier,
                    planId: collision === "ID" ? "same" : `id-${index}`,
                    name: collision === "name" ? "same" : `name-${index}`,
                }),
            );
            await Promise.all(writers.map((w) => w.ready()));
            await fs.writeFile(barrier, "go");
            const results = await Promise.all(writers.map((w) => w.done));
            equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results));
            equal((await listPlanPackages(f.identity)).packages.length, 1);
        } finally {
            await f.cleanup();
        }
    });

test("two worktrees and an explicitly linked clone share the Project package lock until its holder exits", async () => {
    const f = await packageFixture();
    const secondary = `${f.root}-linked`,
        third = `${f.root}-third`,
        clone = `${f.root}-clone`;
    let holder: ReturnType<typeof startDriver> | undefined;
    let waiter: ReturnType<typeof startDriver> | undefined;
    try {
        await git(f.root, ["remote", "add", "origin", "https://example.com/packages.git"]);
        // Re-admission refreshes stored repository evidence used by explicit clone linking.
        await admitProjectIdentity(f.root);
        await git(f.root, ["worktree", "add", "-b", "second", secondary]);
        await git(f.root, ["worktree", "add", "-b", "third", third]);
        const secondIdentity = await admitProjectIdentity(secondary);
        ok(secondIdentity.kind === "existing");
        const thirdIdentity = await admitProjectIdentity(third);
        ok(thirdIdentity.kind === "existing");
        await git(f.root, ["clone", f.root, clone]);
        await git(clone, ["remote", "set-url", "origin", "https://example.com/packages.git"]);
        const pending = inspectProjectIdentity(clone);
        ok(pending.kind === "pending", JSON.stringify(pending));
        const linked = await admitProjectIdentity(clone, {
            choice: { kind: "link", candidates: pending.candidates, projectId: f.identity.projectId },
        });
        ok(linked.kind === "existing");
        await create(f.identity);
        equal((await read(secondIdentity.identity)).metadata.planId, "plan-one");
        equal((await read(thirdIdentity.identity)).metadata.planId, "plan-one");
        equal((await read(linked.identity)).metadata.planId, "plan-one");
        holder = startDriver({ identity: secondIdentity.identity, command: "hold" });
        await holder.ready();
        waiter = startDriver({ identity: linked.identity, command: "metadata" });
        await waiter.ready();
        const settled = await Promise.race([
            waiter.done.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150)),
        ]);
        equal(settled, false, "a still-held native lock must never be stolen");
        holder.child.kill("SIGKILL");
        await holder.done;
        const result = await waiter.done;
        equal(result.code, 0, JSON.stringify(result));
        equal((await read(thirdIdentity.identity)).metadata.controller.validationCiAttempts, 3);
    } finally {
        holder?.child.kill("SIGKILL");
        waiter?.child.kill("SIGKILL");
        await fs.rm(secondary, { recursive: true, force: true });
        await fs.rm(third, { recursive: true, force: true });
        await fs.rm(clone, { recursive: true, force: true });
        await f.cleanup();
    }
});

test("separate personal Project stores do not contend on equal Plan IDs", async () => {
    const first = await packageFixture();
    const personalHome = join(first.root, "other-personal-home");
    await fs.mkdir(personalHome);
    const admitted = await admitProjectIdentity(first.root, {
        context: {
            executionAccountHome: personalHome,
            personalOwner: { kind: "execution-account", identity: personalHome },
        },
    });
    ok(admitted.kind === "existing");
    const second = admitted.identity;
    equal(second.projectId, first.identity.projectId);
    let holder: ReturnType<typeof startDriver> | undefined;
    try {
        await create(first.identity);
        await create(second);
        holder = startDriver({ identity: first.identity, command: "hold" });
        await holder.ready();
        const writer = startDriver({ identity: second, command: "metadata" });
        const result = await writer.done;
        equal(result.code, 0, JSON.stringify(result));
        equal((await read(first.identity)).metadata.revision, 1);
        equal((await read(second)).metadata.revision, 2);
    } finally {
        holder?.child.kill("SIGKILL");
        await first.cleanup();
    }
});
