import process from "node:process";
import type { Stats } from "node:fs";
import { captureScriptProcess } from "./script-process.ts";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
/**
 * Build opaque Workspace assets for the standalone RunWield executable.
 *
 * Astro's server output is collapsed into one self-contained module. Browser
 * JavaScript receives an `.asset` suffix so the runtime serves it as passive
 * data instead of tracing browser chunks as executable server modules.
 */

import { basename, dirname, extname, join } from "node:path";

const DEFAULT_SERVER_ENTRY = "dist/workspace-bun/server/entry.mjs";
const DEFAULT_CLIENT_DIR = "dist/workspace-bun/client";
const DEFAULT_RUNTIME_DIR = "dist/workspace-runtime";
const DEFAULT_CLIENT_ASSET_STABILITY_INTERVAL_MS = 100;
const DEFAULT_CLIENT_ASSET_STABILITY_TIMEOUT_MS = 5000;
const REQUIRED_CLIENT_ASSET_STABILITY_PASSES = 5;

export interface WorkspaceRuntimeBuildOptions {
    serverEntry?: string;
    clientDir?: string;
    runtimeDir?: string;
}

export interface WorkspaceRuntimeBuildPort {
    run(command: string, args: string[]): Promise<void>;
}

const SYSTEM_WORKSPACE_RUNTIME_BUILD_PORT: WorkspaceRuntimeBuildPort = Object.freeze({ run: runCommand });

/**
 * Return the stored filename for a passive browser asset.
 */
export function getOpaqueWorkspaceAssetName(name: string): string {
    return [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"].includes(extname(name).toLowerCase())
        ? `${name}.asset`
        : name;
}

async function runCommand(command: string, args: string[]): Promise<void> {
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

export interface WorkspaceClientAssetStabilityOptions {
    intervalMs?: number;
    timeoutMs?: number;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyOpaqueAssets(sourceDir: string, destinationDir: string): Promise<void> {
    await fsMkdir(destinationDir, { recursive: true });
    for await (const entry of await fsReaddir(sourceDir, { withFileTypes: true })) {
        const sourcePath = join(sourceDir, entry.name);
        const destinationPath = join(destinationDir, getOpaqueWorkspaceAssetName(entry.name));
        if (entry.isDirectory()) {
            await copyOpaqueAssets(sourcePath, destinationPath);
            continue;
        }
        if (!entry.isFile()) {
            throw new Error(`Unsupported Workspace asset entry: ${sourcePath}`);
        }
        await fsCopyFile(sourcePath, destinationPath);
    }
}

async function snapshotWorkspaceAssetDirectory(sourceDir: string, prefix = ""): Promise<string[]> {
    const snapshot: string[] = [];
    for await (const entry of await fsReaddir(sourceDir, { withFileTypes: true })) {
        const sourcePath = join(sourceDir, entry.name);
        const relativePath = prefix ? join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
            snapshot.push(...(await snapshotWorkspaceAssetDirectory(sourcePath, relativePath)));
            continue;
        }
        if (!entry.isFile()) {
            throw new Error(`Unsupported Workspace asset entry: ${sourcePath}`);
        }
        const stat = await fsStat(sourcePath);
        snapshot.push(`${relativePath}:${stat.size}:${stat.mtime?.getTime() ?? 0}`);
    }
    return snapshot.sort();
}

/**
 * Wait until Astro/Vite's client asset tree is quiescent before embedding it.
 * Recent builds can return before all hashed CSS assets are visible to the next
 * subprocess on every filesystem; copying during that window creates standalone
 * binaries whose HTML references missing /_astro/*.css files.
 */
export async function waitForStableWorkspaceClientAssets(
    clientDir: string,
    options: WorkspaceClientAssetStabilityOptions = {},
): Promise<void> {
    const intervalMs = options.intervalMs ?? DEFAULT_CLIENT_ASSET_STABILITY_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_ASSET_STABILITY_TIMEOUT_MS;
    const startedAt = performance.now();
    let previous: string | null = null;
    let stablePasses = 0;

    while (true) {
        const current = await snapshotWorkspaceAssetDirectory(clientDir)
            .then((snapshot) => snapshot.join("\n"))
            .catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
                throw error;
            });
        if (current !== null && previous !== null && current === previous) {
            stablePasses += 1;
            if (stablePasses >= REQUIRED_CLIENT_ASSET_STABILITY_PASSES) return;
        } else {
            stablePasses = 0;
        }
        if (performance.now() - startedAt >= timeoutMs) {
            throw new Error(`Workspace client assets did not settle: ${clientDir}`);
        }
        previous = current;
        await delay(intervalMs);
    }
}

