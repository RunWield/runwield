import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { publicationFixture } from "./testing/package-publication-fixture.ts";
import { read } from "../testing/plan-package-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { setExactProjectCustomSetting } from "../settings.js";
import { recordPlanEvent } from "./plan-lifecycle.js";
import { loadPublicationAttempt } from "./publication-machine.ts";
import { readPlanPackage, readPlanPackagePublication } from "../plan-package-store.ts";
import { readPublishedDeliverySources } from "../work-records/published-source.ts";

for (const boundary of ["artifact_effect", "copy_write"]) {
    test(`validation restart reconciles ${boundary} before deciding whether code changed`, async () => {
        const f = await publicationFixture(true);
        try {
            setExactProjectCustomSetting("verification_command", "false", f.root);
            setExactProjectCustomSetting("codereview", "none", f.root);
            const stopped = await f.drive(boundary);
            equal(stopped.code, 86, stopped.text);
            const attempt = await loadPublicationAttempt(f.root, f.workflow.worktreeId!);
            ok(attempt?.packageInput);
            equal(attempt.phase, "candidate_sealed");
            equal(attempt.artifactCommit, undefined);
            const copiesCommit = await git(f.workflow.executionCwd!, ["rev-parse", "HEAD"]);
            await fs.writeFile(join(f.p.path, "context.md"), "# Keep concurrent editor work\n");
            const resumed = await f.drive(undefined, "validate");
            equal(resumed.code, 0, resumed.text);
            const receipt = (await read(f.identity)).metadata.workflow!.delivery!;
            equal(receipt.source.inputId, attempt.packageInput.inputId);
            equal(receipt.validatedCommit, attempt.validatedCommit);
            equal(await git(f.remote, ["show", "main:docs/plans/one/context.md"]), "# A Plan\n\nProse — 世界");
            await git(f.remote, ["merge-base", "--is-ancestor", copiesCommit, "main"]);
            equal(
                (await git(f.remote, ["log", "--format=%B", "main"])).split("RunWield-Publication-Attempt:").length - 1,
                1,
            );
            equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Keep concurrent editor work\n");
        } finally {
            await f.cleanup();
        }
    });
}

for (const scenario of ["parent_completion", "package_settlement", "reopened"] as const) {
    test(`last-child validation recovers ${scenario} and retains its terminal recording owner`, async () => {
        const f = await publicationFixture(false, [], "last-child");
        try {
            setExactProjectCustomSetting("codereview", "none", f.root);
            const before = await readPlanPackage(f.identity, { planId: "parent" });
            ok(before.kind === "loaded");
            equal(before.metadata.definition.status, "ready_for_work");
            const interrupted = await f.drive(scenario === "reopened" ? "package_settlement" : scenario, "validate");
            equal(interrupted.code, 86, interrupted.text);
            const parentAfterStop = await readPlanPackage(f.identity, { planId: "parent" });
            ok(parentAfterStop.kind === "loaded");
            if (scenario === "reopened") {
                await f.scope(() =>
                    recordPlanEvent({
                        cwd: f.root,
                        planName: "parent",
                        event: "review_reopened",
                        currentStatus: "reviewed",
                    }),
                );
                await fs.writeFile(join(parentAfterStop.path, "context.md"), "# New parent editor work\n");
            }
            const result = await f.drive(undefined, "validate");
            equal(result.code, 0, result.text);
            const receipt = (await read(f.identity)).metadata.workflow!.delivery!;
            const retained = await readPlanPackagePublication(f.identity, receipt.source);
            const parent = retained.members.find((member) => member.metadata.planId === "parent")!;
            equal(parent.metadata.definition.epicCompletionMode, "done_enough");
            ok(parent.metadata.definition.epicDoneEnoughAt);
            const sources = await readPublishedDeliverySources(f.root, {
                planName: "one",
                planId: "plan-one",
                phase: "cleanup_complete",
                packageInput: receipt.source,
            });
            equal(sources.delivered.attrs.status, "verified");
            equal(sources.workRecordOwner?.planId, "parent");
            equal(sources.workRecordOwner?.attrs.status, "verified");
            equal(sources.workRecordOwner?.body, "# Delivered Epic context\n");
            const settledParent = await readPlanPackage(f.identity, { planId: "parent" });
            ok(settledParent.kind === "loaded");
            equal(settledParent.metadata.definition.status, scenario === "reopened" ? "draft" : "verified");
            equal(
                await fs.readFile(join(settledParent.path, "context.md"), "utf8"),
                scenario === "reopened" ? "# New parent editor work\n" : "# Delivered Epic context\n",
            );
        } finally {
            await f.cleanup();
        }
    });
}

for (const scenario of ["untracked", "staged", "prior-copy"] as const) {
    test(`changed code retires partial copy writes, ${scenario}`, async () => {
        const f = await publicationFixture(true);
        try {
            if (scenario === "prior-copy") {
                const first = await f.drive();
                equal(first.code, 0, first.text);
                await f.implementNext("# Updated retained Plan\n");
            }
            equal((await f.drive("copy_write")).code, 86);
            await fs.writeFile(join(f.workflow.executionCwd!, "code.txt"), "changed implementation\n");
            if (scenario === "staged") await git(f.workflow.executionCwd!, ["add", "docs/plans/one/context.md"]);
            const reset = await f.drive(undefined, "revalidate");
            equal(reset.code, 0, reset.text);
            equal((await read(f.identity)).metadata.definition.status, "implemented");
            equal(await fs.readFile(join(f.workflow.executionCwd!, "code.txt"), "utf8"), "changed implementation\n");
            equal(
                await fs
                    .readFile(join(f.workflow.executionCwd!, "docs/plans/one/context.md"), "utf8")
                    .catch(() => null),
                scenario === "prior-copy" ? "# A Plan\n\nProse — 世界\n" : null,
            );
            equal(await git(f.workflow.executionCwd!, ["diff", "--cached", "--name-only"]), "");
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
            const delivered = await f.drive();
            equal(delivered.code, 0, delivered.text);
            equal(await git(f.remote, ["show", "main:code.txt"]), "changed implementation");
            equal(
                (await git(f.remote, ["log", "--format=%B", "main"])).split("RunWield-Publication-Attempt:").length - 1,
                scenario === "prior-copy" ? 2 : 1,
            );
        } finally {
            await f.cleanup();
        }
    });
}

test("revalidation preserves edited partial copies until exact frozen bytes are restored", async () => {
    const f = await publicationFixture(true);
    try {
        equal((await f.drive("copy_write")).code, 86);
        const path = join(f.workflow.executionCwd!, "docs/plans/one/context.md");
        await fs.writeFile(path, "# Editor owns these bytes\n");
        await fs.writeFile(join(f.workflow.executionCwd!, "code.txt"), "changed implementation\n");
        const refused = await f.drive(undefined, "revalidate");
        ok(refused.code !== 0, refused.text);
        ok(refused.text.includes("Edited delivery copies are preserved"), refused.text);
        equal(await fs.readFile(path, "utf8"), "# Editor owns these bytes\n");
        equal((await read(f.identity)).metadata.definition.status, "reviewed");
        await fs.writeFile(path, "# A Plan\n\nProse — 世界\n");
        const restored = await f.drive(undefined, "revalidate");
        equal(restored.code, 0, restored.text);
        equal(await fs.readFile(path, "utf8").catch(() => null), null);
        equal(await fs.readFile(join(f.workflow.executionCwd!, "code.txt"), "utf8"), "changed implementation\n");
        equal((await read(f.identity)).metadata.definition.status, "implemented");
    } finally {
        await f.cleanup();
    }
});
