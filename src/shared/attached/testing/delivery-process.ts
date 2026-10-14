/** Crash instrumentation wraps real filesystem writes; no Core machinery is replaced. */
import { runAttachedOperation } from "../coordinator.ts";
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
    validationCheckpoint?: { hostRecorder?: SavedRecorder; pendingHostDecision?: SavedRequest };
};
type SavedWrite = {
    state?: SavedController | string;
    validation?: { request?: SavedRequest; resume?: { kind: string } };
    entries?: Array<{ publication?: { phase: string } }>;
    closure?: { reason?: string };
};
const config: DriverConfig = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const rename = Deno.rename;
Deno.rename = async (from, to) => {
    let point = "";
    try {
        const contents = await Deno.readTextFile(from);
        if (to.endsWith("/docs/plans/p.md") && /^status:\s*["']?verified["']?\s*$/m.test(contents)) {
            point = "in_place_verified";
        }
        const saved: SavedWrite = JSON.parse(contents);
        if (
            saved.validation?.request?.kind === "decision" &&
            saved.validation.request.interaction?.type === "code_review"
        ) point = "code_review_wait";
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
    } catch { /* Only JSON receipts define a crash boundary. */ }
    if (point === config.crashPoint && config.timing === "before") Deno.exit(86);
    await rename(from, to);
    if (point === config.crashPoint && config.timing !== "before") Deno.exit(86);
};
const result = await runAttachedOperation(config.operation, config.projectRoot, JSON.stringify(config.input));
console.log("ATTACHED_RESULT=" + JSON.stringify(result));