/**
 * Return static relative imports from an Astro server entrypoint. JSDoc type
 * imports are intentionally ignored because they are erased at runtime.
 */
export function getServerEntryImportPaths(source: string, entryDir: string): string[] {
    const importPaths: string[] = [];
    for (const line of source.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) continue;

        const staticMatch = trimmed.match(/^import(?:\s+[^'";]+?\s+from\s+|\s*)['"](\.\.?\/[^'"]+)['"]/);
        if (staticMatch) {
            importPaths.push(join(entryDir, staticMatch[1]));
            continue;
        }

        const dynamicMatch = trimmed.match(/\bimport\(['"](\.\.?\/[^'"]+)['"]\)/);
        if (dynamicMatch) importPaths.push(join(entryDir, dynamicMatch[1]));
    }
    return importPaths;
}

/**
 * Some npm CommonJS shims in the bundled Astro server call the generated
 * dynamic require helper for `node:child_process` even though the Deno bundle
 * also emits static Node built-in imports. That works under `deno run`, but a
 * `deno compile` executable cannot satisfy dynamic require at runtime. Reuse
 * the emitted static imports so the standalone Workspace runtime can be loaded
 * by the release binary.
 */
export function normalizeCompiledNodeChildProcessImports(source: string): string {
    const importPattern =
        /import\{spawn as ([A-Za-z_$][\w$]*),spawnSync as ([A-Za-z_$][\w$]*)\}from"node:child_process";/;
    const match = source.match(importPattern);
    if (!match || !source.includes('Ut("node:child_process")')) return source;

    const [, spawnAlias, spawnSyncAlias] = match;
    const staticBinding = `({exec:__rwNodeChildProcessExec,spawn:${spawnAlias},spawnSync:${spawnSyncAlias}})`;
    return source
        .replace(
            importPattern,
            `import{exec as __rwNodeChildProcessExec,spawn as ${spawnAlias},spawnSync as ${spawnSyncAlias}}from"node:child_process";`,
        )
        .replaceAll('Ut("node:child_process")', staticBinding);
}

/**
 * React's browser server renderer creates a MessageChannel at module scope.
 * Deno's MessagePorts are referenced by default, so an executable that renders
 * one Workspace page stays alive after its HTTP server closes. Replace bundled
 * channels with a subclass whose ports do not keep the process alive.
 */
export function unrefBundledMessageChannels(source: string): string {
    const channelNames = [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new MessageChannel/g)].map(
        (match) => match[1],
    );
    if (!channelNames.length) return source;
    const prelude =
        "class __RunWieldUnrefedMessageChannel extends MessageChannel{constructor(){super();this.port1.unref();this.port2.unref();queueMicrotask(()=>{this.port1.unref();this.port2.unref()})}}\n";
    return prelude + source.replaceAll("new MessageChannel", "new __RunWieldUnrefedMessageChannel");
}

/**
 * Astro's server bundle can expand optional import.meta.env access into a
 * snapshot of the build runner's environment. Keep Vite's production flags,
 * but do not embed runner-specific values or secrets in release binaries.
 * Fail closed if the generated shape changes instead of publishing those values.
 */
