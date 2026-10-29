import { mkdir as fsMkdir, readdir as fsReaddir, rename as fsRename } from "node:fs/promises";
/** Keep Golden diagnostics outside the disposable test sandbox, not its cache or HOME. */
import { join } from "node:path";

export async function retainTestEvidence(sandbox: string, destination: string): Promise<void> {
    for await (const slot of await fsReaddir(sandbox, { withFileTypes: true })) {
        if (!slot.isDirectory()) continue;
        const temp = slot.name.startsWith("tmp-") ? join(sandbox, slot.name) : join(sandbox, slot.name, "tmp");
        const entries = await fsReaddir(temp, { withFileTypes: true }).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
            throw error;
        });
        for (const entry of entries) {
            if (!entry.isDirectory() || !/^runwield-golden-tui-(timeout|child-failure)-/.test(entry.name)) continue;
            await fsMkdir(destination, { recursive: true });
            await fsRename(join(temp, entry.name), join(destination, entry.name));
        }
    }
}
