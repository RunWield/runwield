import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { packageFixture, tree, driver, read, create, startDriver } from "./shared/testing/plan-package-fixture.ts";
import {
    importPlanPackages,
    listPlanPackages,
    readPlanPackage,
    recoverPlanPackages,
    updatePlanPackageMetadata,
    readPlanImportEvidence,
} from "./plan-store.js";
import { git } from "./shared/git-test-fixture.ts";
import { admitProjectIdentity } from "./shared/project-identity.ts";

async function family(root: string) {
    const selection = join(root, "docs/plans");
    await fs.mkdir(selection, { recursive: true });
    await fs.writeFile(join(selection, "a.md"), "# Draft A\n");
    await fs.writeFile(join(selection, "b.md"), "# Draft B\n");
    return selection;
}

for (const boundary of [
    "import-intent",
    "import-allocated",
    "staged-package",
    "moved-resource",
    "metadata",
    "import-all-moved",
    "import-committed",
])
    test(`import interruption at ${boundary} preserves one complete batch and durable IDs`, async () => {
        const f = await packageFixture();
        try {
            await create(f.identity);
            const selection = await family(f.root);
            const sources = await tree(selection);
            const interrupted = await driver({ identity: f.identity, command: "import", selection, boundary });
            equal(interrupted.code, 86, JSON.stringify(interrupted));
            const reserved: { reservedPlanIds: string[] } = JSON.parse(interrupted.output.trim().split("\n").at(-1)!);
            const home = join(f.identity.executionAccountHome, ".wld/projects", f.identity.projectId);
            const before = await tree(home);
            const catalog = await listPlanPackages(f.identity);
            const committed = boundary === "import-committed";
            equal(catalog.packages.length, committed ? 3 : 1, JSON.stringify(catalog));
            for (const name of ["a", "b"])
                equal((await readPlanPackage(f.identity, { name })).kind, committed ? "loaded" : "pending_recovery");
            for (const planId of reserved.reservedPlanIds)
                equal((await readPlanPackage(f.identity, { planId })).kind, committed ? "loaded" : "pending_recovery");
            equal((await readPlanPackage(f.identity, { planId: "plan-one" })).kind, "loaded");
            const reopened = await driver({ identity: f.identity, command: "list" });
            equal(reopened.code, 0, reopened.errors);
            deepEqual(await tree(home), before, "passive reads cannot repair imports");
            await recoverPlanPackages(f.identity);
            const result = await importPlanPackages(f.identity, selection);
            ok(result.kind === "existing", JSON.stringify(result));
            deepEqual([...result.planIds].sort(), [...reserved.reservedPlanIds].sort());
            equal((await listPlanPackages(f.identity)).packages.length, 3);
            const p = await read(f.identity, result.planIds[0]);
            await updatePlanPackageMetadata(f.identity, p.metadata.planId, p.metadata.revision, {
                definition: { ...p.metadata.definition, status: "approved" },
            });
            const settled = await tree(home);
            await recoverPlanPackages(f.identity);
            deepEqual(await tree(home), settled, "recovery cannot replay over newer edits");
            deepEqual(await tree(selection), sources);
            await fs.rm(selection, { recursive: true });
            await recoverPlanPackages(f.identity);
            const repeated = await importPlanPackages(f.identity, selection);
            ok(repeated.kind === "existing");
            deepEqual([...repeated.planIds].sort(), [...result.planIds].sort());
            equal((await read(f.identity, p.metadata.planId)).metadata.definition.status, "approved");
            const evidence = await readPlanImportEvidence(f.identity, p.metadata.references.legacyImport!);
            equal(Buffer.from(evidence.source.bytes!, "base64").toString(), "# Draft A\n");
        } finally {
            await f.cleanup();
        }
    });

test("a batch committing entirely during a catalog scan causes a complete reread", async () => {
    const f = await packageFixture();
    try {
        await create(f.identity);
        const selection = await family(f.root);
        const result = await driver({
            identity: f.identity,
            command: "list",
            selection,
            boundary: "commit-import-during-scan",
        });
        equal(result.code, 0, JSON.stringify(result));
        const line = result.output.trim().split("\n").at(-1)!;
        const response = JSON.parse(line);
        equal(response.result.packages.length, 3, line);
        equal(response.result.issues.length, 0, line);
    } finally {
        await f.cleanup();
    }
});

