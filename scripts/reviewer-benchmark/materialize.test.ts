import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineGitFixture } from "../../src/shared/git-test-fixture.ts";
import { getWorktreeReviewDiff } from "../../src/shared/workflow/git-snapshot.ts";
import { loadFixture } from "./fixtures.ts";
import type { VariantId } from "./fixtures.ts";
import { materializeFixture } from "./materialize.ts";
import { corpusPath, publicTree, rawGit, smokeIds, withFixtureCopy } from "./test-fixtures.ts";

for (const id of smokeIds) {
    const baseline = defineGitFixture(async (cwd) => {
        await cp(join(corpusPath, id, "source"), cwd, { recursive: true });
        await rawGit(cwd, ["add", "."]);
        await rawGit(cwd, ["commit", "-m", "Independent baseline"]);
    });
    for (const variant of (id === "RV-M01" ? ["A"] : ["A", "B"]) as VariantId[]) {
        test(`${id} ${variant} exposes only the selected public tree and production diff`, async () => {
            const fixture = await loadFixture(join(corpusPath, id));
            const expected = await baseline.checkout();
            const project = await materializeFixture(fixture, variant);
            try {
                const patch = await readFile(join(fixture.packageDir, fixture.oracle.variants[variant]!.patch), "utf8");
                await rawGit(expected, ["apply", "-"], patch);
                await rawGit(expected, ["add", "-N", "."]);
                assert.equal(
                    project.diffText,
                    await rawGit(expected, ["diff", "--no-ext-diff", "--no-color", "main", "--"]),
                );
                assert.deepEqual(await publicTree(project.cwd), await publicTree(expected));
                assert.equal(project.planContent, await readFile(join(expected, fixture.manifest.planPath), "utf8"));
                assert.match(basename(project.cwd), /^project-/);
                const checkout = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
                const location = relative(checkout, await realpath(project.cwd));
                assert.ok(isAbsolute(location) || location === ".." || location.startsWith(`..${sep}`));
                const publicFiles = JSON.stringify(await publicTree(project.cwd));
                for (const marker of Object.values(fixture.oracle.proofs).map((proof) => proof.expectedFailureMarker)) {
                    assert.equal(publicFiles.includes(marker), false);
                }
                assert.equal(/evaluation|\.verification|oracle\.yaml|defective|clean\.patch/.test(publicFiles), false);
                assert.equal(await rawGit(project.cwd, ["branch", "--format=%(refname:short)"]), "change\nmain\n");
                assert.equal(await rawGit(project.cwd, ["log", "--all", "--format=%s"]), "Initial project\n");
                assert.equal(
                    await rawGit(project.cwd, ["log", "--all", "--format=%an <%ae>"]),
                    "Developer <developer@example.test>\n",
                );
                assert.equal((await rawGit(project.cwd, ["config", "--local", "--list"])).includes(corpusPath), false);
                await mkdir(join(project.cwd, ".wld"));
                await writeFile(join(project.cwd, ".wld/settings.json"), '{"workflowMetrics":true}\n');
                assert.equal(await getWorktreeReviewDiff(project.cwd, "main"), project.diffText);
            } finally {
                await project.cleanup();
                await rm(expected, { recursive: true, force: true });
            }
            assert.equal(existsSync(project.cwd), false);
            await project.cleanup();
        });
    }
}

test("new regular files appear in the complete diff, not only tracked-file edits", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        const path = join(packageDir, "variants/clean.patch");
        const extra =
            "diff --git a/src/note.ts b/src/note.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/note.ts\n@@ -0,0 +1 @@\n+export const note = 1;\n";
        await writeFile(path, (await readFile(path, "utf8")) + extra);
        const project = await materializeFixture(await loadFixture(packageDir), "B");
        try {
            assert.match(project.diffText, /new file mode 100644/);
            assert.match(project.diffText, /\+export const note = 1;/);
            assert.equal(
                project.diffText,
                await rawGit(project.cwd, ["diff", "--no-ext-diff", "--no-color", "main", "--"]),
            );
            assert.match(await rawGit(project.cwd, ["ls-files"]), /src\/note.ts/);
        } finally {
            await project.cleanup();
        }
    });
});

test("a non-applicable patch removes its incomplete project", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        const path = join(packageDir, "variants/clean.patch");
        await writeFile(
            path,
            (await readFile(path, "utf8")).replace("@@", "@@ -999,1 +999,1 @@\n-missing\n+replacement\n@@"),
        );
        const fixture = await loadFixture(packageDir);
        const before = (await readdir(tmpdir())).filter((name) => name.startsWith("project-"));
        await assert.rejects(materializeFixture(fixture, "B"), /Fixture Git operation failed/);
        assert.deepEqual(
            (await readdir(tmpdir())).filter((name) => name.startsWith("project-")),
            before,
        );
    });
});
