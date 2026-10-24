import { buildStableDocs, prepareStableDocs } from "./build-stable-docs.ts";

import { captureScriptProcess } from "./script-process.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes } from "../src/testing/assertions.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { PUBLIC_DOCS } from "./public-docs.ts";
import { verifyDocsSource } from "./verify-docs-source.ts";

const repositoryRoot = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const reconcileScript = join(repositoryRoot, "scripts", "reconcile-docs-branch.sh");

async function run(cwd: string, ...args: string[]): Promise<string> {
    const output = await captureScriptProcess(args[0], {
        args: args.slice(1),
        cwd,
        stdout: "piped",
        stderr: "piped",
    });
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) throw new Error(`${stdout}\n${stderr}`);
    return stdout.trim();
}

async function write(path: string, content: string): Promise<void> {
    await fsMkdir(resolve(path, ".."), { recursive: true });
    await fsWriteFile(path, content);
}

async function copyTree(source: string, destination: string): Promise<void> {
    await fsMkdir(destination, { recursive: true });
    for await (const entry of await fsReaddir(source, { withFileTypes: true })) {
        if ([".astro", "content", "node_modules"].includes(entry.name)) continue;
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        if (entry.isDirectory()) await copyTree(from, to);
        else if (entry.isFile()) await fsCopyFile(from, to);
    }
}

async function buildDocs(work: string): Promise<string> {
    await buildStableDocs(work);
    return await fsReadFile(join(work, "dist", "docs", "quickstart", "index.html"), "utf8");
}

async function publishDocs(work: string, live: string): Promise<void> {
    await buildDocs(work);
    await fsRm(live, { recursive: true }).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    await copyTree(join(work, "dist", "docs"), live);
}

