import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
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
        return await lstat(path);
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

function hasParentSegment(path: string): boolean {
    return path.split(/[\\/]/).includes("..");
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

async function copyTree(sourceDir: string, destinationDir: string): Promise<void> {
    await mkdir(destinationDir, { recursive: true });
    const currentEntries = new Set<string>();
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
        currentEntries.add(entry.name);
        const sourcePath = join(sourceDir, entry.name);
        const destinationPath = join(destinationDir, entry.name);
        if (entry.isDirectory()) {
            const existing = await destinationStat(destinationPath);
            if (existing && !existing.isDirectory()) await rm(destinationPath, { recursive: true });
            await copyTree(sourcePath, destinationPath);
        } else if (entry.isFile()) {
            const existing = await destinationStat(destinationPath);
            if (existing && (!existing.isFile() || existing.nlink > 1)) await rm(destinationPath, { recursive: true });
            await writeFile(destinationPath, await readFile(sourcePath));
        }
    }

    for (const entry of await readdir(destinationDir, { withFileTypes: true })) {
        if (!currentEntries.has(entry.name)) await rm(join(destinationDir, entry.name), { recursive: true });
    }
}

class MissingBundledAssetError extends Error {
    readonly code = "ENOENT";
}

interface BundledDirectoryLocation {
    path: string;
    canonicalCacheDir?: string;
}

async function safeCacheFile(cacheDir: string, relativePath: string): Promise<string | undefined> {
    const targetPath = join(cacheDir, relativePath);
    if (targetPath === cacheDir || !contains(cacheDir, targetPath)) return undefined;
    const parent = dirname(targetPath);
    if ((await canonicalPath(parent)) !== parent || (await destinationStat(targetPath))?.isSymbolicLink()) {
        return undefined;
    }
    return targetPath;
}

export function createBundledAssetDirectory(
    sourceDir: string,
    getCacheDir: () => string | null = () => null,
    assetLabel = "Bundled asset",
): BundledAssetDirectory {
    const locations = new Map<string, Promise<BundledDirectoryLocation>>();

    async function materialize(cacheDir: string): Promise<BundledDirectoryLocation> {
        // A symlink followed by `..` can resolve differently from a lexically normalized path.
        if (hasParentSegment(sourceDir) || hasParentSegment(cacheDir)) return { path: sourceDir };
        try {
            if (!(await stat(sourceDir)).isDirectory()) return { path: sourceDir };
            const [canonicalSource, canonicalCacheDir] = await Promise.all([
                canonicalPath(sourceDir),
                canonicalPath(cacheDir),
            ]);
            if (contains(canonicalSource, canonicalCacheDir) || contains(canonicalCacheDir, canonicalSource)) {
                return { path: sourceDir };
            }
            await copyTree(canonicalSource, canonicalCacheDir);
            return { path: cacheDir, canonicalCacheDir };
        } catch {
            return { path: sourceDir };
        }
    }

    function location(): Promise<BundledDirectoryLocation> {
        const cacheDir = getCacheDir();
        if (!cacheDir) return Promise.resolve({ path: sourceDir });
        const cached = locations.get(cacheDir);
        if (cached) return cached;
        const pending = materialize(cacheDir);
        locations.set(cacheDir, pending);
        return pending;
    }

    async function getPath(): Promise<string> {
        return (await location()).path;
    }

    async function ensureFile(relativePath: string): Promise<string> {
        const sourcePath = join(sourceDir, relativePath);
        if (await isFile(sourcePath)) return sourcePath;

        const { canonicalCacheDir } = await location();
        let lastError = "";
        for (let attempt = 0; attempt < 5; attempt += 1) {
            let targetPath;
            try {
                targetPath = canonicalCacheDir ? await safeCacheFile(canonicalCacheDir, relativePath) : undefined;
                if (targetPath && (await isFile(targetPath))) return targetPath;
                const bytes = await readFile(sourcePath);
                if (!targetPath) return sourcePath;
                await mkdir(dirname(targetPath), { recursive: true });
                await writeFile(targetPath, bytes);
                return targetPath;
            } catch (error) {
                if (targetPath && (await isFile(targetPath))) return targetPath;
                lastError = error instanceof Error ? error.message : String(error);
                if (!(error instanceof Error) || (!isMissing(error) && !("code" in error && error.code === "EEXIST")))
                    break;
                await delay(20 * (attempt + 1));
            }
        }
        throw new MissingBundledAssetError(`${assetLabel} is missing: ${relativePath}. ${lastError}`);
    }

    return { sourceDir, getPath, ensureFile };
}
