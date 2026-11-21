import { withRetainedPlanFixture } from "../shared/testing/retained-plan-fixture.ts";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { equal, ok } from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSingleEditToolDefinition } from "./edit.ts";
import { wrapPlanSafeFileTool } from "./plan-safe-file-tools.ts";

test("portable Plan tools create once and preserve bytes after rejected edits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "portable-plan-tool-"));
    const path = "docs/plans/nested/tool.md";
    const initial = "# Tool Plan\n\nUnique original text.\n";
    try {
        await withRetainedPlanFixture(cwd, async () => {
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
        });
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("Pi and the Plan Store protect metadata through home, URL, parent and symbolic paths", async () => {
    const { packageFixture, create } = await import("../shared/testing/plan-package-fixture.ts");
    const { relative } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { getHomeDir } = await import("../constants.ts");
    const f = await packageFixture();
    try {
        const plan = await create(f.identity);
        const metadata = join(plan.path, "plan.wld.json");
        const before = await readFile(metadata);
        const tool = wrapPlanSafeFileTool(createWriteToolDefinition(f.root), { cwd: f.root, mode: "write" });
        const write = (path: string) =>
            tool.execute("write", { path, content: "source" }, undefined, undefined, undefined as never);
        await symlink(plan.path, join(f.root, "alias"), "dir");
        for (const path of [
            "~/" + relative(getHomeDir(), metadata),
            "@~/" + relative(getHomeDir(), metadata),
            pathToFileURL(metadata).href,
            join("alias", "plan.wld.json"),
            relative(f.root, metadata),
        ]) {
            ok((await write(path)).isError, path);
            equal((await readFile(metadata)).equals(before), true);
        }
        const foreign = join(getHomeDir(), ".wld", "projects", "foreign", "plan.wld.json");
        ok((await write(foreign)).isError);
        ok(!(await write("ordinary.txt")).isError);
        equal(await readFile(join(f.root, "ordinary.txt"), "utf8"), "source");
    } finally {
        await f.cleanup();
    }
});
