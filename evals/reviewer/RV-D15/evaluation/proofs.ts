import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeWorkspace } from "../src/setup.ts";
import { getWorkspace } from "../src/store.ts";

if (process.argv[2] !== "first-run") throw new Error("Select first-run");
const root = await mkdtemp(join(tmpdir(), "first-run-proof-"));
try {
    const outcome = await initializeWorkspace(root).catch((error) => {
        if (error instanceof Error && error.message === "Invalid workspace identifier: My Workspace") {
            return { error: error.message };
        }
        throw error;
    });
    assert.deepEqual(
        { initialized: outcome, saved: await getWorkspace(root) },
        {
            initialized: { id: "default", label: "My Workspace" },
            saved: { id: "default", label: "My Workspace" },
        },
        "RV-D15-FIRST-RUN-IDENTIFIER",
    );
    console.log("PASS first-run");
} finally {
    await rm(root, { recursive: true, force: true });
}
