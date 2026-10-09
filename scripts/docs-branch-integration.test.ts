import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { PUBLIC_DOCS, stagePublicDocs } from "./public-docs.ts";
import { verifyDocsSource } from "./verify-docs-source.ts";

const repositoryRoot = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const reconcileScript = join(repositoryRoot, "scripts", "reconcile-docs-branch.sh");

async function run(cwd: string, ...args: string[]): Promise<string> {
    const output = await new Deno.Command(args[0], {
        args: args.slice(1),
        cwd,
        stdout: "piped",
        stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) throw new Error(`${stdout}\n${stderr}`);
    return stdout.trim();
}

async function write(path: string, content: string): Promise<void> {
    await Deno.mkdir(resolve(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
}

async function copyTree(source: string, destination: string): Promise<void> {
    await Deno.mkdir(destination, { recursive: true });
    for await (const entry of Deno.readDir(source)) {
        if ([".astro", "content", "node_modules"].includes(entry.name)) continue;
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        if (entry.isDirectory) await copyTree(from, to);
        else if (entry.isFile) await Deno.copyFile(from, to);
    }
}

async function buildDocs(work: string): Promise<string> {
    await stagePublicDocs(work, join(work, "docs-site", "src", "content", "docs"));
    const output = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "npm:astro@7.3.3", "build"],
        cwd: join(work, "docs-site"),
        stdout: "piped",
        stderr: "piped",
    }).output();
    assert(output.success, new TextDecoder().decode(output.stderr));
    return await Deno.readTextFile(join(work, "dist", "docs", "quickstart", "index.html"));
}

