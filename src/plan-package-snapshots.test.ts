import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { create, read, driver, packageFixture, documents, tree } from "./shared/testing/plan-package-fixture.ts";
import { capturePlanPackageInput, readPlanPackageInput, recoverPlanPackages } from "./plan-store.js";

test("durable capture retains exact bytes, metadata revision, optional membership and explicit Epic resource roles", async () => {
    const f = await packageFixture();
    try {
        const p = await create(f.identity, {
            definition: { classification: "PROJECT", status: "draft" },
            documents: { ...documents, "manual-qa.md": "manual", "integration-report.md": "integration evidence" },
        });
        const reference = await capturePlanPackageInput(f.identity, "plan-one");
        const input = await readPlanPackageInput(f.identity, reference);
        deepEqual(input.documents, p.documents);
        equal(input.manifest.metadataRevision, 1);
        equal(input.documents.find((doc) => doc.name === "integration-report.md")?.role, "integration-report");
        const restarted = await driver({ identity: f.identity, command: "input", inputId: reference.inputId });
        equal(restarted.code, 0, JSON.stringify(restarted));
        for (const doc of p.documents) await fs.writeFile(join(p.path, doc.name), "later edit");
        deepEqual((await readPlanPackageInput(f.identity, reference)).documents, p.documents);
        equal((await read(f.identity)).metadata.revision, 1);
        equal((await read(f.identity)).metadata.definition.status, "draft");
    } finally {
        await f.cleanup();
    }
});

for (const edit of ["context.md", "validation.md", "manual-qa.md"] as const) {
    for (const remove of [false, true])
        test(`capture rejects ${remove ? "removal" : "editing/addition"} of ${edit} between observation and commit`, async () => {
            const f = await packageFixture();
            try {
                await create(f.identity, {
                    documents: {
                        ...documents,
                        ...(edit === "manual-qa.md" && remove ? { "manual-qa.md": "present" } : {}),
                    },
                });
                const result = await driver({ identity: f.identity, command: "capture", edit, remove });
                equal(result.code, 2, JSON.stringify(result));
                ok(result.output.includes("PlanPackageError"));
                const project = join(f.identity.executionAccountHome, ".wld", "projects", f.identity.projectId);
                const inputs = await tree(join(project, "internal", "plan-packages", "inputs"));
                deepEqual(inputs, {});
                await recoverPlanPackages(f.identity);
                deepEqual(await tree(join(project, "internal", "plan-packages", "staging")), {});
            } finally {
                await f.cleanup();
            }
        });
}

for (const boundary of ["staged-input", "published-input"] as const)
    test(`capture interrupted at ${boundary} exposes only complete committed inputs after restart`, async () => {
        const f = await packageFixture();
        try {
            const p = await create(f.identity);
            const result = await driver({ identity: f.identity, command: "capture", boundary });
            equal(result.code, 86, JSON.stringify(result));
            const internal = join(
                f.identity.executionAccountHome,
                ".wld",
                "projects",
                f.identity.projectId,
                "internal",
                "plan-packages",
            );
            const source = join(internal, boundary === "staged-input" ? "staging" : "inputs");
            const inputId = (await fs.readdir(source))[0];
            ok(inputId);
            const reference = { projectId: f.identity.projectId, planId: "plan-one", inputId };
            if (boundary === "staged-input")
                await rejects(() => readPlanPackageInput(f.identity, reference), /missing/);
            else {
                const restarted = await driver({ identity: f.identity, command: "input", inputId });
                equal(restarted.code, 0, JSON.stringify(restarted));
                deepEqual((await readPlanPackageInput(f.identity, reference)).documents, p.documents);
            }
            await recoverPlanPackages(f.identity);
            deepEqual(await tree(join(internal, "staging")), {});
            if (boundary === "published-input")
                deepEqual((await readPlanPackageInput(f.identity, reference)).documents, p.documents);
        } finally {
            await f.cleanup();
        }
    });

test("a damaged retained input never resolves as complete evidence", async () => {
    const f = await packageFixture();
    try {
        await create(f.identity);
        const reference = await capturePlanPackageInput(f.identity, "plan-one");
        const path = join(
            f.identity.executionAccountHome,
            ".wld",
            "projects",
            f.identity.projectId,
            "internal",
            "plan-packages",
            "inputs",
            reference.inputId,
            "validation.md",
        );
        await fs.writeFile(path, "counterfeit");
        await rejects(() => readPlanPackageInput(f.identity, reference), /do not match/);
        await fs.unlink(path);
        await rejects(() => readPlanPackageInput(f.identity, reference), /Missing required/);
    } finally {
        await f.cleanup();
    }
});
