import { syncParentDirectory, writeJsonAtomically } from "@runwield/resources/fs";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertWorkRecordContainedPath } from "./paths.ts";

export interface WorkRecordCreationOperation {
    operationId: string;
    digest: string;
}

interface CreationReceipt extends WorkRecordCreationOperation {
    version: 1;
    fileName: string;
    markdown: string;
}

function validateOperation({ operationId, digest }: WorkRecordCreationOperation) {
    if (
        typeof operationId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(operationId) ||
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest)
    )
        throw new Error("Invalid Work Record creation operation.");
}

async function readReceipt(path: string): Promise<CreationReceipt | null> {
    try {
        if (!(await lstat(path)).isFile()) throw new Error("Work Record creation evidence must be a regular file.");
        const receipt: CreationReceipt = JSON.parse(await readFile(path, "utf8"));
        validateOperation(receipt);
        if (receipt.version !== 1 || typeof receipt.fileName !== "string" || typeof receipt.markdown !== "string")
            throw new Error("Invalid Work Record creation evidence.");
        return receipt;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

export function creationReceipts(home: string, internal: string) {
    const pendingFile = join(internal, "pending-creation.json");

    async function completedPath(operation: WorkRecordCreationOperation) {
        validateOperation(operation);
        const path = join(internal, "creations", `${operation.operationId}.json`);
        await assertWorkRecordContainedPath(home, path);
        return path;
    }

    async function readCompleted(operation: WorkRecordCreationOperation) {
        const receipt = await readReceipt(await completedPath(operation));
        if (receipt && (receipt.operationId !== operation.operationId || receipt.digest !== operation.digest))
            throw new Error("Operation ID was already bound to a different Work Record creation request.");
        return receipt;
    }

    async function readPending() {
        await assertWorkRecordContainedPath(home, pendingFile);
        return await readReceipt(pendingFile);
    }

    async function retainPending(
        { operationId, digest }: WorkRecordCreationOperation,
        fileName: string,
        markdown: string,
    ) {
        await assertWorkRecordContainedPath(home, pendingFile);
        const receipt: CreationReceipt = { version: 1, operationId, digest, fileName, markdown };
        writeJsonAtomically(pendingFile, receipt);
        return receipt;
    }

    async function settle(pending: CreationReceipt, fileName: string) {
        const path = await completedPath(pending);
        writeJsonAtomically(path, { ...pending, fileName } satisfies CreationReceipt);
    }

    async function clearPending() {
        await assertWorkRecordContainedPath(home, pendingFile);
        await rm(pendingFile, { force: true });
        syncParentDirectory(pendingFile);
    }

    return { readCompleted, readPending, retainPending, settle, clearPending };
}
