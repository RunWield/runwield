import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { latestResults, readRun } from "./records.ts";
import type { BenchmarkCase, BenchmarkResult, RunManifest } from "./records.ts";

export interface Ratio {
    numerator: number;
    denominator: number;
    value: number | null;
}
export type AdjudicationState = "matched" | "duplicate" | "unsupported" | "novel_valid";
export interface FindingReference {
    caseId: string;
    attempt: number;
    findingIndex: number;
}
export interface Adjudication extends FindingReference {
    state: AdjudicationState;
    defectId?: string;
}
export interface AdjudicationsFile {
    schemaVersion: 1;
    runId: string;
    adjudications: Adjudication[];
}
export interface ReportFinding extends FindingReference {
    finding: NonNullable<BenchmarkResult["outcome"]>["findings"][number];
    /** Evidence-path suggestions only. These never establish a semantic match. */
    suggestedEvidencePathDefectIds: string[];
    adjudication: Adjudication | null;
}
export interface CaseScore extends BenchmarkCase {
    result: BenchmarkResult | null;
    status: BenchmarkResult["kind"] | "missing";
    cause: string | null;
    decisionCorrect: boolean;
    findings: ReportFinding[];
}
export interface DecisionScores {
    decisionAccuracy: Ratio;
    cleanApproval: Ratio;
}
export interface LabelCounts {
    matched: number;
    duplicate: number;
    unsupported: number;
    novel_valid: number;
    labeled: number;
    unlabeled: number;
    falsePositives: number;
}
export interface SemanticScores {
    status: "pending adjudication" | "scored" | "oracle correction required";
    adjudicationsPresent: boolean;
    labels: LabelCounts;
    oracleDefects: number;
    severeOracleDefects: number;
    blockingFindings: number;
    recall: Ratio | null;
    severeRecall: Ratio | null;
    precision: Ratio | null;
}
export interface GroupScores extends DecisionScores {
    semantic: SemanticScores;
}
export interface RunSummary extends DecisionScores {
    schemaVersion: 1;
    runId: string;
    configuration: RunManifest["configuration"];
    variants: Record<string, DecisionScores>;
    groups: Record<string, GroupScores>;
    semantic: SemanticScores;
    cases: CaseScore[];
}

function requireLabel(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`Invalid adjudications: ${message}`);
}
function referenceKey(reference: FindingReference): string {
    return JSON.stringify([reference.caseId, reference.attempt, reference.findingIndex]);
}
function defectKey(caseId: string, defectId: string): string {
    return JSON.stringify([caseId, defectId]);
}
function ratio(numerator: number, denominator: number): Ratio {
    return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}
function decisions(cases: CaseScore[]): DecisionScores {
    const clean = cases.filter((entry) => entry.expectedDecision === "approve");
    return {
        decisionAccuracy: ratio(cases.filter((entry) => entry.decisionCorrect).length, cases.length),
        cleanApproval: ratio(clean.filter((entry) => entry.decisionCorrect).length, clean.length),
    };
}
function splitDecisions(cases: CaseScore[], field: "variant" | "group"): Record<string, DecisionScores> {
    return Object.fromEntries(
        [...new Set(cases.map((entry) => entry[field]))].map((name) => [
            name,
            decisions(cases.filter((entry) => entry[field] === name)),
        ]),
    );
}

