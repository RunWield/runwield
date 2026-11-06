/**
 * @module scripts/router-eval-utils
 *
 * Shared utilities for Router evaluation CSV generation and scoring.
 */

import { LEGACY_ROUTING_INTENT_FEATURE, ROUTING_INTENT_PLANNED_CHANGE, ROUTING_INTENTS } from "../src/constants.js";

export type CsvRow<TCell = string> = Record<string, TCell>;

export interface RouterJudgementInput {
    routerDecision?: string;
    humanJudgement?: string;
}

export type RouterJudgementMetrics = {
    routerDecision: string;
    humanJudgement: string;
    routerAgreesWithHuman: "TRUE" | "FALSE" | "";
    routerCorrection: string;
    routerDistanceFromHuman: number | "";
    routerDisagreementKind: string;
};

export type RouterJudgementRow<TRow> = Omit<TRow, keyof RouterJudgementMetrics> & RouterJudgementMetrics;

export interface RouterJudgementScore {
    total: number;
    agreementCount: number;
    agreementRate: number;
    meanDistance: number;
    invalidRows: number;
    unscoredRows: number;
    corrections: Record<string, number>;
}

export const ROUTER_JUDGEMENT_COLUMNS = [
    "decisionId",
    "timestamp",
    "attribution",
    "requestText",
    "routerDecision",
    "humanJudgement",
    "humanNotes",
    "routerAgreesWithHuman",
    "routerCorrection",
    "routerDistanceFromHuman",
    "routerDisagreementKind",
    "routerSummary",
    "routerAffectedPaths",
    "contextCommit",
];

const ROUTING_INTENT_ORDER = new Map(ROUTING_INTENTS.map((intent, index) => [intent, index]));
ROUTING_INTENT_ORDER.set("FEATURE", ROUTING_INTENT_ORDER.get("PLANNED_CHANGE") ?? 4);
ROUTING_INTENT_ORDER.set("PROJECT", (ROUTING_INTENT_ORDER.get("PLANNED_CHANGE") ?? 4) + 1);
const NON_MATERIALIZING = new Set(["INQUIRY", "IDEATION"]);
const MATERIALIZING = new Set(["OPERATION", "QUICK_FIX", "PLANNED_CHANGE", "FEATURE", "PROJECT"]);

