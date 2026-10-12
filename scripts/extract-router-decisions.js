import { getCwd } from "../src/constants.js";
import { readdir as fsReaddir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
/**
 * @module scripts/extract-router-decisions
 *
 * Extract Router triage decisions from persisted RunWield session JSONL files.
 */

import { basename, join } from "node:path";
import { parseArgs } from "../src/shared/cli-args.ts";
import { ROUTING_INTENTS } from "../src/constants.js";

const PLAN_ROUTING_INTENTS = ["FEATURE", "PROJECT"];

/**
 * @typedef {Object} RouterDecision
 * @property {string} decisionId
 * @property {string} sessionId
 * @property {string} sessionFile
 * @property {string} triageEntryId
 * @property {string} userEntryId
 * @property {string} timestamp
 * @property {string} requestText
 * @property {boolean} hasImages
 * @property {string} provider
 * @property {string} model
 * @property {string} routingIntent
 * @property {string | undefined} [classification]
 * @property {string} complexity
 * @property {string} summary
 * @property {string[]} affectedPaths
 * @property {number} discoveryToolCount
 * @property {string[]} discoveryTools
 * @property {"routingIntent" | "classification"} intentSource
 * @property {"active_agent_router"} attribution
 */

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asRoutingIntent(value) {
    return typeof value === "string" && ROUTING_INTENTS.includes(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringArray(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/**
 * @param {unknown} details
 * @returns {(Pick<RouterDecision, "routingIntent" | "classification" | "complexity" | "summary" | "affectedPaths" | "intentSource">) | null}
 */
export function normalizeTriageDetails(details) {
    if (!details || typeof details !== "object" || Array.isArray(details)) return null;
    const record = /** @type {Record<string, unknown>} */ (details);
    const directIntent = asRoutingIntent(record.routingIntent);
    const legacyIntent = asRoutingIntent(record.classification);
    const routingIntent = directIntent || legacyIntent;
    if (!routingIntent) return null;

    /** @type {Pick<RouterDecision, "routingIntent" | "classification" | "complexity" | "summary" | "affectedPaths" | "intentSource">} */
    const normalized = {
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

/**
 * @param {string} cwd
 * @returns {string}
 */
export function encodeCwdForSessionDir(cwd) {
    return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * @param {unknown} content
 * @returns {{ text: string, hasImages: boolean }}
 */
export function extractUserContent(content) {
    if (typeof content === "string") return { text: content, hasImages: false };
    if (!Array.isArray(content)) return { text: "", hasImages: false };

    /** @type {string[]} */
    const text = [];
    let hasImages = false;
    for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const typed = /** @type {{ type?: string, text?: string }} */ (block);
        if (typed.type === "text" && typed.text) text.push(typed.text);
        if (typed.type === "image" || typed.type === "image_url") hasImages = true;
    }
    return { text: text.join("\n").trim(), hasImages };
}

/**
 * @param {unknown} content
 * @returns {string[]}
 */
export function extractToolCallNames(content) {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const typed = /** @type {{ type?: string, name?: string }} */ (block);
        if ((typed.type === "toolCall" || typed.type === "tool_use") && typed.name) return [typed.name];
        return [];
    });
}

/**
 * @param {Record<string, unknown>[]} entries
 * @param {{ sessionFile?: string }} [options]
 * @returns {RouterDecision[]}
 */
export function extractRouterDecisionsFromEntries(entries, options = {}) {
    let sessionId = "";
    let activeAgent = "";
    let provider = "";
    let model = "";
    let lastRouterAssistantProvider = "";
    let lastRouterAssistantModel = "";

    /** @type {{ entryId: string, timestamp: string, text: string, hasImages: boolean, discoveryTools: string[] } | null} */
    let pendingRouterUser = null;
    /** @type {RouterDecision[]} */
    const decisions = [];
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
            entry.data && typeof entry.data === "object"
        ) {
            const agentName = /** @type {{ agentName?: unknown }} */ (entry.data).agentName;
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
        const message =
            /** @type {{ role?: string, content?: unknown, provider?: string, model?: string, toolName?: string, details?: unknown }} */ (
                entry.message
            );

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

/**
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
export function parseJsonlEntries(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line)));
}

/**
 * @param {string} path
 * @returns {Promise<RouterDecision[]>}
 */
export async function extractRouterDecisionsFromFile(path) {
    const entries = parseJsonlEntries(await fsReadFile(path, "utf8"));
    return extractRouterDecisionsFromEntries(entries, { sessionFile: path });
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listSessionFiles(dir) {
    /** @type {string[]} */
    const files = [];
    for await (const entry of await fsReaddir(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
    }
    return files.sort();
}

/**
 * @param {{ sessionsDir: string, limit?: number }} options
 * @returns {Promise<RouterDecision[]>}
 */
export async function extractRouterDecisions(options) {
    const files = await listSessionFiles(options.sessionsDir);
    /** @type {RouterDecision[]} */
    const rows = [];
    for (const file of files) {
        const entries = parseJsonlEntries(await fsReadFile(file, "utf8"));
        rows.push(...extractRouterDecisionsFromEntries(entries, { sessionFile: file }));
        if (options.limit && rows.length >= options.limit) return rows.slice(0, options.limit);
    }
    return rows;
}

/**
 * @param {unknown[]} rows
 * @returns {string}
 */
function toJsonl(rows) {
    return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

/**
 * @param {string} text
 */
async function writeStdout(text) {
    await new Promise((resolve, reject) =>
        process.stdout.write(text, (error) => error ? reject(error) : resolve(undefined))
    );
}

/**
 * @param {string} value
 * @returns {number | undefined}
 */
function parsePositiveInt(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
    const args = parseArgs(argv, {
        string: ["sessions-dir", "cwd", "out", "limit"],
        boolean: ["help"],
        alias: { h: "help", o: "out" },
    });

    if (args.help) {
        console.log([
            "Usage: bun scripts/extract-router-decisions.js [options]",
            "",
            "Options:",
            "  --sessions-dir <dir>  Session directory to read",
            "  --cwd <path>          Project cwd used to resolve the default session directory",
            "  --out, -o <path>      Write JSONL to this path instead of stdout",
            "  --limit <n>           Stop after n decisions",
        ].join("\n"));
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
