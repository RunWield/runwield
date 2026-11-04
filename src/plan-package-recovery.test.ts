import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { join } from "node:path";
import { create, read, driver, packageFixture, tree } from "./shared/testing/plan-package-fixture.ts";
import { recoverPlanPackages, readPlanPackage, listPlanPackages, updatePlanPackageMetadata } from "./plan-store.js";

for (const boundary of ["staged-package", "intent", "moved-resource", "metadata"] as const)
    test(`creation interrupted at ${boundary} never exposes a partial successful package`, async () => {
        const f = await packageFixture();
        try {
            const result = await driver({ identity: f.identity, command: "create", boundary });
            equal(result.code, 86, JSON.stringify(result));
            const home = join(f.identity.executionAccountHome, ".wld", "projects", f.identity.projectId);
            const before = await tree(home);
            const inspected = await readPlanPackage(f.identity, { planId: "plan-one" });
            equal(inspected.kind, boundary === "staged-package" ? "missing" : "pending_recovery");
            deepEqual(await tree(home), before);
            await recoverPlanPackages(f.identity);
            const catalog = await listPlanPackages(f.identity);
            equal(catalog.issues.length, 0);
            equal(catalog.packages.length, boundary === "staged-package" ? 0 : 1);
            if (catalog.packages.length) {
                equal(new TextDecoder().decode(catalog.packages[0].documents[0].bytes), "# Created\n");
                await updatePlanPackageMetadata(f.identity, "plan-one", 1, { controller: { validationCiAttempts: 7 } });
            }
            const settled = await tree(home);
            await recoverPlanPackages(f.identity);
            deepEqual(await tree(home), settled);
            if (catalog.packages.length) equal((await read(f.identity)).metadata.controller.validationCiAttempts, 7);
        } finally {
            await f.cleanup();
        }
    });

for (const boundary of ["intent", "moved-resource", "metadata"] as const)
    test(`rename interrupted at ${boundary} recovers one identity without reverting a later revision`, async () => {
        const f = await packageFixture();
        try {
            const original = await create(f.identity);
            const result = await driver({ identity: f.identity, command: "rename", boundary });
            equal(result.code, 86, JSON.stringify(result));
            const home = join(f.identity.executionAccountHome, ".wld", "projects", f.identity.projectId);
            const before = await tree(home);
            equal((await readPlanPackage(f.identity, { planId: "plan-one" })).kind, "pending_recovery");
            equal((await readPlanPackage(f.identity, { name: "one" })).kind, "pending_recovery");
            equal((await readPlanPackage(f.identity, { name: "renamed" })).kind, "pending_recovery");
            deepEqual(await tree(home), before);
            await recoverPlanPackages(f.identity);
            const p = await read(f.identity);
            equal(p.metadata.name, "renamed");
            equal(p.metadata.revision, 2);
            deepEqual(p.documents, original.documents);
            const metadataPaths = Object.keys(await tree(join(home, "plans"))).filter((path) =>
                path.endsWith("plan.wld.json"),
            );
            deepEqual(metadataPaths, ["renamed/plan.wld.json"]);
            await updatePlanPackageMetadata(f.identity, "plan-one", 2, {
                controller: { humanReviewDecision: "approved" },
            });
            await recoverPlanPackages(f.identity);
            equal((await read(f.identity)).metadata.revision, 3);
            equal((await read(f.identity)).metadata.controller.humanReviewDecision, "approved");
        } finally {
            await f.cleanup();
        }
    });

test("metadata committed before acknowledgement survives process restart", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity);
        const result = await driver({ identity: f.identity, command: "metadata", boundary: "metadata" });
        equal(result.code, 86, JSON.stringify(result));
        const current = await read(f.identity);
        equal(current.metadata.revision, 2);
        equal(current.metadata.controller.validationCiAttempts, 3);
        deepEqual(current.documents, p.documents);
        await recoverPlanPackages(f.identity);
        equal((await read(f.identity)).metadata.revision, 2);
        ok(!(await tree(current.path))["intent.json"]);
    } finally {
        await f.cleanup();
    }
});

test("a publication begun during a passive scan cannot expose an unresolved destination as loaded", async () => {
    const f = await packageFixture();
    try {
        await create(f.identity);
        const result = await driver({ identity: f.identity, command: "read", boundary: "start-rename-during-scan" });
        equal(result.code, 0, JSON.stringify(result));
        ok(result.output.includes('"kind":"pending_recovery"'), result.output);
        await recoverPlanPackages(f.identity);
        equal((await read(f.identity)).metadata.name, "renamed");
    } finally {
        await f.cleanup();
    }
});
