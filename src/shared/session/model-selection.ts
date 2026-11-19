import { isUnsupportedModelExecutionBackendError } from "../models/model-execution.ts";
import { getSettingsManager, setRemoteDefaultModelSelection } from "../settings.ts";
import { remotePersonalResourcesActive } from "../remote/personal-resources.ts";
import type { SessionRuntime } from "./session-runtime.ts";

export interface ModelActivationResult {
    status: "active" | "deferred";
    message?: string;
}

/** Persist the default used by future sessions without claiming an active session changed. */
export async function setDefaultModelSelection(
    projectRoot: string,
    model: string,
    provider?: string,
): Promise<void> {
    if (remotePersonalResourcesActive()) {
        await setRemoteDefaultModelSelection(projectRoot, model, provider || "");
        return;
    }
    const settingsManager = getSettingsManager(projectRoot);
    await settingsManager.setDefaultModel(model);
    await settingsManager.setDefaultProvider(provider || "");
}

/** Reconfigure the real Runtime session without changing future Session defaults. */
export async function setActiveSessionModel(
    runtime: SessionRuntime,
    sessionId: string,
    model: string,
    provider?: string,
    options: { persistUnactivatedDefault?: boolean } = {},
): Promise<ModelActivationResult> {
    const snapshot = runtime.getSessionSnapshot(sessionId);
    if (!snapshot) throw new Error("Cannot set model for a missing runtime session.");

    try {
        const result = await runtime.reconfigureSessionModel(sessionId, model, provider || "");
        if (!result?.ok) throw new Error("The active Session could not switch models.");
    } catch (error) {
        if (!(error instanceof Error) || !isUnsupportedModelExecutionBackendError(error)) throw error;
        return {
            status: "deferred",
            message: `${error.message} The current Session was not switched.`,
        };
    }

    const afterSwitch = runtime.getSessionSnapshot(sessionId);
    if (options.persistUnactivatedDefault !== false && !afterSwitch?.activeAgent) {
        await setDefaultModelSelection(afterSwitch?.cwd || snapshot.cwd, model, provider || "");
    }

    return { status: "active" };
}
