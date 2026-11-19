import { getCwd } from "../src/constants.ts";
import { readdir as fsReaddir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
/**
 * @module scripts/extract-router-decisions
 *
 * Extract Router triage decisions from persisted RunWield session JSONL files.
 */

import { basename, join } from "node:path";
import { parseArgs } from "../src/shared/cli-args.ts";
import { ROUTING_INTENTS } from "../src/constants.ts";

const PLAN_ROUTING_INTENTS = ["FEATURE", "PROJECT"];

export interface RouterDecision {
    decisionId: string;
    sessionId: string;
    sessionFile: string;
    triageEntryId: string;
    userEntryId: string;
    timestamp: string;
    requestText: string;
    hasImages: boolean;
    provider: string;
    model: string;
    routingIntent: string;
    classification?: string;
    complexity: string;
    summary: string;
    affectedPaths: string[];
    discoveryToolCount: number;
    discoveryTools: string[];
    intentSource: "routingIntent" | "classification";
    attribution: "active_agent_router";
}

export type RouterTriageDecision = Pick<
    RouterDecision,
    "routingIntent" | "classification" | "complexity" | "summary" | "affectedPaths" | "intentSource"
>;

export interface RouterContentBlock {
    type?: string;
    text?: string;
    name?: string;
}

export type RouterMessageContent = string | RouterContentBlock[];

export interface RouterSessionMessage {
    role?: string;
    content?: RouterMessageContent;
    provider?: string;
    model?: string;
    toolName?: string;
    details?: Partial<RouterTriageDecision>;
}

export interface RouterActiveAgentData {
    agentName?: string;
}

export interface RouterSessionEntry {
    type?: string;
    id?: string;
    timestamp?: string;
    customType?: string;
    data?: RouterActiveAgentData;
    provider?: string;
    modelId?: string;
    message?: RouterSessionMessage;
}

export interface RouterUserContent {
    text: string;
    hasImages: boolean;
}

interface PendingRouterUser extends RouterUserContent {
    entryId: string;
    timestamp: string;
    discoveryTools: string[];
}

export interface RouterEntryExtractionOptions {
    sessionFile?: string;
}

export interface RouterExtractionOptions {
    sessionsDir: string;
    limit?: number;
}

interface RouterExtractionArguments {
    _: (string | number)[];
    help?: boolean;
    cwd?: string;
    out?: string;
    limit?: string;
    "sessions-dir"?: string;
}

function asRoutingIntent<TValue>(value: TValue): string | null {
    return typeof value === "string" && ROUTING_INTENTS.includes(value) ? value : null;
}

function asStringArray<TValue>(value: TValue): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeTriageDetails(
    details: Partial<RouterTriageDecision> | null | undefined,
): RouterTriageDecision | null {
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    const record = details;
    const directIntent = asRoutingIntent(record.routingIntent);
    const legacyIntent = asRoutingIntent(record.classification);
    const routingIntent = directIntent || legacyIntent;
    if (!routingIntent) return null;

    const normalized: RouterTriageDecision = {
        routingIntent,
        complexity: typeof record.complexity === "string" ? record.complexity : "",
        summary: typeof record.summary === "string" ? record.summary : "",
        affectedPaths: asStringArray(record.affectedPaths),
        intentSource: directIntent ? "routingIntent" : "classification",
    };

    if (PLAN_ROUTING_INTENTS.includes(routingIntent)) {
        normalized.classification = routingIntent;
    }

    return normalized;
}

export function encodeCwdForSessionDir(cwd: string): string {
    return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function extractUserContent(content: RouterMessageContent | undefined): RouterUserContent {
    if (typeof content === "string") return { text: content, hasImages: false };
    if (!Array.isArray(content)) return { text: "", hasImages: false };

    const text: string[] = [];
    let hasImages = false;
    for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const typed = block;
        if (typed.type === "text" && typed.text) text.push(typed.text);
        if (typed.type === "image" || typed.type === "image_url") hasImages = true;
    }
    return { text: text.join("\n").trim(), hasImages };
}

export function extractToolCallNames(content: RouterMessageContent | undefined): string[] {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const typed = block;
        if ((typed.type === "toolCall" || typed.type === "tool_use") && typed.name) return [typed.name];
        return [];
    });
}

