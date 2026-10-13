import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import { prepareStableDocs } from "./build-stable-docs.ts";

test("historical docs reject graph drift before preparing dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "wld-stable-docs-graph-"));
    try {
        await mkdir(join(root, "docs-site"));
        const current = JSON.parse(await readFile(new URL("../docs-site/package.json", import.meta.url), "utf8"));
        for (const field of ["dependencies", "devDependencies", "optionalDependencies", "overrides", "resolutions"]) {
            const source = { ...current, [field]: { ...current[field], astro: "0.0.0" } };
            await writeFile(join(root, "docs-site/package.json"), JSON.stringify(source));
            await assertRejects(() => prepareStableDocs(root), Error, `Stable docs ${field} differ`);
            assertEquals(
                await stat(join(root, "docs-site/node_modules")).then(
                    () => true,
                    () => false,
                ),
                false,
            );
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
