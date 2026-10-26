import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startValidation } from "../src/validation.ts";
import { alive, ready, stopGroup, waitFor, within } from "../tests/process-fixture.ts";

if (process.argv[2] !== "descendant-cancel") throw new Error("Select descendant-cancel");
for (const role of ["branch", "exiting-branch"]) {
    const root = await mkdtemp(join(tmpdir(), "rv-d07-proof-"));
    // Clear Bun automatic orphan cleanup so this command has ordinary POSIX child lifetime.
    const run = startValidation("env", [
        "-u",
        "BUN_FEATURE_FLAG_NO_ORPHANS",
        process.execPath,
        fileURLToPath(new URL("../tests/workload.ts", import.meta.url)),
        role,
        root,
    ]);
    try {
        await ready(join(root, "ready"));
        await ready(join(root, "leaf-ready"));
        const leaf = Number(await readFile(join(root, "leaf-ready"), "utf8"));
        if (role === "exiting-branch") {
            const leader = Number(await readFile(join(root, "ready"), "utf8"));
            await writeFile(join(root, "exit-parent"), "exit with inherited pipes still open");
            await waitFor(() => !alive(leader));
        }
        assert.equal(alive(leaf), true, "Descendant must be active before cancellation");
        assert.equal((await within(run.cancel())).status, "cancelled");
        await writeFile(join(root, "go"), "cancellation returned");
        // No absence timeout: either the live descendant acknowledges go, or it has already settled.
        await waitFor(() => existsSync(join(root, "done")) || !alive(leaf));
        assert.equal(existsSync(join(root, "sentinel")), false, "RV-D07-DESCENDANT-CANCEL");
    } finally {
        try {
            if (run.pid !== undefined) await stopGroup(run.pid);
            await run.result;
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
}
console.log("PASS descendant-cancel");
