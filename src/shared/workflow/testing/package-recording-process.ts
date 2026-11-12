/** Fresh process exercises actual validation with external Recorder and index transports. */
import fs from "node:fs";
import promises from "node:fs/promises";
import { mock } from "bun:test";
import { createWorkRecordMnemotecaFixture } from "../../work-records/test-fixtures/mnemoteca-port.ts";
import type { PackageWorkflowSelection } from "../../../plan-store/workflows.ts";
import type { ValidationHostResume } from "../validation-host-contract.ts";
interface Config {
    selection: PackageWorkflowSelection;
    boundary?: string;
    requestOnly?: boolean;
    failRecorder?: boolean;
    resume?: ValidationHostResume;
    countPath: string;
    ordinary?: boolean;
}
const config: Config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const port = createWorkRecordMnemotecaFixture();
const run = port.run;
port.run = async (...args) => {
    if (config.boundary === "index" && args[0][0] === "add") process.exit(86);
    return await run(...args);
};
mock.module("../../work-records/mnemoteca-port.ts", () => ({ SYSTEM_WORK_RECORD_MNEMOTECA_PORT: port }));
const rename = fs.renameSync;
mock.module("node:fs", () => ({
    ...fs,
    default: fs,
    renameSync(from: fs.PathLike, to: fs.PathLike) {
        rename(from, to);
        const path = String(to);
        if (!path.endsWith(".json")) return;
        const value = JSON.parse(fs.readFileSync(path, "utf8"));
        if (
            (config.boundary === "source" && value.stage === "recording") ||
            (config.boundary === "sections" && path.includes("/preparations/") && value.sections) ||
            (config.boundary === "backlink" &&
                path.endsWith("/plan.wld.json") &&
                value.workflow?.workRecord?.recordId) ||
            (config.boundary === "manifest" && path.includes("/publications/") && value.preparedRecord) ||
            (config.boundary === "locations" && path.includes("/locations/")) ||
            (config.boundary === "settled" && path.includes("/preparations/") && value.settled)
        )
            process.exit(86);
    },
}));
const link = promises.link;
const move = promises.rename;
const operations = {
    ...promises,
    async link(from: string, to: string) {
        await link(from, to);
        if (config.boundary === "pending" && to.includes("/work-records/") && to.endsWith(".md")) process.exit(86);
    },
    async rename(from: string, to: string) {
        if (
            config.boundary === "before_approval" &&
            to.includes("/work-records/") &&
            to.endsWith(".md") &&
            (await promises.readFile(from, "utf8")).match(/status: [\"]?approved/)
        )
            process.exit(86);
        await move(from, to);
        if (
            config.boundary === "supersession" &&
            to.includes("/work-records/") &&
            to.endsWith(".md") &&
            (await promises.readFile(to, "utf8")).match(/status: [\"]?superseded/)
        )
            process.exit(86);
        if (
            config.boundary === "approval" &&
            to.includes("/work-records/") &&
            to.endsWith(".md") &&
            (await promises.readFile(to, "utf8")).match(/status: [\"]?approved/)
        )
            process.exit(86);
    },
};
mock.module("node:fs/promises", () => ({ ...operations, default: operations }));
const { readPlanPackage } = await import("../../../plan-store/packages.ts");
const { withPackageWorkflow } = await import("../../../plan-store/workflows.ts");
const { continueHostTurnValidation } = await import("../validation-host-turn.ts");
const current = await readPlanPackage(config.selection.identity, { planId: config.selection.planId });
if (current.kind !== "loaded") throw new Error(current.message);
await withPackageWorkflow(
    config.selection.identity.checkoutRoot,
    { ...config.selection, expectedRevision: current.metadata.revision },
    async () => {
        let resume = config.resume;
        for (let step = 0; step < 5; step++) {
            const result = await continueHostTurnValidation({
                projectRoot: config.selection.identity.checkoutRoot,
                planName: current.metadata.name,
                resume,
            });
            if (result.kind !== "host_request" || config.requestOnly) {
                console.log(JSON.stringify(result));
                return;
            }
            if (result.request.kind !== "recorder") throw new Error(JSON.stringify(result));
            const request: { successorRecordId: string } = JSON.parse(result.request.prompt.split("\n")[0]);
            fs.appendFileSync(config.countPath, `${request.successorRecordId}\n`);
            resume = {
                kind: "recorder",
                identity: result.request.identity,
                sections: config.failRecorder
                    ? "invalid"
                    : JSON.stringify({ title: "Delivery outcome", summary: "Recorded retained package input." }),
            };
        }
        throw new Error("Recorder never settled");
    },
);
