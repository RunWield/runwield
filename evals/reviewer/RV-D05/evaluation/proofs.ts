import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/commands.ts";

if (process.argv[2] !== "prefix-sibling") throw new Error("Select prefix-sibling");
const root = await mkdtemp(join(tmpdir(), "containment-proof-"));
try {
    const archive = join(root, "archive");
    const sibling = join(root, "archive-old");
    await mkdir(archive);
    await mkdir(sibling);
    const outside = join(sibling, "keep.txt");
    await writeFile(outside, "not an archived artifact");
    let refused = false;
    try {
        await runCommand(archive, ["remove", "../archive-old/keep.txt"]);
    } catch (error) {
        if (!(error instanceof Error && error.message.includes("beneath the archive root"))) throw error;
        refused = true;
    }
    assert.equal(existsSync(outside), true, "RV-D05-OUTSIDE-DELETION");
    assert.equal(refused, true, "RV-D05-OUTSIDE-DELETION");
    assert.equal(await readFile(outside, "utf8"), "not an archived artifact");
    console.log("PASS prefix-sibling");
} finally {
    await rm(root, { recursive: true, force: true });
}
