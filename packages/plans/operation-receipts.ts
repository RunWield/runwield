/** Owner-private receipt recovery. The package catalog lock protects both intent and effect. */
import type { ManualQaSectionAppend } from "./store.ts";
import type { ProjectStoreIdentity } from "@runwield/projects";
import { localPackageLayout } from "./package-files.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, lstatSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { writeJsonAtomically, writeTextAtomically, syncParentDirectory } from "@runwield/resources/fs";

export interface OperationOutcome {
    operationId: string;
    status: "completed" | "unstarted" | "pending" | "unavailable";
    revision?: string;
    recordId?: string;
    planId?: string;
    snapshotId?: string;
    snapshotDigest?: string;
    attemptId?: string;
    qaStatus?: ManualQaSectionAppend["status"];
}
interface Receipt {
    version: 1;
    operationId: string;
    digest: string;
    planId: string;
    outcome: OperationOutcome;
}
interface Effect {
    version: 1;
    identityPath?: string;
    targetPlanId?: string;
    receipt: Receipt;
    path: string;
    beforeHash: string | null;
    after: string;
    afterHash: string;
}
interface OperationScope {
    directory: string;
    receipt: Receipt;
    settlementRequired: boolean;
}
const operations = new AsyncLocalStorage<OperationScope>();
interface JsonFields {
    [key: string]: JsonValue;
}
type JsonValue = string | number | boolean | null | JsonValue[] | JsonFields;
export function operationDigest(value: string): string {
    const canonical = (input: JsonValue): JsonValue =>
        Array.isArray(input)
            ? input.map(canonical)
            : input && typeof input === "object"
              ? Object.fromEntries(
                    Object.keys(input)
                        .sort()
                        .map((key) => [key, canonical(input[key]!)]),
                )
              : input;
    const parsed: JsonValue = JSON.parse(value);
    return operationHash(JSON.stringify(canonical(parsed)));
}
export const operationHash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Canonical location for the admitted Project's package operation evidence. */
export function planOperationReceiptDirectory(owner: ProjectStoreIdentity): string {
    return localPackageLayout(owner).internal;
}

const receiptPath = (directory: string, id: string) => join(directory, "operations", `${id}.json`);
const effectPath = (directory: string) => join(directory, "operation-effect.json");

function assertSafePath(root: string, path: string): void {
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Operation evidence leaves its owner.");
    for (let current = path; current !== root; current = dirname(current)) {
        if (existsSync(current) && lstatSync(current).isSymbolicLink())
            throw new Error("Operation evidence uses a symlink.");
    }
}
function readReceipt(directory: string, id: string): Receipt | null {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid operation identity.");
    const path = receiptPath(directory, id);
    assertSafePath(directory, path);
    if (!existsSync(path)) return null;
    if (!lstatSync(path).isFile() || lstatSync(path).size > 8192) throw new Error("Invalid operation receipt size.");
    const receipt: Receipt = JSON.parse(readFileSync(path, "utf8"));
    if (
        receipt.version !== 1 ||
        receipt.operationId !== id ||
        typeof receipt.planId !== "string" ||
        receipt.outcome.operationId !== id ||
        !/^[a-f0-9]{64}$/.test(receipt.digest) ||
        !["unstarted", "completed", "pending"].includes(receipt.outcome.status) ||
        (receipt.outcome.status === "completed" && !/^[a-f0-9]{64}$/.test(receipt.outcome.revision || "")) ||
        (receipt.outcome.qaStatus !== undefined &&
            !["recorded", "already_present"].includes(receipt.outcome.qaStatus)) ||
        (receipt.outcome.snapshotId !== undefined &&
            (!/^[a-f0-9-]{36}$/.test(receipt.outcome.snapshotId) ||
                !/^[a-f0-9]{64}$/.test(receipt.outcome.snapshotDigest || "") ||
                !receipt.outcome.attemptId))
    )
        throw new Error("Operation receipt is contradictory.");
    return receipt;
}

