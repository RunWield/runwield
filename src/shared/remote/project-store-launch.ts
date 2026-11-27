import type { PreparedPlanImport } from "@runwield/plans/store";
import type { PublicationAttempt } from "@runwield/workflow/publication";
import { projects, type HomeProjectOwner, type ProjectIdentity } from "@runwield/projects";
import { validateManagedRuntimeTransfer, type ManagedRuntimeTransfer } from "../project-runtime-managed.ts";
import { basename } from "node:path";
import { getCwd, getHomeDir } from "../../constants.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import { fixedPythonCommand } from "./target.ts";
import {
    receiveManagedRuntimeTransfer,
    acknowledgeManagedRuntimeRetirement,
    type PlanExecutionHost,
} from "../../plan-store/index.ts";

/** Trusted launcher input. HTTP requests never supply these locations or executable identities. */
export interface ManagedProjectStoreLaunch {
    host: string;
    cwd: string;
    remoteHome: string;
    executable: string;
}
export interface ManagedProjectStoreAdmission {
    owner: HomeProjectOwner;
    execution: PlanExecutionHost;
}
const ADMIT = fixedPythonCommand(String.raw`import json, subprocess, sys
request = json.loads(sys.stdin.readline())
result = subprocess.run([request['executable'], '--remote-project-admission'], input=json.dumps(request['admission']) + '\n', text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
`);

/** Inspect identity independently of whether this laptop has admitted a Plan store. */
export async function resolveManagedProjectIdentity(
    launch: ManagedProjectStoreLaunch,
    signal: AbortSignal,
    admit: boolean,
): Promise<(ProjectIdentity & PlanExecutionHost) | null> {
    const ownerIdentity = getHomeDir();
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, ADMIT],
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                admission: { cwd: launch.cwd, ownerIdentity, admit },
            }) + "\n",
        signal,
    });
    if (!result.success || result.stdout.byteLength > 16 * 1024)
        throw new Error("Remote Project admission did not return verified identity.");
    const execution: (ProjectIdentity & PlanExecutionHost) | null = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
    if (execution === null && !admit) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
        !execution ||
        ![execution.projectId, execution.repositoryId, execution.checkoutId].every((id) => uuid.test(id)) ||
        execution.cwd !== launch.cwd ||
        execution.executionAccountHome !== launch.remoteHome ||
        !execution.checkoutRoot.startsWith("/") ||
        execution.checkoutRoot.includes("\0") ||
        execution.personalOwner?.kind !== "managed-remote" ||
        execution.personalOwner.identity !== ownerIdentity
    )
        throw new Error("Remote Project admission does not match this launch.");
    signal.throwIfAborted();
    return execution;
}

/** Deliberate admission uses the same verified runtime and target as the interactive launch. */
export async function resolveManagedProjectStore(
    launch: ManagedProjectStoreLaunch,
    signal: AbortSignal,
    admit: boolean,
): Promise<ManagedProjectStoreAdmission | null> {
    const execution = await resolveManagedProjectIdentity(launch, signal, admit);
    if (!execution) return null;
    const owner = admit
        ? await projects.home.register({
              projectId: execution.projectId,
              repositoryId: execution.repositoryId,
              displayName: basename(execution.checkoutRoot),
          })
        : projects.home.find(execution.projectId, execution.repositoryId);
    if (owner && admit) await transferManagedRuntime(launch, owner, signal);
    return owner ? { owner, execution } : null;
}

const PUBLICATION_PROOF = fixedPythonCommand(String.raw`import json, subprocess, sys
request = json.loads(sys.stdin.readline())
result = subprocess.run([request['executable'], '--remote-publication-proof'], input=json.dumps(request['proof']) + '\n', text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
`);
export async function proveManagedProjectPublication(
    launch: ManagedProjectStoreLaunch,
    manifest: import("@runwield/plans/store").PackagePublicationManifest,
    retained?: PublicationAttempt,
    signal?: AbortSignal,
) {
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, PUBLICATION_PROOF],
        signal,
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                proof: { cwd: launch.cwd, ownerIdentity: getHomeDir(), manifest, retained },
            }) + "\n",
    });
    if (!result.success || result.stdout.byteLength > 1024 * 1024)
        throw new Error("Remote Git proof is unavailable; retain the publication attempt.");
    const attempt: PublicationAttempt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (
        attempt.attemptId !== manifest.attemptId ||
        attempt.planId !== manifest.planId ||
        attempt.packageInput?.inputId !== manifest.inputId ||
        !attempt.verifiedAt ||
        !attempt.publishedCommit ||
        !attempt.publicationMode
    )
        throw new Error("Remote publication proof does not match the requested owner input.");
    return attempt;
}

