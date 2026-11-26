import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertEquals, assertRejects } from "../../test-support/assertions.ts";
import { moveCheckoutEpicArtifacts } from "./artifact-files.ts";

for (const archive of [true, false]) {
    test(`Epic artifact collision rolls back earlier ${archive ? "archive" : "restore"} moves`, async () => {
        const projectRoot = await mkdtemp(join(tmpdir(), "epic-artifacts-"));
        try {
            const activeDir = join(projectRoot, "docs", "plans", "epic");
            const archiveDir = join(projectRoot, "docs", "plans", "archived", "epic");
            const fromDir = archive ? activeDir : archiveDir;
            const toDir = archive ? archiveDir : activeDir;
            const fromQa = join(fromDir, "manual-qa.md");
            const toQa = join(toDir, "manual-qa.md");
            const fromReport = join(fromDir, "integration-report.md");
            const toReport = join(toDir, "integration-report.md");
            await mkdir(fromDir, { recursive: true });
            await mkdir(toDir, { recursive: true });
            await writeFile(fromQa, "checklist");
            await writeFile(fromReport, "source report");
            await writeFile(toReport, "destination report");

            await assertRejects(
                () => moveCheckoutEpicArtifacts(projectRoot, "epic", archive),
                Error,
                "Epic Artifact already exists",
            );

            assertEquals(await readFile(fromQa, "utf8"), "checklist");
            await assertRejects(() => readFile(toQa, "utf8"), Error, "ENOENT");
            assertEquals(await readFile(fromReport, "utf8"), "source report");
            assertEquals(await readFile(toReport, "utf8"), "destination report");
        } finally {
            await rm(projectRoot, { recursive: true });
        }
    });
}
