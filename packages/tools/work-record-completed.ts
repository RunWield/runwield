import type { Static } from "typebox";
import type { workRecordCompletedDefinition } from "./definitions/work-record-completed.ts";

type WorkRecordCompletedParameters = Static<typeof workRecordCompletedDefinition.parameters>;

/** Validate the required text without modifying the submitted sections. */
export function validateWorkRecordSections(sections: WorkRecordCompletedParameters): string | null {
    return sections.title.trim() && sections.summary.trim() ? null : "Provide a non-empty title and summary.";
}
