/** Owner-private receipt recovery. The package catalog lock protects both intent and effect. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, lstatSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { writeJsonAtomically, writeTextAtomically, syncParentDirectory } from "../shared/private-json-file.ts";

export interface OperationOutcome {
    operationId: string;
    status: "completed" | "unstarted" | "pending" | "unavailable";
    revision?: string;
    recordId?: string;
    snapshotId?: string;
    snapshotDigest?: string;
    attemptId?: string;
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
    receipt: Receipt;
    path: string;
    beforeHash: string;
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
    const metadataPath = join(dirname(effect.path), "plan.wld.json");
    const metadata: { planId: string } = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (metadata.planId !== retained.planId || effect.receipt.planId !== retained.planId)
        throw new Error("Operation effect belongs to a different Plan.");
    const observed = operationHash(readFileSync(effect.path, "utf8"));
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
    before: string,
    after: string,
    revision: string,
    snapshot?: { inputId: string; digest: string; attemptId: string },
    recordId?: string,
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
    const effect: Effect = {
        version: 1,
        receipt: completed,
        path,
        beforeHash: operationHash(before),
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
