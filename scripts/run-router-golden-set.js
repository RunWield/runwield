import { captureScriptProcess } from "./script-process.ts";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * @module scripts/run-router-golden-set
 *
 * Run the real Router against golden judgement rows and compare its
 * triage_report decision to humanJudgement.
 */

import { parseArgs } from "../src/shared/cli-args.ts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { AGENTS, getCwd, getHomeDir } from "../src/constants.js";
import { createSessionRuntime } from "../src/shared/session/session-runtime.ts";
import { readLatestTriageOutcome as readLatestTriageOutcomeFn } from "../src/shared/workflow/orchestrator.ts";
import {
    parseCsv,
    ROUTER_JUDGEMENT_COLUMNS,
    scoreAgainstHuman,
    toCsv,
    withRouterJudgementMetrics,
} from "./router-eval-utils.js";

/** @typedef {Parameters<import("../src/shared/session/session-runtime.ts").SessionRuntime["setSessionThinkingLevel"]>[1]} RouterThinkingLevel */

const ROUTER_EVAL_DIRNAME = "router-eval";
const DEFAULT_GOLDEN_CSV_NAME = "router-judgements.csv";
const DEFAULT_RESULT_CSV_NAME = "router-judgements-results.csv";
const DEFAULT_ROW_TIMEOUT_MS = 60_000;
const BENCHMARK_BASH_NUDGE = "bash is disabled in this run, and the command below was not executed.";

/**
 * @returns {string}
 */
export function getDefaultRouterEvalDir() {
    return join(getHomeDir(), ".wld", ROUTER_EVAL_DIRNAME);
}

/**
 * @returns {string}
 */
export function getDefaultRouterGoldenCsvPath() {
    return join(getDefaultRouterEvalDir(), DEFAULT_GOLDEN_CSV_NAME);
}

/**
 * @returns {string}
 */
export function getDefaultRouterResultCsvPath() {
    return join(getDefaultRouterEvalDir(), DEFAULT_RESULT_CSV_NAME);
}

const BENCHMARK_ROUTER_TOOLS = [
    "read",
    "grep",
    "find",
    "ls",
    "memory_recall",
    "code_search",
    "code_show",
    "code_outline",
    "code_refs",
    "code_impact",
    "code_trace",
    "code_investigate",
    "code_structure",
    "code_impls",
    "code_importers",
    "triage_report",
];

/**
 * @typedef {Object} RouterAgentRunOptions
 * @property {string} agentName
 * @property {string[]} toolNames
 * @property {string} userRequest
 * @property {import('../src/shared/session/types.js').ImageAttachment[]} images
 * @property {import('@earendil-works/pi-coding-agent').ToolDefinition[]} customTools
 * @property {string} [modelOverride]
 * @property {RouterThinkingLevel} [thinkingLevelOverride]
 * @property {number} [temperatureOverride]
 * @property {string} [cwd]
 */

/** @typedef {(options: RouterAgentRunOptions) => Promise<any[]>} RouterAgentRunner */

/**
 * @returns {import('@earendil-works/pi-coding-agent').ToolDefinition}
 */
export function createBenchmarkBashNudgeTool() {
    let callCount = 0;
    return defineTool({
        name: "bash",
        label: "Benchmark Bash Nudge",
        description:
            "Benchmark-only bash shim. It never executes commands. It explains that bash is disabled here and nudges Router to use read-only discovery tools or call triage_report.",
        parameters: Type.Object({
            command: Type.String({
                description: "The shell command Router wanted to use for discovery.",
            }),
        }),
        // deno-lint-ignore require-await
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
            callCount++;
            const command = typeof params?.command === "string" ? params.command : "";
            const repeatedCallNudge =
                callCount > 1
                    ? `\n\nRepeated bash attempt #${callCount}: stop calling bash in this benchmark row. Call triage_report now unless one non-bash read tool is essential.`
                    : "";
            return {
                content: [
                    {
                        type: "text",
                        text: command
                            ? `${BENCHMARK_BASH_NUDGE}${repeatedCallNudge}\n\nRequested command: ${command}`
                            : `${BENCHMARK_BASH_NUDGE}${repeatedCallNudge}`,
                    },
                ],
                details: {
                    blocked: true,
                    callCount,
                    command,
                    reason: BENCHMARK_BASH_NUDGE,
                },
            };
        },
    });
}

/**
 * @param {Record<string, string>} row
 * @param {number} index
 * @returns {string}
 */
