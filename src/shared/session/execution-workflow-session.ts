import type { ActiveExecutionWorkflow } from "../types.js";
import type { HostedSession, MinimalSessionManagerLike } from "./hosted-session.js";

export interface ExecutionWorkflowSnapshot {
    version: 1;
    workflow: ActiveExecutionWorkflow | null;
}

interface ExecutionWorkflowEntry {
    type: string;
    customType?: string;
    data?: ExecutionWorkflowSnapshot;
}

/** Durable execution ownership, including an explicit clear tombstone. */
export const EXECUTION_WORKFLOW_CUSTOM_TYPE = "runwield.execution_workflow";

export function readExecutionWorkflowSnapshot(
    manager: MinimalSessionManagerLike | null,
): ExecutionWorkflowSnapshot | undefined {
    const entries = manager?.getBranch?.() || manager?.getEntries?.() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as ExecutionWorkflowEntry;
        if (entry.type !== "custom" || entry.customType !== EXECUTION_WORKFLOW_CUSTOM_TYPE) continue;
        // A malformed marker also forbids legacy inference.
        const data = entry.data;
        if (data?.version !== 1 || !data.workflow) return { version: 1, workflow: null };
        const workflow = data.workflow;
        if (
            (typeof workflow.planName !== "string" ||
                (!workflow.planName && workflow.triageMeta?.classification !== "QUICK_FIX")) ||
            !["engineer", "frontend-engineer"].includes(workflow.executionAgent)
        ) {
            return { version: 1, workflow: null };
        }
        return { version: 1, workflow };
    }
    return undefined;
}

export function recordExecutionWorkflowSnapshot(session: HostedSession): void {
    const manager = session.getRootSessionManager();
    if (!manager) return;
    if (session.getManagedMetadata()) {
        const capability = session.getManagedOperationCapability();
        if (!capability) throw new Error("managed_operation_required");
        capability.assertLive();
    }
    appendExecutionWorkflowSnapshot(manager, session.getActiveExecutionWorkflow());
}

/** Append to a transcript while its caller owns the Session writer lock. */
export function appendExecutionWorkflowSnapshot(
    manager: MinimalSessionManagerLike,
    workflow: ActiveExecutionWorkflow | null,
): void {
    manager.appendCustomEntry?.(EXECUTION_WORKFLOW_CUSTOM_TYPE, { version: 1, workflow });
}
