/** Real filesystem permission failures inside disposable test directories. */
import { chmod, stat } from "node:fs/promises";
import { platform } from "node:process";
import { dirname } from "node:path";
import { captureForegroundProcess } from "../shared/captured-process.ts";

/** Deny writes/deletions while retaining reads; returns an awaited permission-restoration action. */
export async function makeReadOnlyDirectoryFixture(path: string): Promise<() => Promise<void>> {
    if (platform !== "win32") {
        const mode = (await stat(path)).mode & 0o777;
        await chmod(path, mode & ~0o222);
        return () => chmod(path, mode);
    }
    // Only these disposable fixture directories receive an Everyone deny ACE.
    // Inherited deletion denial covers children; read and ACL-edit rights remain available.
    const run = async (args: string[]) => {
        const result = await captureForegroundProcess("icacls", { cwd: dirname(path), args: [path, ...args] });
        if (!result.success) {
            throw new Error(`Fixture ACL change failed: ${new TextDecoder().decode(result.stderr || result.stdout)}`);
        }
    };
    await run(["/deny", "*S-1-1-0:(OI)(CI)(WD,AD,DC,DE)"]);
    return () => run(["/remove:d", "*S-1-1-0", "/T"]);
}
