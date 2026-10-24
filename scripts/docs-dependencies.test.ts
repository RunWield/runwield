import { test } from "node:test";
import { ok } from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { prepareDocsDependencies } from "./docs-dependencies.ts";

test("copied docs dependencies stay inside the canonical source when its root has an alias", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "docs-dependency-alias-"));
    const source = join(fixture, "source");
    const alias = join(fixture, "alias");
    try {
        await mkdir(source);
        await symlink(source, alias, "junction");
        await prepareDocsDependencies(alias);

        const store = await realpath(join(source, "docs-site", "node_modules", ".bun"));
        const astro = await realpath(join(alias, "docs-site", "node_modules", "astro"));
        const child = relative(store, astro);
        ok(!child.startsWith("..") && !isAbsolute(child), "Astro must resolve inside the copied dependency store");
    } finally {
        await rm(fixture, { recursive: true, force: true });
    }
});
