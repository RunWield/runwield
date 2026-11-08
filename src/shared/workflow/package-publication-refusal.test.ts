import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { publicationFixture } from "./testing/package-publication-fixture.ts";
import { read } from "../testing/plan-package-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { readPlanPackagePublication } from "../plan-package-store.ts";
import { loadPublishedWorkRecordSource } from "../work-records/published-source.ts";

test("corrupt retained input refuses publication, then exact restoration resumes without losing editor bytes", async () => {
    const f = await publicationFixture(true);
    try {
        equal((await f.drive("candidate_receipt")).code, 86);
        const p = await read(f.identity);
        const ref = p.metadata.workflow!.publication!;
        const path = join(
            f.identity.executionAccountHome,
            ".wld/projects",
            f.identity.projectId,
            "internal/plan-packages/publications",
            `${ref.inputId}.json`,
        );
        const original = await fs.readFile(path);
        await fs.writeFile(path, "{}");
        await fs.writeFile(join(f.p.path, "context.md"), "# Keep live edit\n");
        ok((await f.drive()).code !== 0);
        equal((await read(f.identity)).metadata.definition.status, "reviewed");
        ok((await read(f.identity)).metadata.workflow?.attempt);
        await fs.writeFile(path, original);
        const result = await f.drive();
        equal(result.code, 0, result.text);
        equal((await read(f.identity)).metadata.definition.status, "verified");
        equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Keep live edit\n");
    } finally {
        await f.cleanup();
    }
});

for (const interrupted of [false, true]) {
    test(`changed code retires unpublished copies with interrupted receipt ${interrupted}`, async () => {
        const { preparePublicationRevalidation } = await import("./publication-revalidation.ts");
        const { recordPlanEvent } = await import("./plan-lifecycle.js");
        const f = await publicationFixture(true);
        try {
            equal((await f.drive(interrupted ? "artifact_effect" : "artifact_receipt")).code, 86);
            await fs.writeFile(join(f.workflow.executionCwd!, "code.txt"), "revised code\n");
            if (interrupted) {
                await git(f.workflow.executionCwd!, ["add", "code.txt"]);
                await git(f.workflow.executionCwd!, ["commit", "-m", "Changed code after interrupted copies"]);
            }
            await f.scope(async () => {
                ok(await preparePublicationRevalidation(f.root, "one"));
                equal((await read(f.identity)).metadata.definition.status, "implemented");
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "mechanical_validation_passed",
                    currentStatus: "implemented",
                });
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "semantic_review_passed",
                    currentStatus: "implemented",
                });
            });
            const resumed = await f.drive();
            equal(resumed.code, 0, resumed.text);
            equal(await git(f.remote, ["show", "main:code.txt"]), "revised code");
            equal(
                (await git(f.remote, ["log", "--format=%B", "main"])).split("RunWield-Publication-Attempt:").length - 1,
                1,
            );
        } finally {
            await f.cleanup();
        }
    });
}

for (const issue of ["missing-manifest", "foreign-reference", "missing-registry"] as const) {
    test(`${issue} refuses without freeing ownership and exact repair resumes the same attempt`, async () => {
        const { getWorktreeRegistryPath } = await import("../worktree-registry.js");
        const { updatePlanPackageMetadata } = await import("../plan-package-store.ts");
        const f = await publicationFixture(false);
        try {
            equal((await f.drive("candidate_receipt")).code, 86);
            const p = await read(f.identity);
            const source = p.metadata.workflow!.publication!;
            const manifestPath = join(
                f.identity.executionAccountHome,
                ".wld/projects",
                f.identity.projectId,
                "internal/plan-packages/publications",
                `${source.inputId}.json`,
            );
            const registryPath = getWorktreeRegistryPath(f.root);
            const saved = await fs.readFile(issue === "missing-registry" ? registryPath : manifestPath);
            if (issue === "missing-manifest") await fs.unlink(manifestPath);
            if (issue === "missing-registry")
                await fs.writeFile(registryPath, JSON.stringify({ version: 1, entries: [] }));
            if (issue === "foreign-reference") {
                await updatePlanPackageMetadata(f.identity, p.metadata.planId, p.metadata.revision, {
                    workflow: { ...p.metadata.workflow, publication: { ...source, personalOwner: "foreign-owner" } },
                });
            }
            await fs.writeFile(join(f.p.path, "context.md"), "# Editor content survives refusal\n");
            const targetBeforeRefusal = await git(f.remote, ["rev-parse", "main"]);
            const refused = await f.drive();
            ok(refused.code !== 0, refused.text);
            equal(await git(f.remote, ["rev-parse", "main"]), targetBeforeRefusal);
            equal((await read(f.identity)).metadata.definition.status, "reviewed");
            equal((await read(f.identity)).metadata.workflow?.attempt?.attemptId, f.workflow.worktreeId);
            if (issue === "foreign-reference") {
                const current = await read(f.identity);
                await updatePlanPackageMetadata(f.identity, p.metadata.planId, current.metadata.revision, {
                    workflow: { ...current.metadata.workflow, publication: source },
                });
            } else await fs.writeFile(issue === "missing-registry" ? registryPath : manifestPath, saved);
            const restored = await f.drive();
            equal(restored.code, 0, restored.text);
            equal((await read(f.identity)).metadata.definition.status, "verified");
            equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Editor content survives refusal\n");
        } finally {
            await f.cleanup();
        }
    });
}

