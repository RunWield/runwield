import type { ProjectWorkRecords } from "@runwield/plans/store";
import { hasRetainedCheckoutSource } from "@runwield/plans/retained-checkout";
import { workRecordFiles } from "@runwield/plans/work-record-files";
import { workRecords } from "@runwield/plans/work-records";
import { projects } from "@runwield/projects";
import { ownedWorkRecordFiles, requireOwnedWorkRecordFiles } from "../shared/work-records/owner.ts";
import { listManagedWorkRecords, managedPlanStoreActive } from "./managed.ts";

/** Route a passive read to the admitted owner or the explicit retained checkout. */
export function projectWorkRecordReads(cwd: string): Pick<ProjectWorkRecords, "list" | "read"> {
    const homeOwner = projects.home.current();
    const retained = !homeOwner && hasRetainedCheckoutSource(cwd);
    if (managedPlanStoreActive()) {
        const list = async () => (await listManagedWorkRecords(cwd)).map(workRecords.documents.toProjectDocument);
        return {
            list,
            read: async (id) => workRecords.documents.findById(await list(), id),
        };
    }
    if (retained) return workRecordFiles.forCheckout(cwd).workRecords;
    if (homeOwner) return (ownedWorkRecordFiles() ?? workRecordFiles.forOwner(homeOwner)).workRecords;
    return requireOwnedWorkRecordFiles().workRecords;
}