/** Resolve retained effect evidence before admitting another package writer. Never invoke its command again. */
export function recoverOperationEffect(directory: string, plans: string): void {
    const path = effectPath(directory);
    assertSafePath(directory, path);
    if (!existsSync(path)) return;
    if (!lstatSync(path).isFile() || lstatSync(path).size > 16 * 1024 * 1024)
        throw new Error("Invalid operation effect size.");
    const effect: Effect = JSON.parse(readFileSync(path, "utf8"));
    if (effect.version !== 1 || operationHash(effect.after) !== effect.afterHash)
        throw new Error("Operation effect evidence is corrupt.");
    assertSafePath(plans, effect.path);
    const retained = readReceipt(directory, effect.receipt.operationId);
    if (!retained || retained.digest !== effect.receipt.digest)
        throw new Error("Operation identity evidence is unavailable.");
    const metadataPath = effect.identityPath || join(dirname(effect.path), "plan.wld.json");
    assertSafePath(plans, metadataPath);
    const metadata: { planId: string } = JSON.parse(
        metadataPath === effect.path ? effect.after : readFileSync(metadataPath, "utf8"),
    );
    if (metadata.planId !== (effect.targetPlanId || retained.planId) || effect.receipt.planId !== retained.planId)
        throw new Error("Operation effect belongs to a different Plan.");
    let observed: string | null;
    try {
        observed = operationHash(readFileSync(effect.path, "utf8"));
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        observed = null;
    }
    if (observed !== effect.beforeHash && observed !== effect.afterHash)
        throw new Error("Operation effect conflicts with the owner document; recovery remains pending.");
    if (observed === effect.beforeHash) writeTextAtomically(effect.path, effect.after);
    writeJsonAtomically(receiptPath(directory, retained.operationId), effect.receipt);
    unlinkSync(path);
    syncParentDirectory(path);
}

/** A named command's final canonical commit retains its exact result before replacing the resource. */
export function commitOperationEffect(
    path: string,
    before: string | null,
    after: string,
    revision: string,
    snapshot?: { inputId: string; digest: string; attemptId: string },
    recordId?: string,
    identityPath = join(dirname(path), "plan.wld.json"),
): boolean {
    const scope = operations.getStore();
    if (!scope) return false;
    const receipt = readReceipt(scope.directory, scope.receipt.operationId);
    if (
        !receipt ||
        receipt.digest !== scope.receipt.digest ||
        (receipt.outcome.status !== "unstarted" && !(scope.settlementRequired && receipt.outcome.status === "pending"))
    )
        throw new Error("Operation cannot commit another effect.");
    const completed: Receipt = {
        ...receipt,
        outcome: {
            operationId: receipt.operationId,
            status: scope.settlementRequired ? "pending" : "completed",
            revision,
            ...(recordId ? { recordId } : {}),
            ...(snapshot
                ? { snapshotId: snapshot.inputId, snapshotDigest: snapshot.digest, attemptId: snapshot.attemptId }
                : {}),
        },
    };
    const identity: { planId: string } = JSON.parse(identityPath === path ? after : readFileSync(identityPath, "utf8"));
    if (!identity.planId) throw new Error("Operation effect has no Plan identity.");
    const effect: Effect = {
        version: 1,
        identityPath,
        targetPlanId: identity.planId,
        receipt: completed,
        path,
        beforeHash: before === null ? null : operationHash(before),
        after,
        afterHash: operationHash(after),
    };
    if (new TextEncoder().encode(JSON.stringify(effect)).length > 16 * 1024 * 1024)
        throw new Error("Operation evidence exceeds its bound.");
    writeJsonAtomically(effectPath(scope.directory), effect);
    writeTextAtomically(path, after);
    writeJsonAtomically(receiptPath(scope.directory, receipt.operationId), completed);
    unlinkSync(effectPath(scope.directory));
    syncParentDirectory(effectPath(scope.directory));
    return true;
}

export function inspectOperationReceipt(directory: string, id: string, planId?: string): OperationOutcome {
    try {
        const receipt = readReceipt(directory, id);
        if (!receipt || (planId && receipt.planId !== planId)) return { operationId: id, status: "unavailable" };
        const reservation = join(directory, "operation-identities", `${id}.json`);
        assertSafePath(directory, reservation);
        const reserved: { digest: string } = JSON.parse(readFileSync(reservation, "utf8"));
        if (reserved.digest !== receipt.digest) return { operationId: id, status: "unavailable" };
        if (existsSync(effectPath(directory))) return { operationId: id, status: "pending" };
        return receipt.outcome;
    } catch {
        return { operationId: id, status: "unavailable" };
    }
}

