import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { create, read, driver, packageFixture, documents, tree } from "./shared/testing/plan-package-fixture.ts";
import { PlanPackageError } from "@runwield/plans/file-snapshots";
import { capturePlanPackageInput, readPlanPackageInput, recoverPlanPackages } from "./plan-store/packages.ts";

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
        await rejects(
            () => readPlanPackageInput(f.identity, reference),
            (error) => error instanceof PlanPackageError && error.kind === "malformed_metadata",
        );
        await fs.unlink(path);
        await rejects(
            () => readPlanPackageInput(f.identity, reference),
            (error) => error instanceof PlanPackageError && error.kind === "missing_document",
        );
    } finally {
        await f.cleanup();
    }
});

test("the retained-input reader accepts existing version-one files and rejects conflicting ownership or roles", async () => {
    const f = await packageFixture();
    try {
        const plan = await create(f.identity);
        const reference = {
            projectId: f.identity.projectId,
            planId: plan.metadata.planId,
            inputId: "5b46ab77-d829-4308-83e5-d4f2832d8fec",
        };
        const path = join(
            f.identity.executionAccountHome,
            ".wld",
            "projects",
            reference.projectId,
            "internal",
            "plan-packages",
            "inputs",
            reference.inputId,
        );
        await fs.mkdir(path, { recursive: true });
        // These version-one entries were written before the driver extraction.
        const historical = [
            {
                name: "context.md",
                role: "context",
                hash: "fc1282e6a6e19211743e5cb872d93b0bac9ebd5db4217837da9becd826d0ef41",
                bytes: new TextEncoder().encode("# Old plan\n"),
            },
            {
                name: "validation.md",
                role: "validation",
                hash: "45e7adff9441ea508b58f189000d8470c394f7cf1283e10db3292bd1b1613db7",
                bytes: new TextEncoder().encode("# Old check\n"),
            },
        ];
        for (const document of historical) await fs.writeFile(join(path, document.name), document.bytes);
        const manifest = {
            version: 1,
            ...reference,
            metadataRevision: 1,
            documents: historical.map(({ name, role, hash }) => ({ name, role, hash })),
        };
        const manifestPath = join(path, "input.wld.json");
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        const before = await tree(path);
        const frozen = await readPlanPackageInput(f.identity, reference);
        equal(frozen.path, path);
        deepEqual(frozen.manifest, manifest);
        deepEqual(
            frozen.documents.map((item) => ({ ...item, bytes: new Uint8Array(item.bytes) })),
            historical,
        );
        deepEqual(await tree(path), before);
        await rejects(
            () => readPlanPackageInput(f.identity, { ...reference, projectId: "another-project" }),
            (error) => error instanceof PlanPackageError && error.kind === "unsafe_path",
        );
        await rejects(
            () => readPlanPackageInput(f.identity, { ...reference, planId: "another-plan" }),
            (error) => error instanceof PlanPackageError && error.kind === "malformed_metadata",
        );
        manifest.documents[0].role = "validation";
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await rejects(
            () => readPlanPackageInput(f.identity, reference),
            (error) => error instanceof PlanPackageError && error.kind === "malformed_metadata",
        );
        manifest.documents[0].role = "context";
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        const context = join(path, "context.md");
        await fs.unlink(context);
        await fs.symlink(join(plan.path, "context.md"), context);
        await rejects(
            () => readPlanPackageInput(f.identity, reference),
            (error) => error instanceof PlanPackageError && error.kind === "unsafe_path",
        );
    } finally {
        await f.cleanup();
    }
});
