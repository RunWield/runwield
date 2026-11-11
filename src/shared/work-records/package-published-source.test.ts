import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { publicationFixture } from "../workflow/testing/package-publication-fixture.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { git } from "../git-test-fixture.ts";
import { read } from "../testing/plan-package-fixture.ts";
import { renamePlanPackage, readPlanPackage } from "../plan-package-store.ts";
import { recordPlanEvent } from "../workflow/plan-lifecycle.js";
import { loadPublicationAttempt } from "../workflow/publication-machine.ts";
import { readPublishedDeliverySources } from "./published-source.ts";
import type { WorkRecordSource } from "./generation.js";

for (const family of [undefined, "child", "epic"] as const) {
    test(`retained ${family || "Plan"} Recorder source survives cleanup, rename and editor changes`, async () => {
        const f = await publicationFixture(true, [], family);
        try {
            const stopped = await f.drive("candidate_receipt");
            equal(stopped.code, 86, stopped.text);
            const attempt = await loadPublicationAttempt(f.root, f.workflow.worktreeId!);
            ok(attempt);
            const pending = await readPublishedDeliverySources(f.root, attempt);
            equal(pending.delivered.attrs.status, "reviewed");
            equal(pending.delivered.pendingPublication, true);
            const delivered = await f.drive();
            equal(delivered.code, 0, delivered.text);
            await rejects(fs.access(f.workflow.executionCwd!));
            await rejects(fs.access(attempt.publicationRoot));
            await rejects(git(f.root, ["show-ref", "--verify", `refs/heads/${f.workflow.worktreeBranch}`]));
            const copies = `${f.root}-copy-editor`;
            await git(f.root, ["clone", f.remote, copies]);
            try {
                await git(copies, ["rm", "-r", "docs/plans"]);
                await git(copies, [
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.test",
                    "commit",
                    "-m",
                    "remove delivery copies",
                ]);
                await git(copies, ["push", "origin", "main"]);
            } finally {
                await fs.rm(copies, { recursive: true, force: true });
            }
            const current = await read(f.identity);
            await renamePlanPackage(f.identity, current.metadata.planId, current.metadata.revision, "renamed");
            if (family === "child") {
                const parent = await readPlanPackage(f.identity, { planId: "parent" });
                ok(parent.kind === "loaded");
                await renamePlanPackage(f.identity, "parent", parent.metadata.revision, "renamed-parent");
            }
            const renamed = await read(f.identity);
            await fs.writeFile(join(renamed.path, "context.md"), "# Editor changed source after delivery\n");
            const getSource = async (planId = f.config.packageSelection.planId): Promise<WorkRecordSource> => {
                const result = await captureForegroundProcess(process.execPath, {
                    cwd: f.root,
                    args: [
                        new URL("../workflow/testing/package-source-process.ts", import.meta.url).pathname,
                        JSON.stringify({ ...f.config.packageSelection, planId }),
                    ],
                });
                equal(result.code, 0, new TextDecoder().decode(result.stderr));
                return JSON.parse(new TextDecoder().decode(result.stdout));
            };
            const source = await getSource();
            ok(source);
            equal(source.planId, family === "child" ? "parent" : "plan-one");
            equal(source.name, family === "child" ? "renamed-parent" : "renamed");
            equal(source.attrs.status, family === "child" ? "closed_without_verification" : "verified");
            if (family === "child") {
                equal(source.attrs.epicCompletionMode, "done_enough");
                equal(source.attrs.closedWithoutVerificationReason, "Scope accepted");
            }
            equal(source.body, family === "child" ? "# Delivered Epic context\n" : "# A Plan\n\nProse — 世界\n");
            if (family) {
                ok(source.children?.some((child) => child.planId === "sibling"));
                ok(source.children?.some((child) => child.attrs.tickets?.[0].url === "https://example.com/child/2"));
            }
            const receipt = (await read(f.identity)).metadata.workflow!.delivery;
            const record = async (operation: "fail" | "retry", planId = f.config.packageSelection.planId) => {
                const result = await captureForegroundProcess(process.execPath, {
                    cwd: f.root,
                    args: [
                        new URL("../workflow/testing/package-source-process.ts", import.meta.url).pathname,
                        JSON.stringify({ ...f.config.packageSelection, planId }),
                        operation,
                    ],
                });
                equal(result.code, 0, new TextDecoder().decode(result.stderr));
                return JSON.parse(
                    new TextDecoder().decode(result.stdout),
                ) as import("./auto-generation.ts").WorkRecordAutoGenerationResult;
            };
            const failed = await record("fail");
            equal(failed.status, "failed");
            ok(failed.error?.includes("Recorder service unavailable"), JSON.stringify(failed));
            const ownerAfterFailure = await readPlanPackage(f.identity, { planId: source.planId });
            ok(ownerAfterFailure.kind === "loaded");
            equal(ownerAfterFailure.metadata.workflow?.workRecord?.status, "failed");
            deepEqual((await read(f.identity)).metadata.workflow!.delivery, receipt);
            if (family === "epic")
                await f.scope(() =>
                    recordPlanEvent({
                        cwd: f.root,
                        planName: "renamed",
                        event: "review_reopened",
                        currentStatus: "verified",
                    }),
                );
            if (family === "child") {
                await fs.writeFile(
                    join(ownerAfterFailure.path, "context.md"),
                    "# Live parent after failed recording\n",
                );
                const sibling = await readPlanPackage(f.identity, { planId: "sibling" });
                ok(sibling.kind === "loaded");
                await fs.writeFile(join(sibling.path, "context.md"), "# Live sibling after failed recording\n");
                const ownerSource = await getSource(source.planId);
                equal(ownerSource?.body, source.body);
                deepEqual(ownerSource?.children, source.children);
            }
            const retried = await record("retry", source.planId);
            equal(retried.status, "generated", JSON.stringify(retried));
            if (family === "child")
                equal(
                    await fs.readFile(join(ownerAfterFailure.path, "context.md"), "utf8"),
                    "# Live parent after failed recording\n",
                );
            deepEqual((await read(f.identity)).metadata.workflow!.delivery, receipt);
            equal((await getSource()).body, source.body);
            equal((await read(f.identity)).metadata.definition.status, family === "epic" ? "draft" : "verified");
            equal(
                await fs.readFile(join(renamed.path, "context.md"), "utf8"),
                "# Editor changed source after delivery\n",
            );
            await rejects(fs.access(join(f.root, "docs/plans/one.md")));
        } finally {
            await f.cleanup();
        }
    });
}

