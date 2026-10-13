import { lstatSync } from "node:fs";
import { realpathSync as fsRealpathSync, type BigIntStats, statSync as fsStatSync } from "node:fs";
import { lstat as fsLstat, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { platform } from "node:process";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { getHomeDir } from "../../constants.js";

/** Resource roots for one explicitly activated remote connection. Never set during connection-only startup. */
export interface RemotePersonalResources {
    globalRoot: string;
    agentsRoot?: string;
    /** Only laptop-verified installed global package roots; never resolve from the remote profile. */
    packageRoots?: Record<string, string>;
}

let active: Readonly<RemotePersonalResources> | undefined;

interface RootIdentity {
    dev: bigint;
    ino: bigint;
}

let activeRootIdentities: ReadonlyMap<string, RootIdentity> | undefined;

function rootIdentity(root: string, info: BigIntStats): RootIdentity {
    // A device alone cannot distinguish a detached mount from its local
    // directory. Keep both identifiers exact: NTFS file IDs can exceed 2^53.
    if (!info.isDirectory() || typeof info.dev !== "bigint" || typeof info.ino !== "bigint") {
        throw new PersonalResourcePathError("Personal root", root, "directory identity is unavailable");
    }
    return { dev: info.dev, ino: info.ino };
}

function assertRootIdentity(root: string, resource: string, path: string, info: BigIntStats): void {
    const expected = activeRootIdentities?.get(root);
    if (!expected) throw new PersonalResourcePathError(resource, path, `root "${root}" was not activated`);
    const current = rootIdentity(root, info);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new PersonalResourcePathError(resource, path, `mounted root "${root}" changed identity`);
    }
}

function assertRootIdentitiesSync(roots: string[], resource: string, path: string): void {
    for (const root of roots) {
        try {
            assertRootIdentity(root, resource, path, fsStatSync(root, { bigint: true }));
        } catch (error) {
            if (error instanceof PersonalResourcePathError) throw error;
            throw new PersonalResourcePathError(
                resource,
                path,
                `mounted root "${root}" is unavailable: ${String(error)}`,
            );
        }
    }
}

async function assertRootIdentities(roots: string[], resource: string, path: string): Promise<void> {
    for (const root of roots) {
        try {
            assertRootIdentity(root, resource, path, await fsStat(root, { bigint: true }));
        } catch (error) {
            if (error instanceof PersonalResourcePathError) throw error;
            throw new PersonalResourcePathError(
                resource,
                path,
                `mounted root "${root}" is unavailable: ${String(error)}`,
            );
        }
    }
}

/** Call only in the remote process after the connection supplies a verified mount. */
export function configureRemotePersonalResources(roots: RemotePersonalResources): void {
    if (
        !isAbsolute(roots.globalRoot) || (roots.agentsRoot && !isAbsolute(roots.agentsRoot)) ||
        Object.values(roots.packageRoots ?? {}).some((path) => !isAbsolute(path))
    ) {
        throw new Error("Remote personal resource roots must be absolute");
    }
    if (active) throw new Error("Remote personal resources are already configured");
    const configured = Object.freeze({
        globalRoot: normalize(roots.globalRoot),
        ...(roots.agentsRoot ? { agentsRoot: normalize(roots.agentsRoot) } : {}),
        ...(roots.packageRoots
            ? {
                packageRoots: Object.freeze(Object.fromEntries(
                    Object.entries(roots.packageRoots).map(([source, path]) => [source, normalize(path)]),
                )),
            }
            : {}),
    });
    const identities = new Map<string, RootIdentity>();
    for (
        const root of [
            configured.globalRoot,
            ...(configured.agentsRoot ? [configured.agentsRoot] : []),
            ...Object.values(configured.packageRoots ?? {}),
        ]
    ) {
        try {
            identities.set(root, rootIdentity(root, fsStatSync(root, { bigint: true })));
        } catch (error) {
            if (error instanceof PersonalResourcePathError) throw error;
            throw new PersonalResourcePathError("Personal root", root, String(error));
        }
    }
    activeRootIdentities = identities;
    active = configured;
}

export function personalPackageRoots(): Readonly<Record<string, string>> {
    return active?.packageRoots ?? {};
}

export function remotePersonalResourcesActive(): boolean {
    return active !== undefined;
}