function removeBundledBuildEnvironment(source: string): string {
    const snapshot = /Object\.assign\(\{ASSETS_PREFIX:[^{}]*SSR:!0\},\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\}\)/g;
    const result = source.replace(snapshot, (match) => match.slice(0, match.indexOf("},{") + 3) + "})");
    if (
        result
            .replace(/Object\.assign\(\{ASSETS_PREFIX:[^{}]*SSR:!0\},\{\}\)/g, "")
            .includes("Object.assign({ASSETS_PREFIX:")
    ) {
        throw new Error("Workspace server bundle contains an unrecognized build environment snapshot");
    }
    return result;
}

/**
 * Astro discovers static assets in filesystem order. Its manifest treats them as
 * a set, but their serialized order must match across release build jobs.
 */
function sortBundledManifestAssets(source: string): string {
    return source.replace(
        /assets:(\[(?:"(?:\\.|[^"\\])*"(?:,"(?:\\.|[^"\\])*")*)?\])(?=,buildFormat:)/g,
        (_match: string, serialized: string) => {
            const assets: string[] = JSON.parse(serialized);
            return `assets:${JSON.stringify(assets.sort())}`;
        },
    );
}

/**
 * Astro can expose the entry before its chunks and final manifest are ready.
 * Wait for both before invoking `bun build`, so the runtime does not retain
 * Astro's temporary manifest placeholder.
 */
async function waitForFinalServerEntry(serverEntry: string): Promise<void> {
    const entryDir = dirname(serverEntry);
    const deadline = Date.now() + 5000;
    while (true) {
        const source = await fsReadFile(serverEntry, "utf8");
        const missing: string[] = [];
        for (const path of getServerEntryImportPaths(source, entryDir)) {
            const stat = await fsStat(path).catch((error) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
                throw error;
            });
            if (!stat?.isFile()) missing.push(path);
        }
        const manifestPending = source.includes("@@ASTRO_MANIFEST_REPLACE@@");
        if (missing.length === 0 && !manifestPending) return;
        if (Date.now() >= deadline) {
            throw new Error(
                manifestPending
                    ? "Workspace server manifest is not finalized."
                    : `Workspace server imports are missing: ${missing.join(", ")}`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function waitForFile(path: string): Promise<Stats> {
    const deadline = Date.now() + 5000;
    while (true) {
        const stat = await fsStat(path).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        });
        if (stat?.isFile()) return stat;
        if (Date.now() >= deadline) throw new Error(`Workspace runtime server was not created: ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

export async function buildWorkspaceRuntime(
    options: WorkspaceRuntimeBuildOptions,
    port: WorkspaceRuntimeBuildPort,
): Promise<void> {
    const serverEntry = options.serverEntry || DEFAULT_SERVER_ENTRY;
    const clientDir = options.clientDir || DEFAULT_CLIENT_DIR;
    const runtimeDir = options.runtimeDir || DEFAULT_RUNTIME_DIR;
    const serverOutput = join(runtimeDir, "server.mjs");

    await fsRm(runtimeDir, { recursive: true }).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    await fsMkdir(dirname(serverOutput), { recursive: true });

    await waitForFinalServerEntry(serverEntry);
    await port.run(process.execPath, ["build", "--target", "bun", "--minify", "--outfile", serverOutput, serverEntry]);
    await waitForFile(serverOutput);
    await fsWriteFile(
        serverOutput,
        sortBundledManifestAssets(
            removeBundledBuildEnvironment(
                unrefBundledMessageChannels(
                    normalizeCompiledNodeChildProcessImports(await fsReadFile(serverOutput, "utf8")),
                ),
            ),
        ),
    );
    await waitForStableWorkspaceClientAssets(clientDir);
    await copyOpaqueAssets(clientDir, join(runtimeDir, "client"));

    await waitForFile(serverOutput);
}

if (import.meta.main) {
    await buildWorkspaceRuntime({}, SYSTEM_WORKSPACE_RUNTIME_BUILD_PORT);
    console.log(`Workspace runtime prepared at ${DEFAULT_RUNTIME_DIR} from ${basename(DEFAULT_SERVER_ENTRY)}.`);
}
