import { planFixtureControllerPath } from "./shared/testing/plan-state-fixture.ts";
import { seedPlanController } from "./shared/testing/plan-state-fixture.ts";
import { withRetainedCheckoutSource } from "./plan-store/retained-source.ts";
import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { packageFixture, read, tree, driver } from "./shared/testing/plan-package-fixture.ts";
import {
    importPlanPackages,
    listPlanPackages,
    readPlanImportEvidence,
    renamePlanPackage,
    savePlanPackageDocument,
} from "./plan-store/packages.ts";
import { archivePlan } from "./plan-store/index.ts";
import { git } from "./shared/git-test-fixture.ts";
import { enterProjectRuntime } from "./shared/project-runtime-layout.ts";
import { addEntry, getWorktreeRegistryPath, updateEntry } from "./shared/worktree-registry.js";

import { createPublicationAttempt } from "./shared/workflow/publication-attempt.ts";
import { validationCheckpointCanResume, type ValidationCheckpoint } from "./shared/workflow/validation-checkpoint.ts";
import { hasApplicablePublicationReceipt } from "./shared/workflow/publication-receipt.ts";

const markdown = (body: string, fields = "") =>
    `---\nplanId: active-plan\nclassification: PLANNED_CHANGE\nstatus: implemented\ncreatedAt: '2020-01-01'\n${fields}---\n${body}`;
async function write(root: string, name: string, content: string) {
    const path = join(root, "docs/plans", `${name}.md`);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content);
    return path;
}
async function execution(status: "active" | "planning" = "active") {
    const f = await packageFixture();
    const source = await write(f.root, "active", markdown("# Stale primary\n"));
    await git(f.root, ["add", "docs"]);
    await git(f.root, ["commit", "-m", "source fixture"]);
    const commit = await git(f.root, ["rev-parse", "HEAD"]);
    const path = join(f.root, "execution");
    await git(f.root, ["worktree", "add", "-b", "execution", path]);
    await write(path, "active", markdown("# Current execution\n", "sessionIds: [session-recorded]\n"));
    const entry = {
        id: "attempt",
        planName: "active",
        planId: "active-plan",
        baseBranch: "main",
        baseRef: "main",
        baseCommit: commit,
        branch: "execution",
        path,
        status,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
    };
    await addEntry(f.root, entry);
    return { ...f, source, path, commit, entry };
}

