import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { writeWorkRecord } from "../shared/work-records/index.ts";
import type { WorkRecordFrontMatter } from "../shared/work-records/schema.ts";
import { createWorkRecordReadTool } from "./work-record-read.ts";

const RECORD_ID = "11111111-1111-4111-8111-111111111111";
const EXTENSION_CONTEXT = {} as ExtensionToolContext;

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
    const content = result.content[0];
    return content?.type === "text" ? content.text || "" : "";
}

function recordAttrs(archivedAt?: string): WorkRecordFrontMatter {
    return {
        kind: "work_record",
        recordId: RECORD_ID,
        status: "approved",
        scope: "planned_change",
        workKind: "DOCUMENTATION",
        origin: "internal",
        completionMode: "verified",
        createdAt: "2026-07-14T00:00:00.000Z",
        provenance: { sourcePlans: ["plan-1"] },
        ...(archivedAt ? { archivedAt } : {}),
    };
}

test("work_record_read returns canonical fixture Markdown and structured details", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "work-record-read-tool-"));
    try {
        await writeWorkRecord(
            projectRoot,
            recordAttrs(),
            "# Canonical outcome\n\n## Summary\n\nSummary\n\n## Details\n\nFixture body",
            { fileName: "canonical.md" },
        );
        const tool = createWorkRecordReadTool({ cwd: projectRoot, accessMode: "all" });

        const result = await tool.execute("call", { recordId: RECORD_ID }, undefined, undefined, EXTENSION_CONTEXT);

        assertEquals(result.details?.accessMode, "all");
        assertEquals(result.details?.record?.recordId, RECORD_ID);
        assertStringIncludes(resultText(result), "work: Planned documentation");
        assertStringIncludes(resultText(result), "## Details");
        assertStringIncludes(resultText(result), "Fixture body");
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("work_record_read enforces current-only access through the canonical store", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "work-record-read-current-"));
    try {
        await writeWorkRecord(
            projectRoot,
            recordAttrs("2026-07-15T00:00:00.000Z"),
            "# Archived outcome\n\n## Summary\n\nHistorical.",
            { fileName: "archived.md" },
        );
        const tool = createWorkRecordReadTool({ cwd: projectRoot, accessMode: "current" });

        const result = await tool.execute("call", { recordId: RECORD_ID }, undefined, undefined, EXTENSION_CONTEXT);

        assertEquals(Reflect.get(result, "isError"), true);
        assertEquals(result.details?.accessMode, "current");
        assertStringIncludes(resultText(result), "is not current");
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});
