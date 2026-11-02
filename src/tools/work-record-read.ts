/** Agent Custom Tool for canonical Work Record reads by stable ID. */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatWorkRecordReadResult, readWorkRecordById } from "../shared/work-records/index.ts";

export const WORK_RECORD_READ_TOOL_NAME = "work_record_read";

const PARAMETERS = Type.Object(
    {
        recordId: Type.String({ minLength: 1, description: "Stable Work Record recordId." }),
    },
    { additionalProperties: false },
);

interface WorkRecordReadToolOptions {
    cwd: string;
    accessMode?: "current" | "all";
}

type ReadRecord = Awaited<ReturnType<typeof readWorkRecordById>>;

interface WorkRecordReadDetails {
    accessMode: "current" | "all";
    record: ReadRecord | null;
}

type WorkRecordReadResult = AgentToolResult<WorkRecordReadDetails> & { isError?: boolean };

export function createWorkRecordReadTool(opts: WorkRecordReadToolOptions) {
    const accessMode = opts.accessMode || "current";
    return defineTool<typeof PARAMETERS, WorkRecordReadDetails>({
        name: WORK_RECORD_READ_TOOL_NAME,
        label: "Work Record Read",
        description: "Read canonical Work Record Markdown by stable recordId, subject to agent access mode.",
        promptSnippet: "Read a Work Record by recordId when search results identify relevant planning context.",
        parameters: PARAMETERS,
        async execute(_toolCallId, params): Promise<WorkRecordReadResult> {
            try {
                const result = await readWorkRecordById(opts.cwd, params.recordId, { accessMode });
                return {
                    content: [{ type: "text" as const, text: formatWorkRecordReadResult(result) }],
                    details: { accessMode, record: result },
                };
            } catch (caught) {
                const message = caught instanceof Error ? caught.message : String(caught);
                return {
                    content: [{ type: "text" as const, text: message }],
                    details: { accessMode, record: null },
                    isError: true,
                };
            }
        },
    });
}
