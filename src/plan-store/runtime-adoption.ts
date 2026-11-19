import {
    validateManagedRuntimeContinuations,
    activateManagedRuntimeContinuations,
} from "./retained-managed-execution.ts";
import { normalizeSecretStore, readSecretStore, writeSecretStore } from "../shared/collaboration/secrets.ts";
import { DatabaseSync } from "../shared/sqlite.ts";
/** Laptop-owned staging for managed personal runtime. Publication and source retirement are separate receipts. */
import { join, dirname } from "node:path";
import fs from "node:fs/promises";
import { assertProjectStoreIdentity, type HomeProjectOwner } from "../shared/project-identity.ts";
import {
    ensurePrivateDir,
    writeJsonAtomically,
    writeTextAtomically,
    syncParentDirectory,
} from "../shared/private-json-file.ts";
import { openNativeFileLock } from "../shared/native-file-lock.ts";
import {
    managedRuntimeDigest,
    validateManagedRuntimeTransfer,
    assertManagedRuntimePath,
    type ManagedRuntimeTransfer,
} from "../shared/project-runtime-managed.ts";
interface DestinationTransfer {
    transfer: ManagedRuntimeTransfer;
    phase: "committed" | "retired";
}
function transferRoot(owner: HomeProjectOwner): string {
    assertProjectStoreIdentity(owner);
    return join(
        owner.executionAccountHome,
        ".wld",
        "projects",
        owner.projectId,
        "internal",
        "managed-adoption",
        owner.repositoryId,
    );
}
function assertOwner(owner: HomeProjectOwner, transfer: ManagedRuntimeTransfer): void {
    validateManagedRuntimeTransfer(transfer);
    if (
        owner.projectId !== transfer.projectId ||
        owner.repositoryId !== transfer.repositoryId ||
        owner.personalOwner.identity !== transfer.personalOwner
    )
        throw new Error("Personal runtime transfer belongs to another laptop owner.");
}
/** Commit an immutable staging generation; it remains unavailable as canonical Plan or Work Record input. */
export async function receiveManagedRuntimeTransfer(
    owner: HomeProjectOwner,
    transfer: ManagedRuntimeTransfer,
): Promise<void> {
    assertOwner(owner, transfer);
    const root = transferRoot(owner);
    await assertManagedRuntimePath(root, owner.executionAccountHome);
    ensurePrivateDir(root);
    const lock = openNativeFileLock(join(root, "adoption.lock"));
    await lock.lock(true);
    try {
        await validateManagedRuntimeContinuations(owner, transfer);
        const generation = join(root, transfer.transferId);
        await assertManagedRuntimePath(generation, owner.executionAccountHome);
        ensurePrivateDir(generation);
        for (const file of transfer.files) {
            const path = join(generation, "runtime", file.checkoutId, file.layout, file.name);
            await assertManagedRuntimePath(path, owner.executionAccountHome);
            ensurePrivateDir(dirname(path));
            let bytes: Buffer | undefined;
            try {
                bytes = await fs.readFile(path);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
            if (bytes && managedRuntimeDigest(bytes) !== file.digest) {
                const recovered = join(
                    root,
                    "recovered-staging",
                    managedRuntimeDigest(bytes),
                    file.checkoutId,
                    file.layout,
                    file.name,
                );
                await assertManagedRuntimePath(recovered, owner.executionAccountHome);
                writeTextAtomically(recovered, bytes);
                writeTextAtomically(path, Buffer.from(file.bytes, "base64"));
                bytes = Buffer.from(file.bytes, "base64");
            }
            if (!bytes) {
                const target = await fs.open(path, "wx", 0o600);
                try {
                    await target.writeFile(Buffer.from(file.bytes, "base64"));
                    await target.sync();
                } finally {
                    await target.close();
                }
                syncParentDirectory(path);
            }
            if (managedRuntimeDigest(await fs.readFile(path)) !== file.digest)
                throw new Error("Staged personal runtime did not verify.");
            if (file.name === "collaboration-secrets.json")
                normalizeSecretStore(JSON.parse(await fs.readFile(path, "utf8")));
            if (file.name === "work-records.sqlite3") {
                const database = new DatabaseSync(path, { readOnly: true });
                try {
                    const row = database.prepare("PRAGMA integrity_check").get();
                    if (!row || Object.values(row)[0] !== "ok") throw new Error("Staged Work Record index is corrupt.");
                } finally {
                    database.close();
                }
            }
        }
        const path = join(generation, "transfer.json");
        await assertManagedRuntimePath(path, owner.executionAccountHome);
        let prior: DestinationTransfer | undefined;
        try {
            prior = JSON.parse(await fs.readFile(path, "utf8"));
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (prior) assertOwner(owner, prior.transfer);
        if (!prior) writeJsonAtomically(path, { transfer, phase: "committed" });
    } finally {
        lock.close();
    }
}
/** Source retirement acknowledgement activates only preserved legacy runtime, never repository documents. */
export async function acknowledgeManagedRuntimeRetirement(
    owner: HomeProjectOwner,
    transfer: ManagedRuntimeTransfer,
): Promise<void> {
    assertOwner(owner, transfer);
    await receiveManagedRuntimeTransfer(owner, transfer);
    const root = transferRoot(owner);
    const lock = openNativeFileLock(join(root, "adoption.lock"));
    await lock.lock(true);
    try {
        const path = join(root, transfer.transferId, "transfer.json");
        const stored: DestinationTransfer = JSON.parse(await fs.readFile(path, "utf8"));
        assertOwner(owner, stored.transfer);
        if (stored.transfer.transferId !== transfer.transferId)
            throw new Error("Personal runtime acknowledgement changed generation.");
        const secretPath = join(
            owner.executionAccountHome,
            ".wld",
            "projects",
            owner.projectId,
            "internal",
            "collaboration-secrets.json",
        );
        await assertManagedRuntimePath(secretPath, owner.executionAccountHome);
        const location = { owner: "home-project" as const, homeOwner: owner, path: secretPath };
        const secrets = await readSecretStore(location);
        let changed = false;
        for (const file of stored.transfer.files.filter((file) => file.name === "collaboration-secrets.json")) {
            const incoming = normalizeSecretStore(JSON.parse(Buffer.from(file.bytes, "base64").toString("utf8")));
            for (const [key, record] of Object.entries(incoming.records)) {
                if (!secrets.records[key]) {
                    secrets.records[key] = record;
                    changed = true;
                }
            }
        }
        if (changed) await writeSecretStore(location, secrets);
        await activateManagedRuntimeContinuations(owner, stored.transfer);
        await (await import("./retained-family.ts")).activateManagedFamilyControllers(owner, stored.transfer);
        // Every original generation remains addressable for controller recovery and index reconstruction.
        writeJsonAtomically(path, { transfer: stored.transfer, phase: "retired" });
    } finally {
        lock.close();
    }
}
