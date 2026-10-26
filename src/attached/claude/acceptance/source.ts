import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, lstat, stat as followLink } from "node:fs/promises";
import { join } from "node:path";

import type { CapturedFile } from "./evidence.ts";

export interface CoreSource {
    commit: string;
    dirty: boolean;
    digest: string;
    files: CapturedFile[];
}

/** Read-only fingerprint of runtime source, prompts, packaging, dependencies, and built review assets. */
export async function captureCoreSource(checkout: string): Promise<CoreSource> {
    const files: CoreSource["files"] = [];
    async function visit(path: string): Promise<void> {
        const absolute = join(checkout, path);
        const stat = await lstat(absolute);
        if (stat.isDirectory()) {
            for (const name of (await readdir(absolute)).sort()) {
                if (name !== ".git" && name !== "node_modules") await visit(`${path}/${name}`);
            }
        } else if (stat.isFile() || (stat.isSymbolicLink() && (await followLink(absolute)).isFile()))
            files.push({
                path,
                sha256: createHash("sha256")
                    .update(await readFile(absolute))
                    .digest("hex"),
            });
        else throw new Error("Core source contains an unreadable special file");
    }
    for (const path of [
        "src",
        "scripts",
        ".claude-plugin",
        "runtime-root.js",
        "tsconfig.json",
        "tsconfig.bun.json",
        "bunfig.toml",
        "third_party",
        "package.json",
        "bun.lock",
        "dist/workspace-bun",
    ]) {
        try {
            await lstat(join(checkout, path));
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
            throw error;
        }
        await visit(path);
    }
    if (!files.length) throw new Error("No Core source could be fingerprinted");
    files.sort((a, b) => a.path.localeCompare(b.path));
    const git = (args: string[]) =>
        execFileSync("git", args, { cwd: checkout, encoding: "utf8", timeout: 30_000 }).trim();
    const commit = git(["rev-parse", "HEAD"]);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Core commit could not be identified");
    return {
        commit,
        dirty: git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "",
        files,
        digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    };
}
