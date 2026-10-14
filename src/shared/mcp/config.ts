import { platform } from "node:process";
import { captureForegroundProcess } from "../captured-process.ts";
import { type Stats } from "node:fs";
import { lstat as fsLstat, readFile as fsReadFile } from "node:fs/promises";
import { parse as parseJsonc } from "../jsonc.ts";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";

export type McpSourceKind = "global" | "project" | "request";
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonMap = { [key: string]: JsonValue };

export interface McpServerDefinition {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    source: McpSourceKind;
}

export interface McpWarning {
    source: McpSourceKind;
    filePath?: string;
    serverName?: string;
    stage: string;
    message: string;
}

export interface ResolveMcpConfigOptions {
    cwd: string;
    requestServers?: McpServerDefinition[];
}

export interface ResolveMcpConfigResult {
    servers: McpServerDefinition[];
    warnings: McpWarning[];
}

interface ParsedServerEntry {
    disabled: boolean;
    definition?: Omit<McpServerDefinition, "source">;
}

const MCP_FILE_NAME = "mcp.json";
const PROJECT_RELATIVE_MCP_PATH = ".wld/mcp.json";

function isJsonMap(value: JsonValue): value is JsonMap {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOwnerOnlyMode(mode: number | null): boolean {
    // Windows node:fs exposes synthetic mode bits, unlike Deno's null mode.
    // The POSIX permission gate cannot infer Windows ACL access from those bits.
    if (platform === "win32" || mode === null) return true;
    return (mode & 0o077) === 0;
}

function warning(
    source: McpSourceKind,
    stage: string,
    message: string,
    filePath?: string,
    serverName?: string,
): McpWarning {
    return { source, stage, message, ...(filePath ? { filePath } : {}), ...(serverName ? { serverName } : {}) };
}

async function safeFileInfo(path: string): Promise<Stats | null> {
    try {
        const info = await fsLstat(path);
        return info;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

async function runGit(cwd: string, args: string[]): Promise<boolean> {
    try {
        const output = await captureForegroundProcess("git", { cwd, args });
        return output.code === 0;
    } catch {
        return false;
    }
}

async function isSafeProjectMcpFile(
    projectRoot: string,
    filePath: string,
): Promise<{ ok: boolean; warning?: McpWarning }> {
    const info = await safeFileInfo(filePath);
    if (!info) return { ok: false };
    if (!info.isFile() || info.isSymbolicLink()) {
        return {
            ok: false,
            warning: warning("project", "file", "Project MCP configuration is not a regular file.", filePath),
        };
    }
    if (!isOwnerOnlyMode(info.mode)) {
        return {
            ok: false,
            warning: warning("project", "permissions", "Project MCP configuration must use mode 0600.", filePath),
        };
    }
    const tracked = await runGit(projectRoot, ["ls-files", "--error-unmatch", "--", PROJECT_RELATIVE_MCP_PATH]);
    if (tracked) {
        return {
            ok: false,
            warning: warning(
                "project",
                "git",
                "Project MCP configuration is tracked or staged; it was skipped.",
                filePath,
            ),
        };
    }
    const staged = await runGit(projectRoot, [
        "ls-files",
        "--cached",
        "--error-unmatch",
        "--",
        PROJECT_RELATIVE_MCP_PATH,
    ]);
    if (staged) {
        return {
            ok: false,
            warning: warning("project", "git", "Project MCP configuration is staged; it was skipped.", filePath),
        };
    }
    const ignored = await runGit(projectRoot, ["check-ignore", "--no-index", "--", PROJECT_RELATIVE_MCP_PATH]);
    if (!ignored) {
        return {
            ok: false,
            warning: warning("project", "git", "Project MCP configuration must be ignored by Git.", filePath),
        };
    }
    return { ok: true };
}

function readStringArray(value: JsonValue | undefined, filePath: string, serverName: string, field: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`${filePath} server ${serverName} field ${field} must be an array of strings`);
    }
    return value as string[];
}

function readEnv(value: JsonValue | undefined, filePath: string, serverName: string): Record<string, string> {
    if (value === undefined) return {};
    if (!isJsonMap(value)) throw new Error(`${filePath} server ${serverName} field env must be an object of strings`);
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "string") {
            throw new Error(`${filePath} server ${serverName} field env.${key} must be a string`);
        }
        result[key] = entry;
    }
    return result;
}

