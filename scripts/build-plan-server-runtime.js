import process from "node:process";
import { captureScriptProcess } from "./script-process.ts";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    readdir as fsReaddir,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
/**
 * Build the self-hosted Plan Server runtime root.
 *
 * The generated directory is intentionally small enough for an OCI image final
 * stage to copy wholesale without baking in Plans, local checkout state, or the
 * repository's executable source tree.
 */

import { basename, dirname, join } from "node:path";
import { readWorkspaceStyles } from "../src/ui/workspace/workspace-styles.ts";

const DEFAULT_REMOTE_ENTRY = "src/ui/workspace/remote-server.ts";
const DEFAULT_WORKSPACE_RUNTIME_DIR = "dist/workspace-runtime";
const DEFAULT_PLAN_SERVER_RUNTIME_DIR = "dist/plan-server";
const DEFAULT_BUNDLE_PATH = "remote-server.js";

export const REQUIRED_WORKSPACE_RUNTIME_FILES = Object.freeze(["server.mjs"]);

/**
 * @typedef {Object} RuntimeAssetCopy
 * @property {string} source
 * @property {string} destination
 */

/**
 * @typedef {Object} PlanServerRuntimeBuildOptions
 * @property {string} [remoteEntry]
 * @property {string} [workspaceRuntimeDir]
 * @property {string} [runtimeDir]
 * @property {string} [bundlePath]
 * @property {RuntimeAssetCopy[]} [assetCopies]
 */

/**
 * @typedef {Object} PlanServerRuntimeBuildPort
 * @property {(command: string, args: string[]) => Promise<void>} run
 */

/** @type {RuntimeAssetCopy[]} */
export const DEFAULT_PLAN_SERVER_RUNTIME_ASSETS = [
    { source: "brand/logo.svg", destination: "brand/logo.svg" },
    { source: "src/agent-definitions/architect.md", destination: "src/agent-definitions/architect.md" },
    { source: "src/agent-definitions/engineer.md", destination: "src/agent-definitions/engineer.md" },
    { source: "src/agent-definitions/guide.md", destination: "src/agent-definitions/guide.md" },
    { source: "src/agent-definitions/ideator.md", destination: "src/agent-definitions/ideator.md" },
    { source: "src/agent-definitions/operator.md", destination: "src/agent-definitions/operator.md" },
    { source: "src/agent-definitions/planner.md", destination: "src/agent-definitions/planner.md" },
    { source: "src/agent-definitions/recorder.md", destination: "src/agent-definitions/recorder.md" },
    { source: "src/agent-definitions/router.md", destination: "src/agent-definitions/router.md" },
    { source: "src/agent-definitions/tester.md", destination: "src/agent-definitions/tester.md" },
    { source: "src/ui/workspace/static/styles.css", destination: "src/ui/workspace/static/styles.css" },
    { source: "src/ui/workspace/static/workspace.css", destination: "src/ui/workspace/static/workspace.css" },
    { source: "src/ui/design-system/tokens.css", destination: "src/ui/design-system/tokens.css" },
    { source: "src/ui/design-system/components.css", destination: "src/ui/design-system/components.css" },
    { source: "src/ui/theme/catppuccin-mocha.json", destination: "src/ui/theme/catppuccin-mocha.json" },
];

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
async function assertFile(path) {
    const info = await fsStat(path).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    });
    if (!info?.isFile()) throw new Error(`Required Plan Server runtime file is missing: ${path}`);
}

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
async function assertDirectory(path) {
    const info = await fsStat(path).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    });
    if (!info?.isDirectory()) throw new Error(`Required Plan Server runtime directory is missing: ${path}`);
}

/**
 * @param {string} workspaceRuntimeDir
 * @returns {Promise<void>}
 */
