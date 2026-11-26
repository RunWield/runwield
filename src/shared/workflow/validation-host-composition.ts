import { createAgentRegistry } from "@runwield/agents";
import { createGitPort } from "../git-port.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { ValidationHostShutdown, type ValidationHostResume } from "@runwield/workflow/host-contract";
import type { ValidationProgressRecord, ValidationSessionPort, ValidationWorkflowState } from "./validation-ports.ts";
import type { ValidationLoopArgs } from "./validation-types.ts";

interface HostTurnCompositionOptions {
    projectRoot: string;
    planName: string;
    resume?: ValidationHostResume;
    signal?: AbortSignal;
}

const agentRegistry = createAgentRegistry();

/** Compose the engine without starting or loading a Session. */
export function createHostTurnPort(cwd: string, signal?: AbortSignal): ValidationSessionPort {
    let workflow: ValidationWorkflowState | null = null;
    let progress: ValidationProgressRecord | undefined;
    const unexpected = () => {
        throw new Error("The engine reached an unsupported host-turn wait.");
    };
    return {
        cwd,
        assertLive() {
            if (signal?.aborted) throw new ValidationHostShutdown();
        },
        getActiveWorkflow: () => workflow,
        setActiveWorkflow: (value) => {
            workflow = value;
        },
        releaseActiveAgent() {},
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
        getAgentDisplayName: (agentName, projectRoot) => agentRegistry.displayName(agentName, projectRoot),
        async handoffVerifiedPublication() {},
        runPostVerificationHandoffs: unexpected,
    };
}

/** Build the concrete Session-free engine composition for a claimed attempt. */
export function createHostTurnValidationArgs(
    args: HostTurnCompositionOptions,
    claim: Pick<ValidationLoopArgs, "planContent" | "triageMeta">,
): ValidationLoopArgs {
    return {
        planName: args.planName,
        planContent: claim.planContent,
        triageMeta: claim.triageMeta,
        session: createHostTurnPort(args.projectRoot, args.signal),
        git: createGitPort(),
        localCI: {
            run() {
                throw new Error("Host-turn CI is owned by the engine.");
            },
        },
        workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
        supportsSemanticRepairHandoff: true,
        hostTurn: { resume: args.resume, signal: args.signal },
    };
}