for (const boundary of ["revalidation_intent", "revalidation_reset"]) {
    test(`rewritten source resumes interrupted ${boundary} without duplicating copies`, async () => {
        const { recordPlanEvent } = await import("./plan-lifecycle.js");
        const f = await publicationFixture(true);
        try {
            equal((await f.drive("artifact_receipt")).code, 86);
            await fs.writeFile(join(f.workflow.executionCwd!, "code.txt"), "rewritten code\n");
            await git(f.workflow.executionCwd!, ["add", "code.txt"]);
            await git(f.workflow.executionCwd!, ["commit", "-m", "Change implementation"]);
            equal((await f.drive(boundary, "revalidate")).code, 86);
            const reset = await f.drive(undefined, "revalidate");
            equal(reset.code, 0, reset.text);
            equal((await read(f.identity)).metadata.definition.status, "implemented");
            await f.scope(async () => {
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "mechanical_validation_passed",
                    currentStatus: "implemented",
                });
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "semantic_review_passed",
                    currentStatus: "implemented",
                });
            });
            const result = await f.drive();
            equal(result.code, 0, result.text);
            equal(await git(f.remote, ["show", "main:code.txt"]), "rewritten code");
            equal(
                (await git(f.remote, ["log", "--format=%B", "main"])).split("RunWield-Publication-Attempt:").length - 1,
                1,
            );
        } finally {
            await f.cleanup();
        }
    });
}

for (const issue of ["upstream-unavailable", "target-rewritten", "target-advanced"] as const) {
    test(`confirmed target proof handles ${issue} and resumes without replay`, async () => {
        const f = await publicationFixture(true);
        try {
            equal((await f.drive("target_receipt")).code, 86);
            const published = await git(f.remote, ["rev-parse", "main"]);
            await fs.writeFile(join(f.p.path, "context.md"), "# Live editor survives proof retry\n");
            if (issue === "upstream-unavailable") await fs.rename(f.remote, `${f.remote}.offline`);
            if (issue === "target-rewritten")
                await git(f.remote, ["update-ref", "refs/heads/main", await git(f.root, ["rev-parse", "main"])]);
            if (issue === "target-advanced") {
                await git(f.root, ["fetch", f.remote, "main"]);
                const next = await git(f.root, [
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.test",
                    "commit-tree",
                    await git(f.remote, ["rev-parse", "main^{tree}"]),
                    "-p",
                    published,
                    "-m",
                    "Later delivery",
                ]);
                await git(f.root, ["push", f.remote, `${next}:refs/heads/main`]);
            } else {
                const targetBeforeRefusal =
                    issue === "target-rewritten" ? await git(f.remote, ["rev-parse", "main"]) : undefined;
                const refused = await f.drive();
                ok(refused.code !== 0, refused.text);
                if (targetBeforeRefusal) equal(await git(f.remote, ["rev-parse", "main"]), targetBeforeRefusal);
                equal((await read(f.identity)).metadata.definition.status, "reviewed");
                ok((await read(f.identity)).metadata.workflow?.attempt);
                if (issue === "upstream-unavailable") await fs.rename(`${f.remote}.offline`, f.remote);
                else await git(f.remote, ["update-ref", "refs/heads/main", published]);
            }
            const target = await git(f.remote, ["rev-parse", "main"]);
            const resumed = await f.drive();
            equal(resumed.code, 0, resumed.text);
            equal(await git(f.remote, ["rev-parse", "main"]), target);
            equal((await read(f.identity)).metadata.workflow?.delivery?.publishedCommit, published);
            equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Live editor survives proof retry\n");
        } finally {
            await fs.rename(`${f.remote}.offline`, f.remote).catch(() => {});
            await f.cleanup();
        }
    });
}

