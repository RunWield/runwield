import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { packageFixture, read, tree, driver, create } from "./shared/testing/plan-package-fixture.ts";
import {
    importPlanPackages,
    listPlanPackages,
    readPlanImportEvidence,
    renamePlanPackage,
    savePlanPackageDocument,
} from "./plan-store/packages.ts";
import { loadPlan, listPlans } from "./plan-store/index.ts";

async function source(root: string, name: string, markdown: string) {
    const path = join(root, "docs", "plans", `${name}.md`);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, markdown);
    return path;
}
const legacy = (id: string, fields = "", body = "\n# Preserved — 世界\r\n\r\n---\r\nyaml: body\r\n") =>
    `---\nplanId: ${id}\nclassification: PLANNED_CHANGE\ncreatedAt: '2020-01-02'\nstatus: draft\n${fields}---\n${body}`;

test("explicit family import preserves metadata, exact bodies, archived relationships and Epic resources", async () => {
    const f = await packageFixture();
    try {
        await source(
            f.root,
            "family",
            legacy("epic", "classification: PROJECT\n").replace("classification: PLANNED_CHANGE\n", ""),
        );
        await source(
            f.root,
            "family/sequence",
            legacy("sequence", "type: sequence\nparentPlan: family\nclassification: PROJECT\n").replace(
                "classification: PLANNED_CHANGE\n",
                "",
            ),
        );
        await source(
            f.root,
            "family/first",
            legacy(
                "first",
                "parentPlan: family\norder: 1\ntickets:\n  - url: https://example.com/ticket/1\n    provider: issue\nsupersedes: [12345678-1234-1234-8234-123456789abc]\nobjectiveChecks: [inert]\ncustomFact: kept\nplanDeviations:\n  - id: change\n    supersededRequirement: old\n    replacementRequirement: new\n    approvedAt: yesterday\n",
            ),
        );
        await source(
            f.root,
            "family/second",
            legacy(
                "second",
                "parentPlan: family\norder: 2\ndependencies: [first, family/sequence, old]\ndeliveryBranch: delivery\nclosedWithoutVerificationReason: accepted\nclosedWithoutVerificationAt: yesterday\nheldAt: yesterday\nholdReason: later\n",
            ),
        );
        await source(
            f.root,
            "archived/family/old",
            legacy(
                "old",
                "parentPlan: family\narchivedAt: yesterday\narchiveReason: complete\narchivedFromPath: family/old\narchivedFromStatus: verified\n",
            ),
        );
        await source(
            f.root,
            "restored",
            legacy(
                "restored",
                "archivedAt: yesterday\narchiveReason: complete\nrestoredAt: today\nrestoredFromPath: archived/restored\n",
            ),
        );
        await source(f.root, "family/manual-qa", "# Manual\n");
        await source(f.root, "family/integration-report", "# Integration\n");
        const before = await tree(join(f.root, "docs"));
        const result = await importPlanPackages(f.identity, join(f.root, "docs/plans"));
        equal(result.kind, "committed", JSON.stringify(result));
        const catalog = await listPlanPackages(f.identity, true);
        equal(catalog.packages.length, 6);
        equal(catalog.issues.length, 0);
        const first = await read(f.identity, "first");
        equal(first.metadata.createdAt, "2020-01-02");
        equal(first.metadata.parentPlanId, "epic");
        equal(first.metadata.definition.tickets?.[0].provider, "issue");
        equal(first.metadata.definition.planDeviations?.[0].replacementRequirement, "new");
        deepEqual(first.metadata.definition.supersedes, ["12345678-1234-1234-8234-123456789abc"]);
        equal(new TextDecoder().decode(first.documents[0].bytes), "\n# Preserved — 世界\r\n\r\n---\r\nyaml: body\r\n");
        ok(new TextDecoder().decode(first.documents[1].bytes).includes("context.md"));
        deepEqual((await read(f.identity, "second")).metadata.dependencyPlanIds, ["first", "sequence", "old"]);
        equal((await read(f.identity, "sequence")).metadata.definition.type, "sequence");
        equal((await read(f.identity, "old")).metadata.name, "family/old");
        equal((await read(f.identity, "old")).metadata.archive?.fromStatus, "verified");
        equal((await listPlanPackages(f.identity)).packages.length, 5);
        equal((await read(f.identity, "epic")).documents.length, 4);
        const evidence = await readPlanImportEvidence(f.identity, first.metadata.references.legacyImport!);
        equal(evidence.legacyFields.customFact, "kept");
        deepEqual(evidence.legacyFields.objectiveChecks, ["inert"]);
        ok(!("objectiveChecks" in first.metadata.definition));
        deepEqual(await tree(join(f.root, "docs")), before);
        const reopened = await driver({ identity: f.identity, command: "read", planId: "second" });
        equal(reopened.code, 0, reopened.errors);
        ok(reopened.output.includes('"dependencyPlanIds":["first","sequence","old"]'));
    } finally {
        await f.cleanup();
    }
});