test("delivered sources remain readable through another execution and publication without completing new work", async () => {
    const f = await publicationFixture(false);
    try {
        equal((await f.drive("candidate_receipt")).code, 86);
        const attempt = await loadPublicationAttempt(f.root, f.workflow.worktreeId!);
        ok(attempt);
        equal((await f.drive()).code, 0);
        const source = async (historical = false): Promise<WorkRecordSource> => {
            const result = await captureForegroundProcess(process.execPath, {
                cwd: f.root,
                args: [
                    new URL("../workflow/testing/package-source-process.ts", import.meta.url).pathname,
                    JSON.stringify(f.config.packageSelection),
                    ...(historical ? ["historical", JSON.stringify({ ...attempt, phase: "cleanup_complete" })] : []),
                ],
            });
            equal(result.code, 0, new TextDecoder().decode(result.stderr));
            return JSON.parse(new TextDecoder().decode(result.stdout));
        };
        await f.implementNext("# New work\n");
        equal((await source()).body, "# A Plan\n\nProse — 世界\n");
        const newExecution = await read(f.identity);
        for (const operation of ["fail", "retry"]) {
            const result = await captureForegroundProcess(process.execPath, {
                cwd: f.root,
                args: [
                    new URL("../workflow/testing/package-source-process.ts", import.meta.url).pathname,
                    JSON.stringify(f.config.packageSelection),
                    operation,
                ],
            });
            equal(result.code, 0, new TextDecoder().decode(result.stderr));
            const outcome = JSON.parse(new TextDecoder().decode(result.stdout));
            equal(outcome.status, operation === "fail" ? "failed" : "generated", JSON.stringify(outcome));
            const current = await read(f.identity);
            deepEqual(current.metadata.definition, newExecution.metadata.definition);
            deepEqual(current.metadata.workflow?.attempt, newExecution.metadata.workflow?.attempt);
            equal(current.metadata.controller.validationPhase, newExecution.metadata.controller.validationPhase);
            equal(await fs.readFile(join(current.path, "context.md"), "utf8"), "# New work\n");
        }
        equal((await read(f.identity)).metadata.definition.status, "reviewed");
        const sealed = await f.drive("candidate_receipt");
        equal(sealed.code, 86, sealed.text);
        equal((await source(true)).attrs.status, "verified");
        const next = await loadPublicationAttempt(f.root, f.workflow.worktreeId!);
        ok(next);
        const pending = await readPublishedDeliverySources(f.root, next);
        equal(pending.delivered.pendingPublication, true);
        equal(pending.delivered.attrs.status, "reviewed");
        equal((await source()).body, "# A Plan\n\nProse — 世界\n");
        const delivered = await f.drive();
        equal(delivered.code, 0, delivered.text);
        equal((await source(true)).body, "# A Plan\n\nProse — 世界\n");
        equal((await source()).body, "# New work\n");
    } finally {
        await f.cleanup();
    }
});

