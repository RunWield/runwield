import type { HostedSession } from "../hosted-session.js";
import { emitSystemStatus } from "../session-runtime-events.js";

/** Retry a delivered Plan's Work Record within the current managed capability. */
export async function retrySessionWorkRecord(session: HostedSession, planName: string) {
    const { retryWorkRecordForPlan } = await import("../../work-records/auto-generation.ts");
    const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../../work-records/mnemoteca-port.ts");
    const controller = new AbortController();
    const interactionId = `work-record-retry:${crypto.randomUUID()}`;
    const capabilitySignal = session.getManagedOperationCapability()?.signal;
    const abort = () => controller.abort();
    capabilitySignal?.addEventListener("abort", abort, { once: true });
    if (capabilitySignal?.aborted) abort();
    session.addActiveInteraction(interactionId, { abortController: controller });
    try {
        emitSystemStatus(session, `Retrying the Work Record for ${planName}.`);
        return await retryWorkRecordForPlan({
            cwd: session.cwd,
            planName,
            signal: controller.signal,
            mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        });
    } finally {
        capabilitySignal?.removeEventListener("abort", abort);
        session.removeActiveInteraction(interactionId);
    }
}