function getDecisionId(row, index) {
    return row.decisionId || `golden-${String(index + 1).padStart(4, "0")}`;
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
function withAbortTimeout(promise, timeoutMs, onTimeout = () => {}) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            onTimeout();
            reject(new Error(`Router golden row timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
    });
}

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parsePositiveInt(value) {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * @param {Record<string, string>} row
 * @param {number} index
 * @returns {Record<string, unknown>}
 */
export function normalizeGoldenRow(row, index) {
    return withRouterJudgementMetrics({
        decisionId: getDecisionId(row, index),
        timestamp: row.timestamp || "",
        attribution: row.attribution || "golden_fixture",
        requestText: row.requestText || "",
        routerDecision: row.routerDecision || "",
        humanJudgement: row.humanJudgement || "",
        humanNotes: row.humanNotes || "",
        routerSummary: row.routerSummary || "",
        routerAffectedPaths: row.routerAffectedPaths || "",
        contextCommit: (row.contextCommit || "").trim().toLowerCase(),
    });
}

/**
 * @param {Record<string, string>} row
 * @returns {boolean}
 */
function shouldRunRow(row) {
    return Boolean(row.requestText?.trim() && row.humanJudgement?.trim());
}

/**
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function hasCompletedRouterDecision(row) {
    return Boolean(String(row.routerDecision || "").trim());
}

/**
 * @param {Array<Record<string, string>>} goldenRows
 * @param {Array<Record<string, string>>} resultRows
 * @returns {Array<Record<string, string>>}
 */
export function mergeGoldenRowsWithResultRows(goldenRows, resultRows) {
    const resultById = new Map(resultRows.map((row) => [row.decisionId, row]));
    return goldenRows.map((goldenRow, index) => {
        const decisionId = getDecisionId(goldenRow, index);
        const priorResult = resultById.get(decisionId);
        const contextCommit = (goldenRow.contextCommit || "").trim().toLowerCase();
        const contextChanged = (priorResult?.contextCommit || "").trim().toLowerCase() !== contextCommit;
        const resultRow = contextChanged ? undefined : priorResult;
        return {
            ...goldenRow,
            decisionId,
            routerDecision: contextChanged ? "" : resultRow?.routerDecision || goldenRow.routerDecision || "",
            routerSummary: contextChanged ? "" : resultRow?.routerSummary || goldenRow.routerSummary || "",
            routerAffectedPaths: contextChanged
                ? ""
                : resultRow?.routerAffectedPaths || goldenRow.routerAffectedPaths || "",
        };
    });
}

/**
 * @param {string} path
 * @returns {Promise<Array<Record<string, string>>>}
 */
async function readExistingCsv(path) {
    try {
        return parseCsv(await fsReadFile(path, "utf8"));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function runContextGit(cwd, args) {
    const result = await captureScriptProcess("git", { cwd, args, stdout: "piped", stderr: "piped" });
    const decoder = new TextDecoder();
    if (!result.success) {
        throw new Error(`Context Git failed: ${decoder.decode(result.stderr).trim()}`);
    }
    return decoder.decode(result.stdout).trim();
}

/**
 * @param {string} requestText
 * @param {{
 *   cwd?: string,
 *   modelOverride?: string,
 *   thinkingLevelOverride?: RouterThinkingLevel,
 *   temperatureOverride?: number,
 *   rowTimeoutMs?: number,
 *   runAgentSession?: RouterAgentRunner,
 *   customTools?: import('@earendil-works/pi-coding-agent').ToolDefinition[],
 * }} [options]
 * @returns {Promise<import('../src/shared/workflow/triage-outcome.ts').TriageOutcome>}
 */
export async function runRouterForGoldenRequest(requestText, options = {}) {
    const agentOptions = /** @type {RouterAgentRunOptions} */ ({
        agentName: AGENTS.ROUTER,
        toolNames: BENCHMARK_ROUTER_TOOLS,
        userRequest: requestText,
        images: [],
        customTools: [createBenchmarkBashNudgeTool(), ...(options.customTools || [])],
        modelOverride: options.modelOverride,
        thinkingLevelOverride: options.thinkingLevelOverride,
        temperatureOverride: options.temperatureOverride,
    });

    /** @type {() => void} */
    let cancel = () => {};
    /** @type {() => Promise<void>} */
    let close = () => Promise.resolve();
    let messagesPromise;
    if (options.runAgentSession) {
        messagesPromise = options.runAgentSession({ ...agentOptions, cwd: options.cwd });
    } else {
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: options.cwd || getCwd() });
        cancel = () => {
            runtime.cancelSession(created.sessionId);
        };
        close = async () => {
            await runtime.closeSessionWhenIdle(created.sessionId);
        };
        messagesPromise = runtime.runIsolatedAgent(created.sessionId, agentOptions);
    }

    try {
        const messages = options.rowTimeoutMs
            ? await withAbortTimeout(
                  messagesPromise.then((result) => result),
                  options.rowTimeoutMs,
                  cancel,
              )
            : await messagesPromise;
        if (!Array.isArray(messages)) throw new Error(messages.error || "Router operation was refused.");
        const triage = readLatestTriageOutcomeFn(messages);
        if (!triage) throw new Error("Router did not call triage_report.");
        return triage;
    } finally {
        await close();
    }
}

/**
 * @param {Array<Record<string, string>>} rows
 * @param {{
 *   limit?: number,
 *   cwd?: string,
 *   modelOverride?: string,
 *   thinkingLevelOverride?: RouterThinkingLevel,
 *   temperatureOverride?: number,
 *   rowTimeoutMs?: number,
 *   runAgentSession?: RouterAgentRunner,
 *   onProgress?: (message: string) => void,
 *   onRowComplete?: (rows: Array<Record<string, unknown>>) => Promise<void> | void,
 *   resume?: boolean,
 * }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function runRouterGoldenSet(rows, options = {}) {
    const result = await runRouterGoldenSetWithSelection(rows, options);
    return result.rows;
}

/**
 * @param {Array<Record<string, string>>} rows
 * @param {{
 *   limit?: number,
 *   cwd?: string,
 *   modelOverride?: string,
 *   thinkingLevelOverride?: RouterThinkingLevel,
 *   temperatureOverride?: number,
 *   rowTimeoutMs?: number,
 *   runAgentSession?: RouterAgentRunner,
 *   onProgress?: (message: string) => void,
 *   onRowComplete?: (rows: Array<Record<string, unknown>>) => Promise<void> | void,
 *   resume?: boolean,
 * }} [options]
 * @returns {Promise<{ rows: Array<Record<string, unknown>>, selectedIndexes: number[] }>}
 */
export async function runRouterGoldenSetWithSelection(rows, options = {}) {
    const normalized = rows.map(normalizeGoldenRow);
    const runnableIndexes = normalized
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => shouldRunRow(/** @type {Record<string, string>} */ (row)))
        .filter(({ row }) => !options.resume || !hasCompletedRouterDecision(row));
    const selected = options.limit ? runnableIndexes.slice(0, options.limit) : runnableIndexes;
    const selectedIndexes = selected.map(({ index }) => index);

    if (!options.resume) {
        for (const { row, index } of selected) {
            normalized[index] = withRouterJudgementMetrics({
                ...row,
                routerDecision: "",
                routerSummary: "",
                routerAffectedPaths: "",
            });
        }
    }

    const sourceCwd = options.cwd || getCwd();
    let tempDir = "";
    let worktree = "";
    let worktreeAdded = false;

    /** @param {string} contextCommit */
    async function resolveRowCwd(contextCommit) {
        if (!contextCommit) return sourceCwd;
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(contextCommit)) {
            throw new Error("Invalid contextCommit: use a full 40- or 64-character Git commit hash.");
        }
        const commit = await runContextGit(sourceCwd, ["rev-parse", "--verify", `${contextCommit}^{commit}`]);
        if (!worktreeAdded) {
            tempDir ||= await fsMkdtemp(join(tmpdir(), "runwield-router-context-"));
            worktree = join(tempDir, "checkout");
            await runContextGit(sourceCwd, ["worktree", "add", "--detach", worktree, commit]);
            worktreeAdded = true;
        } else {
            await runContextGit(worktree, ["checkout", "--detach", commit]);
        }
        return worktree;
    }

    try {
        for (let selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
            const { row, index } = selected[selectedIndex];
            try {
                const cwd = await resolveRowCwd(String(row.contextCommit || ""));
                const triage = await runRouterForGoldenRequest(String(row.requestText || ""), {
                    cwd,
                    modelOverride: options.modelOverride,
                    thinkingLevelOverride: options.thinkingLevelOverride,
                    temperatureOverride: options.temperatureOverride,
                    rowTimeoutMs: options.rowTimeoutMs,
                    runAgentSession: options.runAgentSession,
                });
                normalized[index] = withRouterJudgementMetrics({
                    ...row,
                    routerDecision: triage.routingIntent,
                    routerSummary: triage.summary || "",
                    // Triage no longer collects affected paths, so the benchmark column stays empty.
                    routerAffectedPaths: "",
                });
            } catch (error) {
                normalized[index] = withRouterJudgementMetrics({
                    ...row,
                    routerDecision: "",
                    routerSummary: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
                    routerAffectedPaths: "",
                });
            }
            await options.onRowComplete?.(normalized);
            options.onProgress?.(
                `Routed ${selectedIndex + 1}/${selected.length}: ${
                    normalized[index].decisionId || "(unknown decision)"
                }`,
            );
        }
    } finally {
        // Remove only this benchmark's worktree, including generated files, when the run ends.
        // If Git cleanup fails, preserve the directory and surface the failure.
        if (worktreeAdded) await runContextGit(sourceCwd, ["worktree", "remove", "--force", worktree]);
        if (tempDir) await fsRm(tempDir, { recursive: true });
    }

    return { rows: normalized, selectedIndexes };
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Record<string, unknown>}
 */
export function buildRouterGoldenReport(rows) {
    const labelledRows = rows.filter((row) => String(row.humanJudgement || "").trim()).length;
    const router = scoreAgainstHuman(
        rows.map((row) => /** @type {Record<string, string>} */ (row)),
        "routerDecision",
    );
    return {
        labelledRows,
        unlabelledRows: rows.length - labelledRows,
        router,
    };
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
    const args = parseArgs(argv, {
        string: ["csv", "out", "limit", "model", "cwd", "row-timeout-ms", "thinking-level", "temperature"],
        boolean: ["help", "rerun"],
        alias: { h: "help", o: "out", m: "model" },
    });

    if (args.help) {
        console.log(
            [
                "Usage: bun scripts/run-router-golden-set.js [options]",
                "",
                "Runs the real Router against labelled Router judgement rows.",
                "",
                "Options:",
                `  --csv <path>          Golden CSV input (default: ${getDefaultRouterGoldenCsvPath()})`,
                `  --out, -o <path>     CSV output (default: ${getDefaultRouterResultCsvPath()})`,
                "  --limit <n>          Run only the first n selected rows",
                "  --model, -m <ref>    Override Router model, e.g. provider/model",
                "  --thinking-level <level> Override thinking: off, minimal, low, medium, high, xhigh, max",
                "  --temperature <n>    Override sampling temperature (0–2; provider support varies)",
                "  --cwd <path>         Discovery cwd and source repository for contextCommit pins",
                "  CSV contextCommit    Optional full commit hash; discovery uses a detached temporary worktree",
                `  --row-timeout-ms <n> Per-row timeout (default: ${DEFAULT_ROW_TIMEOUT_MS})`,
                "  --rerun              Rerun selected rows instead of resuming unfinished rows",
            ].join("\n"),
        );
        return;
    }

    const thinkingLevels = /** @type {const} */ (["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    const thinkingLevelOverride = thinkingLevels.find((level) => level === args["thinking-level"]);
    if (args["thinking-level"] !== undefined && thinkingLevelOverride === undefined) {
        throw new Error("Invalid --thinking-level. Use off, minimal, low, medium, high, xhigh, or max.");
    }
    const temperatureText = args.temperature?.trim();
    const temperatureOverride = temperatureText === undefined ? undefined : Number(temperatureText);
    if (
        temperatureOverride !== undefined &&
        (temperatureText === "" ||
            !Number.isFinite(temperatureOverride) ||
            temperatureOverride < 0 ||
            temperatureOverride > 2)
    ) {
        throw new Error("Invalid --temperature. Use a finite number from 0 to 2.");
    }

    const csvPath = args.csv || getDefaultRouterGoldenCsvPath();
    const outputPath = args.out || getDefaultRouterResultCsvPath();
    const resume = !args.rerun;
    const goldenRows = parseCsv(await fsReadFile(csvPath, "utf8"));
    const priorResultRows = resume ? await readExistingCsv(outputPath) : [];
    const rows = resume ? mergeGoldenRowsWithResultRows(goldenRows, priorResultRows) : goldenRows;
    await fsMkdir(dirname(outputPath), { recursive: true });
    const result = await runRouterGoldenSetWithSelection(rows, {
        limit: parsePositiveInt(args.limit),
        cwd: args.cwd,
        modelOverride: args.model,
        thinkingLevelOverride,
        temperatureOverride,
        rowTimeoutMs: parsePositiveInt(args["row-timeout-ms"]) || DEFAULT_ROW_TIMEOUT_MS,
        resume,
        onRowComplete: async (checkpointRows) => {
            await fsWriteFile(outputPath, toCsv(ROUTER_JUDGEMENT_COLUMNS, checkpointRows));
        },
        onProgress: (message) => console.error(message),
    });
    const resultRows = result.rows;

    await fsWriteFile(outputPath, toCsv(ROUTER_JUDGEMENT_COLUMNS, resultRows));
    const scoredRows = args.limit ? result.selectedIndexes.map((index) => resultRows[index]) : resultRows;
    console.log(JSON.stringify(buildRouterGoldenReport(scoredRows), null, 2));
}

if (import.meta.main) {
    await main(process.argv.slice(2));
}