test("overlapping concurrent file and folder imports allocate an ID-less source once", async () => {
    const f = await packageFixture();
    try {
        const selection = await family(f.root);
        const barrier = join(f.root, "go");
        const first = startDriver({ identity: f.identity, command: "import", selection, barrier });
        const second = startDriver({
            identity: f.identity,
            command: "import",
            selection: join(selection, "a.md"),
            barrier,
        });
        await Promise.all([first.ready(), second.ready()]);
        await fs.writeFile(barrier, "go");
        const results = await Promise.all([first.done, second.done]);
        for (const result of results) {
            equal(result.code, 0, JSON.stringify(result));
            ok(!result.output.includes('"kind":"conflict"'));
        }
        const catalog = await listPlanPackages(f.identity);
        equal(catalog.packages.length, 2);
        equal(new Set(catalog.packages.map((p) => p.metadata.planId)).size, 2);
    } finally {
        await f.cleanup();
    }
});

test("worktree imports share repository-relative source allocation", async () => {
    const f = await packageFixture();
    try {
        const selection = await family(f.root);
        await git(f.root, ["add", "docs"]);
        await git(f.root, ["commit", "-m", "fixture"]);
        const worktree = join(f.root, "worktree");
        await git(f.root, ["worktree", "add", "-b", "other", worktree]);
        const identity = await admitProjectIdentity(worktree);
        ok(identity.kind === "existing");
        const results = await Promise.all([
            driver({ identity: f.identity, command: "import", selection }),
            driver({ identity: identity.identity, command: "import", selection: join(worktree, "docs/plans") }),
        ]);
        for (const result of results) {
            equal(result.code, 0, JSON.stringify(result));
            ok(!result.output.includes('"kind":"conflict"'), result.output);
        }
        equal((await listPlanPackages(f.identity)).packages.length, 2);
    } finally {
        await f.cleanup();
    }
});

for (const command of ["create", "rename"] as const)
    test(`ordinary ${command} competing with import cannot publish the same name twice`, async () => {
        const f = await packageFixture();
        try {
            const selection = await family(f.root);
            if (command === "rename") await create(f.identity, { planId: "creator", name: "original" });
            const results = await Promise.all([
                driver({ identity: f.identity, command: "import", selection }),
                driver({ identity: f.identity, command, planId: "creator", name: "a" }),
            ]);
            const catalog = await listPlanPackages(f.identity);
            equal(catalog.issues.length, 0);
            equal(catalog.packages.filter((p) => p.metadata.name === "a").length, 1);
            ok(
                results.some(
                    (result) => result.output.includes('"kind":"committed"') || result.output.includes('"name":"a"'),
                ),
            );
            if (catalog.packages.length === 1)
                equal((await readPlanPackage(f.identity, { name: "b" })).kind, "missing");
        } finally {
            await f.cleanup();
        }
    });

test("explicitly linked clones share publication uniqueness without merging distinct source locators", async () => {
    const f = await packageFixture();
    try {
        await family(f.root);
        await git(f.root, ["add", "docs"]);
        await git(f.root, ["commit", "-m", "clone import fixture"]);
        const one = join(f.root, "clone-one"),
            two = join(f.root, "clone-two");
        await git(f.root, ["clone", f.root, one]);
        await git(f.root, ["clone", f.root, two]);
        const first = await admitProjectIdentity(one);
        ok(first.kind === "existing");
        const pending = await admitProjectIdentity(two);
        ok(pending.kind === "pending", JSON.stringify(pending));
        const linked = await admitProjectIdentity(two, {
            choice: { kind: "link", projectId: first.identity.projectId, candidates: pending.candidates },
        });
        ok(linked.kind === "existing");
        equal(first.identity.projectId, linked.identity.projectId);
        ok(first.identity.repositoryId !== linked.identity.repositoryId);
        const results = await Promise.all([
            driver({ identity: first.identity, command: "import", selection: join(one, "docs/plans") }),
            driver({ identity: linked.identity, command: "import", selection: join(two, "docs/plans") }),
        ]);
        equal(results.filter((result) => result.output.includes('"kind":"committed"')).length, 1);
        equal(results.filter((result) => result.output.includes('"kind":"conflict"')).length, 1);
        equal((await listPlanPackages(first.identity)).packages.length, 2);
    } finally {
        await f.cleanup();
    }
});

test("source membership changing during capture leaves every new package unpublished", async () => {
    const f = await packageFixture();
    try {
        const selection = await family(f.root);
        const result = await driver({
            identity: f.identity,
            command: "import",
            selection,
            mutateEvidencePath: join(selection, "a.md"),
            mutateEvidenceDestination: join(selection, "c.md"),
            mutateEvidenceText: "# Added during capture\n",
        });
        equal(result.code, 0, JSON.stringify(result));
        ok(result.output.includes('"kind":"pending"'), result.output);
        equal((await listPlanPackages(f.identity)).packages.length, 0);
        equal((await importPlanPackages(f.identity, selection)).kind, "committed");
        equal((await listPlanPackages(f.identity)).packages.length, 3);
    } finally {
        await f.cleanup();
    }
});
