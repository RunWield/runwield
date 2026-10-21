import { mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";
/**
 * @module scripts/curate-router-judgement-csv
 *
 * Apply deterministic fixture-curation rules to Router judgement CSV files.
 */

import { parseArgs } from "../src/shared/cli-args.ts";
import { dirname, join } from "node:path";
import { getHomeDir } from "../src/constants.js";
import { parseCsv, toCsv } from "./router-eval-utils.js";
import { JUDGEMENT_COLUMNS } from "./write-router-judgement-csv.js";

export interface RouterJudgementCsvRow {
    [column: string]: string | undefined;
    requestText?: string;
    humanJudgement?: string;
    humanNotes?: string;
}

export interface RouterJudgementHumanSeed {
    intent: "INQUIRY" | "OPERATION";
    note: string;
}

export interface RouterJudgementCurationResult {
    rows: RouterJudgementCsvRow[];
    removedGreetings: number;
    seededHumanJudgements: number;
}

interface RouterJudgementCurationArguments {
    _: (string | number)[];
    help?: boolean;
    in?: string;
    out?: string;
}

const DEFAULT_CSV_NAME = "router-judgements.csv";

export function getDefaultRouterJudgementCsvPath() {
    return join(getHomeDir(), ".wld", "router-eval", DEFAULT_CSV_NAME);
}

const PURE_GREETING_REQUESTS = new Set([
    "hi",
    "hello",
    "hey",
    "hi there",
    "hello there",
    "hi there how are you doing?",
    "hi there how are you doing",
]);

function normalizeRequest(value: string | null | undefined) {
    return value == null ? "" : String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

export function isPureGreetingRow(row: RouterJudgementCsvRow) {
    return PURE_GREETING_REQUESTS.has(normalizeRequest(row.requestText));
}

/**
 * Seed only cases that are clear under the current six-intent contract.
 *
 */
export function getUnambiguousHumanSeed(row: RouterJudgementCsvRow): RouterJudgementHumanSeed | null {
    const request = normalizeRequest(row.requestText);

    if (isPureGreetingRow(row)) {
        return {
            intent: "INQUIRY",
            note: "Seeded: representative greeting collapsed from duplicate legacy greeting rows.",
        };
    }

    if (request === "who are you?" || request === "who are you" || request === "hello there who are you?") {
        return { intent: "INQUIRY", note: "Seeded: direct identity question." };
    }

    if (request === "list your skills and tools") {
        return { intent: "INQUIRY", note: "Seeded: direct capability question." };
    }

    if (/^is .+ used anywhere\??$/.test(request) || /^is it possible to /.test(request)) {
        return { intent: "INQUIRY", note: "Seeded: direct informational question." };
    }

    if (request === "commit the changes") {
        return { intent: "OPERATION", note: "Seeded: commit request is a direct repository operation." };
    }

    if (request === "take me to the operator") {
        return { intent: "OPERATION", note: "Seeded: direct handoff/operation request." };
    }

    return null;
}

export function curateRows(rows: RouterJudgementCsvRow[]): RouterJudgementCurationResult {
    let keptGreeting = false;
    let removedGreetings = 0;
    let seededHumanJudgements = 0;
    const curated: RouterJudgementCsvRow[] = [];

    for (const original of rows) {
        const row = { ...original };
        if (isPureGreetingRow(row)) {
            if (keptGreeting) {
                removedGreetings++;
                continue;
            }
            keptGreeting = true;
        }

        const seed = getUnambiguousHumanSeed(row);
        if (seed && !row.humanJudgement?.trim()) {
            row.humanJudgement = seed.intent;
            row.humanNotes = row.humanNotes?.trim() || seed.note;
            seededHumanJudgements++;
        }

        curated.push(row);
    }

    return { rows: curated, removedGreetings, seededHumanJudgements };
}

export async function main(argv: string[]) {
    const args: RouterJudgementCurationArguments = parseArgs(argv, {
        string: ["in", "out"],
        boolean: ["help"],
        alias: { h: "help", i: "in", o: "out" },
    });

    if (args.help) {
        console.log(
            [
                "Usage: bun scripts/curate-router-judgement-csv.js [options]",
                "",
                "Options:",
                `  --in, -i <path>   CSV to curate (default: ${getDefaultRouterJudgementCsvPath()})`,
                "  --out, -o <path>  Curated CSV output (default: same as --in)",
            ].join("\n"),
        );
        return;
    }

    const inputPath = args.in || getDefaultRouterJudgementCsvPath();
    const outputPath = args.out || inputPath;
    await fsMkdir(dirname(outputPath), { recursive: true });
    const result = curateRows(parseCsv(await fsReadFile(inputPath, "utf8")));
    await fsWriteFile(outputPath, toCsv(JUDGEMENT_COLUMNS, result.rows));
    console.log(
        JSON.stringify(
            {
                output: outputPath,
                rows: result.rows.length,
                removedGreetings: result.removedGreetings,
                seededHumanJudgements: result.seededHumanJudgements,
            },
            null,
            2,
        ),
    );
}

if (import.meta.main) {
    await main(process.argv.slice(2));
}