test("docs branch publishes Stable content, preserves corrections, and stops on conflicts", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    try {
        await run(root, "git", "init", "--bare", remote);
        await run(root, "git", "clone", remote, work);
        await run(work, "git", "config", "user.name", "Test");
        await run(work, "git", "config", "user.email", "test@example.com");
        await run(work, "git", "checkout", "-b", "main");

        for (const path of PUBLIC_DOCS) {
            await write(join(work, "docs", path), `# ${path}\n\nSTABLE-A ${path}\n`);
        }
        for (const path of [
            ".github/workflows/docs.yml",
            ".gitignore",
            "deno.json",
            "deno.lock",
            "scripts/public-docs.ts",
            "scripts/check-public-docs.ts",
            "scripts/docs-dev.ts",
            "scripts/public-docs.test.ts",
            "scripts/docs-workflow.test.ts",
            "scripts/docs-branch-integration.test.ts",
            "scripts/reconcile-docs-branch.sh",
            "scripts/verify-docs-source.ts",
        ]) {
            const content =
                path === ".gitignore"
                    ? "# fixture\n"
                    : path === "deno.json"
                      ? '{"lock":false}\n'
                      : path === "deno.lock"
                        ? "{}\n"
                        : `${path}\n`;
            await write(join(work, path), content);
        }
        await write(join(work, "src", "product.ts"), "export const product = 'STABLE-A';\n");
        await copyTree(join(repositoryRoot, "docs-site"), join(work, "docs-site"));
        await write(
            join(work, "docs-site", "release.json"),
            '{"version":"Preview","sourceRef":"main","releaseUrl":"https://example.test"}\n',
        );
        await run(work, "git", "add", ".");
        await run(work, "git", "commit", "-m", "Stable A");
        await run(work, "git", "tag", "v1.0.0");
        await run(work, "git", "push", "origin", "main", "--tags");

        await write(join(work, "docs", "user-documentation", "quickstart.md"), "# Quickstart\n\nUNRELEASED-B\n");
        await write(
            join(work, "docs", "user-documentation", "index.md"),
            "# RunWield Documentation\n\nClean home. Quickstart. Configure RunWield.\n",
        );
        await write(join(work, "src", "product.ts"), "export const product = 'UNRELEASED-B';\n");
        await run(work, "git", "add", ".");
        await run(work, "git", "commit", "-m", "Unreleased B and site support");
        const sourceSha = await run(work, "git", "rev-parse", "HEAD");

        await assertRejects(
            () => run(work, "bash", reconcileScript, "v1.0.0"),
            Error,
            "<stable-tag> true <site-support-commit>",
        );
        const stableASha = await run(work, "git", "rev-parse", "v1.0.0^{commit}");
        const bootstrapCommit = await run(work, "bash", reconcileScript, "v1.0.0", "true", sourceSha);
        assertEquals(/^[0-9a-f]{40}$/.test(bootstrapCommit), true);
        assertEquals(await run(work, "git", "rev-parse", "HEAD"), bootstrapCommit);
        assertEquals(await run(work, "git", "show", "-s", "--format=%P", bootstrapCommit), stableASha);
        assertEquals(await run(work, "git", "rev-list", "--count", `${stableASha}..${bootstrapCommit}`), "1");
        assertEquals(await run(work, "git", "ls-remote", "origin", "refs/heads/docs/stable"), "");
        await run(work, "git", "push", "origin", `${bootstrapCommit}:refs/heads/docs/stable`);
        assertStringIncludes(
            await fsReadFile(join(work, "docs", "user-documentation", "quickstart.md"), "utf8"),
            "STABLE-A",
        );
        assertEquals(
            (await fsReadFile(join(work, "docs", "user-documentation", "quickstart.md"), "utf8")).includes(
                "UNRELEASED-B",
            ),
            false,
        );
        assertStringIncludes(
            await fsReadFile(join(work, "docs", "user-documentation", "index.md"), "utf8"),
            "Clean home",
        );
        assertStringIncludes(await fsReadFile(join(work, "src", "product.ts"), "utf8"), "STABLE-A");
        const stableARelease = JSON.parse(await fsReadFile(join(work, "docs-site", "release.json"), "utf8"));
        assertEquals(stableARelease.version, "v1.0.0");
        assertEquals(stableARelease.sourceRef, stableASha);
        assertEquals(stableARelease.releaseUrl, "https://github.com/gandazgul/runwield/releases/tag/v1.0.0");
        await run(work, "git", "merge-base", "--is-ancestor", stableARelease.sourceRef, "HEAD");
        await run(work, "git", "merge-base", "--is-ancestor", "v1.0.0", "HEAD");
        // The fixture keeps the same frozen dependencies through every publication build.
        await prepareStableDocs(work);
        const stableAHtml = await buildDocs(work);
        assertStringIncludes(stableAHtml, "STABLE-A");
        assertStringIncludes(stableAHtml, "v1.0.0");
        assertEquals(stableAHtml.includes("UNRELEASED-B"), false);

        await write(join(work, "docs", "contributing.md"), "# Contributing\n\nDOCS-CORRECTION\n");
        await run(work, "git", "add", "docs/contributing.md");
        await run(work, "git", "commit", "-m", "Correct docs");
        await run(work, "git", "push", "origin", "HEAD:docs/stable");
        const correctedTip = await run(work, "git", "rev-parse", "HEAD");
        const commitsBeforeCorrectionRetry = await run(work, "git", "rev-list", "--all", "--reflog");
        assertEquals(await run(work, "bash", reconcileScript, "v1.0.0"), correctedTip);
        assertEquals(await run(work, "git", "rev-parse", "HEAD"), correctedTip);
        assertEquals(await run(work, "git", "rev-list", "--all", "--reflog"), commitsBeforeCorrectionRetry);
        const live = join(root, "live");
        await publishDocs(work, live);
        assertStringIncludes(await fsReadFile(join(live, "quickstart", "index.html"), "utf8"), "v1.0.0");
        assertStringIncludes(await fsReadFile(join(live, "contributing", "index.html"), "utf8"), "DOCS-CORRECTION");

        await run(work, "git", "checkout", "main");
        await write(join(work, "docs", "user-documentation", "quickstart.md"), "# Quickstart\n\nSTABLE-B\n");
        await run(work, "git", "add", "docs/user-documentation/quickstart.md");
        await run(work, "git", "commit", "-m", "Stable B");
        await run(work, "git", "tag", "-a", "v1.0.1", "-m", "Stable B");
        await run(work, "git", "push", "origin", "main", "--tags");
        const stableBSha = await run(work, "git", "rev-parse", "HEAD");
        const previousTip = await run(work, "git", "rev-parse", "origin/docs/stable");
        const stableBCommit = await run(work, "bash", reconcileScript, "v1.0.1", "false", stableBSha);
        assertEquals(/^[0-9a-f]{40}$/.test(stableBCommit), true);
        assertEquals(
            await run(work, "git", "show", "-s", "--format=%P", stableBCommit),
            `${stableBSha} ${previousTip}`,
        );
        assertEquals(
            await run(work, "git", "rev-list", "--count", stableBCommit, `^${stableBSha}`, `^${previousTip}`),
            "1",
        );
        assertEquals(
            await run(work, "git", "ls-remote", "origin", "refs/heads/docs/stable"),
            `${previousTip}\trefs/heads/docs/stable`,
        );
        const correction = join(root, "correction");
        await run(root, "git", "clone", "--branch", "docs/stable", remote, correction);
        await run(correction, "git", "config", "user.name", "Test");
        await run(correction, "git", "config", "user.email", "test@example.com");
        await write(
            join(correction, "docs", "user-documentation", "settings.md"),
            "# settings.md\n\nARRIVING-CORRECTION\n",
        );
        await run(correction, "git", "add", "docs/user-documentation/settings.md");
        await run(correction, "git", "commit", "-m", "Correction during preparation");
        const correctionSha = await run(correction, "git", "rev-parse", "HEAD");
        // The caller publishes. A correction after preparation must win the
        // non-forced push race; the retry prepares one commit on that new tip.
        await run(correction, "git", "push", "origin", "HEAD:docs/stable");
        await assertRejects(
            () => run(work, "git", "push", "origin", `${stableBCommit}:refs/heads/docs/stable`),
            Error,
            "fetch first",
        );
        const retryCommit = await run(work, "bash", reconcileScript, "v1.0.1");
        assertEquals(
            await run(work, "git", "show", "-s", "--format=%P", retryCommit),
            `${stableBSha} ${correctionSha}`,
        );
        assertEquals(
            await run(work, "git", "rev-list", "--count", retryCommit, `^${stableBSha}`, `^${correctionSha}`),
            "1",
        );
        assertEquals(
            await run(work, "git", "ls-remote", "origin", "refs/heads/docs/stable"),
            `${correctionSha}\trefs/heads/docs/stable`,
        );
        assertStringIncludes(
            await fsReadFile(join(work, "docs", "user-documentation", "settings.md"), "utf8"),
            "ARRIVING-CORRECTION",
        );
        await run(work, "git", "push", "origin", `${retryCommit}:refs/heads/docs/stable`);
        const objectsBeforeRetry = await run(work, "git", "rev-list", "--all", "--reflog");
        assertEquals(await run(work, "bash", reconcileScript, "v1.0.1"), retryCommit);
        assertEquals(await run(work, "git", "rev-list", "--all", "--reflog"), objectsBeforeRetry);
        assertStringIncludes(
            await fsReadFile(join(work, "docs", "user-documentation", "quickstart.md"), "utf8"),
            "STABLE-B",
        );
        assertStringIncludes(await fsReadFile(join(work, "docs", "contributing.md"), "utf8"), "DOCS-CORRECTION");
        assertStringIncludes(await fsReadFile(join(work, "src", "product.ts"), "utf8"), "UNRELEASED-B");
        const stableBRelease = JSON.parse(await fsReadFile(join(work, "docs-site", "release.json"), "utf8"));
        assertEquals(stableBRelease.version, "v1.0.1");
        assertEquals(stableBRelease.sourceRef, stableBSha);
        assertEquals(stableBRelease.releaseUrl, "https://github.com/gandazgul/runwield/releases/tag/v1.0.1");
        await run(work, "git", "merge-base", "--is-ancestor", stableBRelease.sourceRef, "HEAD");
        await verifyDocsSource(work, "v1.0.1", await run(work, "git", "rev-parse", "HEAD"));
        const stableBHtml = await buildDocs(work);
        assertStringIncludes(stableBHtml, "STABLE-B");
        assertStringIncludes(stableBHtml, "v1.0.1");
        assertStringIncludes(
            await fsReadFile(join(work, "dist", "docs", "contributing", "index.html"), "utf8"),
            "DOCS-CORRECTION",
        );

        await publishDocs(work, live);
        const configPath = join(work, "docs-site", "astro.config.mjs");
        const validConfig = await fsReadFile(configPath, "utf8");
        await fsWriteFile(configPath, "this is not valid JavaScript {");
        await assertRejects(() => publishDocs(work, live));
        assertStringIncludes(await fsReadFile(join(live, "index.html"), "utf8"), "Clean home");
        assertStringIncludes(await fsReadFile(join(live, "quickstart", "index.html"), "utf8"), "STABLE-B");
        await fsWriteFile(configPath, validConfig);
        await publishDocs(work, live);
        assertStringIncludes(await fsReadFile(join(live, "quickstart", "index.html"), "utf8"), "STABLE-B");
        assertEquals(await run(work, "git", "tag", "--points-at", "v1.0.1"), "v1.0.1");

        await write(join(work, "docs", "user-documentation", "quickstart.md"), "# Quickstart\n\nDOCS-CONFLICT\n");
        await run(work, "git", "add", "docs/user-documentation/quickstart.md");
        await run(work, "git", "commit", "-m", "Conflicting docs correction");
        await run(work, "git", "push", "origin", "HEAD:docs/stable");
        const beforeConflict = await run(work, "git", "rev-parse", "HEAD");
        const objectsBeforeCorrectedRetry = await run(work, "git", "cat-file", "--batch-all-objects", "--batch-check");
        assertEquals(await run(work, "bash", reconcileScript, "v1.0.1"), beforeConflict);
        assertEquals(await run(work, "git", "rev-parse", "HEAD"), beforeConflict);
        assertEquals(
            await run(work, "git", "cat-file", "--batch-all-objects", "--batch-check"),
            objectsBeforeCorrectedRetry,
        );

        await run(work, "git", "checkout", "main");
        await write(join(work, "docs", "user-documentation", "quickstart.md"), "# Quickstart\n\nSTABLE-C-CONFLICT\n");
        await run(work, "git", "add", "docs/user-documentation/quickstart.md");
        await run(work, "git", "commit", "-m", "Stable C");
        await run(work, "git", "tag", "v1.0.2");
        await run(work, "git", "push", "origin", "main", "--tags");
        const stableCSha = await run(work, "git", "rev-parse", "HEAD");
        await assertRejects(() => run(work, "bash", reconcileScript, "v1.0.2", "false", stableCSha), Error, "CONFLICT");
        assertEquals(
            await run(work, "git", "ls-remote", "origin", "refs/heads/docs/stable"),
            `${beforeConflict}\trefs/heads/docs/stable`,
        );
        assertEquals((await run(work, "git", "tag", "--list", "v1.*")).split("\n").length, 3);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

for (const history of ["legacy", "single-commit"]) {
    test(`docs branch preserves ${history} corrections across divergent Stable release branches`, async () => {
        const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
        const remote = join(root, "remote.git");
        const work = join(root, "work");
        try {
            await run(root, "git", "init", "--bare", remote);
            await run(root, "git", "clone", remote, work);
            await run(work, "git", "config", "user.name", "Test");
            await run(work, "git", "config", "user.email", "test@example.com");
            await run(work, "git", "checkout", "-b", "main");
            await write(join(work, "docs", "user-documentation", "index.md"), "# Base guide\n");
            await write(
                join(work, "docs-site", "release.json"),
                '{"version":"Preview","sourceRef":"main","releaseUrl":"https://example.test/base"}\n',
            );
            await write(join(work, "src", "product.ts"), "export const product = 'BASE';\n");
            await run(work, "git", "add", ".");
            await run(work, "git", "commit", "-m", "Shared base");
            const baseSha = await run(work, "git", "rev-parse", "HEAD");

            await run(work, "git", "checkout", "-b", "release-a");
            await write(join(work, "src", "product.ts"), "export const product = 'STABLE-A';\n");
            if (history === "single-commit") {
                // A normal release contains its own published documentation.
                await write(join(work, "docs", "user-documentation", "index.md"), "# Published guide\n");
                await write(join(work, "docs", "released-guide.md"), "# Previous release only\n");
            }
            await run(work, "git", "add", ".");
            await run(work, "git", "commit", "-m", "Stable A");
            await run(work, "git", "tag", "v1.0.0");
            await run(work, "git", "checkout", "-b", "docs/stable");
            await write(join(work, "docs", "user-documentation", "index.md"), "# Published guide\n");
            await write(join(work, "docs", "released-guide.md"), "# Previous release only\n");
            const previousRelease = await run(work, "git", "rev-parse", "v1.0.0^{commit}");
            if (history === "single-commit") {
                await write(
                    join(work, "docs-site", "release.json"),
                    JSON.stringify({
                        version: "v1.0.0",
                        sourceRef: previousRelease,
                        releaseUrl: "https://example.test/a",
                    }) + "\n",
                );
            }
            await run(work, "git", "add", ".");
            const publicationTree = await run(work, "git", "write-tree");
            const previousSource = await run(
                work,
                "git",
                "commit-tree",
                publicationTree,
                "-p",
                previousRelease,
                "-p",
                baseSha,
                "-m",
                "Publish Stable A docs",
            );
            await run(work, "git", "reset", "--hard", previousSource);
            if (history === "legacy") {
                await write(
                    join(work, "docs-site", "release.json"),
                    JSON.stringify({
                        version: "v1.0.0",
                        sourceRef: previousSource,
                        releaseUrl: "https://example.test/a",
                    }) + "\n",
                );
                await run(work, "git", "add", "docs-site/release.json");
                await run(work, "git", "commit", "-m", "Record Stable A docs source");
            }
            await write(join(work, "docs", "user-documentation", "index.md"), "# Corrected guide\n");
            const correctedMetadata = JSON.parse(await fsReadFile(join(work, "docs-site", "release.json"), "utf8"));
            correctedMetadata.releaseUrl = "https://example.test/corrected-a";
            await write(join(work, "docs-site", "release.json"), JSON.stringify(correctedMetadata) + "\n");
            await run(work, "git", "add", "docs/user-documentation/index.md", "docs-site/release.json");
            await run(work, "git", "commit", "-m", "Correct Stable A docs and release URL");
            const previousDocsTip = await run(work, "git", "rev-parse", "HEAD");
            await run(work, "git", "push", "origin", "HEAD:docs/stable", "--tags");
            assertEquals(await run(work, "bash", reconcileScript, "v1.0.0"), previousDocsTip);
            assertEquals(await run(work, "git", "rev-parse", "HEAD"), previousDocsTip);

            await run(work, "git", "checkout", "-B", "main", baseSha);
            await write(join(work, "docs", "user-documentation", "index.md"), "# Published guide\n");
            await write(join(work, "src", "product.ts"), "export const product = 'STABLE-B';\n");
            await write(
                join(work, "docs-site", "release.json"),
                '{"version":"Preview","sourceRef":"main","releaseUrl":"https://example.test/b"}\n',
            );
            await run(
                work,
                "git",
                "add",
                "docs/user-documentation/index.md",
                "src/product.ts",
                "docs-site/release.json",
            );
            await run(work, "git", "commit", "-m", "Stable B");
            await run(work, "git", "tag", "v1.0.1");
            await run(work, "git", "push", "origin", "main", "--tags");
            const stableBSha = await run(work, "git", "rev-parse", "HEAD");

            const prepared = await run(work, "bash", reconcileScript, "v1.0.1", "false", stableBSha);
            assertEquals(
                await run(work, "git", "show", "-s", "--format=%P", prepared),
                `${stableBSha} ${previousDocsTip}`,
            );
            assertEquals(
                await run(work, "git", "rev-list", "--count", prepared, `^${stableBSha}`, `^${previousDocsTip}`),
                "1",
            );
            assertEquals(await run(work, "git", "ls-tree", "--name-only", prepared, "docs/released-guide.md"), "");
            const metadata = JSON.parse(await fsReadFile(join(work, "docs-site", "release.json"), "utf8"));
            assertEquals(metadata, {
                version: "v1.0.1",
                sourceRef: stableBSha,
                releaseUrl: "https://github.com/gandazgul/runwield/releases/tag/v1.0.1",
            });
            assertEquals(
                await run(work, "git", "ls-remote", "origin", "refs/heads/docs/stable"),
                `${previousDocsTip}\trefs/heads/docs/stable`,
            );
            await run(work, "git", "push", "origin", `${prepared}:refs/heads/docs/stable`);

            assertStringIncludes(await fsReadFile(join(work, "src", "product.ts"), "utf8"), "STABLE-B");
            assertStringIncludes(
                await fsReadFile(join(work, "docs", "user-documentation", "index.md"), "utf8"),
                "Corrected guide",
            );
            assertEquals(
                JSON.parse(await fsReadFile(join(work, "docs-site", "release.json"), "utf8")).version,
                "v1.0.1",
            );
            await run(work, "git", "merge-base", "--is-ancestor", previousDocsTip, "HEAD");
            await run(work, "git", "merge-base", "--is-ancestor", "v1.0.1", "HEAD");
            // No new correction is made after B. A's correction must still
            // survive C rather than disappearing into the previous merge base.
            await run(work, "git", "checkout", "main");
            await write(join(work, "src", "product.ts"), "export const product = 'STABLE-C';\n");
            await run(work, "git", "add", "src/product.ts");
            await run(work, "git", "commit", "-m", "Stable C");
            await run(work, "git", "tag", "v1.0.2");
            await run(work, "git", "push", "origin", "main", "--tags");
            await run(work, "bash", reconcileScript, "v1.0.2");
            assertStringIncludes(
                await fsReadFile(join(work, "docs", "user-documentation", "index.md"), "utf8"),
                "Corrected guide",
            );
            assertStringIncludes(await fsReadFile(join(work, "src", "product.ts"), "utf8"), "STABLE-C");
        } finally {
            await fsRm(root, { recursive: true });
        }
    });
}

test("docs source validation rejects stale and product-changing commits", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    try {
        await run(root, "git", "init", "--bare", remote);
        await run(root, "git", "clone", remote, work);
        await run(work, "git", "config", "user.name", "Test");
        await run(work, "git", "config", "user.email", "test@example.com");
        await run(work, "git", "checkout", "-b", "main");
        await write(join(work, "docs", "user-documentation", "index.md"), "# Stable\n");
        await write(join(work, "src", "product.ts"), "export const version = 1;\n");
        await run(work, "git", "add", ".");
        await run(work, "git", "commit", "-m", "Stable");
        await run(work, "git", "tag", "v1.0.0");
        await run(work, "git", "push", "origin", "main", "--tags");
        await run(work, "git", "checkout", "-b", "docs/stable");
        await write(join(work, "docs", "user-documentation", "index.md"), "# Corrected\n");
        await run(work, "git", "add", "docs/user-documentation/index.md");
        await run(work, "git", "commit", "-m", "Docs correction");
        await run(work, "git", "push", "-u", "origin", "docs/stable");
        const firstSource = await run(work, "git", "rev-parse", "HEAD");
        await verifyDocsSource(work, "v1.0.0", firstSource);

        await write(join(work, "docs", "user-documentation", "index.md"), "# Newer correction\n");
        await run(work, "git", "add", "docs/user-documentation/index.md");
        await run(work, "git", "commit", "-m", "Newer correction");
        await run(work, "git", "push", "origin", "docs/stable");
        await assertRejects(() => verifyDocsSource(work, "v1.0.0", firstSource), Error, "source is stale");
        const correctedSource = await run(work, "git", "rev-parse", "HEAD");
        await verifyDocsSource(work, "v1.0.0", correctedSource);

        await write(join(work, "src", "product.ts"), "export const version = 2;\n");
        await run(work, "git", "add", "src/product.ts");
        await run(work, "git", "commit", "-m", "Forbidden product change");
        await run(work, "git", "push", "origin", "docs/stable");
        const productSource = await run(work, "git", "rev-parse", "HEAD");
        await assertRejects(() => verifyDocsSource(work, "v1.0.0", productSource), Error, "changes product path");
    } finally {
        await fsRm(root, { recursive: true });
    }
});
