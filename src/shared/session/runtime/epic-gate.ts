/**
 * @module shared/session/runtime/epic-gate
 * Runs the Epic integration gate inside a hosted Session: the manual entry from
 * the Epic menu and the automatic run after an Epic's last child is delivered.
 * The gate itself lives in `workflow/epic-integration.ts`; this module supplies
 * the system ports and the Session messages around it.
 */

import { emitSystemStatus } from "../session-runtime-events.ts";
import type { HostedSession } from "../hosted-session.js";
import type { EpicIntegrationGateResult } from "../../workflow/epic-integration.ts";

/** Which Epic the integration gate checks. */
export interface RuntimeEpicIntegrationGateOptions {
    epicPlanName: string;
    expectedGeneration?: number;
}

/** Run the integration gate with the system reviewer and check runner, reporting a pause in the Session. */
export async function runEpicGateInSession(
    session: HostedSession,
    projectRoot: string,
    epicPlanName: string,
): Promise<EpicIntegrationGateResult> {
    const { runEpicIntegrationGate } = await import("../../workflow/epic-integration.ts");
    const { SYSTEM_SEMANTIC_REVIEW_PORT } = await import("../../workflow/validation.ts");
    const { systemLocalCIPort } = await import("../../workflow/validation-local-ci.ts");
    const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../../work-records/mnemoteca-port.ts");
    const gate = await runEpicIntegrationGate({
        hostedSession: session,
        projectRoot,
        epicPlanName,
        semanticReviewPort: SYSTEM_SEMANTIC_REVIEW_PORT,
        localCIPort: systemLocalCIPort,
        workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
    });
    if (gate.kind === "not_ready" || gate.kind === "paused") {
        emitSystemStatus(session, gate.reason, { level: "warning", header: "RunWield" });
    }
    return gate;
}

/**
 * After an Epic's last child finishes, bring the Epic up to date with its
 * branch and say whether the integration gate should run. Epics without their
 * own branch keep the legacy status-based completion and never run the gate.
 */
export async function isEpicGateReadyAfterChildren(
    session: HostedSession,
    projectRoot: string,
    epicPlanName: string,
): Promise<boolean> {
    const { reconcileEpicDelivery } = await import("../../workflow/epic-integration.ts");
    const reconciled = await reconcileEpicDelivery(projectRoot, epicPlanName);
    if (!reconciled.state || reconciled.gateReady) return reconciled.gateReady;
    const waiting = reconciled.state.children.filter((child) => !child.settled).map((child) => child.name);
    emitSystemStatus(
        session,
        waiting.length
            ? `Epic ${epicPlanName} is waiting for delivery to ${reconciled.state.branch}: ${waiting.join(", ")}.`
            : `Epic ${epicPlanName} has no integration gate to run.`,
        { level: "info", header: "RunWield" },
    );
    return false;
}