async function readAdjudications(directory: string): Promise<AdjudicationsFile | null> {
    let contents: string;
    try {
        contents = await readFile(join(directory, "adjudications.json"), "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
    const file = JSON.parse(contents) as AdjudicationsFile;
    requireLabel(Boolean(file), "schema or run identity");
    return file;
}

/** Accept labels only for blocking findings on the latest, completed attempt. Old labels must be replaced. */
function applyAdjudications(file: AdjudicationsFile | null, runId: string, cases: CaseScore[]): void {
    if (!file) return;
    requireLabel(
        file.schemaVersion === 1 && file.runId === runId && Array.isArray(file.adjudications),
        "schema or run identity",
    );
    const seen = new Set<string>();
    const matched = new Set<string>();
    for (const label of file.adjudications) {
        requireLabel(Boolean(label) && typeof label.caseId === "string", "case identity");
        const entry = cases.find((item) => item.caseId === label.caseId);
        requireLabel(entry !== undefined, `case ${label.caseId}`);
        requireLabel(
            entry.status === "complete" && Number.isInteger(label.attempt) && label.attempt === entry.result?.attempt,
            `latest completed attempt for ${label.caseId}`,
        );
        requireLabel(
            Number.isInteger(label.findingIndex) &&
                label.findingIndex >= 0 &&
                label.findingIndex < entry.findings.length,
            `blocking finding index for ${label.caseId}`,
        );
        requireLabel(["matched", "duplicate", "unsupported", "novel_valid"].includes(label.state), "state");
        const reference = referenceKey(label);
        requireLabel(!seen.has(reference), `duplicate reference ${reference}`);
        seen.add(reference);
        if (label.defectId !== undefined) {
            requireLabel(
                typeof label.defectId === "string" &&
                    entry.defects.some((defect) => defect.defectId === label.defectId),
                `defect ID for ${reference}`,
            );
        }
        if (label.state === "matched" || label.state === "duplicate") {
            requireLabel(typeof label.defectId === "string", `defect ID required for ${reference}`);
            if (label.state === "matched") {
                const key = defectKey(label.caseId, label.defectId!);
                requireLabel(!matched.has(key), `defect already matched; use duplicate for ${reference}`);
                matched.add(key);
            }
        }
        entry.findings[label.findingIndex].adjudication = label;
    }
    for (const label of file.adjudications) {
        if (label.state === "duplicate") {
            requireLabel(
                matched.has(defectKey(label.caseId, label.defectId!)),
                `duplicate requires matched primary in same case for ${referenceKey(label)}`,
            );
        }
    }
}

function semanticScores(cases: CaseScore[], adjudicationsPresent: boolean): SemanticScores {
    const findings = cases.flatMap((entry) => entry.findings);
    const labels: LabelCounts = {
        matched: 0,
        duplicate: 0,
        unsupported: 0,
        novel_valid: 0,
        labeled: 0,
        unlabeled: 0,
        falsePositives: 0,
    };
    const matched = new Set<string>();
    for (const finding of findings) {
        if (!finding.adjudication) {
            labels.unlabeled++;
            continue;
        }
        const label = finding.adjudication;
        labels[label.state]++;
        labels.labeled++;
        if (label.state === "matched") matched.add(defectKey(label.caseId, label.defectId!));
    }
    labels.falsePositives = labels.duplicate + labels.unsupported;
    const oracle = cases.flatMap((entry) => entry.defects.map((defect) => ({ caseId: entry.caseId, ...defect })));
    const severe = oracle.filter((defect) => ["high", "critical"].includes(defect.severity));
    const status =
        labels.novel_valid > 0
            ? "oracle correction required"
            : !adjudicationsPresent || labels.unlabeled > 0
              ? "pending adjudication"
              : "scored";
    return {
        status,
        adjudicationsPresent,
        labels,
        oracleDefects: oracle.length,
        severeOracleDefects: severe.length,
        blockingFindings: findings.length,
        recall: status === "scored" ? ratio(matched.size, oracle.length) : null,
        severeRecall:
            status === "scored"
                ? ratio(
                      severe.filter((defect) => matched.has(defectKey(defect.caseId, defect.defectId))).length,
                      severe.length,
                  )
                : null,
        precision: status === "scored" ? ratio(labels.matched, findings.length) : null,
    };
}

/** Literal path citations are suggestions, not semantic adjudication. */
function citesPath(evidence: string, path: string): boolean {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_./-])${escaped}(?=$|[^A-Za-z0-9_./-])`).test(evidence);
}

function showRatio(value: Ratio): string {
    return `${value.numerator}/${value.denominator} (${value.value === null ? "unavailable" : value.value})`;
}
function jsonBlock(value: RunSummary["configuration"] | CaseScore): string {
    return JSON.stringify(value, null, 2)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
}
function markdown(summary: RunSummary): string {
    const semantic = summary.semantic;
    const lines = [
        `# Reviewer benchmark: ${summary.runId}`,
        "",
        "One trial per case. One trial cannot establish stability. No pass threshold is applied.",
        "",
        "## Configuration identity",
        "",
        jsonBlock(summary.configuration),
        "",
        "## Mechanical decisions",
        "",
        `Decision accuracy: ${showRatio(summary.decisionAccuracy)}`,
        `Clean approval: ${showRatio(summary.cleanApproval)}`,
        "",
        "All manifest cases remain in these denominators, including missing and failed results.",
        "",
    ];
    for (const [heading, split] of [
        ["Variants", summary.variants],
        ["Groups", summary.groups],
    ] as const) {
        lines.push(`### ${heading}`, "");
        for (const [name, scores] of Object.entries(split)) {
            lines.push(
                `- ${name}: decisions ${showRatio(scores.decisionAccuracy)}; clean approval ${showRatio(scores.cleanApproval)}`,
            );
        }
        lines.push("");
    }
    lines.push("### Semantic scores by group", "");
    for (const [name, group] of Object.entries(summary.groups)) {
        const scores = group.semantic;
        lines.push(
            `- ${name}: ${scores.status}; recall ${scores.recall ? showRatio(scores.recall) : scores.status}; precision ${scores.precision ? showRatio(scores.precision) : scores.status}; severe recall ${scores.severeRecall ? showRatio(scores.severeRecall) : scores.status}`,
        );
    }
    lines.push(
        "",
        "## Semantic scores",
        "",
        `Status: ${semantic.status}`,
        `Labels: ${semantic.labels.labeled}/${semantic.blockingFindings}; unlabeled: ${semantic.labels.unlabeled}.`,
        `Matched: ${semantic.labels.matched}; duplicate: ${semantic.labels.duplicate}; unsupported: ${semantic.labels.unsupported}; novel_valid: ${semantic.labels.novel_valid}.`,
        `False positives (duplicate + unsupported): ${semantic.labels.falsePositives}.`,
        `Oracle denominators: all defects ${semantic.oracleDefects}; high/critical defects ${semantic.severeOracleDefects}; blocking findings ${semantic.blockingFindings}.`,
        `Defect recall: ${semantic.recall ? showRatio(semantic.recall) : semantic.status}`,
        `Severe-defect recall: ${semantic.severeRecall ? showRatio(semantic.severeRecall) : semantic.status}`,
        `Blocking-finding precision: ${semantic.precision ? showRatio(semantic.precision) : semantic.status}`,
        "",
        "Suggested evidence-path matches are suggestions only. They never count as semantic recall. Advisories are not blocking findings and cannot be adjudicated.",
        "A novel_valid label requires an oracle correction before semantic scoring. Mechanical decisions do not change.",
        "",
        "## Cases",
        "",
        "Each case includes the accepted observed decision, exact findings and advisories, finding references (caseId, attempt, zero-based findingIndex), actual model/provider, usage, elapsed time, and nudge attempts. Missing measurements are unavailable, never estimated.",
        "",
    );
    for (const entry of summary.cases) {
        lines.push(
            `### ${entry.caseId}`,
            "",
            `Status: ${entry.status}; decision correct: ${entry.decisionCorrect}.`,
            "",
        );
        if (!entry.result)
            lines.push(
                "Observed decision, model/provider, tokens, tool calls, elapsed time, nudge attempts: unavailable.",
                "",
            );
        // Indented JSON preserves exact evidence/advisories without allowing finding text to break Markdown fences.
        lines.push(jsonBlock(entry), "");
    }
    return lines.join("\n");
}

