/** Crash instrumentation wraps real filesystem writes; no Core machinery is replaced. */
import fs from "node:fs";
import promises from "node:fs/promises";
import process from "node:process";
import { readAttachedRecord } from "../record-encoding.ts";
import type { AttachedJsonObject, AttachedOperationName } from "../operations.ts";

type DriverConfig = {
    projectRoot: string;
    operation: AttachedOperationName;
    input: AttachedJsonObject;
    crashPoint?: string;
    timing?: "before" | "after";
    cleanupGate?: { registryPath: string; attemptId: string; entered: string; release: string };
};
type SavedRequest = { kind?: string; interaction?: { type?: string } };
type SavedRecorder = { sections?: { title: string }; invalidSubmissions?: number; failure?: string };
type SavedController = {
    status?: string;
    deliveryEvidence?: { mode?: string };
    validationCheckpoint?: { hostRecorder?: SavedRecorder; pendingHostDecision?: SavedRequest };
};
type SavedWrite = {
    schemaVersion?: number;
    definition?: { status?: string };
    workflow?: { controller?: { revisionId: string } };
    controller?: { executionMode?: string };
    state?: SavedController | string;
    validation?: { request?: SavedRequest; resume?: { kind: string } };
    entries?: Array<{ publication?: { phase: string } }>;
    closure?: { reason?: string };
};
const config: DriverConfig = JSON.parse(await promises.readFile(process.argv[2], "utf8"));
function crashPoint(from: fs.PathLike, to: fs.PathLike): string {
    let point = "";
    try {
        const contents = fs.readFileSync(from, "utf8");
        if (String(to).endsWith("/docs/plans/p.md") && /^status:\s*["']?verified["']?\s*$/m.test(contents)) {
            point = "in_place_verified";
        }
        const saved: SavedWrite = JSON.parse(contents);
        if (saved.definition?.status === "verified" && saved.controller?.executionMode === "non_git_in_place")
            point = "in_place_verified";
        // Inspect the decoded workflow, while still crashing at the actual atomic rename.
        const request: SavedRequest | undefined =
            saved.schemaVersion === 2
                ? readAttachedRecord(String(from)).validation?.request
                : saved.validation?.request;
        if (request?.kind === "decision" && request.interaction?.type === "code_review") point = "code_review_wait";
        if (request?.kind === "recorder") point = "recorder_wait";
        if (saved.validation?.resume?.kind === "decision") point = "code_review_decision";
        if (String(to).endsWith("/plan.wld.json") && saved.workflow?.controller) {
            const projectHome = String(to).slice(0, String(to).lastIndexOf("/plans/"));
            const evidence: SavedWrite = JSON.parse(
                fs.readFileSync(
                    `${projectHome}/internal/plan-packages/controller-evidence/${saved.workflow.controller.revisionId}.json`,
                    "utf8",
                ),
            );
            saved.state = evidence.state;
        }
        if (typeof saved.state === "object" && !String(to).includes("/internal/plan-packages/controller-evidence/")) {
            if (saved.state.status === "verified" && saved.state.deliveryEvidence?.mode === "non_git_in_place") {
                point = "in_place_verified";
            }
            const recorder = saved.state.validationCheckpoint?.hostRecorder;
            if (recorder?.failure) point = "recorder_failure";
            else if (recorder?.sections) point = "recorder_sections";
            else if (recorder?.invalidSubmissions) point = "recorder_rejected";
        }
        const phase = saved.entries?.find((entry) => entry.publication)?.publication?.phase;
        if (phase) point = phase;
        if (saved.closure?.reason === "delivered") point = "delivered_record";
    } catch {
        /* Only JSON receipts define a crash boundary. */
    }
    return point;
}
function crashIf(point: string, timing: "before" | "after") {
    if (point === config.crashPoint && (config.timing ?? "after") === timing) process.exit(86);
}
const rename = promises.rename;
promises.rename = async (from, to) => {
    const point = crashPoint(from, to);
    crashIf(point, "before");
    await rename(from, to);
    const gate = config.cleanupGate;
    if (gate && String(to) === gate.registryPath) {
        const registry: { entries: Array<{ id: string }> } = JSON.parse(await promises.readFile(to, "utf8"));
        if (!registry.entries.some((entry) => entry.id === gate.attemptId)) {
            await promises.writeFile(gate.entered, "cleanup persisted\n");
            while (
                !(await promises.stat(gate.release).then(
                    () => true,
                    () => false,
                ))
            )
                await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
    crashIf(point, "after");
};
const renameSync = fs.renameSync;
fs.renameSync = (from, to) => {
    const point = crashPoint(from, to);
    crashIf(point, "before");
    renameSync(from, to);
    crashIf(point, "after");
};
const remove = promises.rm;
promises.rm = async (path, options) => {
    await remove(path, options);
    if (config.crashPoint === "record_saved" && /\/(?:docs\/)?work-records\/\.[^/]+\.tmp$/.test(String(path))) {
        process.exit(86);
    }
};
// Bun's named builtin exports need an explicit module refresh after instrumentation.
const { mock } = await import("bun:test");
mock.module("node:fs", () => ({ ...fs, default: fs }));
mock.module("node:fs/promises", () => ({ ...promises, default: promises }));
const { runAttachedOperation } = await import("../coordinator.ts");
const result = await runAttachedOperation(config.operation, config.projectRoot, JSON.stringify(config.input));
console.log("ATTACHED_RESULT=" + JSON.stringify(result));
