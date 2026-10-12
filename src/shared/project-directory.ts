import { basename, dirname, parse, resolve } from "@std/path";
import * as windows from "@std/path/windows";
import * as posix from "@std/path/posix";
import { createHmac, randomBytes } from "node:crypto";
import { getHomeDir } from "../constants.js";

export const DIRECTORY_WARNING = "System or home folder detected. Continue?";
const POSIX_SYSTEM_DIRECTORIES =
    "/bin /sbin /etc /usr /usr/bin /usr/sbin /usr/lib /usr/lib64 /usr/local /usr/local/bin /usr/local/sbin /usr/local/lib /var /var/log /var/lib /var/cache /var/run /tmp /opt /home /root /lib /lib64 /boot /dev /proc /sys /run /srv /mnt /media"
        .split(" ");
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
    return selected === normalize(paths.parse(path).root) ||
        locations.some((location) => normalize(location) === selected);
}

/** Read-only inspection shared by project startup and Workspace registration. */
export function inspectProjectDirectory(path: string): DirectoryInspection {
    const enteredRoot = resolve(path);
    const stat = Deno.statSync(enteredRoot);
    if (!stat.isDirectory) throw new Error("Project root must be a directory");
    const canonicalRoot = Deno.realPathSync(enteredRoot);
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
            if (!Deno.statSync(ancestor).isDirectory) throw new Error("Project root must be a directory");
            return resolve(Deno.realPathSync(ancestor), ...suffix);
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            // An existing dangling link is not a missing directory we own.
            try {
                Deno.lstatSync(ancestor);
            } catch (entryError) {
                if (!(entryError instanceof Deno.errors.NotFound)) throw entryError;
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
        platform: Deno.build.os,
        home: getHomeDir(),
        systemRoot: Deno.env.get("SystemRoot") || Deno.env.get("WINDIR"),
        systemDrive: Deno.env.get("SystemDrive"),
        programFiles: Deno.env.get("ProgramFiles"),
        programFilesX86: Deno.env.get("ProgramFiles(x86)"),
        programData: Deno.env.get("ProgramData"),
    });
    const canonicalLocations: string[] = [];
    for (const location of locations) {
        try {
            canonicalLocations.push(canonicalMissingDirectory(resolve(location)));
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound) && !(error instanceof Deno.errors.PermissionDenied)) {
                throw error;
            }
        }
    }
    return {
        enteredRoot,
        canonicalRoot,
        classified: isExactSystemDirectory(enteredRoot, locations, Deno.build.os) ||
            isExactSystemDirectory(canonicalRoot, canonicalLocations, Deno.build.os) ||
            canonicalRoot === parse(canonicalRoot).root,
    };
}

const confirmationSecret = randomBytes(32);
function confirmationFor(directory: DirectoryInspection): string {
    return createHmac("sha256", confirmationSecret).update(
        JSON.stringify([directory.enteredRoot, directory.canonicalRoot]),
    ).digest("hex");
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
