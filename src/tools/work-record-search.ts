/** Agent Custom Tool for canonical Work Record search. */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { formatWorkRecordSearchResults, searchWorkRecords } from "../shared/work-records/index.ts";
import type { WorkRecordMnemotecaPort } from "../shared/work-records/mnemoteca-port.ts";

export const WORK_RECORD_SEARCH_TOOL_NAME = "work_record_search";

const PARAMETERS = Type.Object(
    {
        query: Type.String({ minLength: 1, description: "Work Record search query." }),
    },
    { additionalProperties: false },
);

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
    return defineTool<typeof PARAMETERS, WorkRecordSearchDetails>({
        name: WORK_RECORD_SEARCH_TOOL_NAME,
        label: "Work Record Search",
        description: "Search canonical Work Records through the derived index and return hydrated Markdown metadata.",
        promptSnippet: "Search current usable Work Records for planning context by query.",
        parameters: PARAMETERS,
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
