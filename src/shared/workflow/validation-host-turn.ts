/** Session-free composition. Validation policy remains in the shared attempt owner and engine. */
import { runValidationAttempt } from "./validation-supervisor.ts";
import type { ValidationProgressRecord, ValidationSessionPort, ValidationWorkflowState } from "./validation-ports.ts";
import type { HostTurnValidationResult, ValidationHostResume } from "./validation-host-contract.ts";
import { createGitPort } from "../git-port.ts";
import { getAgentDisplayName } from "./validation-prompts.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";

export type ContinueHostTurnValidationArgs = {
    projectRoot: string;
    planName: string;
    resume?: ValidationHostResume;
};
export type {
    HostTurnValidationResult,
    ValidationHostRequest,
    ValidationHostResume,
} from "./validation-host-contract.ts";

function createHostTurnPort(cwd: string): ValidationSessionPort {
    let workflow: ValidationWorkflowState | null = null;
    let progress: ValidationProgressRecord | undefined;
    const unexpected = () => {
        throw new Error("The engine reached an unsupported host-turn wait.");
    };
    return {
        cwd,
        getActiveWorkflow: () => workflow,
        setActiveWorkflow: (value) => {
            workflow = value;
        },
        rememberPosition() {},
        clearPosition() {},
        getCurrentProgress: () => progress,
        setCurrentProgress: (value) => {
            progress = value;
        },
        emitStatus() {},
        emitAssistantMessage() {},
        requestInteraction: unexpected,
        registerActiveInteraction() {},
        unregisterActiveInteraction() {},
        runIndependentRepairTurn: unexpected,
        continueLastRepairTurn: unexpected,
        runIsolatedAgentSession: unexpected,
        getAgentDisplayName,
        handoffVerifiedPublication: unexpected,
        runPostVerificationHandoffs: unexpected,
    };
}

export async function continueHostTurnValidation(
    args: ContinueHostTurnValidationArgs,
): Promise<HostTurnValidationResult> {
    const result = await runValidationAttempt({
        projectRoot: args.projectRoot,
        planName: args.planName,
        hostResume: args.resume,
        buildEngineArgs: (claim) => ({
            planName: args.planName,
            planContent: claim.planContent,
            triageMeta: claim.triageMeta,
            session: createHostTurnPort(args.projectRoot),
            git: createGitPort(),
            localCI: {
                run() {
                    throw new Error("Host-turn CI is owned by the engine.");
                },
            },
            workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
            supportsSemanticRepairHandoff: true,
            hostTurn: { resume: args.resume },
        }),
    });
    if (result.kind === "host_request" && result.hostRequest) {
        return { kind: "host_request", request: result.hostRequest };
    }
    if (result.kind === "awaiting_delivery") return { kind: "awaiting_delivery", planName: args.planName };
    return {
        kind: result.kind === "failed" ? "failed" : "paused",
        reason: result.reason || "Validation paused.",
        recovery: result.recovery,
    };
}