for (const copies of [false, true]) {
    test(`local publication recovers its integration effect with copies ${copies}`, async () => {
        const f = await publicationFixture(copies, [], undefined, true);
        try {
            const stopped = await f.drive("integration_effect");
            equal(stopped.code, 86, stopped.text);
            const target = await git(f.root, ["rev-parse", "main"]);
            const result = await f.drive();
            equal(result.code, 0, result.text);
            equal(await git(f.root, ["rev-parse", "main"]), target);
            equal((await read(f.identity)).metadata.workflow?.delivery?.mode, "local");
            equal((await read(f.identity)).metadata.workflow?.attempt, undefined);
        } finally {
            await f.cleanup();
        }
    });
}

for (const place of ["linked-clone", "foreign-owner"] as const) {
    test(`${place} cannot adopt publication; original owner resumes the same attempt`, async () => {
        const { admitProjectIdentity, inspectProjectIdentity } = await import("../project-identity.ts");
        const f = await publicationFixture(false);
        const clone = `${f.root}-linked`;
        try {
            equal((await f.drive("candidate_receipt")).code, 86);
            const identity = f.config.packageSelection.identity;
            if (place === "linked-clone") {
                await admitProjectIdentity(f.root);
                await git(f.root, ["clone", f.remote, clone]);
                const pending = inspectProjectIdentity(clone);
                ok(pending.kind === "pending");
                const linked = await admitProjectIdentity(clone, {
                    choice: { kind: "link", candidates: pending.candidates, projectId: identity.projectId },
                });
                ok(linked.kind === "existing");
                f.config.projectRoot = clone;
                f.config.packageSelection.identity = linked.identity;
            } else {
                f.config.packageSelection.identity = {
                    ...identity,
                    personalOwner: { ...identity.personalOwner, identity: "foreign-owner" },
                };
            }
            await fs.writeFile(join(f.p.path, "context.md"), "# Keep owner editor bytes\n");
            ok((await f.drive()).code !== 0);
            equal((await read(identity)).metadata.workflow?.attempt?.attemptId, f.workflow.worktreeId);
            equal((await read(identity)).metadata.definition.status, "reviewed");
            f.config.projectRoot = f.root;
            f.config.packageSelection.identity = identity;
            const result = await f.drive();
            equal(result.code, 0, result.text);
            equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Keep owner editor bytes\n");
        } finally {
            await fs.rm(clone, { recursive: true, force: true });
            await f.cleanup();
        }
    });
}

test("stale receipt cannot complete or promote an active attempt; fresh proof settles and reopening invalidates completion", async () => {
    const { rejects } = await import("node:assert/strict");
    const { updatePlanPackageMetadata } = await import("../plan-package-store.ts");
    const { recordPlanEvent } = await import("./plan-lifecycle.js");
    const f = await publicationFixture(false);
    try {
        equal((await f.drive("candidate_receipt")).code, 86);
        const p = await read(f.identity);
        const source = p.metadata.workflow!.publication!;
        const manifest = await readPlanPackagePublication(f.identity, source);
        await updatePlanPackageMetadata(f.identity, p.metadata.planId, p.metadata.revision, {
            workflow: {
                ...p.metadata.workflow,
                delivery: {
                    source,
                    validatedCommit: manifest.validatedCommit,
                    publishedCommit: manifest.validatedCommit,
                    targetBranch: manifest.targetBranch,
                    mode: "remote",
                    verifiedAt: new Date().toISOString(),
                },
            },
        });
        await f.scope(async () => {
            await rejects(
                recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "validation_passed",
                    currentStatus: "reviewed",
                }),
                /historical/,
            );
            await rejects(loadPublishedWorkRecordSource(f.root, "one"), /no matching delivery receipt/);
        });
        const delivered = await f.drive();
        equal(delivered.code, 0, delivered.text);
        await f.scope(async () => {
            await recordPlanEvent({
                cwd: f.root,
                planName: "one",
                event: "review_reopened",
                currentStatus: "verified",
            });
            await rejects(
                recordPlanEvent({ cwd: f.root, planName: "one", event: "validation_passed", currentStatus: "draft" }),
                /historical/,
            );
        });
        equal((await read(f.identity)).metadata.definition.status, "draft");
        ok((await read(f.identity)).metadata.workflow?.delivery?.source);
        const { startActiveExecutionWorkflow, createExecutionStartPorts } = await import("./execution-start.ts");
        const { loadPackageWorkflowPlan } = await import("./package-workflow.ts");
        let nextPath = "";
        try {
            await f.scope(async () => {
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "review_approved",
                    currentStatus: "draft",
                });
                await recordPlanEvent({
                    cwd: f.root,
                    planName: "one",
                    event: "readiness_passed",
                    currentStatus: "approved",
                });
                const next = await startActiveExecutionWorkflow({
                    cwd: f.root,
                    planName: "one",
                    currentStatus: "ready_for_work",
                    triageMeta: (await loadPackageWorkflowPlan("one")).attrs,
                    ports: createExecutionStartPorts(),
                });
                nextPath = next.executionCwd!;
                ok(next.worktreeId !== f.workflow.worktreeId);
                equal((await read(f.identity)).metadata.definition.status, "in_progress");
                await rejects(
                    recordPlanEvent({
                        cwd: f.root,
                        planName: "one",
                        event: "validation_passed",
                        currentStatus: "in_progress",
                    }),
                    /historical/,
                );
            });
        } finally {
            if (nextPath) await git(f.root, ["worktree", "remove", "--force", nextPath]);
        }
    } finally {
        await f.cleanup();
    }
});