/** Score saved records without model calls. Adjudications never come from suggested path matches. */
export async function scoreRun(directory: string): Promise<RunSummary> {
    const run = await readRun(directory);
    const latest = latestResults(run);
    const cases: CaseScore[] = run.manifest.cases.map((entry) => {
        const result = latest.get(entry.caseId) ?? null;
        return {
            ...entry,
            result,
            status: result?.kind ?? "missing",
            cause: result ? (result.reason ?? null) : "No saved result",
            decisionCorrect: result?.kind === "complete" && result.observedDecision === entry.expectedDecision,
            findings: (result?.outcome?.findings ?? []).map((finding, findingIndex) => ({
                caseId: entry.caseId,
                attempt: result!.attempt,
                findingIndex,
                finding,
                suggestedEvidencePathDefectIds: entry.defects
                    .filter((defect) => defect.evidence.some((path) => citesPath(finding.evidence, path)))
                    .map((defect) => defect.defectId),
                adjudication: null,
            })),
        };
    });
    const adjudications = await readAdjudications(directory);
    applyAdjudications(adjudications, run.manifest.runId, cases);
    const summary: RunSummary = {
        schemaVersion: 1,
        runId: run.manifest.runId,
        configuration: run.manifest.configuration,
        ...decisions(cases),
        variants: splitDecisions(cases, "variant"),
        groups: Object.fromEntries(
            Object.entries(splitDecisions(cases, "group")).map(([group, scores]) => [
                group,
                {
                    ...scores,
                    semantic: semanticScores(
                        cases.filter((entry) => entry.group === group),
                        adjudications !== null,
                    ),
                },
            ]),
        ),
        semantic: semanticScores(cases, adjudications !== null),
        cases,
    };
    await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    await writeFile(join(directory, "summary.md"), markdown(summary), { mode: 0o600 });
    return summary;
}
