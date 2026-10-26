import { captureScriptProcess } from "./script-process.ts";
import { lstat as fsLstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * List repository files that CI owns: tracked files plus untracked files that Git does not ignore.
 * Runtime state and the Reviewer corpus's source, variants and hidden proofs are not RunWield source.
 * Corpus admission checks those projects separately; its manifests and runner remain in CI.
 */
export async function listCiFiles(repoRoot: string): Promise<string[]> {
    const output = await captureScriptProcess("git", {
        args: ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"],
        cwd: repoRoot,
        stdout: "piped",
        stderr: "piped",
    });
    if (!output.success) {
        const detail = new TextDecoder().decode(output.stderr).trim();
        throw new Error(detail || "git ls-files failed");
    }

    const candidates = new TextDecoder()
        .decode(output.stdout)
        .split("\0")
        .filter((path) => path && path !== ".wld" && !path.startsWith(".wld/"))
        .filter((path) => !/^evals\/reviewer\/[^/]+\/(?:source|variants|evaluation)(?:\/|$)/.test(path));
    const files = await Promise.all(
        candidates.map(async (path) => {
            const isFile = await fsLstat(join(repoRoot, path))
                .then((stat) => stat.isFile() || stat.isSymbolicLink())
                .catch((error) => {
                    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
                    throw error;
                });
            return isFile ? path : "";
        }),
    );
    return files.filter(Boolean).sort();
}
