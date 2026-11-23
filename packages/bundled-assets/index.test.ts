import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { createBundledAssetDirectory } from "@runwield/bundled-assets";

test("materialization repairs stale caches and supplies a cached asset when its source is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-bundle-recovery-"));
    try {
        const source = join(root, "source");
        const cache = join(root, "cache");
        const asset = join("prompts", "reviewer.md");
        await mkdir(join(source, "prompts"), { recursive: true });
        await mkdir(join(cache, asset), { recursive: true });
        await writeFile(join(source, asset), "Review the change.");
        await writeFile(join(cache, "obsolete.md"), "obsolete");

        const assets = createBundledAssetDirectory(source, () => cache);
        assert.equal(await assets.getPath(), cache);
        assert.equal(await readFile(join(cache, asset), "utf8"), "Review the change.");
        await assert.rejects(readFile(join(cache, "obsolete.md")), { code: "ENOENT" });

        await rm(join(source, asset));
        assert.equal(await readFile(await assets.ensureFile(asset), "utf8"), "Review the change.");
        const coldAssets = createBundledAssetDirectory(source, () => cache);
        assert.equal(await readFile(await coldAssets.ensureFile(asset), "utf8"), "Review the change.");
        await rm(source, { recursive: true });
        assert.equal(await readFile(await coldAssets.ensureFile(asset), "utf8"), "Review the change.");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the same bundle retries a failed refresh and repairs removed or damaged files and directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-bundle-refresh-"));
    try {
        const source = join(root, "source");
        const cache = join(root, "blocked", "cache");
        const file = join("formats", "plan.md");
        await mkdir(join(source, "formats"), { recursive: true });
        await writeFile(join(source, file), "Plan Format");
        await writeFile(join(root, "blocked"), "placeholder");

        const assets = createBundledAssetDirectory(source, () => cache);
        assert.equal(await assets.getPath(), source);
        await rm(join(root, "blocked"));
        assert.equal(await assets.getPath(), cache);
        assert.equal(await readFile(join(cache, file), "utf8"), "Plan Format");

        await writeFile(join(cache, file), "Fake Format");
        assert.equal(await assets.getPath(), cache);
        assert.equal(await readFile(join(cache, file), "utf8"), "Plan Format");

        await rm(join(cache, "formats"), { recursive: true });
        assert.equal(await assets.getPath(), cache);
        assert.equal(await readFile(join(cache, file), "utf8"), "Plan Format");

        await rm(cache, { recursive: true });
        await mkdir(cache);
        assert.deepEqual(await Promise.all([assets.getPath(), assets.getPath()]), [cache, cache]);
        assert.equal(await readFile(join(cache, file), "utf8"), "Plan Format");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("bundle cache root symlinks are refused both before and after materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-bundle-cache-root-link-"));
    try {
        const source = join(root, "source");
        const cache = join(root, "cache");
        const external = join(root, "external");
        await Promise.all([mkdir(source), mkdir(external)]);
        await writeFile(join(source, "router.md"), "Bundled router");
        await writeFile(join(external, "router.md"), "External router");
        await writeFile(join(external, "keep.md"), "Keep external file");
        await symlink(external, cache, "junction");

        const assets = createBundledAssetDirectory(source, () => cache);
        assert.equal(await assets.getPath(), source);
        assert.equal(await readFile(join(external, "router.md"), "utf8"), "External router");

        await rm(cache);
        assert.equal(await assets.getPath(), cache);
        assert.equal(await readFile(join(cache, "router.md"), "utf8"), "Bundled router");

        await rm(cache, { recursive: true });
        await symlink(external, cache, "junction");
        assert.equal(await assets.getPath(), source);
        await assert.rejects(assets.ensureFile("keep.md"), { code: "ENOENT" });
        assert.ok((await lstat(cache)).isSymbolicLink());
        assert.equal(await realpath(cache), await realpath(external));
        assert.equal(await readFile(join(external, "router.md"), "utf8"), "External router");
        assert.equal(await readFile(join(external, "keep.md"), "utf8"), "Keep external file");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("an overlapping bundle cache uses the source and leaves both trees intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-bundle-overlap-"));
    try {
        const source = join(root, "source");
        await mkdir(source);
        await writeFile(join(source, "router.md"), "source definition");
        await writeFile(join(root, "keep.md"), "ancestor file");
        const descendant = join(source, "new", "cache");
        const sourceAlias = join(root, "source-link");
        await symlink(source, sourceAlias, "junction");
        const ancestorAlias = join(source, "root-link");
        await symlink(root, ancestorAlias, "junction");
        const nested = join(source, "nested");
        await mkdir(nested);
        const nestedAlias = join(root, "nested-link");
        await symlink(nested, nestedAlias, "junction");
        const ambiguousCache = `${nestedAlias}${sep}..${sep}ambiguous-cache`;

        for (const cache of [
            root,
            descendant,
            sourceAlias,
            join(sourceAlias, "new", "cache"),
            ancestorAlias,
            ambiguousCache,
        ]) {
            const assets = createBundledAssetDirectory(source, () => cache);
            assert.equal(await assets.getPath(), source);
        }

        const ambiguousSource = `${nestedAlias}${sep}..`;
        const otherCache = join(root, "other-cache");
        assert.equal(await createBundledAssetDirectory(ambiguousSource, () => otherCache).getPath(), ambiguousSource);
        assert.equal(await readFile(join(root, "keep.md"), "utf8"), "ancestor file");
        assert.equal(await readFile(join(source, "router.md"), "utf8"), "source definition");
        assert.ok((await lstat(sourceAlias)).isSymbolicLink());
        assert.ok((await lstat(ancestorAlias)).isSymbolicLink());
        await assert.rejects(lstat(join(source, "new")), { code: "ENOENT" });
        await assert.rejects(lstat(join(root, "ambiguous-cache")), { code: "ENOENT" });
        await assert.rejects(lstat(join(source, "ambiguous-cache")), { code: "ENOENT" });
        await assert.rejects(lstat(otherCache), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("materialization replaces cache symlinks without copying into their targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-bundle-cache-links-"));
    try {
        const source = join(root, "source");
        const cache = join(root, "cache");
        const external = join(root, "external");
        await Promise.all([
            mkdir(join(source, "subagent-definitions"), { recursive: true }),
            mkdir(cache),
            mkdir(external),
        ]);
        await writeFile(join(source, "router.md"), "source role");
        await writeFile(join(source, "subagent-definitions", "reviewer.md"), "source subagent");
        const externalFile = join(external, "keep.md");
        await writeFile(externalFile, "keep this file");
        await symlink(externalFile, join(cache, "router.md"), "file");
        await symlink(external, join(cache, "subagent-definitions"), "junction");

        const assets = createBundledAssetDirectory(source, () => cache);
        assert.equal(await assets.getPath(), cache);
        assert.ok((await lstat(join(cache, "router.md"))).isFile());
        assert.ok((await lstat(join(cache, "subagent-definitions"))).isDirectory());
        assert.equal(await readFile(join(cache, "router.md"), "utf8"), "source role");
        assert.equal(await readFile(join(cache, "subagent-definitions", "reviewer.md"), "utf8"), "source subagent");
        assert.equal(await readFile(externalFile, "utf8"), "keep this file");
        await assert.rejects(lstat(join(external, "reviewer.md")), { code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
