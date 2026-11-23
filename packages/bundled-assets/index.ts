import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface BundledAssetDirectory {
    readonly sourceDir: string;
    /** Return the materialized cache path when available, or the source path. Overlapping paths use the source. */
    getPath(): Promise<string>;
    /** Resolve an individual file, retrying transient source or cache errors. */
    ensureFile(relativePath: string): Promise<string>;
}

function isMissing(error: Error): boolean {
    return "code" in error && error.code === "ENOENT";
}

async function destinationStat(path: string) {
    try {
        return await lstat(path, { bigint: true });
    } catch (error) {
        if (!(error instanceof Error) || !isMissing(error)) throw error;
    }
}

/** Resolve existing ancestors as well as final symlinks before creating a cache path. */
async function canonicalPath(path: string): Promise<string> {
    const absolutePath = resolve(path);
    const missing: string[] = [];
    for (let current = absolutePath; ; current = dirname(current)) {
        try {
            return join(await realpath(current), ...missing.reverse());
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !isMissing(error) ||
                (await destinationStat(current))?.isSymbolicLink() ||
                current === dirname(current)
            )
                throw error;
            missing.push(basename(current));
        }
    }
}

function contains(directory: string, file: string): boolean {
    const relativePath = relative(directory, file);
    return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function pathsOverlap(first: string, second: string): boolean {
    return contains(first, second) || contains(second, first);
}

function hasParentSegment(path: string): boolean {
    return path.split(/[\\/]/).includes("..");
}

interface CachedFile {
    name: string;
    stats: BigIntStats;
}

interface CachedDirectory {
    name: string;
    entries: CachedEntry[];
}

type CachedEntry = CachedFile | CachedDirectory;

interface MaterializedCache {
    directory: string;
    entries: CachedEntry[];
}

const stagedFilePattern = /^\.runwield-asset-[0-9a-f-]{36}\.tmp$/;

async function requireRealDirectory(directory: string): Promise<void> {
    if (!(await destinationStat(directory))?.isDirectory() || relative(directory, await realpath(directory)) !== "") {
        throw new Error(`Bundled asset cache is no longer a directory: ${directory}`);
    }
}

function sameFile(current: BigIntStats | undefined, previous: BigIntStats): boolean {
    return (
        current?.isFile() === true &&
        current.nlink === 1n &&
        current.dev === previous.dev &&
        current.ino === previous.ino &&
        current.size === previous.size &&
        current.mtimeNs === previous.mtimeNs &&
        current.ctimeNs === previous.ctimeNs
    );
}

async function copyFile(source: string, destination: string): Promise<BigIntStats> {
    const bytes = await readFile(source);
    const directory = dirname(destination);
    await requireRealDirectory(directory);
    const previous = await destinationStat(destination);
    if (previous?.isFile() && previous.nlink === 1n && previous.size === BigInt(bytes.length)) {
        const existingBytes = await readFile(destination).catch(() => undefined);
        if (existingBytes?.equals(bytes) && sameFile(await destinationStat(destination), previous)) return previous;
    }
    const temporary = join(directory, `.runwield-asset-${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, bytes, { flag: "wx" });
        await requireRealDirectory(directory);
        const existing = await destinationStat(destination);
        if (existing && !existing.isFile()) await rm(destination, { recursive: true, force: true });
        await rename(temporary, destination);
    } finally {
        await requireRealDirectory(directory)
            .then(() => rm(temporary, { force: true }))
            .catch(() => {});
    }
    return lstat(destination, { bigint: true });
}

async function copyTree(sourceDir: string, destinationDir: string): Promise<CachedEntry[]> {
    const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
    await mkdir(destinationDir, { recursive: true });
    await requireRealDirectory(destinationDir);
    const currentEntries = new Set<string>();
    const entries: CachedEntry[] = [];
    for (const entry of sourceEntries) {
        currentEntries.add(entry.name);
        const sourcePath = join(sourceDir, entry.name);
        const destinationPath = join(destinationDir, entry.name);
        if (entry.isDirectory()) {
            await requireRealDirectory(destinationDir);
            const existing = await destinationStat(destinationPath);
            if (existing && !existing.isDirectory()) await rm(destinationPath, { recursive: true, force: true });
            entries.push({ name: entry.name, entries: await copyTree(sourcePath, destinationPath) });
        } else if (entry.isFile()) {
            entries.push({ name: entry.name, stats: await copyFile(sourcePath, destinationPath) });
        }
    }

    await requireRealDirectory(destinationDir);
    for (const entry of await readdir(destinationDir, { withFileTypes: true })) {
        // Another process may be publishing a file into the same cache.
        if (!currentEntries.has(entry.name) && !stagedFilePattern.test(entry.name)) {
            await requireRealDirectory(destinationDir);
            await rm(join(destinationDir, entry.name), { recursive: true, force: true });
        }
    }
    return entries;
}

async function cacheIsCurrent(directory: string, entries: CachedEntry[]): Promise<boolean> {
    const status = await Promise.all(
        entries.map(async (entry) => {
            const path = join(directory, entry.name);
            const current = await destinationStat(path);
            if ("entries" in entry) return current?.isDirectory() && (await cacheIsCurrent(path, entry.entries));
            return sameFile(current, entry.stats);
        }),
    );
    return status.every(Boolean);
}

class MissingBundledAssetError extends Error {
    readonly code = "ENOENT";
}

async function cacheDirectory(cacheDir: string): Promise<string | undefined> {
    if (hasParentSegment(cacheDir)) return undefined;
    const absolute = resolve(cacheDir);
    const directory = join(await canonicalPath(dirname(absolute)), basename(absolute));
    const existing = await destinationStat(directory);
    if (!existing) return directory;
    if (!existing.isDirectory()) return undefined;

    const canonical = await realpath(directory);
    if (canonical === directory) return directory;
    // Case-insensitive filesystems may return a different spelling for the same directory.
    const resolved = await destinationStat(canonical);
    if (resolved?.isDirectory() && resolved.dev === existing.dev && resolved.ino === existing.ino) return canonical;
}

async function safeCacheFile(cacheDir: string, relativePath: string): Promise<string | undefined> {
    const targetPath = join(cacheDir, relativePath);
    if (targetPath === cacheDir || !contains(cacheDir, targetPath)) return undefined;
    const parent = dirname(targetPath);
    if ((await canonicalPath(parent)) !== parent || !(await destinationStat(targetPath))?.isFile()) {
        return undefined;
    }
    return targetPath;
}

export function createBundledAssetDirectory(
    sourceDir: string,
    getCacheDir: () => string | null = () => null,
    assetLabel = "Bundled asset",
): BundledAssetDirectory {
    const materialized = new Map<string, MaterializedCache>();
    const pending = new Map<string, Promise<string>>();

    async function materialize(cacheDir: string): Promise<string> {
        // A symlink followed by `..` can resolve differently from a lexically normalized path.
        if (hasParentSegment(sourceDir)) return sourceDir;
        try {
            const directory = await cacheDirectory(cacheDir);
            if (!directory) return sourceDir;
            const previous = materialized.get(cacheDir);
            if (
                previous?.directory === directory &&
                (await destinationStat(directory))?.isDirectory() &&
                (await cacheIsCurrent(directory, previous.entries))
            ) {
                await requireRealDirectory(directory);
                return cacheDir;
            }
            if (!(await stat(sourceDir)).isDirectory()) return sourceDir;
            const source = await canonicalPath(sourceDir);
            if (pathsOverlap(source, directory)) return sourceDir;
            const entries = await copyTree(source, directory);
            await requireRealDirectory(directory);
            materialized.set(cacheDir, { directory, entries });
            return cacheDir;
        } catch {
            return sourceDir;
        }
    }

    async function getPath(): Promise<string> {
        const cacheDir = getCacheDir();
        if (!cacheDir) return sourceDir;
        const inFlight = pending.get(cacheDir);
        if (inFlight) return inFlight;
        const next = materialize(cacheDir).finally(() => pending.delete(cacheDir));
        pending.set(cacheDir, next);
        return await next;
    }

    async function ensureFile(relativePath: string): Promise<string> {
        const sourcePath = join(sourceDir, relativePath);
        let lastError = "";
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                if ((await stat(sourcePath)).isFile()) return sourcePath;
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
            const cacheDir = getCacheDir();
            try {
                // Use a retained copy before a full refresh can prune a file missing from the source.
                const directory = cacheDir && (await cacheDirectory(cacheDir));
                if (
                    directory &&
                    !hasParentSegment(sourceDir) &&
                    !pathsOverlap(await canonicalPath(sourceDir), directory)
                ) {
                    const targetPath = await safeCacheFile(directory, relativePath);
                    if (targetPath) return targetPath;
                }
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
            if (attempt < 4) await delay(20 * (attempt + 1));
        }
        throw new MissingBundledAssetError(`${assetLabel} is missing: ${relativePath}. ${lastError}`);
    }

    return { sourceDir, getPath, ensureFile };
}