for (const status of ["planning", "active"] as const)
    test(`import uses registered ${status} prose and retains resolvable controller/checkpoint continuation`, async () => {
        const f = await execution(status);
        try {
            const checkpoint: ValidationCheckpoint = {
                version: 1,
                attemptId: "attempt",
                generation: "generation",
                expectedStatus: "implemented",
                nextPhase: "mechanical",
                state: "awaiting_repair",
                updatedAt: "2026-01-01",
                repairKind: "validation",
                repairGeneration: "repair-one",
                pendingRepair: {
                    kind: "repair",
                    identity: { attemptId: "attempt", generation: "generation", repairGeneration: "repair-one" },
                    repairGeneration: "repair-one",
                    prompt: "Repair",
                    cwd: f.path,
                    role: "engineer",
                },
                hostReview: { semanticRound: 2, correctionCount: 1 },
                hostRecorder: {
                    recordId: "record",
                    invalidSubmissions: 1,
                    request: {
                        kind: "recorder",
                        identity: { attemptId: "attempt", generation: "generation" },
                        cwd: f.path,
                        prompt: "Record",
                    },
                },
            };
            const controller = await seedPlanController(
                f.root,
                { planId: "active-plan", planName: "active" },
                {
                    validationCheckpoint: checkpoint,
                    recordingSource: { commit: f.commit, planName: "active", planId: "active-plan" },
                    publicationReceipt: { validatedCommit: f.commit, publishedCommit: f.commit, targetBranch: "main" },
                },
            );
            const registryBefore = await fs.readFile(getWorktreeRegistryPath(f.root), "utf8");
            const controllerBefore = await fs.readFile(
                planFixtureControllerPath(f.root, { planId: "active-plan", planName: "active" }),
                "utf8",
            );
            const result = await importPlanPackages(f.identity, f.source);
            equal(result.kind, "committed", JSON.stringify(result));
            const p = await read(f.identity, "active-plan");
            equal(Buffer.from(p.documents[0].bytes).toString(), "# Current execution\n");
            equal(p.metadata.definition.status, "implemented");
            deepEqual(p.metadata.controller, {});
            deepEqual(p.metadata.references.sessionIds, ["session-recorded"]);
            const evidence = await readPlanImportEvidence(f.identity, p.metadata.references.legacyImport!);
            equal(evidence.authorityKind, "registered");
            deepEqual(evidence.controller, controller);
            deepEqual(evidence.attempts, [f.entry]);
            ok(
                validationCheckpointCanResume(
                    evidence.controller!.state.validationCheckpoint!,
                    "attempt",
                    "implemented",
                ),
            );
            equal(
                validationCheckpointCanResume(
                    evidence.controller!.state.validationCheckpoint!,
                    "other-attempt",
                    "implemented",
                ),
                false,
            );
            equal(
                hasApplicablePublicationReceipt({
                    publicationReceipt: evidence.controller!.state.publicationReceipt,
                    targetBranch: "other-target",
                }),
                false,
            );
            equal(await fs.readFile(getWorktreeRegistryPath(f.root), "utf8"), registryBefore);
            equal(
                await fs.readFile(
                    planFixtureControllerPath(f.root, { planId: "active-plan", planName: "active" }),
                    "utf8",
                ),
                controllerBefore,
            );
            const restarted = await driver({ identity: f.identity, command: "evidence", planId: "active-plan" });
            equal(restarted.code, 0, restarted.errors);
            ok(restarted.output.includes('"repairGeneration":"repair-one"'));
            ok(restarted.output.includes('"recordId":"record"'));
        } finally {
            await f.cleanup();
        }
    });

for (const status of ["planning", "active"] as const)
    test(`registered ${status} worktree root import attaches Epic resources and preserves renamed repeats`, async () => {
        const f = await execution(status);
        try {
            await write(
                f.path,
                "active",
                markdown("# Current Epic\n").replace("classification: PLANNED_CHANGE", "classification: PROJECT"),
            );
            await write(f.path, "active/manual-qa", "# Original QA\n");
            await write(f.path, "active/integration-report", "# Original report\n");
            const sources = await tree(f.path);
            const registry = await fs.readFile(getWorktreeRegistryPath(f.root), "utf8");
            const imported = await importPlanPackages(f.identity, f.path);
            equal(imported.kind, "committed", JSON.stringify(imported));
            const p = await read(f.identity, "active-plan");
            equal(p.metadata.name, "active");
            equal(p.metadata.definition.classification, "PROJECT");
            deepEqual(
                p.documents.map((document) => [document.name, Buffer.from(document.bytes).toString()]),
                [
                    ["context.md", "# Current Epic\n"],
                    ["validation.md", "Use the verification instructions in context.md.\n"],
                    ["manual-qa.md", "# Original QA\n"],
                    ["integration-report.md", "# Original report\n"],
                ],
            );
            deepEqual((await listPlanPackages(f.identity)).packages.map((item) => item.metadata.name).sort(), [
                "README",
                "active",
            ]);
            deepEqual(await tree(f.path), sources);

            await renamePlanPackage(f.identity, "active-plan", p.metadata.revision, "renamed-epic");
            const qa = p.documents.find((document) => document.name === "manual-qa.md")!;
            await savePlanPackageDocument(f.identity, "active-plan", "manual-qa.md", qa.hash, "# Edited QA\n");
            await write(f.path, "active/integration-report", "# Changed source report\n");
            const beforeRepeat = await read(f.identity, "active-plan");
            const repeated = await driver({ identity: f.identity, command: "import", selection: f.path });
            equal(repeated.code, 0, repeated.errors);
            ok(repeated.output.includes('"kind":"existing"'), repeated.output);
            deepEqual(await read(f.identity, "active-plan"), beforeRepeat);
            equal(await fs.readFile(getWorktreeRegistryPath(f.root), "utf8"), registry);
        } finally {
            await f.cleanup();
        }
    });

