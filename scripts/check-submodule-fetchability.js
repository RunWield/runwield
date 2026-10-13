import { captureScriptProcess } from "./script-process.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp as fsMkdtemp, rm as fsRm, stat as fsStat } from "node:fs/promises";
/**
 * Verify that every submodule commit pinned by the superproject can be fetched
 * from the submodule's configured remote.
 */

/**
 * @typedef {Object} CommandResult
 * @property {boolean} success
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {Object} SubmoduleConfig
 * @property {string} name
 * @property {string} path
 * @property {string} url
 */

/**
 * @typedef {Object} SubmodulePin
 * @property {string} name
 * @property {string} path
 * @property {string} url
 * @property {string} sha
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<CommandResult>}
 */
async function run(command, args, options = {}) {
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

/**
 * @returns {Promise<boolean>}
 */
async function hasGitmodules() {
    try {
        const stat = await fsStat(".gitmodules");
        return stat.isFile();
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
        throw error;
    }
}

/**
 * @returns {Promise<SubmoduleConfig[]>}
 */
async function readSubmoduleConfigs() {
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

    /** @type {Map<string, Partial<SubmoduleConfig>>} */
    const submodulesByName = new Map();
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

/**
 * @param {SubmoduleConfig} submodule
 * @returns {Promise<SubmodulePin>}
 */
async function readPinnedSubmoduleCommit(submodule) {
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

/**
 * @param {SubmodulePin} submodule
 * @param {string} workDir
 * @returns {Promise<CommandResult>}
 */
async function fetchPinnedCommit(submodule, workDir) {
    const repoDir = await fsMkdtemp(join(workDir ?? tmpdir(), "submodule-fetch-"));
    const initResult = await run("git", ["init", "--bare", repoDir]);
    if (!initResult.success) return initResult;

    return await run("git", ["-C", repoDir, "fetch", "--depth=1", submodule.url, submodule.sha]);
}

/**
 * @returns {Promise<void>}
 */
async function main() {
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
