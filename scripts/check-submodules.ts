import { captureScriptProcess } from "./script-process.ts";
import { stat as fsStat } from "node:fs/promises";
/**
 * Verify local submodule hygiene without network access.
 *
 * This check is intended for fast per-change CI. Remote fetchability for pinned
 * commits lives in scripts/check-submodule-fetchability.ts.
 */

interface SubmoduleStatus {
    prefix: string;
    sha: string;
    path: string;
    line: string;
}

async function run(command: string, args: string[]) {
    const output = await captureScriptProcess(command, {
        args,
        stdout: "piped",
        stderr: "piped",
    });
    const decoder = new TextDecoder();
    return {
        success: output.success,
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
    };
}

async function hasGitmodules(): Promise<boolean> {
    try {
        const stat = await fsStat(".gitmodules");
        return stat.isFile();
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

function parseSubmoduleStatus(output: string): SubmoduleStatus[] {
    return output.split("\n").flatMap((line) => {
        if (!line.trim()) return [];
        const match = line.match(/^([ +-U])([0-9a-f]{40})\s+([^\s]+)(?:\s|$)/);
        if (!match) throw new Error(`Unable to parse submodule status line: ${line}`);
        return [{ prefix: match[1], sha: match[2], path: match[3], line }];
    });
}

async function readRecursiveSubmoduleStatus(): Promise<SubmoduleStatus[]> {
    const result = await run("git", ["submodule", "status", "--recursive"]);
    if (!result.success) {
        throw new Error(`Failed to read submodule status:\n${result.stderr || result.stdout}`);
    }
    return parseSubmoduleStatus(result.stdout);
}

function reportUninitializedOrMismatchedSubmodules(statuses: SubmoduleStatus[]): boolean {
    let failed = false;
    for (const status of statuses) {
        if (status.prefix === "-") {
            failed = true;
            console.error(`Submodule is not initialized: ${status.path}`);
            console.error(status.line);
        } else if (status.prefix === "+") {
            failed = true;
            console.error(`Submodule checkout does not match the pinned gitlink: ${status.path}`);
            console.error(status.line);
        } else if (status.prefix === "U") {
            failed = true;
            console.error(`Submodule has merge conflicts: ${status.path}`);
            console.error(status.line);
        }
    }
    return failed;
}

async function reportDirtySubmodule(status: SubmoduleStatus): Promise<boolean> {
    const result = await run("git", [
        "-C",
        status.path,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
    ]);
    if (!result.success) {
        console.error(`Failed to inspect submodule working tree: ${status.path}`);
        console.error(result.stderr || result.stdout || `git status exited with code ${result.code}`);
        return true;
    }
    if (!result.stdout.trim()) return false;

    console.error(`Submodule working tree is dirty: ${status.path}`);
    console.error(result.stdout.trimEnd());
    return true;
}

async function reportDirtySubmodules(statuses: SubmoduleStatus[]): Promise<boolean> {
    let failed = false;
    for (const status of statuses) {
        if (status.prefix === "-") continue;
        if (await reportDirtySubmodule(status)) failed = true;
    }
    return failed;
}

async function main(): Promise<void> {
    if (!(await hasGitmodules())) {
        console.log("No .gitmodules file found; skipping local submodule check.");
        return;
    }

    const statuses = await readRecursiveSubmoduleStatus();
    if (statuses.length === 0) {
        console.log("No submodules configured; skipping local submodule check.");
        return;
    }

    const hasCheckoutFailure = reportUninitializedOrMismatchedSubmodules(statuses);
    const hasDirtySubmodule = await reportDirtySubmodules(statuses);
    if (hasCheckoutFailure || hasDirtySubmodule) {
        throw new Error(
            "Local submodule check failed. Initialize submodules, checkout pinned commits, and clean them before merging.",
        );
    }

    console.log("All local submodules are initialized, pinned, and clean.");
}

await main();
