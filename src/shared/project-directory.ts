import { basename, dirname, parse, resolve, win32 as windows, posix } from "node:path";
import { statSync, realpathSync, lstatSync } from "node:fs";
import process from "node:process";
import { createHmac, randomBytes } from "node:crypto";
import { getHomeDir } from "../constants.js";

export const DIRECTORY_WARNING = "System or home folder detected. Continue?";
const POSIX_SYSTEM_DIRECTORIES =
    "/bin /sbin /etc /usr /usr/bin /usr/sbin /usr/lib /usr/lib64 /usr/local /usr/local/bin /usr/local/sbin /usr/local/lib /var /var/log /var/lib /var/cache /var/run /tmp /opt /home /root /lib /lib64 /boot /dev /proc /sys /run /srv /mnt /media".split(
        " ",
    );
const MAC_SYSTEM_DIRECTORIES =
    "/Applications /Library /System /Users /Volumes /private /private/etc /private/tmp /private/var".split(" ");

export interface DirectoryInspection {
    enteredRoot: string;
    canonicalRoot: string;
    classified: boolean;
}
export interface DirectoryPolicy {
    platform: string;
    home: string;
    systemRoot?: string;
    programFiles?: string;
    programFilesX86?: string;
    programData?: string;
    systemDrive?: string;
}

export function systemDirectoryLocations(policy: DirectoryPolicy): string[] {
    if (policy.platform === "windows") {
        const drive = policy.systemDrive || windows.parse(policy.systemRoot || "").root.replace(/[\\/]+$/, "") || "C:";
        return [
            policy.home,
            policy.systemRoot || `${drive}\\Windows`,
            policy.programFiles || `${drive}\\Program Files`,
            policy.programFilesX86 || `${drive}\\Program Files (x86)`,
            policy.programData || `${drive}\\ProgramData`,
            `${drive}\\Users`,
        ];
    }
    return [policy.home, ...POSIX_SYSTEM_DIRECTORIES, ...(policy.platform === "darwin" ? MAC_SYSTEM_DIRECTORIES : [])];
}

export function isExactSystemDirectory(path: string, locations: string[], platform: string): boolean {
    const paths = platform === "windows" ? windows : posix;
    const normalize = (value: string) => {
        const normalized = paths.resolve(value);
        return platform === "windows" ? normalized.toLowerCase() : normalized;
    };
    const selected = normalize(path);
    return (
        selected === normalize(paths.parse(path).root) || locations.some((location) => normalize(location) === selected)
    );
}

/** Read-only inspection shared by project startup and Workspace registration. */
export function inspectProjectDirectory(path: string): DirectoryInspection {
    const enteredRoot = resolve(path);
    const stat = statSync(enteredRoot);
    if (!stat.isDirectory()) throw new Error("Project root must be a directory");
    const canonicalRoot = realpathSync(enteredRoot);
    return classifyProjectDirectory(enteredRoot, canonicalRoot);
}

/** Only for a registered execution target that recovery must create. Existing roots stay strict. */
export function inspectMissingManagedProjectDirectory(path: string): DirectoryInspection {
    const enteredRoot = resolve(path);
    return classifyProjectDirectory(enteredRoot, canonicalMissingDirectory(enteredRoot));
}

function canonicalMissingDirectory(path: string): string {
    let ancestor = path;
    const suffix: string[] = [];
    while (true) {
        try {
            if (!statSync(ancestor).isDirectory()) throw new Error("Project root must be a directory");
            return resolve(realpathSync(ancestor), ...suffix);
        } catch (error) {
            if (!(error instanceof Error && isFileError(error, "ENOENT"))) throw error;
            // An existing dangling link is not a missing directory we own.
            try {
                lstatSync(ancestor);
            } catch (entryError) {
                if (!(entryError instanceof Error && isFileError(entryError, "ENOENT"))) throw entryError;
                const parent = dirname(ancestor);
                if (parent === ancestor) throw error;
                suffix.unshift(basename(ancestor));
                ancestor = parent;
                continue;
            }
            throw error;
        }
    }
}

function classifyProjectDirectory(enteredRoot: string, canonicalRoot: string): DirectoryInspection {
    const locations = systemDirectoryLocations({
        platform: process.platform === "win32" ? "windows" : process.platform,
        home: getHomeDir(),
        systemRoot: process.env["SystemRoot"] || process.env["WINDIR"],
        systemDrive: process.env["SystemDrive"],
        programFiles: process.env["ProgramFiles"],
        programFilesX86: process.env["ProgramFiles(x86)"],
        programData: process.env["ProgramData"],
    });
    const canonicalLocations: string[] = [];
    for (const location of locations) {
        try {
            canonicalLocations.push(canonicalMissingDirectory(resolve(location)));
        } catch (error) {
            if (
                !(error instanceof Error && isFileError(error, "ENOENT")) &&
                !(
                    (error instanceof Error && isFileError(error, "EACCES")) ||
                    (error instanceof Error && isFileError(error, "EPERM"))
                )
            ) {
                throw error;
            }
        }
    }
    return {
        enteredRoot,
        canonicalRoot,
        classified:
            isExactSystemDirectory(
                enteredRoot,
                locations,
                process.platform === "win32" ? "windows" : process.platform,
            ) ||
            isExactSystemDirectory(
                canonicalRoot,
                canonicalLocations,
                process.platform === "win32" ? "windows" : process.platform,
            ) ||
            canonicalRoot === parse(canonicalRoot).root,
    };
}

const confirmationSecret = randomBytes(32);
function confirmationFor(directory: DirectoryInspection): string {
    return createHmac("sha256", confirmationSecret)
        .update(JSON.stringify([directory.enteredRoot, directory.canonicalRoot]))
        .digest("hex");
}
export class DirectoryConfirmationRequired extends Error {
    readonly code = "directory_confirmation_required";
    readonly confirmation: string;
    constructor(directory: DirectoryInspection) {
        super(DIRECTORY_WARNING);
        this.confirmation = confirmationFor(directory);
    }
}
export function requireDirectoryConfirmation(directory: DirectoryInspection, confirmation?: string): void {
    if (directory.classified && confirmation !== confirmationFor(directory)) {
        throw new DirectoryConfirmationRequired(directory);
    }
}

function isFileError(error: Error, code: string): boolean {
    return "code" in error && error.code === code;
}