const RUNTIME_TRANSFER = fixedPythonCommand(String.raw`import json, subprocess, sys
request = json.loads(sys.stdin.readline())
result = subprocess.run([request['executable'], '--remote-runtime-transfer'], input=json.dumps(request['transfer']) + '\n', text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
`);
async function transferManagedRuntime(
    launch: ManagedProjectStoreLaunch,
    owner: HomeProjectOwner,
    signal: AbortSignal,
): Promise<void> {
    const invoke = async (retire?: string) => {
        const result = await captureForegroundProcess("ssh", {
            cwd: getCwd(),
            args: ["-T", "--", launch.host, RUNTIME_TRANSFER],
            signal,
            stdinText:
                JSON.stringify({
                    executable: launch.executable,
                    transfer: {
                        cwd: launch.cwd,
                        ownerIdentity: owner.personalOwner.identity,
                        ...(retire ? { retire } : {}),
                    },
                }) + "\n",
        });
        if (!result.success || result.stdout.byteLength > 64 * 1024 * 1024)
            throw new Error("Managed personal runtime transfer remains recoverable.");
        return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    };
    let transfer: ManagedRuntimeTransfer = JSON.parse(await invoke());
    for (let generation = 0; generation < 3; generation++) {
        validateManagedRuntimeTransfer(transfer);
        await receiveManagedRuntimeTransfer(owner, transfer);
        signal.throwIfAborted();
        try {
            const acknowledgement: { retired: string } = JSON.parse(await invoke(transfer.transferId));
            if (acknowledgement.retired !== transfer.transferId)
                throw new Error("Remote runtime retirement was not confirmed.");
            await acknowledgeManagedRuntimeRetirement(owner, transfer);
            return;
        } catch (error) {
            signal.throwIfAborted();
            const refreshed: ManagedRuntimeTransfer = JSON.parse(await invoke());
            validateManagedRuntimeTransfer(refreshed);
            if (refreshed.transferId === transfer.transferId) throw error;
            transfer = refreshed;
        }
    }
    throw new Error("Personal runtime is still changing; its staged transfer remains recoverable.");
}

export async function proveManagedRetainedPublication(
    launch: ManagedProjectStoreLaunch,
    execution: import("../../plan-store/index.ts").RetainedManagedExecution,
    retained?: PublicationAttempt,
    signal?: AbortSignal,
    candidateOnly = false,
    requireCleanup = false,
) {
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, PUBLICATION_PROOF],
        signal,
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                proof: {
                    cwd: launch.cwd,
                    ownerIdentity: getHomeDir(),
                    execution,
                    retained,
                    candidateOnly,
                    requireCleanup,
                },
            }) + "\n",
    });
    if (!result.success || result.stdout.byteLength > 1024 * 1024)
        throw new Error("Retained execution Git proof is unavailable.");
    const proof: PublicationAttempt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (
        proof.planId !== execution.planId ||
        proof.attemptId !== execution.attempt.id ||
        proof.executionCwd !== execution.attempt.path ||
        proof.executionBranch !== execution.attempt.branch ||
        (!candidateOnly && (!proof.verifiedAt || !proof.publishedCommit || !proof.publicationMode))
    )
        throw new Error("Retained execution Git proof changed identity.");
    return proof;
}

export interface RetainedRecordingProof {
    proof: PublicationAttempt;
    sources: import("../../plan-store/index.ts").PublishedDeliverySources;
    recordCopy: import("@runwield/plans/publication-copies").DeliveryCopy | null;
}
/** Source bytes are read by the trusted execution process from the independently proven commit. */
export async function readManagedRetainedRecordingProof(
    launch: ManagedProjectStoreLaunch,
    execution: import("../../plan-store/index.ts").RetainedManagedExecution,
    retained: PublicationAttempt | undefined,
    pendingPublication: boolean,
    signal?: AbortSignal,
): Promise<RetainedRecordingProof> {
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, PUBLICATION_PROOF],
        signal,
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                proof: {
                    cwd: launch.cwd,
                    ownerIdentity: getHomeDir(),
                    execution,
                    retained,
                    candidateOnly: pendingPublication,
                    recordingSource: true,
                },
            }) + "\n",
    });
    if (!result.success || result.stdout.byteLength > 1024 * 1024)
        throw new Error("Retained recording source is unavailable.");
    const value: RetainedRecordingProof = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (
        value.proof.planId !== execution.planId ||
        value.proof.attemptId !== execution.attempt.id ||
        value.proof.executionCwd !== execution.attempt.path ||
        value.proof.executionBranch !== execution.attempt.branch ||
        value.sources.delivered.planId !== execution.planId ||
        (!pendingPublication && (!value.proof.verifiedAt || !value.proof.publishedCommit))
    )
        throw new Error("Retained recording source changed ownership.");
    return value;
}

