import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
/**
 * @module scripts/evaluate-router-judgements
 *
 * Score human-filled Router judgement CSV files.
 */

import { parseArgs } from "../src/shared/cli-args.ts";
import { dirname, join } from "node:path";
import { getHomeDir } from "../src/constants.js";
import { parseCsv, scoreAgainstHuman } from "./router-eval-utils.js";

const DEFAULT_CSV_NAME = "router-judgements.csv";

/**
 * @returns {string}
 */
export function getDefaultRouterJudgementCsvPath() {
    return join(getHomeDir(), ".wld", "router-eval", DEFAULT_CSV_NAME);
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function parseNumber(value) {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * @param {Array<Record<string, string>>} rows
 */
export function summarizeJudgements(rows) {
    const labelledRows = rows.filter((row) => row.humanJudgement?.trim()).length;
    const router = scoreAgainstHuman(rows, "routerDecision");

    return {
        labelledRows,
        unlabelledRows: rows.length - labelledRows,
        router,
    };
}

/**
 * @param {ReturnType<typeof summarizeJudgements>} summary
 * @param {{ minRouterAgreementRate?: number, maxRouterMeanDistance?: number }} thresholds
 * @returns {string[]}
 */
export function checkThresholds(summary, thresholds) {
    /** @type {string[]} */
    const failures = [];
    if (
        thresholds.minRouterAgreementRate !== undefined &&
        summary.router.agreementRate < thresholds.minRouterAgreementRate
    ) {
        failures.push(
            `Router agreement ${summary.router.agreementRate} < threshold ${thresholds.minRouterAgreementRate}`,
        );
    }
    if (
        thresholds.maxRouterMeanDistance !== undefined &&
        summary.router.meanDistance > thresholds.maxRouterMeanDistance
    ) {
        failures.push(
            `Router mean distance ${summary.router.meanDistance} > threshold ${thresholds.maxRouterMeanDistance}`,
        );
    }
    return failures;
}

/**
 * @param {ReturnType<typeof summarizeJudgements>} summary
 * @param {string} csvPath
 * @returns {Record<string, unknown>}
 */
export function buildBaseline(summary, csvPath) {
    return {
        createdAt: new Date().toISOString(),
        csv: csvPath,
        labelledRows: summary.labelledRows,
        metrics: summary,
        thresholds: {
            minRouterAgreementRate: Number(Math.max(0, summary.router.agreementRate - 0.05).toFixed(4)),
            maxRouterMeanDistance: Number((summary.router.meanDistance + 0.1).toFixed(4)),
        },
    };
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
    const args = parseArgs(argv, {
        string: ["csv", "baseline", "baseline-out", "min-router-agreement", "max-router-mean-distance"],
        boolean: ["help"],
        alias: { h: "help" },
    });

    if (args.help) {
        console.log([
            "Usage: bun scripts/evaluate-router-judgements.js [options]",
            "",
            "Fill humanJudgement in router-judgements.csv with one of:",
            "  INQUIRY, IDEATION, OPERATION, QUICK_FIX, FEATURE, PROJECT",
            "",
            "Options:",
            `  --csv <path>                       Judgement CSV (default: ${getDefaultRouterJudgementCsvPath()})`,
            "  --baseline <path>                  Read thresholds from a previous baseline JSON",
            "  --baseline-out <path>              Write current metrics and suggested thresholds",
            "  --min-router-agreement <number>    Fail if Router agreement is below this rate, e.g. 0.90",
            "  --max-router-mean-distance <number> Fail if Router mean distance is above this value",
        ].join("\n"));
        return;
    }

    const csvPath = args.csv || getDefaultRouterJudgementCsvPath();
    const rows = parseCsv(await fsReadFile(csvPath, "utf8"));
    const summary = summarizeJudgements(rows);

    /** @type {{ minRouterAgreementRate?: number, maxRouterMeanDistance?: number }} */
    const thresholds = {
        minRouterAgreementRate: parseNumber(args["min-router-agreement"]),
        maxRouterMeanDistance: parseNumber(args["max-router-mean-distance"]),
    };

    if (args.baseline) {
        const baseline = JSON.parse(await fsReadFile(args.baseline, "utf8"));
        const baselineThresholds = baseline?.thresholds || {};
        thresholds.minRouterAgreementRate ??= parseNumber(baselineThresholds.minRouterAgreementRate);
        thresholds.maxRouterMeanDistance ??= parseNumber(baselineThresholds.maxRouterMeanDistance);
    }

    const failures = checkThresholds(summary, thresholds);
    const report = {
        summary,
        thresholds,
        passed: failures.length === 0,
        failures,
    };

    if (args["baseline-out"]) {
        await fsMkdir(dirname(args["baseline-out"]), { recursive: true });
        await fsWriteFile(args["baseline-out"], `${JSON.stringify(buildBaseline(summary, csvPath), null, 2)}\n`);
    }

    console.log(JSON.stringify(report, null, 2));
    if (failures.length > 0) process.exit(1);
}

if (import.meta.main) {
    await main(process.argv.slice(2));
}
