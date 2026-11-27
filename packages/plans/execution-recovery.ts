import { AsyncLocalStorage } from "node:async_hooks";
import { projects, type HomeProjectOwner, type ProjectStoreIdentity } from "@runwield/projects";
import { readPlanPackage, type LoadedPlanPackage, type PackageAttemptReference } from "./package-storage.ts";
import {
    validateExecutionRecoveryEvidence,
    type ExecutionRecoveryAction,
    type ExecutionRecoveryEvidence,
    type ExecutionRecoveryRequest,
    type RecoveryExecutionRecord,
} from "./project-store-wire.ts";

interface ExecutionRecoveryHost {
    projectId: string;
    repositoryId: string;
    repositoryRoot: string;
    personalOwner: { kind: "managed-remote"; identity: string };
}

interface ExecutionRecoveryOperation {
    planId: string;
    expectedPlanName: string;
    expectedRevision: number;
    attemptId: string;
    action: ExecutionRecoveryAction;
}

type ExecutionRecoveryEntry = Pick<
    RecoveryExecutionRecord,
    | "id"
    | "planId"
    | "planName"
    | "path"
    | "branch"
    | "status"
    | "baseBranch"
    | "baseCommit"
    | "baseTree"
    | "executionBaselineTree"
>;

interface ExecutionRecoveryObservation {
    request: ExecutionRecoveryRequest;
    entry: ExecutionRecoveryEntry;
    observedAt: string;
    transitionId?: string;
}

interface ExecutionRecoveryScope {
    registrationDigest: string;
    executionAccountHome: string;
    repositoryRoot: string;
    action: ExecutionRecoveryAction;
    observation?: ExecutionRecoveryObservation;
}

const recoveryScope = new AsyncLocalStorage<ExecutionRecoveryScope | null>();

function matchesRecoveryAttempt(
    request: ExecutionRecoveryRequest,
    repositoryRoot: string,
    plan: LoadedPlanPackage,
    binding: PackageAttemptReference | undefined,
): boolean {
    const { metadata } = plan;
    return (
        metadata.planId === request.planId &&
        metadata.name === request.planName &&
        (!metadata.archive || !!metadata.archive.restoredAt) &&
        !!binding &&
        binding.attemptId === request.attemptId &&
        binding.personalOwner === request.personalOwner &&
        binding.repositoryId === request.repositoryId &&
        binding.repositoryRoot === repositoryRoot &&
        binding.input.inputs.some((input) => input.planId === request.planId && input.projectId === request.projectId)
    );
}

/** Admit the SSH host's observation for one canonical execution recovery operation. */
export async function withManagedExecutionRecovery<T>(
    owner: HomeProjectOwner,
    host: ExecutionRecoveryHost,
    operation: ExecutionRecoveryOperation,
    observe: (request: ExecutionRecoveryRequest) => Promise<ExecutionRecoveryEvidence>,
    run: () => Promise<T>,
): Promise<T> {
    const { action, expectedRevision } = operation;
    // Even a nested probe starts without access to the enclosing operation's evidence.
    return await recoveryScope.run(null, async () => {
        projects.home.assertStoreIdentity(owner);
        if (
            host.projectId !== owner.projectId ||
            host.repositoryId !== owner.repositoryId ||
            host.personalOwner.kind !== "managed-remote" ||
            host.personalOwner.identity !== owner.personalOwner.identity
        )
            throw new Error("Execution recovery requires the admitted execution host.");

        const request: ExecutionRecoveryRequest = {
            projectId: owner.projectId,
            repositoryId: owner.repositoryId,
            personalOwner: owner.personalOwner.identity,
            planId: operation.planId,
            planName: operation.expectedPlanName,
            attemptId: operation.attemptId,
            purpose: action === "refresh" || action === "recreate" ? "active" : "abandoned",
        };
        const repositoryRoot = host.repositoryRoot;
        const assertCurrentAttempt = async () => {
            const plan = await readPlanPackage(owner, { planId: request.planId });
            if (
                plan.kind !== "loaded" ||
                plan.metadata.revision !== expectedRevision ||
                !matchesRecoveryAttempt(request, repositoryRoot, plan, plan.metadata.workflow?.attempt)
            )
                throw new Error("Execution recovery does not match the current canonical Plan attempt.");
        };
        await assertCurrentAttempt();
        const evidence = await observe({ ...request });
        validateExecutionRecoveryEvidence(request, evidence);
        const { id, planId, planName, path, branch, status, baseBranch, baseCommit, baseTree, executionBaselineTree } =
            evidence.entry;
        const observation: ExecutionRecoveryObservation = {
            request,
            entry: {
                id,
                planId,
                planName,
                path,
                branch,
                status,
                baseBranch,
                baseCommit,
                baseTree,
                executionBaselineTree,
            },
            observedAt: evidence.observedAt,
            transitionId: evidence.transitionId,
        };
        await assertCurrentAttempt();
        const scope: ExecutionRecoveryScope = {
            registrationDigest: owner.registrationDigest,
            executionAccountHome: owner.executionAccountHome,
            repositoryRoot,
            action,
            observation,
        };
        return await recoveryScope.run(scope, async () => {
            try {
                return await run();
            } finally {
                // Async resources created within the operation can outlive its promise.
                scope.observation = undefined;
            }
        });
    });
}

/** Only the scoped operation can use its observation for the matching persisted Plan and attempt. */
export function currentExecutionRecoveryObservation(
    identity: ProjectStoreIdentity,
    plan: LoadedPlanPackage,
    binding = plan.metadata.workflow?.attempt,
    action?: ExecutionRecoveryAction,
): ExecutionRecoveryObservation | null {
    const scope = recoveryScope.getStore();
    const observation = scope?.observation;
    if (!observation || !projects.home.isOwner(identity)) return null;
    const { request } = observation;
    if (
        (action !== undefined && action !== scope.action) ||
        identity.projectId !== request.projectId ||
        identity.repositoryId !== request.repositoryId ||
        identity.personalOwner.kind !== "execution-account" ||
        identity.personalOwner.identity !== request.personalOwner ||
        identity.executionAccountHome !== scope.executionAccountHome ||
        identity.registrationDigest !== scope.registrationDigest ||
        !matchesRecoveryAttempt(request, scope.repositoryRoot, plan, plan.metadata.workflow?.attempt) ||
        !matchesRecoveryAttempt(request, scope.repositoryRoot, plan, binding)
    )
        return null;
    return structuredClone(observation);
}
