import { equal, ok } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { publicationFixture } from "./package-publication-fixture.ts";
import { read } from "../../testing/plan-package-fixture.ts";
import { inspectWorktreeRegistry } from "../../worktree-registry.js";
import { git } from "../../git-test-fixture.ts";
import { readPlanPackagePublication } from "../../plan-package-store.ts";
import { loadPublishedWorkRecordSource } from "../../work-records/published-source.ts";

export const publicationBoundaries = [
    "retained_input",
    "input_reference",
    "candidate_receipt",
    "artifact_effect",
    "artifact_receipt",
    "integration_effect",
    "integration_receipt",
    "target_effect",
    "target_receipt",
    "verification_receipt",
    "package_settlement",
    "registry_pruned",
];
export async function resumePublicationBoundary(copies: boolean, boundary: string): Promise<void> {
    const f = await publicationFixture(copies);
    try {
        const stopped = await f.drive(boundary);
        equal(stopped.code, 86, stopped.text);
        const targetAtStop = await git(f.remote, ["rev-parse", "main"]);
        await fs.writeFile(join(f.p.path, "context.md"), "# Concurrent editor prose\n");
        const continued = await f.drive();
        equal(continued.code, 0, continued.text);
        const current = await read(f.identity);
        equal(current.metadata.definition.status, "verified");
        equal(current.metadata.workflow?.attempt, undefined);
        const receipt = current.metadata.workflow!.delivery!;
        ok(receipt);
        const manifest = await readPlanPackagePublication(f.identity, receipt.source);
        equal(manifest.planCopies, copies);
        equal((await inspectWorktreeRegistry(f.root)).entries.length, 0);
        equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Concurrent editor prose\n");
        equal(await git(f.remote, ["show", "main:code.txt"]), "code");
        const history = await git(f.remote, ["log", "--format=%B", "main"]);
        equal(history.split("RunWield-Publication-Attempt:").length - 1, copies ? 1 : 0);
        if (
            [
                "target_effect",
                "target_receipt",
                "verification_receipt",
                "package_settlement",
                "registry_pruned",
            ].includes(boundary)
        )
            equal(await git(f.remote, ["rev-parse", "main"]), targetAtStop);
        await f.scope(async () => {
            const source = await loadPublishedWorkRecordSource(f.root, "one");
            equal(source?.body, "# A Plan\n\nProse — 世界\n");
        });
    } finally {
        await f.cleanup();
    }
}