test("sealed publication evidence and repair content remain byte-for-byte unchanged", async () => {
    const f = await execution();
    try {
        // Replace the same registry entry via its owner with a real sealed attempt.
        const { updatePublication } = await import("./shared/worktree-registry.js");
        const repair = join(f.root, "publication");
        await fs.mkdir(repair);
        await fs.writeFile(join(repair, "repair.txt"), "preserve repair");
        const publication = createPublicationAttempt({
            attemptId: "attempt",
            planId: "active-plan",
            planName: "active",
            targetBranch: "main",
            executionBranch: "execution",
            executionCwd: f.path,
            publicationRoot: repair,
            validatedCommit: f.commit,
            targetHeadAtSeal: f.commit,
        });
        await updatePublication(f.root, "attempt", null, publication);
        const before = await tree(f.root);
        const registry = await fs.readFile(getWorktreeRegistryPath(f.root), "utf8");
        const refs = await git(f.root, ["show-ref"]);
        const result = await importPlanPackages(f.identity, f.source);
        equal(result.kind, "committed", JSON.stringify(result));
        const p = await read(f.identity, "active-plan");
        const evidence = await readPlanImportEvidence(f.identity, p.metadata.references.legacyImport!);
        deepEqual(evidence.attempts[0].publication, publication);
        equal(evidence.format, "legacy-markdown");
        equal(await fs.readFile(getWorktreeRegistryPath(f.root), "utf8"), registry);
        equal(await git(f.root, ["show-ref"]), refs);
        deepEqual(await tree(f.root), before);
    } finally {
        await f.cleanup();
    }
});

for (const problem of ["missing", "foreign", "corrupt-registry", "duplicate-attempt"] as const)
    test(`${problem} authority refuses import without a stale-primary fallback`, async () => {
        const f = await execution();
        try {
            if (problem === "missing") await fs.rename(f.path, `${f.path}-moved`);
            if (problem === "foreign") {
                await fs.rename(f.path, `${f.path}-moved`);
                await fs.mkdir(f.path);
                await write(f.path, "active", markdown("# Foreign\n"));
            }
            if (problem === "corrupt-registry") await fs.writeFile(getWorktreeRegistryPath(f.root), "{broken");
            if (problem === "duplicate-attempt") {
                const path = getWorktreeRegistryPath(f.root);
                const registry = JSON.parse(await fs.readFile(path, "utf8"));
                registry.entries.push({ ...f.entry, id: "competing" });
                await fs.writeFile(path, JSON.stringify(registry));
            }
            const before = await tree(join(f.root, "docs"));
            const result = await importPlanPackages(f.identity, f.source);
            ok(["pending", "unavailable"].includes(result.kind), JSON.stringify(result));
            equal((await listPlanPackages(f.identity)).packages.length, 0);
            deepEqual(await tree(join(f.root, "docs")), before);
        } finally {
            await f.cleanup();
        }
    });

