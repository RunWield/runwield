import { readPlanPackage } from "../../plan-package-store.ts";
import { withPackageWorkflow, type PackageWorkflowSelection } from "../package-workflow.ts";
import { loadPublishedWorkRecordSource } from "../../work-records/published-source.ts";
const selection: PackageWorkflowSelection = JSON.parse(process.argv[2]);
const current = await readPlanPackage(selection.identity, { planId: selection.planId });
if (current.kind !== "loaded") throw new Error(current.message);
const source = await withPackageWorkflow(
    selection.identity.checkoutRoot,
    { ...selection, expectedRevision: current.metadata.revision },
    () => loadPublishedWorkRecordSource(selection.identity.checkoutRoot, current.metadata.name),
);
console.log(JSON.stringify(source));
