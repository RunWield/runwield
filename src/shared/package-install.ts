/**
 * @module shared/package-install
 * Detect package-manager-owned RunWield installs from metadata beside the executable.
 */

import { dirname, isAbsolute, join } from "node:path";

import { readFileSync, realpathSync, statSync } from "node:fs";
import { env as processEnv, execPath as runtimeExecutable, platform } from "node:process";

export type RunWieldPackageManager = "homebrew" | "winget";

export interface RunWieldPackageInstall {
    schemaVersion: 1;
    packageManager: RunWieldPackageManager;
    packageIdentifier: string;
    updateCommand: string;
    repairCommand: string;
    installDirectory: string;
    version?: string;
}

export const RUNWIELD_PACKAGE_METADATA_FILE = "runwield-install.json";

function isRunWieldPackageManager(value: string): value is RunWieldPackageManager {
    return value === "homebrew" || value === "winget";
}

function textProperty(record: Record<string, string | number>, key: string): string | null {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value : null;
}

function normalizePackageInstall(value: Record<string, string | number>): RunWieldPackageInstall | null {
    const schemaVersion = value.schemaVersion;
    const packageManager = textProperty(value, "packageManager");
    const packageIdentifier = textProperty(value, "packageIdentifier");
    const updateCommand = textProperty(value, "updateCommand");
    const repairCommand = textProperty(value, "repairCommand");
    const installDirectory = textProperty(value, "installDirectory");
    const version = textProperty(value, "version");

    if (schemaVersion !== 1 || !packageManager || !isRunWieldPackageManager(packageManager)) return null;
    if (!packageIdentifier || !updateCommand || !repairCommand || !installDirectory) return null;

    return {
        schemaVersion,
        packageManager,
        packageIdentifier,
        updateCommand,
        repairCommand,
        installDirectory,
        ...(version ? { version } : {}),
    };
}

function parsePackageMetadata(text: string): RunWieldPackageInstall | null {
    try {
        const parsed = JSON.parse(text) as Record<string, string | number>;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return normalizePackageInstall(parsed);
    } catch {
        return null;
    }
}

export function packageMetadataPathForExecutablePath(execPath: string): string | null {
    const path = String(execPath || "");
    if (!path) return null;
    try {
        return join(dirname(realpathSync(path)), RUNWIELD_PACKAGE_METADATA_FILE);
    } catch {
        return join(dirname(path), RUNWIELD_PACKAGE_METADATA_FILE);
    }
}

export function readRunWieldPackageInstallSync(execPath = runtimeExecutable): RunWieldPackageInstall | null {
    const metadataPath = packageMetadataPathForExecutablePath(execPath);
    if (!metadataPath) return null;
    try {
        const install = parsePackageMetadata(readFileSync(metadataPath, "utf8"));
        if (!install) return null;
        return {
            ...install,
            installDirectory: isAbsolute(install.installDirectory)
                ? install.installDirectory
                : join(dirname(metadataPath), install.installDirectory),
        };
    } catch {
        return null;
    }
}

export function bundledHelperDirectoryForInstall(install: RunWieldPackageInstall): string | null {
    const helpers = join(install.installDirectory, "runtime", "helpers");
    const executableSuffix = platform === "win32" ? ".exe" : "";
    for (const name of ["mnemoteca", "cymbal", "ketch", "agent-browser"]) {
        try {
            const stat = statSync(join(helpers, `${name}${executableSuffix}`));
            if (!stat.isFile()) return null;
        } catch {
            return null;
        }
    }
    return helpers;
}

function pathEnvironmentKey(env: Record<string, string>): string {
    if (platform !== "win32") return "PATH";
    const existing = Object.keys(env).find((key) => key.toLowerCase() === "path");
    return existing || "Path";
}

export function prependToPathEnv(env: Record<string, string>, directory: string): Record<string, string> {
    const key = pathEnvironmentKey(env);
    const current = env[key] || "";
    const separator = platform === "win32" ? ";" : ":";
    return { ...env, [key]: current ? `${directory}${separator}${current}` : directory };
}

export function exposeBundledHelpersSync(execPath = runtimeExecutable): string | null {
    const install = readRunWieldPackageInstallSync(execPath);
    if (!install) return null;
    const helpers = bundledHelperDirectoryForInstall(install);
    if (!helpers) return null;
    const env = prependToPathEnv(
        Object.fromEntries(
            Object.entries(processEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        helpers,
    );
    const key = pathEnvironmentKey(env);
    processEnv[key] = env[key];
    return helpers;
}
