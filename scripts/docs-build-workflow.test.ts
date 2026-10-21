import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { git } from "../src/shared/git-test-fixture.ts";
import { sha256File } from "./build-metadata.ts";
import {
    decoder,
    docsFixture,
    docsStep,
    jobBlock,
    publishedAssets,
    repositoryRoot,
    runShell,
    stepRun,
    write,
} from "./docs-workflow-fixture.ts";

for (const scenario of ["correction", "legacy"]) {
    test(`${scenario} documentation rebuilds the real source with frozen tooling`, async () => {
        const f = await docsFixture();
        try {
            await publishedAssets(f, f.releaseSha, scenario === "legacy");
            for (const name of [
                "Verify documentation source and qualified release",
                "Select qualified documentation bytes",
            ]) {
                const result = await runShell(await docsStep(name), f.env, f.source);
                assert(result.success, decoder.decode(result.stderr));
            }
            assertEquals(await fsReadFile(f.env.GITHUB_OUTPUT, "utf8"), "rebuild=true\n");
            const built = await runShell(await docsStep("Build and check documentation corrections"), f.env, f.root);
            assert(built.success, decoder.decode(built.stdout) + decoder.decode(built.stderr));
            const html = await fsReadFile(join(f.source, "dist/docs/quickstart/index.html"), "utf8");
            assertStringIncludes(html, "CORRECTED-MANUAL");
            assertEquals(html.includes("QUALIFIED-ARCHIVE-BYTES"), false);
            assertEquals(
                JSON.parse(await fsReadFile(join(f.source, "dist/docs/release.json"), "utf8")).sourceRef,
                f.sha,
            );
            if (scenario === "correction")
                assertEquals(
                    await fsReadFile(join(f.root, "previous-docs-asset/index.html"), "utf8"),
                    "QUALIFIED-ARCHIVE-BYTES\n",
                );
        } finally {
            await fsRm(f.root, { recursive: true, force: true });
        }
    });
}

test("Stable qualification builds the prepared commit and transfers a reusable bundle", async () => {
    const f = await docsFixture();
    try {
        const releaseTag = "v2.0.1";
        await git(f.source, ["checkout", "--detach", f.releaseSha]);
        await write(join(f.source, "docs-site/qualified-release.txt"), "Stable docs input\n");
        await git(f.source, ["add", "."]);
        await git(f.source, ["commit", "-m", "Next Stable"]);
        const released = await git(f.source, ["rev-parse", "HEAD"]);
        await git(f.source, ["tag", releaseTag]);
        await git(f.source, ["push", "origin", "--tags"]);
        const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
        const artifact = jobBlock(workflow, "docs-artifact");
        const prepare = stepRun(artifact, "Prepare one documentation commit");
        const env = { ...f.env, RELEASE_TAG: releaseTag };
        const prepared = await runShell(prepare, env, f.source);
        assert(prepared.success, decoder.decode(prepared.stderr));
        const sha = (await fsReadFile(env.GITHUB_OUTPUT, "utf8")).trim().slice(4);
        const committedMetadata = await fsReadFile(join(f.source, "docs-site/release.json"), "utf8");
        assertEquals(JSON.parse(committedMetadata).sourceRef, released);
        const built = await runShell(
            stepRun(artifact, "Build and package qualified documentation"),
            { ...env, DOCS_SHA: sha },
            f.root,
        );
        assert(built.success, decoder.decode(built.stdout) + decoder.decode(built.stderr));
        const archive = `runwield-docs-${releaseTag}.tar.gz`;
        const archivePath = join(f.root, "docs-artifact", archive);
        assertEquals(
            (await fsReadFile(`${archivePath}.sha256`, "utf8")).trim(),
            `${await sha256File(archivePath)}  ${archive}`,
        );
        assertEquals(JSON.parse(await fsReadFile(join(f.source, "dist/docs/release.json"), "utf8")).sourceRef, sha);
        const receiver = join(f.root, "receiver");
        await git(f.root, ["clone", f.remote, receiver]);
        await git(receiver, ["fetch", join(f.root, "prepared-docs.bundle"), "refs/docs/prepared"]);
        assertEquals(await git(receiver, ["rev-parse", "FETCH_HEAD"]), sha);
        await git(receiver, ["push", "origin", `${sha}:docs/stable`]);
        await fsWriteFile(join(f.source, "docs-site/release.json"), committedMetadata);
        // A fresh retry must be able to retain an already published commit too.
        await fsWriteFile(env.GITHUB_OUTPUT, "");
        await fsRm(join(f.root, "prepared-docs.bundle"));
        const retry = await runShell(prepare, env, f.source);
        assert(retry.success, decoder.decode(retry.stderr));
        assertEquals((await fsReadFile(env.GITHUB_OUTPUT, "utf8")).trim(), `sha=${sha}`);
        await git(receiver, ["bundle", "verify", join(f.root, "prepared-docs.bundle")]);
    } finally {
        await fsRm(f.root, { recursive: true, force: true });
    }
});
