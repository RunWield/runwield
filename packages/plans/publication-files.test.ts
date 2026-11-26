import { materializeDeliveryCopy } from "./publication-files.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";

test("publication copy materialization rejects paths outside the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "publication-copy-destination-"));
    try {
        const checkout = join(root, "checkout");
        const protectedFile = join(root, "protected.md");
        const original = "Keep these bytes.\n";
        await mkdir(checkout);
        await writeFile(protectedFile, original);
        await rejects(
            materializeDeliveryCopy(checkout, { kind: "plan", path: "../protected.md", text: "New content" }, original),
            /Unsafe or duplicate delivery copy destination/,
        );
        equal(await readFile(protectedFile, "utf8"), original);
    } finally {
        await rm(root, { recursive: true });
    }
});
