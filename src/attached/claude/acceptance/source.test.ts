import { test } from "node:test";
import { deepStrictEqual as equal, notStrictEqual, rejects, ok as assert } from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineCommittedGitFixture } from "../../../shared/git-test-fixture.ts";
import { captureCoreSource } from "./source.ts";

const fixture = defineCommittedGitFixture({
    "src/runtime.ts": "export const runtime = 1;\n",
    "scripts/acceptance.ts": "// driver\n",
    ".claude-plugin/marketplace.json": "{}\n",
    "runtime-root.js": "// root\n",
    "package.json": "{}\n",
    "bun.lock": "lock\n",
    "tsconfig.json": "{}\n",
    "bunfig.toml": "env = false\n",
    "third_party/core/runtime.ts": "// vendored runtime\n",
    "dist/workspace-bun/server/entry.mjs": "// renderer\n",
    "dist/workspace-bun/client/_astro/page.js": "// browser\n",
});

async function withSource(run: (root: string) => Promise<void>): Promise<void> {
    const root = await fixture.checkout();
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("unchanged source has a deterministic fingerprint and a clean revision", async () => {
    await withSource(async (root) => {
        const before = await captureCoreSource(root);
        equal(await captureCoreSource(root), before);
        equal(before.dirty, false);
        assert(/^[a-f0-9]{64}$/.test(before.digest));
        assert(before.files.every((file) => !file.path.startsWith(root) && file.text === undefined));
    });
});

for (const path of [
    "src/runtime.ts",
    "scripts/acceptance.ts",
    ".claude-plugin/marketplace.json",
    "bun.lock",
    "tsconfig.json",
    "bunfig.toml",
    "third_party/core/runtime.ts",
    "dist/workspace-bun/client/_astro/page.js",
    "src/new-runtime.ts",
])
    test(`fingerprint identifies changed bytes at ${path} even when HEAD is unchanged`, async () => {
        await withSource(async (root) => {
            const before = await captureCoreSource(root);
            await writeFile(join(root, path), "changed\n");
            const after = await captureCoreSource(root);
            equal(after.commit, before.commit);
            equal(after.dirty, true);
            notStrictEqual(after.digest, before.digest);
            assert(after.files.some((file) => file.path === path));
        });
    });

test("a removed runtime file changes the fingerprint", async () => {
    await withSource(async (root) => {
        const before = await captureCoreSource(root);
        await rm(join(root, "src/runtime.ts"));
        notStrictEqual((await captureCoreSource(root)).digest, before.digest);
    });
});

test("vendored file symlinks include their resolved bytes in the proof", async () => {
    await withSource(async (root) => {
        await symlink(join(root, "package.json"), join(root, "src/linked.json"));
        const before = await captureCoreSource(root);
        equal(
            before.files.find((file) => file.path === "src/linked.json")?.sha256,
            before.files.find((file) => file.path === "package.json")?.sha256,
        );
        await writeFile(join(root, "package.json"), "changed\n");
        const after = await captureCoreSource(root);
        notStrictEqual(
            after.files.find((file) => file.path === "src/linked.json")?.sha256,
            before.files.find((file) => file.path === "src/linked.json")?.sha256,
        );
    });
});

test("a broken source link cannot be treated as a valid fingerprint", async () => {
    await withSource(async (root) => {
        await symlink(join(root, "missing.json"), join(root, "src/linked.json"));
        await rejects(captureCoreSource(root));
    });
});

test("an unreadable checkout cannot become a valid source identity", async () => {
    await withSource(async (root) => {
        const empty = join(root, "empty");
        await mkdir(empty);
        await rejects(captureCoreSource(empty), /No Core source/);
    });
});