export async function runReceiptedOperation(
    directory: string,
    operationId: string,
    digest: string,
    planId: string,
    action: (recovering: boolean) => Promise<Omit<OperationOutcome, "operationId" | "status">>,
    settlementRequired = false,
): Promise<OperationOutcome> {
    const reservation = join(directory, "operation-identities", `${operationId}.json`);
    assertSafePath(directory, reservation);
    const prior = readReceipt(directory, operationId);
    if (existsSync(reservation)) {
        const retained: { digest: string } = JSON.parse(readFileSync(reservation, "utf8"));
        if (retained.digest !== digest) throw new Error("Operation ID was already bound to a different request.");
        if (!prior) throw new Error("Reserved operation evidence is unavailable.");
    } else {
        if (prior) throw new Error("Operation reservation evidence is unavailable.");
        writeJsonAtomically(reservation, { digest });
    }
    if (prior && (prior.digest !== digest || prior.planId !== planId))
        throw new Error("Operation ID was already bound to a different request.");
    if (prior?.outcome.status === "completed") return prior.outcome;
    if (prior && prior.outcome.status !== "unstarted" && !settlementRequired) return prior.outcome;
    const receipt: Receipt = prior || {
        version: 1,
        operationId,
        digest,
        planId,
        outcome: { operationId, status: settlementRequired ? "pending" : "unstarted" },
    };
    if (!prior) writeJsonAtomically(receiptPath(directory, operationId), receipt);
    const observed = await operations.run({ directory, receipt, settlementRequired }, () => action(Boolean(prior)));
    const outcome = inspectOperationReceipt(directory, operationId);
    if (outcome.status === "unstarted" || (settlementRequired && outcome.status === "pending"))
        writeJsonAtomically(receiptPath(directory, operationId), {
            ...receipt,
            outcome: {
                ...observed,
                ...outcome,
                operationId,
                status: "completed",
                revision: outcome.revision || observed.revision,
            },
        } satisfies Receipt);
    return inspectOperationReceipt(directory, operationId);
}

export interface BatchOperationIntent {
    operationId: string;
    digest: string;
    planId: string;
}
export function captureBatchOperation(): BatchOperationIntent | undefined {
    const scope = operations.getStore();
    return scope
        ? { operationId: scope.receipt.operationId, digest: scope.receipt.digest, planId: scope.receipt.planId }
        : undefined;
}
/** The authoring journal carries this receipt until its complete generation is visible. */
export function settleBatchOperation(directory: string, intent: BatchOperationIntent, revision: string): void {
    const retained = readReceipt(directory, intent.operationId);
    if (!retained || retained.digest !== intent.digest || retained.planId !== intent.planId)
        throw new Error("Authoring operation identity is unavailable.");
    if (retained.outcome.status === "completed") {
        if (retained.outcome.revision !== revision) throw new Error("Authoring operation result changed.");
        return;
    }
    completeOperationReceipt(directory, retained, revision);
}

function completeOperationReceipt(directory: string, receipt: Receipt, revision?: string): void {
    const { operationId, planId } = receipt;
    writeJsonAtomically(receiptPath(directory, operationId), {
        ...receipt,
        outcome: { operationId, status: "completed", revision, planId },
    } satisfies Receipt);
}

type OperationReceiptResult =
    "child-authoring-results" | "collaboration-results" | "collaboration-effects" | "sequence-review-results";

export function operationReceiptResultPath(
    directory: string,
    operationId: string,
    kind: OperationReceiptResult,
): string {
    const path = join(directory, kind, `${operationId}.json`);
    assertSafePath(directory, path);
    return path;
}

/** Sidecar results use the checked path of the active operation. */
export function currentOperationReceiptResultPath(kind: OperationReceiptResult): string | undefined {
    const scope = operations.getStore();
    if (!scope) return undefined;
    return operationReceiptResultPath(scope.directory, scope.receipt.operationId, kind);
}

/** A missing or invalid operation has no Sequence result to recover. */
export function hasSequenceOperationReceipt(directory: string, operationId: string): boolean {
    return /^[a-f0-9-]{36}$/.test(operationId) && Boolean(readReceipt(directory, operationId));
}

/** Complete the canonical receipt after the Sequence owner verifies its retained result. */
export function completeSequenceOperationReceipt(
    directory: string,
    operationId: string,
    retained: BatchOperationIntent,
    revision?: string,
): void {
    const receipt = readReceipt(directory, operationId);
    if (!receipt) return;
    if (
        retained.operationId !== operationId ||
        retained.digest !== receipt.digest ||
        retained.planId !== receipt.planId
    )
        throw new Error("Sequence operation result changed ownership.");
    completeOperationReceipt(directory, receipt, revision);
}
