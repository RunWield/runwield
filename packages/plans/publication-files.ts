import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertDeliveryCopies, type DeliveryCopy } from "./publication-copies.ts";

/** The caller verifies any previous delivered copy before allowing replacement. */
export async function materializeDeliveryCopy(cwd: string, copy: DeliveryCopy, base: string | null): Promise<void> {
    assertDeliveryCopies([copy]);
    const path = join(cwd, copy.path);
    // Never follow an execution-checkout symlink while materializing a copy.
    let cursor = cwd;
    for (const segment of copy.path.split("/")) {
        cursor = join(cursor, segment);
        const stat = await fs.lstat(cursor).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (stat?.isSymbolicLink()) throw new Error("Delivery copy destination contains a symbolic link.");
    }
    const current = await fs.readFile(path, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (current !== null && current !== copy.text && current !== base)
        throw new Error(`Delivery copy collides with editor content: ${copy.path}`);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, copy.text);
}