async function publishDocs(work: string, live: string): Promise<void> {
    await buildDocs(work);
    await Deno.remove(live, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await copyTree(join(work, "dist", "docs"), live);
}

async function runWithEnv(cwd: string, env: Record<string, string>, ...args: string[]): Promise<string> {
    const output = await new Deno.Command(args[0], {
        args: args.slice(1),
        cwd,
        env,
        stdout: "piped",
        stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) throw new Error(`${stdout}\n${stderr}`);
    return stdout.trim();
}

Deno.test("docs branch publishes Stable content, preserves corrections, and stops on conflicts", async () => {
    const root = await Deno.makeTempDir();
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
        for (
            const path of [
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
            ]
        ) {
            const content = path === ".gitignore"
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
        await write(join(work, "docs", "user-documentation", "index.md"), "# Public home\n\nClean home\n");
        await write(join(work, "src", "product.ts"), "export const product = 'UNRELEASED-B';\n");
        await run(work, "git", "add", ".");
        await run(work, "git", "commit", "-m", "Unreleased B and site support");
        const sourceSha = await run(work, "git", "rev-parse", "HEAD");

        await run(work, "bash", reconcileScript, "v1.0.0", "true", sourceSha);
        assertStringIncludes(
            await Deno.readTextFile(join(work, "docs", "user-documentation", "quickstart.md")),
            "STABLE-A",
        );
        assertEquals(
            (await Deno.readTextFile(join(work, "docs", "user-documentation", "quickstart.md"))).includes(
                "UNRELEASED-B",
            ),
            false,
        );
        assertStringIncludes(
            await Deno.readTextFile(join(work, "docs", "user-documentation", "index.md")),
            "Clean home",
        );
        assertStringIncludes(await Deno.readTextFile(join(work, "src", "product.ts")), "STABLE-A");
        const stableARelease = JSON.parse(await Deno.readTextFile(join(work, "docs-site", "release.json")));
        assertEquals(stableARelease.version, "v1.0.0");
        assertEquals(stableARelease.sourceRef === "v1.0.0", false);
        await run(work, "git", "merge-base", "--is-ancestor", stableARelease.sourceRef, "HEAD");
        await run(work, "git", "merge-base", "--is-ancestor", "v1.0.0", "HEAD");
        const stableAHtml = await buildDocs(work);
        assertStringIncludes(stableAHtml, "STABLE-A");
        assertStringIncludes(stableAHtml, "v1.0.0");
        assertEquals(stableAHtml.includes("UNRELEASED-B"), false);

        await write(join(work, "docs", "contributing.md"), "# Contributing\n\nDOCS-CORRECTION\n");
        await run(work, "git", "add", "docs/contributing.md");
        await run(work, "git", "commit", "-m", "Correct docs");
        await run(work, "git", "push", "origin", "HEAD:docs/stable");
        const live = join(root, "live");
        await publishDocs(work, live);
        assertStringIncludes(await Deno.readTextFile(join(live, "quickstart", "index.html")), "v1.0.0");
        assertStringIncludes(
            await Deno.readTextFile(join(live, "contributing", "index.html")),
            "DOCS-CORRECTION",
        );

        await run(work, "git", "checkout", "main");
        await write(join(work, "docs", "user-documentation", "quickstart.md"), "# Quickstart\n\nSTABLE-B\n");
        await run(work, "git", "add", "docs/user-documentation/quickstart.md");
        await run(work, "git", "commit", "-m", "Stable B");
        await run(work, "git", "tag", "v1.0.1");
        await run(work, "git", "push", "origin", "main", "--tags");
        const stableBSha = await run(work, "git", "rev-parse", "HEAD");
        await run(work, "bash", reconcileScript, "v1.0.1", "false", stableBSha);
        assertStringIncludes(
            await Deno.readTextFile(join(work, "docs", "user-documentation", "quickstart.md")),
            "STABLE-B",
        );
        assertStringIncludes(await Deno.readTextFile(join(work, "docs", "contributing.md")), "DOCS-CORRECTION");
        assertStringIncludes(await Deno.readTextFile(join(work, "src", "product.ts")), "UNRELEASED-B");
        const stableBRelease = JSON.parse(await Deno.readTextFile(join(work, "docs-site", "release.json")));
        assertEquals(stableBRelease.version, "v1.0.1");
        assertEquals(stableBRelease.sourceRef === "v1.0.1", false);
        await run(work, "git", "merge-base", "--is-ancestor", stableBRelease.sourceRef, "HEAD");
        await verifyDocsSource(work, "v1.0.1", await run(work, "git", "rev-parse", "HEAD"));
        const stableBHtml = await buildDocs(work);
        assertStringIncludes(stableBHtml, "STABLE-B");
        assertStringIncludes(stableBHtml, "v1.0.1");
        assertStringIncludes(
            await Deno.readTextFile(join(work, "dist", "docs", "contributing", "index.html")),
            "DOCS-CORRECTION",
        );

        await publishDocs(work, live);
        const configPath = join(work, "docs-site", "astro.config.mjs");
        const validConfig = await Deno.readTextFile(configPath);
        await Deno.writeTextFile(configPath, "this is not valid JavaScript {");
        await assertRejects(() => publishDocs(work, live));
        assertStringIncludes(await Deno.readTextFile(join(live, "index.html")), "Clean home");
        assertStringIncludes(await Deno.readTextFile(join(live, "quickstart", "index.html")), "STABLE-B");
        await Deno.writeTextFile(configPath, validConfig);
        await publishDocs(work, live);
        assertStringIncludes(await Deno.readTextFile(join(live, "quickstart", "index.html")), "STABLE-B");
        assertEquals(await run(work, "git", "tag", "--points-at", "v1.0.1"), "v1.0.1");

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

        const bin = join(root, "bin");
        const marker = join(root, "correction-pushed");
        const realGit = await run(root, "bash", "-c", "command -v git");
        await Deno.mkdir(bin);
        await write(
            join(bin, "git"),
            `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "push origin HEAD:docs/stable" && ! -e "$RACE_MARKER" ]]; then
    touch "$RACE_MARKER"
    "$REAL_GIT" -C "$CORRECTION_WORK" push origin HEAD:docs/stable
fi
exec "$REAL_GIT" "$@"
`,
        );
        await Deno.chmod(join(bin, "git"), 0o755);
        await assertRejects(
            () =>
                runWithEnv(
                    work,
                    {
                        PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
                        RACE_MARKER: marker,
                        REAL_GIT: realGit,
                        CORRECTION_WORK: correction,
                    },
                    "bash",
                    reconcileScript,
                    "v1.0.1",
                    "false",
                    stableBSha,
                ),
            Error,
            "fetch first",
        );
        assertStringIncludes(
            await run(root, "git", "--git-dir", remote, "show", `${correctionSha}:docs/user-documentation/settings.md`),
            "ARRIVING-CORRECTION",
        );
        await run(work, "bash", reconcileScript, "v1.0.1", "false", stableBSha);
        assertStringIncludes(
            await Deno.readTextFile(join(work, "docs", "user-documentation", "settings.md")),
            "ARRIVING-CORRECTION",
        );

        await write(join(work, "docs", "user-documentation", "quickstart.md"), "# Quickstart\n\nDOCS-CONFLICT\n");
        await run(work, "git", "add", "docs/user-documentation/quickstart.md");
        await run(work, "git", "commit", "-m", "Conflicting docs correction");
        await run(work, "git", "push", "origin", "HEAD:docs/stable");
        const beforeConflict = await run(work, "git", "rev-parse", "HEAD");

        await run(work, "git", "checkout", "main");
        await write(join(work, "docs", "user-documentation", "quickstart.md"), "# Quickstart\n\nSTABLE-C-CONFLICT\n");
        await run(work, "git", "add", "docs/user-documentation/quickstart.md");
        await run(work, "git", "commit", "-m", "Stable C");
        await run(work, "git", "tag", "v1.0.2");
        await run(work, "git", "push", "origin", "main", "--tags");
        const stableCSha = await run(work, "git", "rev-parse", "HEAD");
        await assertRejects(
            () => run(work, "bash", reconcileScript, "v1.0.2", "false", stableCSha),
            Error,
            "CONFLICT",
        );
        assertEquals(
            await run(work, "git", "ls-remote", "origin", "refs/heads/docs/stable"),
            `${beforeConflict}\trefs/heads/docs/stable`,
        );
        assertEquals((await run(work, "git", "tag", "--list", "v1.*")).split("\n").length, 3);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("docs branch preserves corrections across divergent Stable release branches", async () => {
    const root = await Deno.makeTempDir();
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    try {
        await run(root, "git", "init", "--bare", remote);
        await run(root, "git", "clone", remote, work);
        await run(work, "git", "config", "user.name", "Test");
        await run(work, "git", "config", "user.email", "test@example.com");
        await run(work, "git", "checkout", "-b", "main");
        await write(join(work, "docs", "user-documentation", "index.md"), "# Base guide\n");
        await write(join(work, "docs-site", "release.json"), '{"version":"Preview","sourceRef":"main"}\n');
        await write(join(work, "src", "product.ts"), "export const product = 'BASE';\n");
        await run(work, "git", "add", ".");
        await run(work, "git", "commit", "-m", "Shared base");
        const baseSha = await run(work, "git", "rev-parse", "HEAD");

        await run(work, "git", "checkout", "-b", "release-a");
        await write(join(work, "src", "product.ts"), "export const product = 'STABLE-A';\n");
        await run(work, "git", "add", "src/product.ts");
        await run(work, "git", "commit", "-m", "Stable A");
        await run(work, "git", "tag", "v1.0.0");
        await run(work, "git", "checkout", "-b", "docs/stable");
        await write(join(work, "docs", "user-documentation", "index.md"), "# Published guide\n");
        await run(work, "git", "add", "docs/user-documentation/index.md");
        await run(work, "git", "commit", "-m", "Publish Stable A docs");
        const previousSource = await run(work, "git", "rev-parse", "HEAD");
        await write(
            join(work, "docs-site", "release.json"),
            `{"version":"v1.0.0","sourceRef":"${previousSource}"}\n`,
        );
        await run(work, "git", "add", "docs-site/release.json");
        await run(work, "git", "commit", "-m", "Record Stable A docs source");
        await write(join(work, "docs", "user-documentation", "index.md"), "# Corrected guide\n");
        await run(work, "git", "add", "docs/user-documentation/index.md");
        await run(work, "git", "commit", "-m", "Correct Stable A docs");
        const previousDocsTip = await run(work, "git", "rev-parse", "HEAD");
        await run(work, "git", "push", "origin", "HEAD:docs/stable", "--tags");

        await run(work, "git", "checkout", "-B", "main", baseSha);
        await write(join(work, "docs", "user-documentation", "index.md"), "# Published guide\n");
        await write(join(work, "src", "product.ts"), "export const product = 'STABLE-B';\n");
        await run(work, "git", "add", "docs/user-documentation/index.md", "src/product.ts");
        await run(work, "git", "commit", "-m", "Stable B");
        await run(work, "git", "tag", "v1.0.1");
        await run(work, "git", "push", "origin", "main", "--tags");
        const stableBSha = await run(work, "git", "rev-parse", "HEAD");

        await run(work, "bash", reconcileScript, "v1.0.1", "false", stableBSha);

        assertStringIncludes(await Deno.readTextFile(join(work, "src", "product.ts")), "STABLE-B");
        assertStringIncludes(
            await Deno.readTextFile(join(work, "docs", "user-documentation", "index.md")),
            "Corrected guide",
        );
        assertEquals(JSON.parse(await Deno.readTextFile(join(work, "docs-site", "release.json"))).version, "v1.0.1");
        await run(work, "git", "merge-base", "--is-ancestor", previousDocsTip, "HEAD");
        await run(work, "git", "merge-base", "--is-ancestor", "v1.0.1", "HEAD");
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("docs source validation rejects stale and product-changing commits", async () => {
    const root = await Deno.makeTempDir();
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
        await assertRejects(
            () => verifyDocsSource(work, "v1.0.0", firstSource),
            Error,
            "source is stale",
        );
        const correctedSource = await run(work, "git", "rev-parse", "HEAD");
        await verifyDocsSource(work, "v1.0.0", correctedSource);

        await write(join(work, "src", "product.ts"), "export const version = 2;\n");
        await run(work, "git", "add", "src/product.ts");
        await run(work, "git", "commit", "-m", "Forbidden product change");
        await run(work, "git", "push", "origin", "docs/stable");
        const productSource = await run(work, "git", "rev-parse", "HEAD");
        await assertRejects(
            () => verifyDocsSource(work, "v1.0.0", productSource),
            Error,
            "changes product path",
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