export async function proveManagedExecutionRecovery(
    launch: ManagedProjectStoreLaunch,
    request: import("../workflow/execution-recovery-proof.ts").ExecutionRecoveryRequest,
    signal?: AbortSignal,
): Promise<import("../workflow/execution-recovery-proof.ts").ExecutionRecoveryEvidence> {
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, PUBLICATION_PROOF],
        signal,
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                proof: { cwd: launch.cwd, ownerIdentity: getHomeDir(), recovery: request },
            }) + "\n",
    });
    if (!result.success || result.stdout.byteLength > 1024 * 1024)
        throw new Error("Execution recovery proof is unavailable.");
    const proof: import("../workflow/execution-recovery-proof.ts").ExecutionRecoveryEvidence = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
    if (
        JSON.stringify(proof.request) !== JSON.stringify(request) ||
        proof.entry.id !== request.attemptId ||
        proof.entry.planId !== request.planId ||
        proof.entry.planName !== request.planName ||
        (request.purpose === "abandoned" ? proof.entry.status !== "abandoned" : proof.entry.status === "abandoned")
    )
        throw new Error("Execution recovery proof changed ownership.");
    return proof;
}

export async function proveManagedRetainedFamily(
    launch: ManagedProjectStoreLaunch,
    execution: import("../../plan-store/index.ts").RetainedManagedExecution,
    member: import("../../plan-store/index.ts").RetainedFamilyIdentity,
    signal?: AbortSignal,
): Promise<import("../../plan-store/index.ts").RetainedFamilyMember | null> {
    const recovery: import("../workflow/execution-recovery-proof.ts").ExecutionRecoveryRequest = {
        projectId: execution.projectId,
        repositoryId: execution.repositoryId,
        personalOwner: execution.personalOwner,
        planId: execution.planId,
        planName: execution.planName,
        attemptId: execution.attempt.id,
        purpose: "active",
    };
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, PUBLICATION_PROOF],
        signal,
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                proof: { cwd: launch.cwd, ownerIdentity: getHomeDir(), recovery, family: member },
            }) + "\n",
    });
    if (!result.success || result.stdout.byteLength > 1024 * 1024)
        throw new Error("Retained family identity proof is unavailable.");
    const response: {
        request: typeof recovery;
        member: import("../../plan-store/index.ts").RetainedFamilyMember | null;
    } = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (
        JSON.stringify(response.request) !== JSON.stringify(recovery) ||
        (response.member &&
            (response.member.planName !== member.planName ||
                (member.planId && response.member.planId !== member.planId)))
    )
        throw new Error("Retained family proof changed identity.");
    return response.member;
}

export async function readManagedImportSource(
    launch: ManagedProjectStoreLaunch,
    request: import("../../plan-store/index.ts").ManagedImportPreparationRequest,
    signal?: AbortSignal,
): Promise<PreparedPlanImport> {
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, PUBLICATION_PROOF],
        signal,
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                proof: { cwd: launch.cwd, ownerIdentity: getHomeDir(), importSource: request },
            }) + "\n",
    });
    if (!result.success || result.stdout.byteLength > 8 * 1024 * 1024)
        throw new Error("Managed import source is unavailable or changed.");
    const prepared: PreparedPlanImport = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (
        prepared.selection !== request.selection ||
        !Array.isArray(prepared.members) ||
        !Array.isArray(prepared.observations)
    )
        throw new Error("Managed import source changed selection.");
    return prepared;
}

export async function proveManagedNonGitExecution(
    launch: ManagedProjectStoreLaunch,
    identity: import("../workflow/execution-recovery-proof.ts").ManagedExecutionIdentity,
    signal?: AbortSignal,
): Promise<void> {
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, PUBLICATION_PROOF],
        signal,
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                proof: { cwd: launch.cwd, ownerIdentity: getHomeDir(), nonGit: identity },
            }) + "\n",
    });
    if (!result.success || result.stdout.byteLength > 65536) throw new Error("Non-Git execution proof is unavailable.");
    const proof: { identity: typeof identity; executionMode: string } = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
    if (proof.executionMode !== "non_git_in_place" || JSON.stringify(proof.identity) !== JSON.stringify(identity))
        throw new Error("Non-Git execution proof changed ownership.");
}

export async function readManagedRetentionContext(
    launch: ManagedProjectStoreLaunch,
    binding: import("../../plan-store/index.ts").ProjectStoreBinding,
    signal?: AbortSignal,
) {
    const result = await captureForegroundProcess("ssh", {
        cwd: getCwd(),
        args: ["-T", "--", launch.host, PUBLICATION_PROOF],
        signal,
        stdinText:
            JSON.stringify({
                executable: launch.executable,
                proof: { cwd: launch.cwd, ownerIdentity: getHomeDir(), retention: binding },
            }) + "\n",
    });
    if (!result.success || result.stdout.byteLength > 1024 * 1024)
        throw new Error("Cannot verify retention policy and unfinished publication in the bound execution repository.");
    const response: { binding: typeof binding; context: import("../../plan-store/index.ts").RetentionContext } =
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout));
    if (
        !(await import("./project-store-protocol.ts")).sameProjectStoreBinding(binding, response.binding) ||
        !Array.isArray(response.context?.pending)
    )
        throw new Error("Retention proof changed its repository binding.");
    for (const policy of [response.context.policy?.records, response.context.policy?.plans])
        if (!policy || ![policy.keepLast, policy.retentionDays].every((n) => Number.isSafeInteger(n) && n >= 0))
            throw new Error("Invalid execution repository retention settings.");
    return response.context;
}
