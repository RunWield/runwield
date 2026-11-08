import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { create, read, driver, packageFixture, tree, documents } from "./shared/testing/plan-package-fixture.ts";
import {
    readPlanPackage,
    listPlanPackages,
    updatePlanPackageMetadata,
    savePlanPackageDocument,
    renamePlanPackage,
    archivePlanPackage,
    restorePlanPackage,
    getPlansDir,
    savePlan,
    loadPlan,
    listPlans,
    StalePlanWriteError,
} from "./plan-store.js";

test("packages persist plain documents and separate versioned metadata across processes", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity, {
            controller: { humanReviewDecision: "approved" },
            references: { sessionIds: ["session-a"], worktreeId: "attempt-a" },
        });
        deepEqual((await fs.readdir(p.path)).sort(), ["context.md", "plan.wld.json", "validation.md"]);
        equal(await fs.readFile(join(p.path, "context.md"), "utf8"), documents["context.md"]);
        equal(p.metadata.version, 1);
        const restarted = await driver({ identity: f.identity, command: "read" });
        equal(restarted.code, 0, restarted.errors);
        ok(restarted.output.includes('"humanReviewDecision":"approved"'));
        ok(restarted.output.includes('"session-a"'));
        equal((await read(f.identity)).documents.length, 2);
    } finally {
        await f.cleanup();
    }
});

test("YAML-looking editor bytes cannot change package identity, state, or relationships", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity, {
            parentPlanId: "parent",
            dependencyPlanIds: ["before"],
            controller: { humanReviewDecision: "approved" },
        });
        const text = "---\nplanId: counterfeit\nstatus: verified\nparentPlan: other\n---\n# My prose\n";
        await fs.writeFile(join(p.path, "context.md"), text);
        const current = await read(f.identity);
        deepEqual(current.metadata, p.metadata);
        equal(new TextDecoder().decode(current.documents[0].bytes), text);
    } finally {
        await f.cleanup();
    }
});

test("metadata and document revisions are independent and stale writes preserve newer content", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        const metadata = await updatePlanPackageMetadata(f.identity, "plan-one", 1, {
            definition: { ...p.metadata.definition, status: "approved" },
        });
        equal(metadata.revision, 2);
        equal(await fs.readFile(join(p.path, "context.md"), "utf8"), documents["context.md"]);
        await savePlanPackageDocument(f.identity, "plan-one", "context.md", p.documents[0].hash, "new body\n");
        await rejects(
            () => savePlanPackageDocument(f.identity, "plan-one", "context.md", p.documents[0].hash, "stale"),
            StalePlanWriteError,
        );
        await updatePlanPackageMetadata(f.identity, "plan-one", 2, { controller: { validationCiAttempts: 2 } });
        await rejects(
            () => updatePlanPackageMetadata(f.identity, "plan-one", 2, { controller: {} }),
            StalePlanWriteError,
        );
        equal(await fs.readFile(join(p.path, "context.md"), "utf8"), "new body\n");
        equal((await read(f.identity)).metadata.controller.validationCiAttempts, 2);
    } finally {
        await f.cleanup();
    }
});

test("metadata updates preserve direct editor changes in every document byte", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity, { documents: { ...documents, "manual-qa.md": "optional" } });
        for (const doc of p.documents) await fs.writeFile(join(p.path, doc.name), Buffer.from([0, 255, 13, 10, 35]));
        const before = await tree(p.path);
        await updatePlanPackageMetadata(f.identity, "plan-one", 1, { controller: { humanReviewDecision: "approved" } });
        const after = await tree(p.path);
        for (const name of Object.keys(documents).concat("manual-qa.md")) equal(after[name], before[name]);
    } finally {
        await f.cleanup();
    }
});

