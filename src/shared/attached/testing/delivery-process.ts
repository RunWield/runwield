/** Crash instrumentation wraps real filesystem writes; no Core machinery is replaced. */
import fs from "node:fs";
import promises from "node:fs/promises";
import process from "node:process";
import type { AttachedJsonObject, AttachedOperationName } from "../operations.ts";

type DriverConfig = {
    projectRoot: string;
    operation: AttachedOperationName;
    input: AttachedJsonObject;
    crashPoint?: string;
    timing?: "before" | "after";
};
type SavedRequest = { kind?: string; interaction?: { type?: string } };
type SavedRecorder = { sections?: { title: string }; invalidSubmissions?: number };
type SavedController = {
    status?: string;
    deliveryEvidence?: { mode?: string };
    validationCheckpoint?: { hostRecorder?: SavedRecorder; pendingHostDecision?: SavedRequest };
};
type SavedWrite = {
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
        if (
            saved.validation?.request?.kind === "decision" &&
            saved.validation.request.interaction?.type === "code_review"
        )
            point = "code_review_wait";
        if (saved.validation?.request?.kind === "recorder") point = "recorder_wait";
        if (saved.validation?.resume?.kind === "decision") point = "code_review_decision";
        if (typeof saved.state === "object") {
            if (saved.state.status === "verified" && saved.state.deliveryEvidence?.mode === "non_git_in_place") {
                point = "in_place_verified";
            }
            const recorder = saved.state.validationCheckpoint?.hostRecorder;
            if (recorder?.sections) point = "recorder_sections";
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
    if (config.crashPoint === "record_saved" && /\/docs\/work-records\/\.[^/]+\.tmp$/.test(String(path))) {
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