async function assertWorkspaceRuntimeFiles(workspaceRuntimeDir) {
    await assertDirectory(workspaceRuntimeDir);
    for (const file of REQUIRED_WORKSPACE_RUNTIME_FILES) {
        await assertFile(join(workspaceRuntimeDir, file));
    }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function runCommand(command, args) {
    const result = await captureScriptProcess(command, {
        args,
        stdout: "piped",
        stderr: "piped",
    });
    if (result.success) return;

    const decoder = new TextDecoder();
    const output = `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`.trim();
    throw new Error(output || `${command} failed with exit code ${result.code}`);
}

/** @type {PlanServerRuntimeBuildPort} */
const SYSTEM_PLAN_SERVER_RUNTIME_BUILD_PORT = Object.freeze({ run: runCommand });

/**
 * @param {string} source
 * @param {string} destination
 * @returns {Promise<void>}
 */
async function copyDirectory(source, destination) {
    await fsMkdir(destination, { recursive: true });
    for await (const entry of await fsReaddir(source, { withFileTypes: true })) {
        const sourcePath = join(source, entry.name);
        const destinationPath = join(destination, entry.name);
        if (entry.isDirectory()) {
            await copyDirectory(sourcePath, destinationPath);
            continue;
        }
        if (!entry.isFile()) throw new Error(`Unsupported Plan Server runtime entry: ${sourcePath}`);
        await fsCopyFile(sourcePath, destinationPath);
    }
}

/**
 * @param {RuntimeAssetCopy[]} assets
 * @returns {string[]}
 */
export function listRuntimeAssetDestinations(assets = DEFAULT_PLAN_SERVER_RUNTIME_ASSETS) {
    return assets.map((asset) => asset.destination).sort();
}

/**
 * @param {string} runtimeDir
 * @returns {Promise<string[]>}
 */
export async function listRuntimeFiles(runtimeDir) {
    /** @type {string[]} */
    const files = [];

    /**
     * @param {string} root
     * @param {string} prefix
     */
    async function walk(root, prefix) {
        for await (const entry of await fsReaddir(root, { withFileTypes: true })) {
            const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
            const childPath = join(root, entry.name);
            if (entry.isDirectory()) await walk(childPath, childPrefix);
            else if (entry.isFile()) files.push(childPrefix);
        }
    }

    await walk(runtimeDir, "");
    return files.sort();
}

/**
 * @param {string[]} files
 * @returns {string[]}
 */
export function findProhibitedRuntimeFiles(files) {
    return files.filter((file) => {
        if (file === DEFAULT_BUNDLE_PATH) return false;
        if (file.startsWith("dist/workspace-runtime/")) return false;
        if (listRuntimeAssetDestinations().includes(file)) return false;
        return (
            file.endsWith(".js") ||
            file.endsWith(".jsx") ||
            file.endsWith(".ts") ||
            file.endsWith(".tsx") ||
            file.startsWith("docs/plans/") ||
            file.startsWith(".wld/") ||
            file.startsWith(".git/") ||
            file.includes("collaboration-secrets") ||
            file.endsWith(".sqlite") ||
            file.includes("/sessions/") ||
            file.includes(".test.")
        );
    });
}

/**
 * @param {PlanServerRuntimeBuildOptions} options
 * @param {PlanServerRuntimeBuildPort} port
 * @returns {Promise<void>}
 */
export async function buildPlanServerRuntime(options, port) {
    const remoteEntry = options.remoteEntry || DEFAULT_REMOTE_ENTRY;
    const workspaceRuntimeDir = options.workspaceRuntimeDir || DEFAULT_WORKSPACE_RUNTIME_DIR;
    const runtimeDir = options.runtimeDir || DEFAULT_PLAN_SERVER_RUNTIME_DIR;
    const bundlePath = options.bundlePath || DEFAULT_BUNDLE_PATH;
    const bundleOutput = join(runtimeDir, bundlePath);
    const assetCopies = options.assetCopies || DEFAULT_PLAN_SERVER_RUNTIME_ASSETS;

    await assertFile(remoteEntry);
    await assertWorkspaceRuntimeFiles(workspaceRuntimeDir);
    for (const asset of assetCopies) await assertFile(asset.source);

    await fsRm(runtimeDir, { recursive: true }).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    await fsMkdir(dirname(bundleOutput), { recursive: true });

    await port.run(process.execPath, ["build", "--target", "bun", "--minify", "--outfile", bundleOutput, remoteEntry]);

    await assertFile(bundleOutput);
    await copyDirectory(workspaceRuntimeDir, join(runtimeDir, "dist", "workspace-runtime"));
    await assertWorkspaceRuntimeFiles(join(runtimeDir, "dist", "workspace-runtime"));
    for (const asset of assetCopies) {
        const destination = join(runtimeDir, asset.destination);
        await fsMkdir(dirname(destination), { recursive: true });
        if (asset.destination === "src/ui/workspace/static/workspace.css") {
            await fsWriteFile(destination, await readWorkspaceStyles(asset.source));
        } else {
            await fsCopyFile(asset.source, destination);
        }
    }

    const prohibited = findProhibitedRuntimeFiles(await listRuntimeFiles(runtimeDir));
    if (prohibited.length > 0) throw new Error(`Prohibited Plan Server runtime files: ${prohibited.join(", ")}`);
}

if (import.meta.main) {
    await buildPlanServerRuntime({}, SYSTEM_PLAN_SERVER_RUNTIME_BUILD_PORT);
    console.log(
        `Plan Server runtime prepared at ${DEFAULT_PLAN_SERVER_RUNTIME_DIR} from ${basename(DEFAULT_REMOTE_ENTRY)}.`,
    );
}
