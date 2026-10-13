import { assertEquals } from "../testing/assertions.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { wrapPlanSafeFileTool } from "./plan-safe-file-tools.ts";

test("Plan-safe write wrapper refuses existing canonical Plan overwrite", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-plan-safe-tool-"));
    try {
        await fsMkdir(`${cwd}/docs/plans`, { recursive: true });
        await fsWriteFile(`${cwd}/docs/plans/demo.md`, "# Demo\n");
        const tool = wrapPlanSafeFileTool(
            defineTool({
                name: "write",
                label: "write",
                description: "write test",
                parameters: {},
                execute: async () => {
                    await Promise.resolve();
                    return { content: [{ type: "text", text: "wrote" }], details: null };
                },
            }),
            { cwd, mode: "write" },
        );
        const result = /** @type {{ isError?: boolean }} */ (await tool.execute(
            "call",
            /** @type {any} */ ({ path: "docs/plans/demo.md", content: "# New" }),
            undefined,
            undefined,
            /** @type {any} */ (undefined),
        ));
        assertEquals(result.isError, true);
        assertEquals(await fsReadFile(`${cwd}/docs/plans/demo.md`, "utf8"), "# Demo\n");
    } finally {
        await fsRm(cwd, { recursive: true }).catch(() => {});
    }
});