for (const changed of ["source", "controller", "registry"] as const)
    test(`${changed} changes during capture invalidate import before publication`, async () => {
        const f = await execution();
        try {
            const controller = await seedPlanController(
                f.root,
                { planId: "active-plan", planName: "active" },
                { failureReason: "original" },
            );
            const controllerPath = planFixtureControllerPath(f.root, { planId: "active-plan", planName: "active" });
            const registryPath = getWorktreeRegistryPath(f.root);
            const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
            registry.entries[0].updatedAt = "changed";
            const path = changed === "source" ? f.source : changed === "controller" ? controllerPath : registryPath;
            const replacement =
                changed === "source"
                    ? markdown("# Changed source\n")
                    : changed === "controller"
                      ? JSON.stringify({
                            ...controller,
                            revision: controller.revision + 1,
                            state: { failureReason: "changed" },
                        })
                      : JSON.stringify(registry);
            const result = await driver({
                identity: f.identity,
                command: "import",
                selection: f.source,
                mutateEvidencePath: path,
                mutateEvidenceText: replacement,
            });
            equal(result.code, 0, JSON.stringify(result));
            ok(result.output.includes('"kind":"pending"'), result.output);
            equal((await listPlanPackages(f.identity)).packages.length, 0);
            equal((await importPlanPackages(f.identity, f.source)).kind, "committed");
        } finally {
            await f.cleanup();
        }
    });

test("same-ID repeats after package edits or source edits never rewrite live metadata or prose", async () => {
    const f = await execution();
    try {
        equal((await importPlanPackages(f.identity, f.source)).kind, "committed");
        const p = await read(f.identity, "active-plan");
        await renamePlanPackage(f.identity, "active-plan", 1, "renamed");
        await savePlanPackageDocument(f.identity, "active-plan", "context.md", p.documents[0].hash, "# Live edit\n");
        await fs.writeFile(f.source, markdown("# Changed original\n"));
        const before = await read(f.identity, "active-plan");
        equal((await importPlanPackages(f.identity, f.source)).kind, "existing");
        deepEqual(await read(f.identity, "active-plan"), before);
    } finally {
        await f.cleanup();
    }
});

test("an explicitly selected target-only child imports its local snapshot without unrelated siblings", async () => {
    const f = await packageFixture();
    try {
        await write(
            f.root,
            "family",
            "---\nplanId: family\nclassification: PROJECT\nstatus: draft\ntargetBranch: epic/family\n---\n# Family\n",
        );
        await git(f.root, ["add", "docs"]);
        await git(f.root, ["commit", "-m", "parent"]);
        const target = join(f.root, "target");
        await git(f.root, ["worktree", "add", "-b", "epic/family", target]);
        await write(
            target,
            "family/selected",
            markdown("# Target only\n", "parentPlan: family\ntargetBranch: epic/family\n"),
        );
        await write(target, "family/other", markdown("# Unrelated\n").replace("active-plan", "unrelated"));
        await git(target, ["add", "docs"]);
        await git(target, ["commit", "-m", "published target documents"]);
        await enterProjectRuntime(f.root);
        const parentResult = await importPlanPackages(f.identity, join(f.root, "docs/plans/family.md"));
        equal(parentResult.kind, "committed", JSON.stringify(parentResult));
        const result = await importPlanPackages(f.identity, join(f.root, "docs/plans/family/selected.md"));
        equal(result.kind, "committed", JSON.stringify(result));
        const p = await read(f.identity, "active-plan");
        equal(Buffer.from(p.documents[0].bytes).toString(), "# Target only\n");
        equal(p.metadata.parentPlanId, "family");
        equal(
            (await readPlanImportEvidence(f.identity, p.metadata.references.legacyImport!)).authorityKind,
            "target-snapshot",
        );
        equal((await listPlanPackages(f.identity)).packages.length, 2);
        equal((await tree(join(f.root, "docs/plans")))["family/selected.md"], undefined);
    } finally {
        await f.cleanup();
    }
});

test("a stale completed primary cannot hide a registered unfinished execution", async () => {
    const f = await execution();
    try {
        await fs.writeFile(f.source, markdown("# Old completion\n").replace("status: implemented", "status: verified"));
        const result = await importPlanPackages(f.identity, f.source);
        equal(result.kind, "committed", JSON.stringify(result));
        const p = await read(f.identity, "active-plan");
        equal(p.metadata.definition.status, "implemented");
        equal(Buffer.from(p.documents[0].bytes).toString(), "# Current execution\n");
    } finally {
        await f.cleanup();
    }
});