test("plain Markdown and generic YAML retain complete bytes including BOM and CRLF", async () => {
    const f = await packageFixture();
    try {
        const generic = "\ufeff---\r\ntitle: Generic\r\ntags: [one]\r\n---\r\n\r\n# 世界\r\n";
        await source(f.root, "generic", generic);
        await source(f.root, "plain", "# No metadata\n");
        await source(
            f.root,
            "legacy",
            "\ufeff---\r\nplanId: bom\r\nclassification: FEATURE\r\nstatus: completed\r\n---\r\n\r\n# Exact\r\n",
        );
        const result = await importPlanPackages(f.identity, join(f.root, "docs/plans"));
        equal(result.kind, "committed", JSON.stringify(result));
        const catalog = await listPlanPackages(f.identity);
        equal(
            Buffer.from(catalog.packages.find((p) => p.metadata.name === "generic")!.documents[0].bytes).toString(),
            generic,
        );
        equal(catalog.packages.find((p) => p.metadata.name === "plain")!.metadata.definition.origin, "external");
        const bom = await read(f.identity, "bom");
        equal(bom.metadata.definition.status, "verified");
        equal(Buffer.from(bom.documents[0].bytes).toString(), "\r\n# Exact\r\n");
    } finally {
        await f.cleanup();
    }
});

test("durable ID-less allocation survives restart, overlapping selection, package edits and rename", async () => {
    const f = await packageFixture();
    try {
        const path = await source(f.root, "draft", "# Original\n");
        const first = await importPlanPackages(f.identity, path);
        ok(first.kind === "committed", JSON.stringify(first));
        const id = first.planIds[0];
        const reopened = await driver({ identity: f.identity, command: "import", selection: path });
        equal(reopened.code, 0, reopened.errors);
        ok(reopened.output.includes(`"planIds":["${id}"]`));
        const p = await read(f.identity, id);
        await renamePlanPackage(f.identity, id, 1, "renamed");
        await savePlanPackageDocument(f.identity, id, "context.md", p.documents[0].hash, "# Edited\n");
        const before = await tree(
            join(f.identity.executionAccountHome, ".wld/projects", f.identity.projectId, "plans"),
        );
        equal((await importPlanPackages(f.identity, join(f.root, "docs/plans"))).kind, "existing");
        deepEqual(
            await tree(join(f.identity.executionAccountHome, ".wld/projects", f.identity.projectId, "plans")),
            before,
        );
        await source(f.root, "copy", "# Original\n");
        const copied = await importPlanPackages(f.identity, join(f.root, "docs/plans/copy.md"));
        ok(copied.kind === "committed");
        ok(copied.planIds[0] !== id);
        await fs.writeFile(path, "# Changed\n");
        equal((await importPlanPackages(f.identity, path)).kind, "conflict");
        equal(Buffer.from((await read(f.identity, id)).documents[0].bytes).toString(), "# Edited\n");
    } finally {
        await f.cleanup();
    }
});

