import { type ScriptProcessOptions, captureScriptProcess } from "./script-process.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp as fsMkdtemp, rm as fsRm, stat as fsStat } from "node:fs/promises";
/**
 * Verify that every submodule commit pinned by the superproject can be fetched
 * from the submodule's configured remote.
 */

interface SubmoduleConfig {
    name: string;
    path: string;
    url: string;
}

interface SubmodulePin extends SubmoduleConfig {
    sha: string;
}

type CommandOptions = Pick<ScriptProcessOptions, "cwd">;

async function run(command: string, args: string[], options: CommandOptions = {}) {
    const output = await captureScriptProcess(command, {
        args,
        cwd: options.cwd,
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

async function readSubmoduleConfigs(): Promise<SubmoduleConfig[]> {
    const result = await run("git", [
        "config",
        "--file",
        ".gitmodules",
        "--get-regexp",
        "^submodule\\..*\\.(path|url)$",
    ]);
    if (!result.success) {
        throw new Error(`Failed to read .gitmodules:\n${result.stderr || result.stdout}`);
    }

    const submodulesByName = new Map<string, Partial<SubmoduleConfig>>();
    for (const line of result.stdout.split("\n")) {
        if (!line.trim()) continue;
        const match = line.match(/^submodule\.(.+)\.(path|url)\s+(.+)$/);
        if (!match) continue;

        const [, name, key, value] = match;
        const submodule = submodulesByName.get(name) ?? { name };
        if (key === "path") submodule.path = value.trim();
        if (key === "url") submodule.url = value.trim();
        submodulesByName.set(name, submodule);
    }

    return Array.from(submodulesByName.values()).map((submodule) => {
        if (!submodule.name || !submodule.path || !submodule.url) {
            throw new Error(`Incomplete .gitmodules entry: ${JSON.stringify(submodule)}`);
        }
        return {
            name: submodule.name,
            path: submodule.path,
            url: submodule.url,
        };
    });
}

async function readPinnedSubmoduleCommit(submodule: SubmoduleConfig): Promise<SubmodulePin> {
    const result = await run("git", ["ls-tree", "HEAD", "--", submodule.path]);
    if (!result.success) {
        throw new Error(`Failed to read pinned commit for ${submodule.path}:\n${result.stderr || result.stdout}`);
    }

    const match = result.stdout.match(/^160000 commit ([0-9a-f]{40})\t(.+)$/m);
    if (!match) {
        throw new Error(`No gitlink entry found for submodule path ${submodule.path}.`);
    }

    return {
        ...submodule,
        sha: match[1],
    };
}

async function fetchPinnedCommit(submodule: SubmodulePin, workDir: string) {
    const repoDir = await fsMkdtemp(join(workDir ?? tmpdir(), "submodule-fetch-"));
    const initResult = await run("git", ["init", "--bare", repoDir]);
    if (!initResult.success) return initResult;

    return await run("git", ["-C", repoDir, "fetch", "--depth=1", submodule.url, submodule.sha]);
}

async function main(): Promise<void> {
    if (!(await hasGitmodules())) {
        console.log("No .gitmodules file found; skipping submodule fetchability check.");
        return;
    }

    const configs = await readSubmoduleConfigs();
    if (configs.length === 0) {
        console.log("No submodules configured; skipping submodule fetchability check.");
        return;
    }

    const submodules = await Promise.all(configs.map(readPinnedSubmoduleCommit));
    const tempDir = await fsMkdtemp(join(tmpdir(), "wld-submodule-check-"));
    let failed = false;

    try {
        for (const submodule of submodules) {
            console.log(`Checking ${submodule.path} @ ${submodule.sha} from ${submodule.url}`);
            const result = await fetchPinnedCommit(submodule, tempDir);
            if (!result.success) {
                failed = true;
                console.error(`Pinned submodule commit is not fetchable: ${submodule.path} @ ${submodule.sha}`);
                console.error(result.stderr || result.stdout || `git fetch exited with code ${result.code}`);
            }
        }
    } finally {
        await fsRm(tempDir, { recursive: true }).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
    }

    if (failed) {
        throw new Error("Submodule fetchability check failed. Update the pinned submodule commit before merging.");
    }

    console.log("All pinned submodule commits are fetchable.");
}

await main();
