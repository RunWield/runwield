import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDir, writeJsonAtomically } from "../shared/private-json-file.ts";
import { assertWorkRecordPath, workRecordOwnerLayout } from "../shared/work-records/owner.ts";
import type { RetentionKind, PruneCopy } from "./retention.ts";

interface PruneEffect {
    projectId: string;
    owner: string;
    repositoryId: string;
    kind: RetentionKind;
    token: string;
    identity: string;
    copies: PruneCopy[];
    completed: boolean;
}
export function pruneEffect(kind: RetentionKind, token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid confirmed prune identity.");
    const layout = workRecordOwnerLayout()!;
    const binding = {
        projectId: layout.identity.projectId,
        owner: layout.identity.personalOwner.identity,
        repositoryId: layout.identity.repositoryId,
        kind,
        token,
    };
    const path = join(layout.root, "internal", "retention", kind, token + ".json");
    assertWorkRecordPath(path);
    return {
        async read(): Promise<PruneEffect | undefined> {
            const bytes = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
            if (bytes === undefined) return;
            const value: PruneEffect = JSON.parse(bytes);
            if (
                value.projectId !== binding.projectId ||
                value.owner !== binding.owner ||
                value.repositoryId !== binding.repositoryId ||
                value.kind !== kind ||
                value.token !== token ||
                typeof value.identity !== "string" ||
                !Array.isArray(value.copies) ||
                typeof value.completed !== "boolean"
            )
                throw new Error("Prune recovery evidence belongs to another approval.");
            return value;
        },
        write(identity: string, copies: PruneCopy[], completed: boolean) {
            ensurePrivateDir(dirname(path));
            writeJsonAtomically(path, { ...binding, identity, copies, completed });
        },
    };
}
