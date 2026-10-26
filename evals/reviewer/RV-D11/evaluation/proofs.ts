import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveNotes } from "../src/store.ts";

if (process.argv[2] !== "active-project") throw new Error("Select active-project");
const root = await mkdtemp(join(tmpdir(), "active-project-proof-"));
try {
    const first = join(root, "first");
    const second = join(root, "second");
    await saveNotes(first, [{ id: "one", title: "First project", body: "First body" }]);
    await saveNotes(second, [
        { id: "two", title: "Second project", body: "Second body" },
        { id: "three", title: "Another note", body: "Third body" },
    ]);
    // Only this child changes cwd. Import after the first selection: initial load must work in both twins.
    const moduleUrl = new URL("../src/commands.ts", import.meta.url).href;
    const script = `
        process.chdir(${JSON.stringify(first)});
        const { projectSummary } = await import(${JSON.stringify(moduleUrl)});
        const first = await projectSummary();
        process.chdir(${JSON.stringify(second)});
        const second = await projectSummary();
        console.log(JSON.stringify([first, second]));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    assert.equal(code, 0, "Project operation child must complete: " + error);
    assert.deepEqual(
        JSON.parse(output),
        [
            { count: 1, titles: ["First project"] },
            { count: 2, titles: ["Second project", "Another note"] },
        ],
        "RV-D11-ACTIVE-PROJECT",
    );
    console.log("PASS active-project");
} finally {
    await rm(root, { recursive: true, force: true });
}
