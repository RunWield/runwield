#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { captureScriptProcess } from "./script-process.ts";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import process from "node:process";

/**
 * Ratchet: relative Markdown links must resolve to a real file, and every
 * `#fragment` must match a heading in the target. Plans can retain references
 * to removed proposal PRDs after their requirements move into lasting docs.
 *
 * Both defects this catches were found by hand: `docs/architecture.md` linked
 * `docs/entity-model.md` from inside `docs/`, and `docs/entity-model.md` linked
 * `../architecture.md` from inside `docs/`. Neither resolved, and nothing noticed.
 */

import { join, posix } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXCLUDED_PREFIXES = ["node_modules/", ".history/", "dist/", "third_party/"];
const LINK_PATTERN = /\[(?:[^\]\\]|\\.)*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*$/;
const CODE_FENCE_PATTERN = /^\s*(?:```|~~~)/;
const FRONT_MATTER_DELIMITER_PATTERN = /^---\s*$/;

export interface RelativeLink {
    line: number;
    target: string;
}

export interface BrokenLink extends RelativeLink {
    sourceFile: string;
    reason: string;
}

export type ReadTextFile = (path: string) => Promise<string>;
export type PathExists = (path: string) => Promise<boolean>;

async function trackedMarkdownFiles(): Promise<string[]> {
    const output = await captureScriptProcess("git", {
        args: ["ls-files", "-z", "*.md"],
        cwd: REPO_ROOT,
        stdout: "piped",
        stderr: "piped",
    });
    if (!output.success) {
        throw new Error(new TextDecoder().decode(output.stderr).trim() || "git ls-files failed");
    }
    return new TextDecoder()
        .decode(output.stdout)
        .split("\0")
        .filter((path) => path && !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
        .sort();
}

/** GitHub-style heading slug: lowercase, drop punctuation, spaces to hyphens. */
export function headingSlug(heading: string): string {
    return heading
        .replace(/`/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_~]/g, "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-");
}

export function headingSlugs(markdown: string): Set<string> {
    const slugs = new Set<string>();
    let inFence = false;
    let inFrontMatter = markdown.startsWith("---\n");
    const lines = markdown.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (inFrontMatter) {
            if (index > 0 && FRONT_MATTER_DELIMITER_PATTERN.test(line)) inFrontMatter = false;
            continue;
        }
        if (CODE_FENCE_PATTERN.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const match = HEADING_PATTERN.exec(line);
        if (!match) continue;
        const slug = headingSlug(match[1]);
        if (!slug) continue;
        // Duplicate headings get -1, -2, ... suffixes, same as GitHub.
        let candidate = slug;
        let suffix = 1;
        while (slugs.has(candidate)) candidate = `${slug}-${suffix++}`;
        slugs.add(candidate);
    }
    return slugs;
}

function isCheckableRelativeLink(target: string): boolean {
    if (!target || target.startsWith("#")) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
    return !target.startsWith("//");
}

export function extractRelativeLinks(markdown: string): RelativeLink[] {
    const links: RelativeLink[] = [];
    let inFence = false;
    let inFrontMatter = markdown.startsWith("---\n");
    const lines = markdown.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (inFrontMatter) {
            if (index > 0 && FRONT_MATTER_DELIMITER_PATTERN.test(line)) inFrontMatter = false;
            continue;
        }
        if (CODE_FENCE_PATTERN.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        for (const match of line.matchAll(LINK_PATTERN)) {
            const target = match[1];
            if (isCheckableRelativeLink(target)) links.push({ line: index + 1, target });
        }
    }
    return links;
}

export async function findBrokenLinks(
    files: string[],
    readTextFile: ReadTextFile = (path) => fsReadFile(join(REPO_ROOT, path), "utf8"),
    pathExists: PathExists = async (path) => {
        try {
            await fsStat(join(REPO_ROOT, path));
            return true;
        } catch {
            return false;
        }
    },
): Promise<BrokenLink[]> {
    const broken: BrokenLink[] = [];
    const slugCache = new Map<string, Set<string> | null>();

    for (const sourceFile of files) {
        // `git ls-files` still reports a tracked file after it has been deleted or
        // moved in the working tree. It has no links left to validate there.
        if (!(await pathExists(sourceFile))) continue;
        const markdown = await readTextFile(sourceFile);
        for (const { line, target } of extractRelativeLinks(markdown)) {
            const [pathPart, fragment] = target.split("#");
            const resolved = pathPart
                ? posix.normalize(posix.join(posix.dirname(sourceFile), decodeURIComponent(pathPart)))
                : sourceFile;

            if (resolved.startsWith("..")) {
                broken.push({ sourceFile, line, target, reason: "resolves outside the repository" });
                continue;
            }
            if (!(await pathExists(resolved))) {
                // Retired proposal PRDs stay in Plan history; lasting docs must use their current owners.
                if (sourceFile.startsWith("docs/plans/") && resolved.startsWith("docs/prd/")) continue;
                broken.push({ sourceFile, line, target, reason: `no such file: ${resolved}` });
                continue;
            }
            if (!fragment || !resolved.endsWith(".md")) continue;

            if (!slugCache.has(resolved)) {
                try {
                    slugCache.set(resolved, headingSlugs(await readTextFile(resolved)));
                } catch {
                    slugCache.set(resolved, null);
                }
            }
            const slugs = slugCache.get(resolved);
            if (slugs && !slugs.has(fragment.toLowerCase())) {
                broken.push({ sourceFile, line, target, reason: `no heading "#${fragment}" in ${resolved}` });
            }
        }
    }
    return broken;
}

function formatBrokenLinks(broken: BrokenLink[]) {
    return broken
        .map((entry) => `  ${entry.sourceFile}:${entry.line}  ${entry.target}\n      ${entry.reason}`)
        .join("\n");
}

if (import.meta.main) {
    const files = await trackedMarkdownFiles();
    const broken = await findBrokenLinks(files);

    if (broken.length) {
        console.error(
            `Broken relative Markdown links (${broken.length}):\n${formatBrokenLinks(broken)}\n\n` +
                "Links resolve relative to the file they appear in, not the repository root.",
        );
        process.exit(1);
    }

    console.log(`Checked relative Markdown links in ${files.length} tracked files.`);
}

export { trackedMarkdownFiles };