for (const [label, bad] of [
    ["unclosed YAML", "---\nplanId: bad\n"],
    ["unknown status", legacy("bad", "").replace("status: draft", "status: pretend")],
    ["invalid Tickets", legacy("bad", "tickets: [dropped]\n")],
    ["unresolved relationship", legacy("bad", "dependencies: [absent]\n")],
    ["unsupported type", legacy("bad", "type: alien\n")],
] as const)
    test(`a batch with ${label} publishes no members and preserves existing packages and sources`, async () => {
        const f = await packageFixture();
        try {
            const existing = await create(f.identity);
            await source(f.root, "good", legacy("good"));
            await source(f.root, "bad", bad);
            const before = await tree(join(f.root, "docs"));
            const result = await importPlanPackages(f.identity, join(f.root, "docs/plans"));
            ok(!["committed", "existing"].includes(result.kind), JSON.stringify(result));
            equal((await listPlanPackages(f.identity)).packages.length, 1);
            deepEqual((await read(f.identity)).metadata, existing.metadata);
            deepEqual(await tree(join(f.root, "docs")), before);
        } finally {
            await f.cleanup();
        }
    });

test("duplicate IDs, case collisions, traversal and symlink escapes are explicit refusals", async () => {
    const f = await packageFixture();
    try {
        const one = await source(f.root, "one", legacy("same"));
        await source(f.root, "two", legacy("same"));
        equal((await importPlanPackages(f.identity, join(f.root, "docs/plans"))).kind, "conflict");
        equal((await listPlanPackages(f.identity)).packages.length, 0);
        equal((await importPlanPackages(f.identity, `${f.root}/docs/../docs/plans/one.md`)).kind, "invalid");
        const link = join(f.root, "link.md");
        await fs.symlink(one, link);
        equal((await importPlanPackages(f.identity, link)).kind, "invalid");
        await create(f.identity, { name: "ONE", planId: "another" });
        equal((await importPlanPackages(f.identity, one)).kind, "conflict");
    } finally {
        await f.cleanup();
    }
});

test("explicit import activates home discovery and refuses managed-remote persistence", async () => {
    const f = await packageFixture();
    try {
        const path = await source(f.root, "legacy", legacy("legacy"));
        equal(await loadPlan(f.root, "legacy"), null);
        const before = await fs.readFile(path, "utf8");
        equal(
            (
                await importPlanPackages(
                    { ...f.identity, personalOwner: { kind: "managed-remote", identity: "laptop" } },
                    path,
                )
            ).kind,
            "unavailable",
        );
        equal((await listPlanPackages(f.identity)).packages.length, 0);
        equal((await importPlanPackages(f.identity, path)).kind, "committed");
        equal(await fs.readFile(path, "utf8"), before);
        equal((await loadPlan(f.root, "legacy"))?.attrs.planId, "legacy");
        equal((await listPlans(f.root)).length, 1);
        equal((await tree(join(f.root, ".wld")))["internal/"], undefined);
    } finally {
        await f.cleanup();
    }
});

test("ID-less source changes cannot evade conflict by adding its allocated ID", async () => {
    const f = await packageFixture();
    try {
        const path = await source(f.root, "draft", "# Original\n");
        const result = await importPlanPackages(f.identity, path);
        ok(result.kind === "committed");
        await fs.writeFile(path, legacy(result.planIds[0]));
        equal((await importPlanPackages(f.identity, path)).kind, "conflict");
        equal(Buffer.from((await read(f.identity, result.planIds[0])).documents[0].bytes).toString(), "# Original\n");
    } finally {
        await f.cleanup();
    }
});

test("ambiguous short-name dependencies and duplicate existing IDs refuse the entire selection", async () => {
    const f = await packageFixture();
    try {
        await create(f.identity, { planId: "root-first", name: "first" });
        await source(
            f.root,
            "family",
            legacy("parent", "classification: PROJECT\n").replace("classification: PLANNED_CHANGE\n", ""),
        );
        await source(f.root, "family/first", legacy("child-first", "parentPlan: family\n"));
        await source(f.root, "family/second", legacy("child-second", "parentPlan: family\ndependencies: [first]\n"));
        equal((await importPlanPackages(f.identity, join(f.root, "docs/plans"))).kind, "conflict");
        equal((await listPlanPackages(f.identity)).packages.length, 1);
        const other = join(f.root, "other");
        await fs.mkdir(other);
        await fs.writeFile(join(other, "alias.md"), legacy("root-first"));
        await fs.writeFile(join(other, "conflict.md"), legacy("root-first", "", "# Different\n"));
        equal((await importPlanPackages(f.identity, other)).kind, "conflict");
        equal((await listPlanPackages(f.identity)).packages.length, 1);
    } finally {
        await f.cleanup();
    }
});