function parseServer(name: string, value: JsonValue, filePath: string): ParsedServerEntry {
    if (!isJsonMap(value)) throw new Error(`${filePath} server ${name} must be an object`);
    if (value.enabled === false) return { disabled: true };
    if (typeof value.command !== "string" || !value.command.trim()) {
        throw new Error(`${filePath} server ${name} field command must be a string`);
    }
    return {
        disabled: false,
        definition: {
            name,
            command: value.command,
            args: readStringArray(value.args, filePath, name, "args"),
            env: readEnv(value.env, filePath, name),
        },
    };
}

function safeConfigErrorMessage(path: string, error: Error | null): string {
    const message = error?.message || "MCP configuration could not be read.";
    if (message.startsWith(`${path} `)) return message;
    return `${path} could not be parsed.`;
}

async function readConfigFile(
    path: string,
    source: McpSourceKind,
): Promise<{ entries: Map<string, ParsedServerEntry>; warning?: McpWarning }> {
    const info = await safeFileInfo(path);
    if (!info) return { entries: new Map() };
    if (!info.isFile() || info.isSymbolicLink()) {
        return {
            entries: new Map(),
            warning: warning(source, "file", "MCP configuration is not a regular file.", path),
        };
    }
    if (!isOwnerOnlyMode(info.mode)) {
        return {
            entries: new Map(),
            warning: warning(source, "permissions", "MCP configuration must use mode 0600.", path),
        };
    }
    try {
        const text = await fsReadFile(path, "utf8");
        const parsed = parseJsonc(text) as JsonValue;
        if (!isJsonMap(parsed)) throw new Error(`${path} must contain an object`);
        const servers = parsed.mcpServers;
        if (servers === undefined) return { entries: new Map() };
        if (!isJsonMap(servers)) throw new Error(`${path} field mcpServers must be an object`);
        const entries = new Map<string, ParsedServerEntry>();
        for (const [name, value] of Object.entries(servers)) entries.set(name, parseServer(name, value, path));
        return { entries };
    } catch (error) {
        const failure = error instanceof Error ? error : null;
        return { entries: new Map(), warning: warning(source, "parse", safeConfigErrorMessage(path, failure), path) };
    }
}

export function getGlobalMcpConfigPath(): string {
    return join(getHomeDir(), ".wld", MCP_FILE_NAME);
}

export function getProjectMcpConfigPath(cwd: string): string {
    return join(resolvePrimaryCheckoutRoot(cwd), PROJECT_RELATIVE_MCP_PATH);
}

export async function resolveMcpConfig(options: ResolveMcpConfigOptions): Promise<ResolveMcpConfigResult> {
    const warnings: McpWarning[] = [];
    const resolved = new Map<string, McpServerDefinition>();
    const globalPath = getGlobalMcpConfigPath();
    const globalFile = await readConfigFile(globalPath, "global");
    if (globalFile.warning) warnings.push(globalFile.warning);
    for (const [name, entry] of globalFile.entries) {
        if (entry.definition && !entry.disabled) resolved.set(name, { ...entry.definition, source: "global" });
    }

    const primaryRoot = resolvePrimaryCheckoutRoot(options.cwd);
    const projectPath = join(primaryRoot, PROJECT_RELATIVE_MCP_PATH);
    const projectSafety = await isSafeProjectMcpFile(primaryRoot, projectPath);
    if (projectSafety.warning) warnings.push(projectSafety.warning);
    if (projectSafety.ok) {
        const projectFile = await readConfigFile(projectPath, "project");
        if (projectFile.warning) warnings.push(projectFile.warning);
        for (const [name, entry] of projectFile.entries) {
            if (entry.disabled) resolved.delete(name);
            else if (entry.definition) resolved.set(name, { ...entry.definition, source: "project" });
        }
    }

    for (const requestServer of options.requestServers || []) {
        if (resolved.has(requestServer.name)) {
            warnings.push(
                warning(
                    "request",
                    "merge",
                    "Request MCP server name duplicates configured server; request server was skipped.",
                    undefined,
                    requestServer.name,
                ),
            );
            continue;
        }
        resolved.set(requestServer.name, { ...requestServer, source: "request" });
    }
    return { servers: Array.from(resolved.values()), warnings };
}
