import { statSync as fsStatSync } from "node:fs";
import process from "node:process";
import { join } from "node:path";

function isFile(path: string): boolean {
    try {
        return fsStatSync(path).isFile();
    } catch {
        return false;
    }
}

/** Find Git Bash even when Windows exposes only Git's cmd directory on PATH. */
export function findWindowsBashPath(): string | undefined {
    const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"]]
        .filter((root): root is string => Boolean(root))
        .map((root) => join(root, "Git"));
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData) roots.push(join(localAppData, "Programs", "Git"));
    const pathDirs = (process.env["PATH"] || "").split(";")
        .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
    for (const dir of pathDirs) {
        if (isFile(join(dir, "git.exe"))) roots.push(join(dir, ".."));
    }
    const candidates = roots.flatMap((root) => [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]);
    candidates.push(...pathDirs.map((dir) => join(dir, "bash.exe")));
    return candidates.find(isFile);
}
