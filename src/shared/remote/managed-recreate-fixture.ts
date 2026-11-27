import { ok } from "node:assert/strict";
import { createInteractiveSessionRuntime } from "@runwield/session-runtime/services";
import { getCommandDefinition } from "../../cmd/registry.ts";
import { handlePlanRecovery, SYSTEM_RECOVERY_FLOW_PORTS } from "../../cmd/load-plan/plan-recovery-flow.ts";
import type { PlanSessionSurface } from "../../cmd/load-plan/plan-session-types.ts";
import { createSilentUiApi } from "../../ui/tui/api.ts";
import { configureRemoteSettingsConnection } from "./settings-bridge.ts";
import { RemoteSessionControl } from "./session-control-client.ts";
import type { RemoteInteractiveConfig } from "./entry.ts";
import { planDocumentsForCheckout } from "../../plan-store/index.ts";

/** Drive Load Plan recovery with scripted user input and stop at the Agent boundary. */
export async function recreateManagedFixturePlan(
    cwd: string,
    planName: string,
    confirmation: "confirm" | "cancel" | null,
    connection?: RemoteInteractiveConfig["connection"],
) {
    let executions = 0;
    let confirmations = 0;
    let selectedRecreate = false;
    const errors: string[] = [];
    const executePlan = () => {
        executions++;
        return Promise.resolve({ executionComplete: false });
    };
    const uiAPI = createSilentUiApi();
    uiAPI.promptSelect = (title, options) => {
        if (confirmation && !selectedRecreate && options.some(({ value }) => value === "reset")) {
            selectedRecreate = true;
            return Promise.resolve("reset");
        }
        if (/recreate/i.test(title) && options.some(({ value }) => value === "confirm")) {
            confirmations++;
            return Promise.resolve(confirmation);
        }
        return Promise.resolve(null);
    };
    uiAPI.appendSystemMessage = (message, isError) => {
        if (isError) errors.push(message);
    };
    if (connection) {
        configureRemoteSettingsConnection(connection);
        const runtime = createInteractiveSessionRuntime({ remoteSessionControl: new RemoteSessionControl(connection) });
        const { sessionId } = await runtime.createSession({ cwd });
        const loadPlan = getCommandDefinition("load-plan");
        ok(loadPlan);
        runtime.executePlan = executePlan;
        try {
            await loadPlan.execute([planName], { uiAPI, sessionRuntime: runtime, sessionId, slashSurface: "tui" });
        } finally {
            await runtime.closeAllSessions();
        }
        return { confirmations, executions, errors };
    }

    const loaded = await planDocumentsForCheckout(cwd).load(planName);
    ok(loaded?.revision, "Recovery Plan is unavailable.");
    const unavailable = () => {
        throw new Error("Unexpected Session action during managed recovery.");
    };
    const session: PlanSessionSurface = {
        id: "managed-recreate-fixture",
        cwd,
        getActiveAgentName: () => "engineer",
        getEffectiveAgentName: () => "engineer",
        switchAgent: unavailable,
        executePlan,
        runPlanningAgent: unavailable,
        runValidation: unavailable,
        runSlicerAgent: unavailable,
        getActiveExecutionWorkflow: () => null,
        setActiveExecutionWorkflow: unavailable,
        replaceWithExecutionSession: unavailable,
        clearActiveExecutionWorkflow: unavailable,
        reviewPlan: unavailable,
        activateForPlan: () => Promise.resolve(),
    };
    await handlePlanRecovery({
        projectRoot: cwd,
        plan: { ...loaded, planName },
        agentName: "engineer",
        uiAPI,
        session,
        ports: SYSTEM_RECOVERY_FLOW_PORTS,
    });
    return { confirmations, executions, errors };
}