test("recording owner can reuse the delivered child's sealed name without receiving child metadata", async () => {
    const f = await publicationFixture(true, [], "child");
    try {
        const stopped = await f.drive("candidate_receipt");
        equal(stopped.code, 86, stopped.text);
        const sealed = await read(f.identity);
        const reference = sealed.metadata.workflow!.publication!;
        await renamePlanPackage(f.identity, sealed.metadata.planId, sealed.metadata.revision, "renamed");
        const parent = await readPlanPackage(f.identity, { planId: "parent" });
        ok(parent.kind === "loaded");
        await renamePlanPackage(f.identity, "parent", parent.metadata.revision, "one");
        const renamedParent = await readPlanPackage(f.identity, { planId: "parent" });
        ok(renamedParent.kind === "loaded");
        const siblingBefore = await readPlanPackage(f.identity, { planId: "sibling" });
        ok(siblingBefore.kind === "loaded");

        const delivered = await f.drive();
        equal(delivered.code, 0, delivered.text);
        const owner = await readPlanPackage(f.identity, { planId: "parent" });
        ok(owner.kind === "loaded");
        deepEqual(owner.metadata.workflow?.recordingSource, reference);
        deepEqual(owner.metadata.definition, renamedParent.metadata.definition);
        const child = await read(f.identity);
        equal(child.metadata.definition.status, "verified");
        equal(child.metadata.workflow?.recordingSource, undefined);
        equal(child.metadata.workflow?.attempt, undefined);
        deepEqual(child.metadata.workflow?.delivery?.source, reference);
        await rejects(fs.access(f.workflow.executionCwd!));
        equal(await git(f.remote, ["show", "main:docs/plans/one/context.md"]), "# A Plan\n\nProse — 世界");

        const invoke = async (planId: string, operation?: "fail" | "retry") => {
            const result = await captureForegroundProcess(process.execPath, {
                cwd: f.root,
                args: [
                    new URL("../workflow/testing/package-source-process.ts", import.meta.url).pathname,
                    JSON.stringify({ ...f.config.packageSelection, planId }),
                    ...(operation ? [operation] : []),
                ],
            });
            equal(result.code, 0, new TextDecoder().decode(result.stderr));
            return new TextDecoder().decode(result.stdout);
        };
        const source: WorkRecordSource = JSON.parse(await invoke("plan-one"));
        equal(source.planId, "parent");
        equal(source.name, "one");
        equal(source.body, "# Delivered Epic context\n");
        equal(source.children?.find((member) => member.planId === "plan-one")?.body, "# A Plan\n\nProse — 世界\n");
        ok(source.children?.some((member) => member.attrs.tickets?.[0].url === "https://example.com/child/2"));
        deepEqual(JSON.parse(await invoke("parent")), source);
        const failed = JSON.parse(await invoke("plan-one", "fail"));
        equal(failed.status, "failed");
        ok(failed.error?.includes("Recorder service unavailable"), JSON.stringify(failed));
        const failedOwner = await readPlanPackage(f.identity, { planId: "parent" });
        ok(failedOwner.kind === "loaded");
        equal(failedOwner.metadata.workflow?.workRecord?.status, "failed");
        deepEqual((await read(f.identity)).metadata, child.metadata);
        await fs.writeFile(join(owner.path, "context.md"), "# Preserve parent editor text\n");
        const retried = JSON.parse(await invoke("parent", "retry"));
        equal(retried.status, "generated", JSON.stringify(retried));
        const retriedOwner = await readPlanPackage(f.identity, { planId: "parent" });
        ok(retriedOwner.kind === "loaded");
        equal(retriedOwner.metadata.workflow?.workRecord?.status, "generated");
        deepEqual(retriedOwner.metadata.workflow?.recordingSource, reference);
        equal(JSON.parse(await invoke("plan-one")).body, source.body);
        deepEqual((await read(f.identity)).metadata, child.metadata);
        const siblingAfter = await readPlanPackage(f.identity, { planId: "sibling" });
        ok(siblingAfter.kind === "loaded");
        deepEqual(siblingAfter.metadata, siblingBefore.metadata);
        equal(await fs.readFile(join(owner.path, "context.md"), "utf8"), "# Preserve parent editor text\n");
    } finally {
        await f.cleanup();
    }
});