export function oneLine<TValue>(value: TValue): string {
    return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

export function toCsvCell<TValue>(value: TValue): string {
    const text = oneLine(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv<TCell>(columns: string[], rows: CsvRow<TCell>[]): string {
    const lines = [columns.join(",")];
    for (const row of rows) {
        lines.push(columns.map((column) => toCsvCell(row[column])).join(","));
    }
    return `${lines.join("\n")}\n`;
}

export function parseCsv(text: string): CsvRow[] {
    const records: string[][] = [];

    let record: string[] = [];
    let field = "";
    let quoted = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') {
                    field += '"';
                    index++;
                } else {
                    quoted = false;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            record.push(field);
            field = "";
        } else if (char === "\n") {
            record.push(field);
            field = "";
            if (record.some((cell) => cell.length > 0)) records.push(record);
            record = [];
        } else if (char !== "\r") {
            field += char;
        }
    }

    if (field.length > 0 || record.length > 0) {
        record.push(field);
        if (record.some((cell) => cell.length > 0)) records.push(record);
    }

    const [header, ...body] = records;
    if (!header) return [];
    return body.map((cells) => {
        const row: CsvRow = {};
        header.forEach((column, index) => {
            row[column] = cells[index] || "";
        });
        return row;
    });
}

export function normalizeRoutingIntentCell<TValue>(value: TValue): string {
    const text = oneLine(value).toUpperCase();
    if (text === LEGACY_ROUTING_INTENT_FEATURE) return ROUTING_INTENT_PLANNED_CHANGE;
    return ROUTING_INTENTS.includes(text) ? text : "";
}

export function routingIntentDistance<TLeft, TRight>(left: TLeft, right: TRight): number | null {
    const a = normalizeRoutingIntentCell(left);
    const b = normalizeRoutingIntentCell(right);
    if (!a || !b) return null;
    return Math.abs((ROUTING_INTENT_ORDER.get(a) ?? 0) - (ROUTING_INTENT_ORDER.get(b) ?? 0));
}

export function classifyRoutingIntentDisagreement<TFrom, TTo>(from: TFrom, to: TTo): string {
    const a = normalizeRoutingIntentCell(from);
    const b = normalizeRoutingIntentCell(to);
    if (!a || !b) return "invalid";
    if (a === b) return "exact";

    if (a === "QUICK_FIX" && b === "INQUIRY") return "legacy_quick_fix_to_inquiry";
    if (a === "INQUIRY" && b === "QUICK_FIX") return "inquiry_to_quick_fix";
    if ((a === "INQUIRY" && b === "IDEATION") || (a === "IDEATION" && b === "INQUIRY")) {
        return "inquiry_ideation_boundary";
    }
    if ((a === "OPERATION" && b === "QUICK_FIX") || (a === "QUICK_FIX" && b === "OPERATION")) {
        return "operation_quick_fix_boundary";
    }
    if ((NON_MATERIALIZING.has(a) && MATERIALIZING.has(b)) || (MATERIALIZING.has(a) && NON_MATERIALIZING.has(b))) {
        return "answer_action_boundary";
    }
    if (a === "QUICK_FIX" && (b === ROUTING_INTENT_PLANNED_CHANGE || b === "PROJECT")) {
        return "scope_underestimated";
    }
    if ((a === ROUTING_INTENT_PLANNED_CHANGE || a === "PROJECT") && b === "QUICK_FIX") {
        return "scope_overestimated";
    }
    if (
        (a === ROUTING_INTENT_PLANNED_CHANGE && b === "PROJECT") ||
        (a === "PROJECT" && b === ROUTING_INTENT_PLANNED_CHANGE)
    ) {
        return "feature_project_boundary";
    }
    if (a === "IDEATION" || b === "IDEATION") return "ideation_boundary";
    return "other";
}

export function indexRowsByDecisionId(rows: CsvRow[]): Map<string, CsvRow> {
    const indexed = new Map<string, CsvRow>();
    for (const row of rows) {
        if (row.decisionId) indexed.set(row.decisionId, row);
    }
    return indexed;
}

export function withRouterJudgementMetrics<TRow extends RouterJudgementInput>(row: TRow): RouterJudgementRow<TRow> {
    const routerDecision = normalizeRoutingIntentCell(row.routerDecision);
    const humanJudgement = normalizeRoutingIntentCell(row.humanJudgement);
    const agrees = routerDecision && humanJudgement && routerDecision === humanJudgement;
    const correction =
        routerDecision && humanJudgement && routerDecision !== humanJudgement
            ? `${routerDecision}->${humanJudgement}`
            : "";
    const isScored = Boolean(routerDecision && humanJudgement);

    return {
        ...row,
        routerDecision,
        humanJudgement,
        routerAgreesWithHuman: isScored ? (agrees ? "TRUE" : "FALSE") : "",
        routerCorrection: correction,
        routerDistanceFromHuman: isScored ? (routingIntentDistance(routerDecision, humanJudgement) ?? "") : "",
        routerDisagreementKind: isScored ? classifyRoutingIntentDisagreement(routerDecision, humanJudgement) : "",
    };
}

export function scoreAgainstHuman<TCell>(rows: CsvRow<TCell>[], candidateColumn: string): RouterJudgementScore {
    let total = 0;
    let agreementCount = 0;
    let distanceSum = 0;
    let invalidRows = 0;
    let unscoredRows = 0;

    const corrections: Record<string, number> = {};

    for (const row of rows) {
        const human = normalizeRoutingIntentCell(row.humanJudgement);
        if (!human) continue;
        const rawCandidate = oneLine(row[candidateColumn]);
        if (!rawCandidate) {
            unscoredRows++;
            continue;
        }
        const candidate = normalizeRoutingIntentCell(rawCandidate);
        total++;
        if (!candidate) {
            invalidRows++;
            continue;
        }
        if (human === candidate) agreementCount++;
        const distance = routingIntentDistance(candidate, human);
        if (distance != null) distanceSum += distance;
        if (human !== candidate) {
            const key = `${candidate}->${human}`;
            corrections[key] = (corrections[key] || 0) + 1;
        }
    }

    return {
        total,
        agreementCount,
        agreementRate: total ? Number((agreementCount / total).toFixed(4)) : 0,
        meanDistance: total ? Number((distanceSum / total).toFixed(4)) : 0,
        invalidRows,
        unscoredRows,
        corrections: Object.fromEntries(Object.entries(corrections).sort((a, b) => b[1] - a[1])),
    };
}
