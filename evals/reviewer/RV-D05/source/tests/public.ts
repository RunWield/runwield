let passed = 0;
async function check(name: string, assertion: () => void | Promise<void>): Promise<void> {
    await assertion();
    passed += 1;
    console.log("PASS " + name);
}

import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/commands.ts";

await check("list reports the archived files", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-"));
    try {
        await writeFile(join(root, "report.txt"), "done");
        assert.deepEqual(JSON.parse(await runCommand(root, ["list"])), [{ path: "report.txt", bytes: 4 }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("read returns archived content", async () => {
    const root = await mkdtemp(join(tmpdir(), "archive-"));
    try {
        await writeFile(join(root, "report.txt"), "done");
        assert.equal(await runCommand(root, ["read", "report.txt"]), "done");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

console.log(`# tests ${passed}`);