test("selected primary and registered worktree copies resolve through one proven authority", async () => {
    const f = await execution();
    try {
        const result = await importPlanPackages(f.identity, f.root);
        equal(result.kind, "committed", JSON.stringify(result));
        const p = await read(f.identity, "active-plan");
        equal(Buffer.from(p.documents[0].bytes).toString(), "# Current execution\n");
        const evidence = await readPlanImportEvidence(f.identity, p.metadata.references.legacyImport!);
        equal(evidence.repositoryRelativePath, "docs/plans/active.md");
        equal(evidence.authority.path, join(f.path, "docs/plans/active.md"));
        equal(
            (await listPlanPackages(f.identity)).packages.filter((p) => p.metadata.planId === "active-plan").length,
            1,
        );
        const repeated = await driver({ identity: f.identity, command: "import", selection: f.root });
        equal(repeated.code, 0, repeated.errors);
        ok(repeated.output.includes('"kind":"existing"'), repeated.output);
        deepEqual(await read(f.identity, "active-plan"), p);
    } finally {
        await f.cleanup();
    }
});

for (const foreignId of [false, true])
    test(`registered archived authority ${foreignId ? "rejects a mismatched identity" : "preserves archive and continuation evidence"}`, async () => {
        const f = await execution();
        try {
            await updateEntry(f.root, "attempt", { status: "completed" });
            await write(
                f.path,
                "active",
                markdown("# Completed execution\n").replace("status: implemented", "status: verified"),
            );
            const archived = await withRetainedCheckoutSource(f.identity, () =>
                archivePlan(f.root, "active", { now: "2026-01-01", reason: "complete" }),
            );
            const controller = await seedPlanController(
                f.root,
                { planId: "active-plan", planName: "active" },
                { publicationReceipt: { validatedCommit: f.commit, publishedCommit: f.commit, targetBranch: "main" } },
            );
            if (foreignId) {
                const bytes = await fs.readFile(archived.toPath, "utf8");
                await fs.writeFile(archived.toPath, bytes.replace("active-plan", "foreign-plan"));
            }
            const sources = await tree(join(f.path, "docs"));
            const registry = await fs.readFile(getWorktreeRegistryPath(f.root), "utf8");
            const result = await importPlanPackages(f.identity, archived.toPath);
            if (foreignId) {
                ok(["pending", "unavailable"].includes(result.kind), JSON.stringify(result));
                equal((await listPlanPackages(f.identity, true)).packages.length, 0);
            } else {
                equal(result.kind, "committed", JSON.stringify(result));
                const p = await read(f.identity, "active-plan");
                equal(p.metadata.name, "active");
                equal(p.metadata.archive?.archivedAt, "2026-01-01");
                equal(p.metadata.archive?.reason, "complete");
                equal(p.metadata.definition.status, "verified");
                equal(Buffer.from(p.documents[0].bytes).toString(), "# Completed execution\n");
                const evidence = await readPlanImportEvidence(f.identity, p.metadata.references.legacyImport!);
                equal(evidence.authority.path, archived.toPath);
                equal(evidence.attempts[0].status, "completed");
                deepEqual(evidence.controller, controller);
                equal((await listPlanPackages(f.identity)).packages.length, 0);
                const repeated = await driver({ identity: f.identity, command: "import", selection: archived.toPath });
                equal(repeated.code, 0, repeated.errors);
                ok(repeated.output.includes('"kind":"existing"'), repeated.output);
                deepEqual(await read(f.identity, "active-plan"), p);
            }
            equal(await fs.readFile(getWorktreeRegistryPath(f.root), "utf8"), registry);
            deepEqual(await tree(join(f.path, "docs")), sources);
        } finally {
            await f.cleanup();
        }
    });
