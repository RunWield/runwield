import { captureForegroundProcess } from "../captured-process.ts";

/** Local Git commands. No Plan registry operations belong in standalone review. */
export async function git(cwd: string, args: string[]): Promise<string> {
    const result = await captureForegroundProcess("git", { cwd, args });
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr).trim());
    return new TextDecoder().decode(result.stdout).trim();
}
