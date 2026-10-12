/** Materialize the frozen docs dependency closure inside a separate documentation source tree. */
import { constants } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath, stat, symlink, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:process";

export async function prepareDocsDependencies(root: string): Promise<void> {
    const repository = fileURLToPath(new URL("../", import.meta.url));
    const modules = join(repository, "docs-site", "node_modules");
    const store = await realpath(join(modules, ".bun"));
    const destination = join(root, "docs-site", "node_modules", ".bun");
    const visited = new Set<string>();
    const links: Array<{ source: string; destination: string }> = [];
    async function copyDependencies(sourceRoot: string, destinationRoot: string, topLevel = false): Promise<void> {
        await cp(sourceRoot, destinationRoot, {
            recursive: true,
            verbatimSymlinks: true,
            mode: constants.COPYFILE_FICLONE,
            async filter(source, target) {
                if (
                    topLevel &&
                    [".bun", ".deno", ".astro", ".vite"].includes(relative(modules, source).split(sep)[0])
                ) {
                    return false;
                }
                if (platform === "win32" && (await lstat(source)).isSymbolicLink()) {
                    // Windows package links are junctions. Rebuild them against the
                    // copied store instead of carrying host paths/reparse data across.
                    links.push({ source, destination: target });
                    return false;
                }
                return true;
            },
        });
    }
    await mkdir(destination, { recursive: true });
    async function visitModules(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue;
            const path = join(directory, entry.name);
            if (entry.name.startsWith("@") && entry.isDirectory()) {
                await visitModules(path);
                continue;
            }
            const target = await realpath(path);
            const relativePath = relative(store, target);
            if (relativePath.startsWith("..") || resolve(store, relativePath) !== target) {
                throw new Error(`Docs dependency is outside the frozen Bun store: ${path}`);
            }
            const owner = relativePath.split(sep)[0];
            if (visited.has(owner)) continue;
            visited.add(owner);
            await copyDependencies(join(store, owner), join(destination, owner));
            await visitModules(join(store, owner, "node_modules"));
        }
    }
    await visitModules(modules);
    await copyDependencies(modules, join(root, "docs-site", "node_modules"), true);
    for (const link of links) {
        const original = await realpath(link.source);
        const child = relative(store, original);
        if (child.startsWith("..") || resolve(store, child) !== original) {
            throw new Error(`Docs dependency link is outside the frozen Bun store: ${link.source}`);
        }
        const target = join(destination, child);
        const existing = await lstat(link.destination).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        });
        if (existing) {
            if (!existing.isSymbolicLink()) throw new Error(`Expected a docs dependency link: ${link.destination}`);
            const actual = await realpath(link.destination).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (actual === (await realpath(target))) continue;
            await unlink(link.destination); // Remove only the junction, never its contents.
        }
        await symlink(target, link.destination, (await stat(original)).isDirectory() ? "junction" : "file");
    }
    for (const link of links) {
        const target = await realpath(link.destination);
        const child = relative(destination, target);
        if (child.startsWith("..") || resolve(destination, child) !== target) {
            throw new Error(`Copied docs dependency escaped its fixture: ${link.destination}`);
        }
    }
}
