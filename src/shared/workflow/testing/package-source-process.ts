import { readPlanPackage } from "../../../plan-store/packages.ts";
import { type PackageWorkflowSelection } from "../../../plan-store/workflows.ts";
import { withPackageWorkflow } from "../../../plan-store/workflows.ts";
import { readPublishedDeliverySources, loadPublishedWorkRecordSource } from "../../../plan-store/index.ts";
const selection: PackageWorkflowSelection = JSON.parse(process.argv[2]);
const current = await readPlanPackage(selection.identity, { planId: selection.planId });
if (current.kind !== "loaded") throw new Error(current.message);
const source = await withPackageWorkflow(
    selection.identity.checkoutRoot,
    { ...selection, expectedRevision: current.metadata.revision },
    async () => {
        const root = selection.identity.checkoutRoot;
        if (process.argv[3] === "historical")
            return (await readPublishedDeliverySources(root, JSON.parse(process.argv[4]))).delivered;
        if (process.argv[3] === "fail" || process.argv[3] === "retry") {
            const { retryWorkRecordForPlan } = await import("../../work-records/auto-generation.ts");
            const { createWorkRecordMnemotecaFixture } =
                await import("../../work-records/test-fixtures/mnemoteca-port.ts");
            return await retryWorkRecordForPlan({
                cwd: root,
                planName: current.metadata.name,
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
                runRecorderStep: async (prompt) => {
                    if (process.argv[3] === "fail") throw new Error("Recorder service unavailable");
                    const source = await loadPublishedWorkRecordSource(root, current.metadata.name);
                    if (!source || JSON.parse(prompt).source.body !== source.body)
                        throw new Error("Recorder lost retained source");
                    return { title: "Retried delivery", summary: "Recorded retained delivery inputs." };
                },
            });
        }
        return await loadPublishedWorkRecordSource(root, current.metadata.name);
    },
);
console.log(JSON.stringify(source));