for (const id of ["../../escape", "package-import"])
    test(`opaque ID ${id} cannot become a path or collide with a catalog lock`, async () => {
        const f = await packageFixture();
        try {
            const path = await source(f.root, "safe", legacy(id));
            const result = await importPlanPackages(f.identity, path);
            equal(result.kind, "committed", JSON.stringify(result));
            equal((await read(f.identity, id)).metadata.planId, id);
            const internal = await tree(
                join(f.identity.executionAccountHome, ".wld/projects", f.identity.projectId, "internal/plan-packages"),
            );
            ok(!Object.keys(internal).some((path) => path.startsWith("escape")));
        } finally {
            await f.cleanup();
        }
    });

test("later child imports resolve original parent names after the package is renamed", async () => {
    const f = await packageFixture();
    try {
        const parent = await source(
            f.root,
            "family",
            legacy("parent", "classification: PROJECT\n").replace("classification: PLANNED_CHANGE\n", ""),
        );
        equal((await importPlanPackages(f.identity, parent)).kind, "committed");
        await renamePlanPackage(f.identity, "parent", 1, "renamed-family");
        const child = await source(f.root, "family/child", legacy("child", "parentPlan: family\n"));
        const result = await importPlanPackages(f.identity, child);
        equal(result.kind, "committed", JSON.stringify(result));
        equal((await read(f.identity, "child")).metadata.parentPlanId, "parent");
        equal((await read(f.identity, "parent")).metadata.name, "renamed-family");
    } finally {
        await f.cleanup();
    }
});

test("conflicting directory casing refuses the whole import before publishing a family", async () => {
    const f = await packageFixture();
    try {
        const existing = await create(f.identity);
        await source(f.root, "Family", legacy("parent"));
        await source(f.root, "family/child", legacy("child"));
        const before = await tree(join(f.root, "docs"));
        const result = await importPlanPackages(f.identity, join(f.root, "docs/plans"));
        equal(result.kind, "conflict", JSON.stringify(result));
        const catalog = await listPlanPackages(f.identity, true);
        deepEqual(catalog.packages, [existing]);
        deepEqual(catalog.issues, []);
        deepEqual(await tree(join(f.root, "docs")), before);
    } finally {
        await f.cleanup();
    }
});

test("renamed Epic retains resources on repeat folder import", async () => {
    const f = await packageFixture();
    try {
        const markdown = legacy("parent", "classification: PROJECT\n").replace("classification: PLANNED_CHANGE\n", "");
        await source(f.root, "family", markdown);
        await source(f.root, "family/manual-qa", "# Original QA\n");
        await source(f.root, "family/integration-report", "# Original report\n");
        const selection = join(f.root, "docs/plans");
        const initial = await importPlanPackages(f.identity, selection);
        ok(initial.kind === "committed", JSON.stringify(initial));
        const id = initial.planIds[0];
        await renamePlanPackage(f.identity, id, 1, "renamed-family");
        const p = await read(f.identity, id);
        const qa = p.documents.find((document) => document.name === "manual-qa.md")!;
        await savePlanPackageDocument(f.identity, id, "manual-qa.md", qa.hash, "# Edited QA\n");
        await source(f.root, "family/integration-report", "# Changed source report\n");
        const before = await read(f.identity, id);
        const repeated = await driver({ identity: f.identity, command: "import", selection });
        equal(repeated.code, 0, repeated.errors);
        ok(repeated.output.includes('"kind":"existing"'), repeated.output);
        deepEqual(await read(f.identity, id), before);
    } finally {
        await f.cleanup();
    }
});
