import { emitSystemStatus } from "../session/session-runtime-events.js";
import type { HostedSession } from "../session/hosted-session.js";

export interface ExecutionWorktreeProgressDetails {
    worktreeBranch: string;
    baseBranch?: string;
}

function baseBranchLabel(baseBranch?: string): string {
    const trimmed = baseBranch?.trim();
    return trimmed ? trimmed : "HEAD";
}

function emitExecutionPreparationStatus(hostedSession: HostedSession | undefined, message: string): boolean {
    return emitSystemStatus(hostedSession, message, { header: "RunWield" });
}

export function emitPreparingExecutionTarget(hostedSession: HostedSession | undefined): boolean {
    return emitExecutionPreparationStatus(hostedSession, "Preparing the implementation target...");
}

export function emitPreparingInPlaceExecution(hostedSession: HostedSession | undefined): boolean {
    return emitExecutionPreparationStatus(hostedSession, "Preparing in-place work because Git is unavailable...");
}

export function emitCreatingExecutionWorktree(hostedSession: HostedSession | undefined, baseBranch?: string): boolean {
    return emitExecutionPreparationStatus(
        hostedSession,
        `Creating the worktree from base branch ${baseBranchLabel(baseBranch)}...`,
    );
}

export function emitCreatedExecutionWorktree(
    hostedSession: HostedSession | undefined,
    details: ExecutionWorktreeProgressDetails,
): boolean {
    return emitExecutionPreparationStatus(
        hostedSession,
        `Created worktree ${details.worktreeBranch} from base branch ${baseBranchLabel(details.baseBranch)}.`,
    );
}

export function emitReusingExecutionWorktree(
    hostedSession: HostedSession | undefined,
    details: ExecutionWorktreeProgressDetails,
): boolean {
    return emitExecutionPreparationStatus(
        hostedSession,
        `Reusing worktree ${details.worktreeBranch} from base branch ${baseBranchLabel(details.baseBranch)}.`,
    );
}

export function emitIndexingExecutionWorktree(hostedSession: HostedSession | undefined): boolean {
    return emitExecutionPreparationStatus(hostedSession, "Indexing the worktree for code search...");
}

export function emitExecutionWorktreeIndexWarning(hostedSession: HostedSession | undefined, reason: string): boolean {
    return emitSystemStatus(hostedSession, `Cymbal index did not complete: ${reason}`, {
        header: "RunWield",
        level: "warning",
    });
}

export function emitMaterializingPlanInExecutionWorktree(hostedSession: HostedSession | undefined): boolean {
    return emitExecutionPreparationStatus(hostedSession, "Copying the Plan into the worktree...");
}

export function emitRestoredPlanInExecutionWorktree(hostedSession: HostedSession | undefined): boolean {
    return emitExecutionPreparationStatus(hostedSession, "Copied the Plan into the worktree.");
}

export function emitReconciledPlanInExecutionWorktree(hostedSession: HostedSession | undefined): boolean {
    return emitExecutionPreparationStatus(hostedSession, "Updated the Plan file in the worktree.");
}

export function emitUpdatingPlanStatusToInProgress(hostedSession: HostedSession | undefined): boolean {
    return emitExecutionPreparationStatus(hostedSession, "Marking the Plan as in progress...");
}

export function emitLaunchingExecutionAgent(
    hostedSession: HostedSession | undefined,
    agentDisplayName: string,
): boolean {
    return emitExecutionPreparationStatus(hostedSession, `Starting ${agentDisplayName}...`);
}
