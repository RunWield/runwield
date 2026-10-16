import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
/**
 * @module scripts/write-router-judgement-csv
 *
 * Generate a human-reviewable Router judgement CSV from extracted Router decisions.
 */

import { parseArgs } from "../src/shared/cli-args.ts";
import { dirname, join } from "node:path";
import { getHomeDir } from "../src/constants.js";
import {
    indexRowsByDecisionId,
    parseCsv,
    ROUTER_JUDGEMENT_COLUMNS,
    toCsv,
    withRouterJudgementMetrics,
} from "./router-eval-utils.js";

const DEFAULT_INPUT = "/private/tmp/runwield-router-decisions.jsonl";
const DEFAULT_OUTPUT_NAME = "router-judgements.csv";

/**
 * @returns {string}
 */
export function getDefaultRouterJudgementCsvPath() {
    return join(getHomeDir(), ".wld", "router-eval", DEFAULT_OUTPUT_NAME);
}

export const JUDGEMENT_COLUMNS = ROUTER_JUDGEMENT_COLUMNS;

/**
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
export function parseJsonlRows(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => /** @type {Record<string, unknown>} */ (JSON.parse(line)));
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, string> | undefined} existing
 * @returns {Record<string, unknown>}
 */
export function buildJudgementCsvRow(row, existing) {
    const routerDecision = typeof row.routingIntent === "string" ? row.routingIntent : "";

    return withRouterJudgementMetrics({
        decisionId: row.decisionId,
        timestamp: row.timestamp,
        attribution: row.attribution,
        requestText: row.requestText,
        routerDecision,
        humanJudgement: existing?.humanJudgement || "",
        humanNotes: existing?.humanNotes || "",
        contextCommit: existing?.contextCommit || "",
        routerSummary: typeof row.summary === "string" ? row.summary : "",
        routerAffectedPaths: Array.isArray(row.affectedPaths) ? row.affectedPaths.join("; ") : "",
    });
}

/**
 * @param {Record<string, unknown>[]} reviewedRows
 * @param {Array<Record<string, string>>} [existingRows]
 * @returns {string}
 */
export function buildJudgementCsv(reviewedRows, existingRows = []) {
    const existingById = indexRowsByDecisionId(existingRows);
    const rows = reviewedRows.map((row) => buildJudgementCsvRow(row, existingById.get(String(row.decisionId || ""))));
    return toCsv(JUDGEMENT_COLUMNS, rows);
}

/**
 * @param {string} path
 * @returns {Promise<Array<Record<string, string>>>}
 */
async function readExistingCsv(path) {
    try {
        return parseCsv(await fsReadFile(path, "utf8"));
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return [];
        throw error;
    }
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
    const args = parseArgs(argv, {
        string: ["in", "out"],
        boolean: ["help", "no-preserve"],
        alias: { h: "help", i: "in", o: "out" },
    });

    if (args.help) {
        console.log([
            "Usage: bun scripts/write-router-judgement-csv.js --in router-decisions.jsonl --out router-judgements.csv",
            "",
            "Options:",
            `  --in, -i <path>       Extracted Router decisions JSONL (default: ${DEFAULT_INPUT})`,
            `  --out, -o <path>      CSV output (default: ${getDefaultRouterJudgementCsvPath()})`,
            "  --no-preserve         Do not preserve existing humanJudgement/humanNotes values from the output CSV",
        ].join("\n"));
        return;
    }

    const inputPath = args.in || DEFAULT_INPUT;
    const outputPath = args.out || getDefaultRouterJudgementCsvPath();
    const reviewedRows = parseJsonlRows(await fsReadFile(inputPath, "utf8"));
    const existingRows = args["no-preserve"] ? [] : await readExistingCsv(outputPath);
    await fsMkdir(dirname(outputPath), { recursive: true });
    await fsWriteFile(outputPath, buildJudgementCsv(reviewedRows, existingRows));
    console.log(`Wrote ${reviewedRows.length} row(s) to ${outputPath}.`);
}

if (import.meta.main) {
    await main(process.argv.slice(2));
}
