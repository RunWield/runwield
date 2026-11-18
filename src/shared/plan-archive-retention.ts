import { previewPlanRetention } from "../plan-store/index.ts";
export {
    collectArchivedPlanUnits,
    type ArchivedPlanUnit,
    selectArchivedPlansForPrune,
    type ArchiveRetentionPolicy,
    type ArchivePruneSelection,
} from "../plan-store/index.ts";
export async function formatArchiveRetentionNudge(cwd: string): Promise<string | null> {
    try {
        const selection = await previewPlanRetention(cwd);
        if (selection.due.length === 0) return null;
        const noun = selection.due.length === 1 ? "Plan is" : "Plans are";
        return `${selection.due.length} archived ${noun} past retention · run \`wld plans prune\``;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Archive retention policy warning: ${message}`;
    }
}
