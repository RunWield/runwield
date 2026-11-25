import { documents } from "./work-records/documents.ts";

export type {
    GeneratedWorkRecordSections,
    WorkRecordCompletionMode,
    WorkRecordFrontMatter,
    WorkRecordResource,
    WorkRecordScope,
    WorkRecordSupersessionCandidate,
} from "./work-records/documents.ts";

/** Read and format Work Record documents without opening project storage. */
export const workRecords = { documents } as const;
