import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { publicationFixture } from "../workflow/testing/package-publication-fixture.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { git } from "../git-test-fixture.ts";
import { read } from "../testing/plan-package-fixture.ts";
import { renamePlanPackage, readPlanPackage } from "../plan-package-store.ts";
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
            const getSource = async (): Promise<WorkRecordSource> => {
                const result = await captureForegroundProcess(process.execPath, {
                    cwd: f.root,
                    args: [
                        new URL("../workflow/testing/package-source-process.ts", import.meta.url).pathname,
                        JSON.stringify(f.config.packageSelection),
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
            // An external Recorder failure cannot revoke delivery or consume its source.
            await rejects(async () => {
                await getSource();
                throw new Error("Recorder service unavailable");
            }, /Recorder service/);
            equal((await getSource()).body, source.body);
            equal((await read(f.identity)).metadata.definition.status, "verified");
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
