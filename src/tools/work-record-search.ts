/** Agent Custom Tool for canonical Work Record search. */

import { toolRegistry } from "@runwield/tools";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatWorkRecordSearchResults, searchWorkRecords } from "../shared/work-records/index.ts";
import type { WorkRecordMnemotecaPort } from "../shared/work-records/mnemoteca-port.ts";

const definition = toolRegistry.get("work_record_search").definition;

interface WorkRecordSearchToolOptions {
    cwd: string;
    accessMode?: "current" | "all";
    mnemotecaPort: WorkRecordMnemotecaPort;
}

type SearchResult = Awaited<ReturnType<typeof searchWorkRecords>>;

interface WorkRecordSearchDetails {
    accessMode: "current" | "all";
    records: SearchResult["records"];
    staleRecordIds: string[];
    bootstrapped: boolean;
}

type WorkRecordSearchResult = AgentToolResult<WorkRecordSearchDetails> & { isError?: boolean };

export function createWorkRecordSearchTool(opts: WorkRecordSearchToolOptions) {
    const accessMode = opts.accessMode || "current";
    const mnemotecaPort = opts.mnemotecaPort;
    return defineTool<typeof definition.parameters, WorkRecordSearchDetails>({
        ...definition,

        async execute(_toolCallId, params): Promise<WorkRecordSearchResult> {
            try {
                const result = await searchWorkRecords(opts.cwd, params.query, { accessMode, mnemotecaPort });
                return {
                    content: [{ type: "text" as const, text: formatWorkRecordSearchResults(result) }],
                    details: {
                        accessMode,
                        records: result.records,
                        staleRecordIds: result.staleRecordIds,
                        bootstrapped: result.bootstrapped,
                    },
                };
            } catch (caught) {
                const message = caught instanceof Error ? caught.message : String(caught);
                return {
                    content: [{ type: "text" as const, text: message }],
                    details: { accessMode, records: [], staleRecordIds: [], bootstrapped: false },
                    isError: true,
                };
            }
        },
    });
}

export const WORK_RECORD_SEARCH_TOOL_NAME = definition.name;