test("edited publication copies refuse before push and exact restoration completes the same attempt", async () => {
    const { loadPublicationAttempt } = await import("./publication-machine.ts");
    const f = await publicationFixture(true);
    try {
        equal((await f.drive("integration_effect")).code, 86);
        const attempt = await loadPublicationAttempt(f.root, f.workflow.worktreeId!);
        ok(attempt);
        const original = await git(attempt.publicationRoot, ["rev-parse", "HEAD"]);
        const target = await git(f.remote, ["rev-parse", "main"]);
        await fs.writeFile(join(attempt.publicationRoot, "docs/plans/one/context.md"), "# Tampered publication copy\n");
        await git(attempt.publicationRoot, ["add", "docs/plans/one/context.md"]);
        await git(attempt.publicationRoot, ["commit", "--amend", "--no-edit"]);
        await fs.writeFile(join(f.p.path, "context.md"), "# Live edit during refusal\n");
        const refused = await f.drive();
        ok(refused.code !== 0, refused.text);
        equal(await git(f.remote, ["rev-parse", "main"]), target);
        equal((await read(f.identity)).metadata.definition.status, "reviewed");
        await git(attempt.publicationRoot, ["reset", "--hard", original]);
        const completed = await f.drive();
        equal(completed.code, 0, completed.text);
        equal(await git(f.remote, ["show", "main:docs/plans/one/context.md"]), "# A Plan\n\nProse — 世界");
        equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Live edit during refusal\n");
    } finally {
        await f.cleanup();
    }
});

test("rewritten copyless code requires new validation and seals the new commit", async () => {
    const { recordPlanEvent } = await import("./plan-lifecycle.js");
    const f = await publicationFixture(false);
    try {
        equal((await f.drive("artifact_receipt")).code, 86);
        const previous = (await read(f.identity)).metadata.workflow!.publication!;
        await fs.writeFile(join(f.workflow.executionCwd!, "code.txt"), "amended implementation\n");
        await git(f.workflow.executionCwd!, ["add", "code.txt"]);
        await git(f.workflow.executionCwd!, ["commit", "--amend", "--no-edit"]);
        equal((await f.drive(undefined, "revalidate")).code, 0);
        equal((await read(f.identity)).metadata.definition.status, "implemented");
        ok((await f.drive()).code !== 0);
        await f.scope(async () => {
            await recordPlanEvent({
                cwd: f.root,
                planName: "one",
                event: "mechanical_validation_passed",
                currentStatus: "implemented",
            });
            await recordPlanEvent({
                cwd: f.root,
                planName: "one",
                event: "semantic_review_passed",
                currentStatus: "implemented",
            });
        });
        const completed = await f.drive();
        equal(completed.code, 0, completed.text);
        equal(await git(f.remote, ["show", "main:code.txt"]), "amended implementation");
        ok((await read(f.identity)).metadata.workflow?.delivery?.source.inputId !== previous.inputId);
        equal(
            (await git(f.remote, ["log", "--format=%B", "main"])).split("RunWield-Publication-Attempt:").length - 1,
            0,
        );
    } finally {
        await f.cleanup();
    }
});