test("Epic rename and archive preserve independently located children, references and artifacts", async () => {
    const f = await packageFixture();
    try {
        await create(f.identity, {
            name: "epic",
            definition: { classification: "PROJECT", status: "draft" },
            documents: { ...documents, "integration-report.md": "integration evidence" },
            references: { sessionIds: ["s"], worktreeId: "w" },
        });
        await create(f.identity, {
            planId: "child",
            name: "epic/child",
            parentPlanId: "plan-one",
            dependencyPlanIds: ["prerequisite"],
        });
        await create(f.identity, { planId: "prerequisite", name: "independent" });
        const renamed = await renamePlanPackage(f.identity, "plan-one", 1, "renamed");
        deepEqual(renamed.references, { sessionIds: ["s"], worktreeId: "w" });
        const child = await read(f.identity, "child");
        equal(child.metadata.name, "epic/child");
        equal(child.metadata.parentPlanId, "plan-one");
        equal((await read(f.identity, child.metadata.dependencyPlanIds[0])).metadata.name, "independent");
        const epic = await read(f.identity);
        equal(
            new TextDecoder().decode(epic.documents.find((d) => d.name === "integration-report.md")!.bytes),
            "integration evidence",
        );
        const archived = await archivePlanPackage(f.identity, "plan-one", 2, "done");
        equal((await listPlanPackages(f.identity)).packages.length, 2);
        equal((await listPlanPackages(f.identity, true)).packages.length, 3);
        equal((await read(f.identity, "child")).metadata.archive, null);
        const movedArchive = await renamePlanPackage(f.identity, "plan-one", archived.revision, "archived-epic");
        deepEqual(movedArchive.archive, archived.archive);
        const restored = await restorePlanPackage(f.identity, "plan-one", movedArchive.revision);
        ok(restored.archive?.restoredAt);
        equal(restored.archive.archivedAt, archived.archive!.archivedAt);
        equal((await listPlanPackages(f.identity)).packages.length, 3);
    } finally {
        await f.cleanup();
    }
});

test("name and ID collisions cannot overwrite packages, including an empty destination namespace", async () => {
    const f = await packageFixture();
    try {
        await create(f.identity);
        await rejects(() => create(f.identity, { planId: "other" }), /destination/);
        await rejects(() => create(f.identity, { name: "other" }), /ID already/);
        await create(f.identity, { planId: "child", name: "namespace/child" });
        await renamePlanPackage(f.identity, "plan-one", 1, "namespace");
        await rejects(() => renamePlanPackage(f.identity, "plan-one", 2, "namespace/child"), /destination/);
        equal((await listPlanPackages(f.identity)).packages.length, 2);
        equal((await readPlanPackage(f.identity, { name: "namespace", planId: "wrong" })).kind, "missing");
    } finally {
        await f.cleanup();
    }
});

for (const operation of ["create", "rename"] as const)
    for (const name of ["epic/second", "Epic/group/second", "Epic/group"])
        test(`${operation} preserves readable packages when ${name} aliases existing directory spelling`, async () => {
            const f = await packageFixture();
            try {
                const first = await create(f.identity, { name: "Epic/Group/first" });
                const original =
                    operation === "rename" ? await create(f.identity, { planId: "second", name: "original" }) : null;
                const plans = join(first.path, "../../..");
                const aliases = await fs.stat(join(plans, "epic")).then(
                    () => true,
                    (error) => {
                        if (error.code === "ENOENT") return false;
                        throw error;
                    },
                );
                const publish = () =>
                    operation === "create"
                        ? create(f.identity, { planId: "second", name })
                        : renamePlanPackage(f.identity, "second", 1, name);
                if (aliases) {
                    await rejects(publish, /directory spelling/);
                    deepEqual(await read(f.identity), first);
                    if (original) deepEqual(await read(f.identity, "second"), original);
                    else equal((await readPlanPackage(f.identity, { planId: "second" })).kind, "missing");
                } else {
                    await publish();
                    equal((await read(f.identity, "second")).metadata.name, name);
                }
                await create(f.identity, { planId: "after", name: "Epic/Group/after" });
                equal((await listPlanPackages(f.identity)).issues.length, 0);
            } finally {
                await f.cleanup();
            }
        });

for (const [label, contents, kind] of [
    ["malformed JSON", "{", "malformed_metadata"],
    ["unsupported version", '{"version":2}', "unsupported_metadata"],
    ["invalid fields", '{"version":1,"planId":2}', "malformed_metadata"],
] as const)
    test(`strict inspection distinguishes ${label} without hiding healthy packages`, async () => {
        const f = await packageFixture();
        try {
            const bad = await create(f.identity);
            await create(f.identity, { planId: "healthy", name: "healthy" });
            await fs.writeFile(join(bad.path, "plan.wld.json"), contents);
            const before = await tree(join(f.identity.executionAccountHome, ".wld", "projects", f.identity.projectId));
            equal((await readPlanPackage(f.identity, { name: "one" })).kind, kind);
            const listed = await listPlanPackages(f.identity);
            equal(listed.packages.length, 1);
            equal(listed.packages[0].metadata.planId, "healthy");
            equal(listed.issues[0].kind, kind);
            deepEqual(
                await tree(join(f.identity.executionAccountHome, ".wld", "projects", f.identity.projectId)),
                before,
            );
        } finally {
            await f.cleanup();
        }
    });

