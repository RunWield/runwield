/** Agent Custom Tool for canonical Work Record reads by stable ID. */

import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatWorkRecordReadResult, readWorkRecordById } from "../shared/work-records/index.ts";

const definition = toolRegistry.get("work_record_read").definition;

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
    return defineTool<typeof definition.parameters, WorkRecordReadDetails>({
        ...definition,

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
