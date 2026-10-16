import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { writeWorkRecord } from "../shared/work-records/index.ts";
import type { WorkRecordFrontMatter } from "../shared/work-records/schema.ts";
import type { WorkRecordMnemotecaPort } from "../shared/work-records/mnemoteca-port.ts";
import { createWorkRecordMnemotecaFixture } from "../shared/work-records/test-fixtures/mnemoteca-port.ts";
import { createWorkRecordSearchTool } from "./work-record-search.ts";

const RECORD_ID = "11111111-1111-4111-8111-111111111111";
const EXTENSION_CONTEXT = {} as ExtensionToolContext;

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
    const content = result.content[0];
    return content?.type === "text" ? content.text || "" : "";
}

function recordAttrs(): WorkRecordFrontMatter {
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
    };
}

test("work_record_search indexes and hydrates canonical fixture records", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "work-record-search-tool-"));
    try {
        await writeWorkRecord(
            projectRoot,
            recordAttrs(),
            "# Useful outcome\n\n## Summary\n\nFull durable summary text.",
            { fileName: "useful.md" },
        );
        const tool = createWorkRecordSearchTool({
            cwd: projectRoot,
            accessMode: "current",
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        const result = await tool.execute(
            "call",
            { query: "durable summary" },
            undefined,
            undefined,
            EXTENSION_CONTEXT,
        );

        assertEquals(result.details?.accessMode, "current");
        assertEquals(result.details?.records[0].recordId, RECORD_ID);
        assertEquals(Object.hasOwn(result.details?.records[0] || {}, "body"), false);
        assertStringIncludes(resultText(result), "Useful outcome");
        assertStringIncludes(resultText(result), "work: Planned documentation");
        assertStringIncludes(resultText(result), "Full durable summary text");
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("work_record_search reports the external Mnemoteca failure as a tool error", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "work-record-search-failure-"));
    const failedPort: WorkRecordMnemotecaPort = {
        run: () =>
            Promise.resolve({
                success: false,
                code: 7,
                stdout: new Uint8Array(),
                stderr: new TextEncoder().encode("fixture index unavailable"),
            }),
    };
    try {
        await writeWorkRecord(
            projectRoot,
            recordAttrs(),
            "# Useful outcome\n\n## Summary\n\nFull durable summary text.",
            { fileName: "useful.md" },
        );
        const tool = createWorkRecordSearchTool({ cwd: projectRoot, accessMode: "all", mnemotecaPort: failedPort });

        const result = await tool.execute("call", { query: "durable" }, undefined, undefined, EXTENSION_CONTEXT);

        assertEquals(Reflect.get(result, "isError"), true);
        assertEquals(result.details?.accessMode, "all");
        assertStringIncludes(resultText(result), "fixture index unavailable");
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});