test("missing required input is distinct from missing optional QA and never assigned a new status", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        equal((await read(f.identity)).documents.length, 2);
        await fs.unlink(join(p.path, "validation.md"));
        equal((await readPlanPackage(f.identity, { name: "one" })).kind, "missing_document");
        equal((await readPlanPackage(f.identity, { planId: "plan-one" })).kind, "missing_document");
        const metadata = JSON.parse(await fs.readFile(join(p.path, "plan.wld.json"), "utf8"));
        equal(metadata.definition.status, "draft");
    } finally {
        await f.cleanup();
    }
});

test("passive package inspection creates no storage, locks, identities, or repository files", async () => {
    const f = await packageFixture();
    try {
        const home = join(f.identity.executionAccountHome, ".wld", "projects", f.identity.projectId);
        const before = { home: await tree(home), checkout: await tree(f.root) };
        equal((await readPlanPackage(f.identity, { planId: "absent" })).kind, "missing");
        deepEqual(await listPlanPackages(f.identity), { packages: [], issues: [] });
        equal((await readPlanPackage(f.identity, { name: "absent" })).kind, "missing");
        deepEqual({ home: await tree(home), checkout: await tree(f.root) }, before);
    } finally {
        await f.cleanup();
    }
});

test("traversal, reserved resource names, and symbolic links cannot escape or overwrite the store", async () => {
    const f = await packageFixture();
    try {
        for (const name of [
            "../escape",
            "bad/../escape",
            "/absolute",
            "a\\b",
            "epic/manual-qa",
            "integration-report",
            "context.md",
            "validation",
            "plan.wld.json",
            "NUL",
        ]) {
            await rejects(() => create(f.identity, { name }), /name/);
        }
        const p = await create(f.identity);
        const outside = join(f.root, "outside");
        await fs.mkdir(outside);
        await fs.symlink(outside, join(p.path, "manual-qa.md"));
        equal((await readPlanPackage(f.identity, { name: "one" })).kind, "unsafe_path");
        await rejects(() => updatePlanPackageMetadata(f.identity, "plan-one", 1, { controller: {} }), /Symbolic link/);
        deepEqual(await fs.readdir(outside), []);
    } finally {
        await f.cleanup();
    }
});

test("explicit packages do not join legacy discovery or controller routing", async () => {
    const f = await packageFixture();
    try {
        await savePlan(f.root, "legacy", "# Legacy body\n");
        const before = await tree(getPlansDir(f.root));
        await create(f.identity);
        deepEqual(await tree(getPlansDir(f.root)), before);
        ok(await loadPlan(f.root, "legacy"));
        equal(await loadPlan(f.root, "one"), null);
        ok((await listPlans(f.root)).every((p) => p.name !== "one"));
        await rejects(() => fs.lstat(join(f.root, ".wld", "plans")), { code: "ENOENT" });
    } finally {
        await f.cleanup();
    }
});

test("managed-remote ownership cannot select the execution account's package store", async () => {
    const f = await packageFixture();
    try {
        const remote = { ...f.identity, personalOwner: { kind: "managed-remote" as const, identity: "laptop-owner" } };
        const before = await tree(f.identity.executionAccountHome);
        await rejects(() => create(remote), /personal-store transport/);
        equal((await readPlanPackage(remote, { name: "one" })).kind, "unavailable");
        deepEqual(await tree(f.identity.executionAccountHome), before);
    } finally {
        await f.cleanup();
    }
});

test("duplicate metadata IDs never let name lookup select a counterfeit identity", async () => {
    const f = await packageFixture();
    try {
        const first = await create(f.identity);
        const second = await create(f.identity, { planId: "second", name: "second" });
        await fs.writeFile(join(second.path, "plan.wld.json"), JSON.stringify({ ...first.metadata, name: "second" }));
        equal((await readPlanPackage(f.identity, { name: "one" })).kind, "malformed_metadata");
        equal((await readPlanPackage(f.identity, { planId: "plan-one" })).kind, "malformed_metadata");
        equal((await listPlanPackages(f.identity, true)).packages.length, 0);
    } finally {
        await f.cleanup();
    }
});

test("a symlinked package directory cannot redirect creation outside the personal store", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        const outside = join(f.root, "outside");
        await fs.mkdir(outside);
        await fs.symlink(outside, join(p.path, "..", "escape"));
        const before = await tree(outside);
        await rejects(() => create(f.identity, { planId: "outside", name: "escape/new" }), /damaged|Symbolic link/);
        deepEqual(await tree(outside), before);
        equal((await readPlanPackage(f.identity, { name: "escape/new" })).kind, "unsafe_path");
    } finally {
        await f.cleanup();
    }
});
