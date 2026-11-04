import { stat as fsStat } from "node:fs/promises";
/**
 * @module tools/grep
 *
 * Wraps the pi-coding-agent `grep` tool so agents can use shell-shaped path
 * arguments such as "src/shared/session src/cmd" without those paths being
 * treated as one literal filesystem path.
 */

import { createGrepToolDefinition, type GrepToolDetails, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { getHomeDir } from "../constants.js";

const grepSchema = Type.Object({
    pattern: Type.String({ description: "Search pattern (regex or literal string)." }),
    path: Type.Optional(
        Type.Union([
            Type.String({
                description:
                    "Directory or file to search. May contain shell-style multiple paths, e.g. 'src tests'. Defaults to current directory.",
            }),
            Type.Array(Type.String(), {
                description: "Directories or files to search. Use this for multiple search roots.",
            }),
        ]),
    ),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.js' or '**/*.test.js'." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex." })),
    context: Type.Optional(Type.Number({ description: "Number of lines before and after each match." })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)." })),
});

export interface RunWieldGrepParams extends Static<typeof grepSchema> {
    paths?: string[];
}

export type RunWieldGrepToolDefinition = ToolDefinition<typeof grepSchema, GrepToolDetails | undefined>;

interface SearchTarget {
    path: string;
    glob?: string;
    prefix?: string;
    fileBasename?: string;
    forcePrefix?: boolean;
}

interface RawGrepArguments {
    path?: unknown;
    paths?: unknown;
}

interface GrepContentPart {
    type: string;
    text?: string;
}

interface GrepSearchResult {
    content: GrepContentPart[];
    details?: GrepToolDetails;
}

function resolveToCwd(targetPath: string, cwd: string): string {
    const expanded = targetPath.startsWith("~/") ? join(getHomeDir(), targetPath.slice(2)) : targetPath;
    return isAbsolute(expanded) ? expanded : join(cwd, expanded);
}

async function pathExists(targetPath: string, cwd: string): Promise<boolean> {
    try {
        await fsStat(resolveToCwd(targetPath, cwd));
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
    }
}

async function isDirectory(targetPath: string, cwd: string): Promise<boolean> {
    return (await fsStat(resolveToCwd(targetPath, cwd))).isDirectory();
}

function hasGlobSyntax(value: string): boolean {
    return /[*?\[]/.test(value);
}

function splitGlobToken(token: string) {
    const normalizedToken = token.replace(/\\/g, "/");
    const absolute = normalizedToken.startsWith("/");
    const segments = normalizedToken.split("/");
    const firstGlobIndex = segments.findIndex((segment) => hasGlobSyntax(segment));

    if (firstGlobIndex <= 0) {
        return { path: absolute ? "/" : ".", glob: absolute ? normalizedToken.slice(1) : normalizedToken };
    }

    const rootSegments = segments.slice(0, firstGlobIndex);
    const globSegments = segments.slice(firstGlobIndex);
    return {
        path: `${absolute ? "/" : ""}${rootSegments.join("/")}`,
        glob: globSegments.join("/"),
    };
}

function splitShellLike(value: string): string[] {
    const tokens: string[] = [];
    let token = "";
    let quote: "'" | '"' | null = null;
    let escaped = false;

    for (const char of value) {
        if (escaped) {
            token += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) quote = null;
            else token += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (token) {
                tokens.push(token);
                token = "";
            }
            continue;
        }
        token += char;
    }

    if (escaped) token += "\\";
    if (token) tokens.push(token);
    return tokens;
}

function displayPath(targetPath: string, cwd: string): string {
    const absolute = resolveToCwd(targetPath, cwd);
    const rel = relative(cwd, absolute).replace(/\\/g, "/");
    if (rel && !rel.startsWith("..")) return rel;
    return targetPath.replace(/\\/g, "/");
}

function prepareGrepArguments(input: unknown): RunWieldGrepParams {
    if (!input || typeof input !== "object") {
        return input as RunWieldGrepParams;
    }

    const args = input as RawGrepArguments;
    if (args.path === undefined && Array.isArray(args.paths)) {
        return { ...args, path: args.paths } as RunWieldGrepParams;
    }

    return input as RunWieldGrepParams;
}

async function normalizePathTokens(rawPath: RunWieldGrepParams["path"], cwd: string): Promise<string[]> {
    if (Array.isArray(rawPath)) {
        return rawPath.map((path) => path.trim()).filter(Boolean);
    }

    const pathText = typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : ".";
    if (await pathExists(pathText, cwd)) return [pathText];

    const tokens = splitShellLike(pathText);
    return tokens.length > 0 ? tokens : ["."];
}

async function buildSearchTargets(
    rawPath: RunWieldGrepParams["path"],
    explicitGlob: RunWieldGrepParams["glob"],
    cwd: string,
): Promise<SearchTarget[]> {
    const tokens = await normalizePathTokens(rawPath, cwd);
    const targets: SearchTarget[] = [];

    for (const token of tokens) {
        if (hasGlobSyntax(token) && !(await pathExists(token, cwd))) {
            const target = splitGlobToken(token);
            const prefix = displayPath(target.path, cwd);
            targets.push({
                path: target.path,
                glob: target.glob,
                prefix: prefix === "." ? "" : prefix.replace(/\/+$/, ""),
                forcePrefix: true,
            });
            continue;
        }

        const normalizedToken = normalize(token);
        let prefix = "";
        let fileBasename = "";
        try {
            if (await isDirectory(normalizedToken, cwd)) {
                const shown = displayPath(normalizedToken, cwd);
                prefix = shown === "." ? "" : shown.replace(/\/+$/, "");
            } else {
                const shown = displayPath(normalizedToken, cwd);
                const dir = dirname(shown);
                fileBasename = basename(shown);
                prefix = dir === "." ? "" : dir;
            }
        } catch {
            // Let the underlying grep tool produce its normal path-not-found error.
        }

        targets.push({
            path: normalizedToken,
            glob: explicitGlob,
            prefix,
            fileBasename,
        });
    }

    return targets;
}

function prefixOutputLine(line: string, target: SearchTarget): string {
    if (!target.prefix || !/^.+?(?::\d+: |-\d+- )/.test(line)) return line;
    if (line.startsWith(`${target.prefix}/`)) return line;

    if (target.fileBasename) {
        if (line.startsWith(`${target.fileBasename}:`) || line.startsWith(`${target.fileBasename}-`)) {
            return `${target.prefix}/${line}`;
        }
        return line;
    }

    return `${target.prefix}/${line}`;
}

function extractPrefixedText(result: GrepSearchResult, target: SearchTarget): string {
    return result.content
        .map((part) => part.text || "")
        .join("")
        .split("\n")
        .filter((line) => line !== "No matches found")
        .map((line) => prefixOutputLine(line, target))
        .join("\n")
        .trim();
}

function mergeDetails(results: Pick<GrepSearchResult, "details">[]): GrepToolDetails | undefined {
    const details: GrepToolDetails = {};
    for (const result of results) {
        if (result.details?.matchLimitReached) {
            details.matchLimitReached = Math.max(
                Number(details.matchLimitReached || 0),
                Number(result.details.matchLimitReached),
            );
        }
        if (result.details?.truncation) details.truncation = result.details.truncation;
        if (result.details?.linesTruncated) details.linesTruncated = true;
    }
    return Object.keys(details).length > 0 ? details : undefined;
}

export function createRunWieldGrepToolDefinition(cwd: string): RunWieldGrepToolDefinition {
    const original = createGrepToolDefinition(cwd);
    const originalExecute = original.execute;
    const tool = original as unknown as RunWieldGrepToolDefinition;

    tool.description =
        "Search file contents for a pattern. Accepts one path, multiple paths, or shell-style path text such as 'src tests'. Respects .gitignore.";
    tool.promptSnippet = "Search file contents across one or more paths (respects .gitignore)";
    tool.promptGuidelines = [
        "Use grep path as a string for one path, an array for multiple paths, or shell-style text like 'src tests'",
        "Use glob for file filtering, or include a path glob such as 'docs/plans/feature*.md'",
    ];
    tool.parameters = grepSchema;
    tool.prepareArguments = prepareGrepArguments;
    tool.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
        const grepParams: RunWieldGrepParams = params;
        const targets = await buildSearchTargets(grepParams.path, grepParams.glob, cwd);

        if (targets.length === 1 && !Array.isArray(grepParams.path) && !targets[0].forcePrefix) {
            const target = targets[0];
            return await originalExecute(
                toolCallId,
                { ...grepParams, path: target.path, glob: target.glob },
                signal,
                onUpdate,
                ctx,
            );
        }

        const results: GrepSearchResult[] = [];
        const outputBlocks: string[] = [];
        let remainingLimit = grepParams.limit;

        for (const target of targets) {
            const result = await originalExecute(
                toolCallId,
                { ...grepParams, path: target.path, glob: target.glob, limit: remainingLimit },
                signal,
                onUpdate,
                ctx,
            );
            results.push(result);

            const text = extractPrefixedText(result, target);
            if (text) outputBlocks.push(text);

            if (remainingLimit !== undefined) {
                const matchedLines = text ? text.split("\n").filter((line) => /:\d+: /.test(line)).length : 0;
                if (matchedLines >= remainingLimit || result.details?.matchLimitReached) break;
                remainingLimit = Math.max(1, remainingLimit - matchedLines);
            }
        }

        const output = outputBlocks.join("\n");
        return {
            content: [{ type: "text", text: output || "No matches found" }],
            details: mergeDetails(results),
        };
    };

    return tool;
}

export const __test = {
    buildSearchTargets,
    prepareGrepArguments,
    splitShellLike,
};