export function personalGlobalRoot(): string {
    return active?.globalRoot ?? join(getHomeDir(), ".wld");
}

export function personalAgentsRoot(): string | undefined {
    return active ? active.agentsRoot : join(getHomeDir(), ".agents");
}

/** A mounted personal path that cannot safely be read on this remote machine. */
export class PersonalResourcePathError extends Error {
    constructor(resource: string, path: string, reason: string) {
        super(`${resource} at "${path}" cannot be read from the laptop mount: ${reason}`);
        this.name = "PersonalResourcePathError";
    }
}

function within(path: string, root: string): boolean {
    const remainder = relative(root, path);
    return remainder === "" ||
        (remainder !== ".." && !remainder.startsWith(`..${platform === "win32" ? "\\" : "/"}`) &&
            !isAbsolute(remainder));
}

function mountedRoots(): string[] {
    if (!active) return [];
    return [
        active.globalRoot,
        ...(active.agentsRoot ? [active.agentsRoot] : []),
        ...Object.values(active.packageRoots ?? {}),
    ];
}

function checkedRoots(path: string, resource: string, packageResource: boolean): string[] {
    if (!active) return [];
    const roots = mountedRoots();
    if (packageResource && !Object.values(active.packageRoots ?? {}).some((root) => within(path, root))) {
        throw new PersonalResourcePathError(resource, path, "path is outside verified package roots");
    }
    return roots.filter((root) => within(path, root));
}

/** Check a file before reading it. Project and bundled paths are not mounted personal resources. */
export async function assertPersonalResourcePath(
    path: string,
    resource: string,
    options: { packageResource?: boolean } = {},
): Promise<void> {
    const roots = checkedRoots(path, resource, options.packageResource === true);
    if (!roots.length) return;
    await assertRootIdentities(roots, resource, path);
    try {
        const target = await fsRealpath(path);
        const realRoots = await Promise.all(roots.map((root) => fsRealpath(root)));
        if (!realRoots.some((root) => within(target, root))) {
            throw new PersonalResourcePathError(resource, path, `resolved outside mounted roots to "${target}"`);
        }
    } catch (error) {
        if (error instanceof PersonalResourcePathError) throw error;
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw new PersonalResourcePathError(resource, path, String(error));
        }
        // Missing ordinary files are optional. A broken symlink is not: it may
        // point at a laptop absolute path which exists on another remote account.
        for (let current = path; roots.some((root) => within(current, root)); current = dirname(current)) {
            try {
                if ((await fsLstat(current)).isSymbolicLink()) {
                    throw new PersonalResourcePathError(resource, path, `unresolved symlink at "${current}"`);
                }
            } catch (linkError) {
                if (linkError instanceof PersonalResourcePathError) throw linkError;
                if (!(linkError instanceof Error && "code" in linkError && linkError.code === "ENOENT")) {
                    throw linkError;
                }
            }
        }
    }
}

/** Synchronous variant for the synchronous Agent display-name reader. */
export function assertPersonalResourcePathSync(path: string, resource: string): void {
    const roots = checkedRoots(path, resource, false);
    if (!roots.length) return;
    assertRootIdentitiesSync(roots, resource, path);
    try {
        const target = fsRealpathSync(path);
        if (!roots.map((root) => fsRealpathSync(root)).some((root) => within(target, root))) {
            throw new PersonalResourcePathError(resource, path, `resolved outside mounted roots to "${target}"`);
        }
    } catch (error) {
        if (error instanceof PersonalResourcePathError) throw error;
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw new PersonalResourcePathError(resource, path, String(error));
        }
        for (let current = path; roots.some((root) => within(current, root)); current = dirname(current)) {
            try {
                if (lstatSync(current).isSymbolicLink()) {
                    throw new PersonalResourcePathError(resource, path, `unresolved symlink at "${current}"`);
                }
            } catch (linkError) {
                if (linkError instanceof PersonalResourcePathError) throw linkError;
                if (!(linkError instanceof Error && "code" in linkError && linkError.code === "ENOENT")) {
                    throw linkError;
                }
            }
        }
    }
}

/** A remote runtime must not create managed Session files without a laptop-native writer guard. */
export function requireLocalSessionWriter(): void {
    if (active) throw new Error("Remote managed Session writes require a laptop-native writer guard");
}
