import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import type { FixtureDefect, VariantId } from "./fixtures.ts";
import type { FixtureReviewResult } from "./reviewer.ts";

export const SMOKE_GROUPS: Record<string, string> = {
    "RV-D04": "correctness-beyond-plan",
    "RV-D05": "plan-named-edge-case",
    "RV-D12": "architecture",
    "RV-D13": "plan-adherence",
    "RV-M01": "multiple-defects",
};
export interface RunConfiguration {
    revision: string;
    dirty: boolean;
    promptHashes: Record<string, string>;
    model: string;
    provider: string;
    thinkingLevel?: string;
    temperature?: number;
    bunVersion: string;
}
export interface BenchmarkCase {
    caseId: string;
    scenarioId: string;
    variant: VariantId;
    fixtureRevision: number;
    fixtureHash: string;
    trial: 1;
    expectedDecision: "approve" | "reject";
    group: string;
    defects: FixtureDefect[];
}
export interface RunManifest {
    schemaVersion: 1;
    runId: string;
    createdAt: string;
    configuration: RunConfiguration;
    timeoutMs?: number;
    cases: BenchmarkCase[];
}
export interface BenchmarkResult extends FixtureReviewResult {
    runId: string;
    caseId: string;
    scenarioId: string;
    variant: VariantId;
    fixtureRevision: number;
    trial: 1;
    attempt: number;
    recordedAt: string;
    expectedDecision: "approve" | "reject";
    observedDecision: "approve" | "reject" | "unavailable";
    configuration: RunConfiguration;
}
export interface SavedRun {
    manifest: RunManifest;
    /** All attempts stay on disk. Scoring uses the latest attempt for each case, never the best attempt. */
    results: BenchmarkResult[];
}

function requireRecord(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`Invalid benchmark data: ${message}`);
}
function text(value: string): boolean {
    return typeof value === "string" && value.length > 0;
}
function configurationValid(value: RunConfiguration): boolean {
    return Boolean(
        value &&
        text(value.revision) &&
        typeof value.dirty === "boolean" &&
        text(value.model) &&
        text(value.provider) &&
        text(value.bunVersion) &&
        value.promptHashes &&
        Object.keys(value.promptHashes).length >= 2 &&
        Object.values(value.promptHashes).every((hash) => /^[a-f0-9]{64}$/.test(hash)),
    );
}

/** Missing files and malformed/truncated journals fail closed; they never authorize a resume. */
export async function readRun(directory: string): Promise<SavedRun> {
    const manifest = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as RunManifest;
    requireRecord(manifest?.schemaVersion === 1 && text(manifest.runId) && text(manifest.createdAt), "run manifest");
    requireRecord(configurationValid(manifest.configuration), "configuration identity");
    requireRecord(Array.isArray(manifest.cases) && manifest.cases.length > 0, "case inventory");
    const ids = new Set<string>();
    for (const entry of manifest.cases) {
        requireRecord(
            Boolean(entry && SMOKE_GROUPS[entry.scenarioId]) &&
                ["A", "B"].includes(entry.variant) &&
                entry.caseId === `${entry.scenarioId}/${entry.variant}` &&
                !ids.has(entry.caseId) &&
                entry.trial === 1 &&
                Number.isInteger(entry.fixtureRevision) &&
                entry.fixtureRevision > 0 &&
                /^[a-f0-9]{64}$/.test(entry.fixtureHash) &&
                ["approve", "reject"].includes(entry.expectedDecision) &&
                text(entry.group) &&
                Array.isArray(entry.defects),
            "case identity",
        );
        requireRecord(
            entry.expectedDecision === "approve" ? entry.defects.length === 0 : entry.defects.length > 0,
            "case oracle",
        );
        const defects = new Set<string>();
        for (const defect of entry.defects) {
            requireRecord(
                Boolean(
                    defect &&
                    text(defect.defectId) &&
                    !defects.has(defect.defectId) &&
                    text(defect.severity) &&
                    Array.isArray(defect.evidence) &&
                    defect.evidence.length &&
                    defect.evidence.every(text),
                ),
                "defect oracle",
            );
            defects.add(defect.defectId);
        }
        ids.add(entry.caseId);
    }
    const contents = await readFile(join(directory, "results.jsonl"), "utf8");
    const results = contents
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as BenchmarkResult);
    const attempts = new Map<string, number>();
    for (const result of results) {
        requireRecord(
            Boolean(result && result.runId === manifest.runId && ids.has(result.caseId)),
            "result/run identity",
        );
        const entry = manifest.cases.find((item) => item.caseId === result.caseId)!;
        requireRecord(
            result.scenarioId === entry.scenarioId &&
                result.variant === entry.variant &&
                result.trial === 1 &&
                result.fixtureRevision === entry.fixtureRevision &&
                result.expectedDecision === entry.expectedDecision &&
                Number.isInteger(result.attempt) &&
                result.attempt === (attempts.get(result.caseId) ?? 0) + 1 &&
                JSON.stringify(result.configuration) === JSON.stringify(manifest.configuration),
            "result case/configuration identity",
        );
        requireRecord(["complete", "paused", "failed", "timeout"].includes(result.kind), "protocol outcome");
        requireRecord(
            result.kind === "complete"
                ? Boolean(
                      result.outcome &&
                      typeof result.outcome.approved === "boolean" &&
                      Array.isArray(result.outcome.findings) &&
                      Array.isArray(result.outcome.advisories) &&
                      result.observedDecision === (result.outcome.approved ? "approve" : "reject"),
                  )
                : result.observedDecision === "unavailable" && text(result.reason!),
            "observed decision",
        );
        if (result.outcome) {
            requireRecord(
                Array.isArray(result.outcome.findings) &&
                    Array.isArray(result.outcome.advisories) &&
                    result.outcome.findings.every(
                        (finding) => finding && text(finding.title) && typeof finding.evidence === "string",
                    ),
                "finding evidence",
            );
        }
        attempts.set(result.caseId, result.attempt);
    }
    return { manifest, results };
}

export function latestResults(run: SavedRun): Map<string, BenchmarkResult> {
    return new Map(run.results.map((result) => [result.caseId, result]));
}

/** Flush every scenario independently so a later failure does not erase accepted results. */
export async function appendResult(directory: string, result: BenchmarkResult): Promise<void> {
    const file = await open(join(directory, "results.jsonl"), "a+", 0o600);
    try {
        const size = (await file.stat()).size;
        let separator = "";
        if (size > 0) {
            const last = Buffer.alloc(1);
            const read = await file.read(last, 0, 1, size - 1);
            if (read.bytesRead !== 1) throw new Error("Cannot establish the result journal boundary");
            if (last[0] !== 10) separator = "\n";
        }
        await file.writeFile(separator + JSON.stringify(result) + "\n");
        await file.sync();
    } finally {
        await file.close();
    }
}
