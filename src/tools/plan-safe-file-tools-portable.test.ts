import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { equal, ok } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSingleEditToolDefinition } from "./edit.js";
import { wrapPlanSafeFileTool } from "./plan-safe-file-tools.ts";

test("portable Plan tools create once and preserve bytes after rejected edits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "portable-plan-tool-"));
    const path = "docs/plans/nested/tool.md";
    const initial = "# Tool Plan\n\nUnique original text.\n";
    try {
        const write = wrapPlanSafeFileTool(createWriteToolDefinition(cwd), { cwd, mode: "write" });
        const edit = wrapPlanSafeFileTool(createSingleEditToolDefinition(cwd), { cwd, mode: "edit" });
        const created = await write.execute(
            "create",
            { path, content: initial },
            undefined,
            undefined,
            undefined as never,
        );
        ok(!created.isError);
        equal(await readFile(join(cwd, path), "utf8"), initial);
        const refused = await write.execute(
            "overwrite",
            { path, content: "lost bytes" },
            undefined,
            undefined,
            undefined as never,
        );
        equal(refused.isError, true);
        equal(await readFile(join(cwd, path), "utf8"), initial);
        const changed = await edit.execute(
            "edit",
            { path, oldText: "Unique original text.", newText: "Reviewed text." },
            undefined,
            undefined,
            undefined as never,
        );
        ok(!changed.isError);
        const saved = await readFile(join(cwd, path), "utf8");
        equal(saved, "# Tool Plan\n\nReviewed text.\n");
        const stale = await edit.execute(
            "stale",
            { path, oldText: "Unique original text.", newText: "stale overwrite" },
            undefined,
            undefined,
            undefined as never,
        );
        equal(stale.isError, true);
        equal(await readFile(join(cwd, path), "utf8"), saved);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
