/** Approve a prepared record after Core establishes non-Git in-place completion. */
import { loadPlan } from "../../plan-store.js";
import { findWorkRecordById, replaceWorkRecord } from "./store.js";
import { approveWorkRecord } from "./lifecycle.ts";
import { formatWorkRecordMarkdown } from "./markdown.js";
import { syncWorkRecordToIndex } from "./index-adapter.ts";
import type { WorkRecordMnemotecaPort } from "./mnemoteca-port.ts";

export async function completeInPlaceWorkRecord(
    cwd: string,
    planName: string,
    mnemotecaPort: WorkRecordMnemotecaPort,
): Promise<void> {
    const plan = await loadPlan(cwd, planName);
    if (plan?.attrs.status !== "verified" || plan.attrs.deliveryEvidence?.mode !== "non_git_in_place") return;
    const id = plan.attrs.workRecord?.recordId;
    if (!id) return;
    let record = await findWorkRecordById(cwd, id);
    if (!record) throw new Error("The prepared in-place Work Record is missing.");
    if (record.attrs.status === "pending_verification") {
        record = await replaceWorkRecord(
            cwd,
            record,
            formatWorkRecordMarkdown(approveWorkRecord(record.attrs), record.body),
        );
    }
    await syncWorkRecordToIndex(cwd, record, { mnemotecaPort });
}