export function extractRouterDecisionsFromEntries(
    entries: RouterSessionEntry[],
    options: RouterEntryExtractionOptions = {},
): RouterDecision[] {
    let sessionId = "";
    let activeAgent = "";
    let provider = "";
    let model = "";
    let lastRouterAssistantProvider = "";
    let lastRouterAssistantModel = "";

    let pendingRouterUser: PendingRouterUser | null = null;
    const decisions: RouterDecision[] = [];
    const sessionFile = options.sessionFile || "";

    for (const entry of entries) {
        const type = entry.type;
        if (type === "session") {
            sessionId = typeof entry.id === "string" ? entry.id : sessionId;
            continue;
        }

        if (
            (type === "custom" || type === "custom_message") &&
            entry.customType === "runwield.active_agent" &&
            entry.data &&
            typeof entry.data === "object"
        ) {
            const agentName = entry.data.agentName;
            activeAgent = typeof agentName === "string" ? agentName : activeAgent;
            if (activeAgent !== "router") pendingRouterUser = null;
            continue;
        }

        if (type === "model_change") {
            provider = typeof entry.provider === "string" ? entry.provider : provider;
            model = typeof entry.modelId === "string" ? entry.modelId : model;
            continue;
        }

        if (type !== "message" || !entry.message || typeof entry.message !== "object") continue;
        const message = entry.message;

        if (message.role === "user") {
            if (activeAgent !== "router") {
                pendingRouterUser = null;
                continue;
            }
            const userContent = extractUserContent(message.content);
            pendingRouterUser = {
                entryId: typeof entry.id === "string" ? entry.id : "",
                timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
                text: userContent.text,
                hasImages: userContent.hasImages,
                discoveryTools: [],
            };
            continue;
        }

        if (message.role === "assistant") {
            if (typeof message.provider === "string") provider = message.provider;
            if (typeof message.model === "string") model = message.model;

            if (activeAgent === "router" && pendingRouterUser) {
                const toolNames = extractToolCallNames(message.content);
                for (const toolName of toolNames) {
                    if (toolName !== "triage_report") pendingRouterUser.discoveryTools.push(toolName);
                }
                if (toolNames.includes("triage_report")) {
                    lastRouterAssistantProvider = provider;
                    lastRouterAssistantModel = model;
                }
            }
            continue;
        }

        if (message.role === "toolResult" && message.toolName === "triage_report") {
            if (activeAgent !== "router" || !pendingRouterUser) continue;
            const normalized = normalizeTriageDetails(message.details);
            if (!normalized) continue;

            const triageEntryId = typeof entry.id === "string" ? entry.id : "";
            decisions.push({
                decisionId: `${basename(sessionFile)}:${triageEntryId || decisions.length}`,
                sessionId,
                sessionFile,
                triageEntryId,
                userEntryId: pendingRouterUser.entryId,
                timestamp: typeof entry.timestamp === "string" ? entry.timestamp : pendingRouterUser.timestamp,
                requestText: pendingRouterUser.text,
                hasImages: pendingRouterUser.hasImages,
                provider: lastRouterAssistantProvider || provider,
                model: lastRouterAssistantModel || model,
                ...normalized,
                discoveryToolCount: pendingRouterUser.discoveryTools.length,
                discoveryTools: pendingRouterUser.discoveryTools.slice(),
                attribution: "active_agent_router",
            });

            pendingRouterUser = null;
            lastRouterAssistantProvider = "";
            lastRouterAssistantModel = "";
        }
    }

    return decisions;
}

export function parseJsonlEntries(text: string): RouterSessionEntry[] {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line): RouterSessionEntry => JSON.parse(line));
}

export async function extractRouterDecisionsFromFile(path: string): Promise<RouterDecision[]> {
    const entries = parseJsonlEntries(await fsReadFile(path, "utf8"));
    return extractRouterDecisionsFromEntries(entries, { sessionFile: path });
}

export async function listSessionFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of await fsReaddir(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
    }
    return files.sort();
}

export async function extractRouterDecisions(options: RouterExtractionOptions): Promise<RouterDecision[]> {
    const files = await listSessionFiles(options.sessionsDir);
    const rows: RouterDecision[] = [];
    for (const file of files) {
        const entries = parseJsonlEntries(await fsReadFile(file, "utf8"));
        rows.push(...extractRouterDecisionsFromEntries(entries, { sessionFile: file }));
        if (options.limit && rows.length >= options.limit) return rows.slice(0, options.limit);
    }
    return rows;
}

function toJsonl<TRow>(rows: TRow[]): string {
    return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

async function writeStdout(text: string) {
    await new Promise((resolve, reject) =>
        process.stdout.write(text, (error) => (error ? reject(error) : resolve(undefined))),
    );
}

function parsePositiveInt(value: string): number | undefined {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function main(argv: string[]) {
    const args: RouterExtractionArguments = parseArgs(argv, {
        string: ["sessions-dir", "cwd", "out", "limit"],
        boolean: ["help"],
        alias: { h: "help", o: "out" },
    });

    if (args.help) {
        console.log(
            [
                "Usage: bun scripts/extract-router-decisions.ts [options]",
                "",
                "Options:",
                "  --sessions-dir <dir>  Session directory to read",
                "  --cwd <path>          Project cwd used to resolve the default session directory",
                "  --out, -o <path>      Write JSONL to this path instead of stdout",
                "  --limit <n>           Stop after n decisions",
            ].join("\n"),
        );
        return;
    }

    const cwd = args.cwd || getCwd();
    const home = process.env["HOME"] || "";
    const sessionsDir = args["sessions-dir"] || join(home, ".wld", "sessions", encodeCwdForSessionDir(cwd));
    const rows = await extractRouterDecisions({
        sessionsDir,
        limit: args.limit ? parsePositiveInt(args.limit) : undefined,
    });
    const output = toJsonl(rows);

    if (args.out) await fsWriteFile(args.out, output);
    else await writeStdout(output);
}

if (import.meta.main) {
    await main(process.argv.slice(2));
}
