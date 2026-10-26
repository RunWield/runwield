import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
async function check(name: string, assertion: () => void | Promise<void>): Promise<void> {
    await assertion();
    passed += 1;
    console.log("PASS " + name);
}

import { saveNotes, listNotes } from "../src/store.ts";
import { noteTitles, projectSummary } from "../src/commands.ts";

await check("explicit project notes retain their bodies and order", async () => {
    const root = await mkdtemp(join(tmpdir(), "notes-"));
    try {
        const notes = [
            { id: "one", title: "First", body: "Details" },
            { id: "two", title: "Second", body: "More" },
        ];
        await saveNotes(root, notes);
        assert.deepEqual(await listNotes(root), notes);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("explicit project titles are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "titles-"));
    try {
        await saveNotes(root, [{ id: "one", title: "First", body: "Details" }]);
        assert.deepEqual(await noteTitles(root), ["First"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
await check("an empty active project has an empty summary", async () => {
    assert.deepEqual(await projectSummary(), { count: 0, titles: [] });
});
await check("the active project summary includes its saved note titles", async () => {
    const root = await mkdtemp(join(tmpdir(), "active-summary-"));
    try {
        await saveNotes(root, [{ id: "one", title: "Current work", body: "Details" }]);
        const moduleUrl = new URL("../src/commands.ts", import.meta.url).href;
        const script = `
            const { projectSummary } = await import(${JSON.stringify(moduleUrl)});
            console.log(JSON.stringify(await projectSummary()));
        `;
        const child = Bun.spawn([process.execPath, "--eval", script], {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [output, error, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        assert.equal(code, 0, "Summary child must complete: " + error);
        assert.deepEqual(JSON.parse(output), { count: 1, titles: ["Current work"] });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

console.log(`# tests ${passed}`);
