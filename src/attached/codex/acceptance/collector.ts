import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { field, map, type Check, type HostObservation, type JsonMap } from "./evidence.ts";
import { execFileSync } from "node:child_process";
import { extractYaml } from "../../../shared/front-matter.ts";

export interface CollectedEvidence {
    observations: HostObservation[];
    clients: JsonMap[];
    errors: string[];
}
/** Read only whitelisted evidence produced at the subprocess boundary. No transcript ingestion. */
export async function collectEvidence(root: string): Promise<CollectedEvidence> {
    const evidence: CollectedEvidence = { observations: [], clients: [], errors: [] };
    for (const name of ["host-evidence.jsonl", "handshakes.jsonl"]) {
        let lines: string[];
        try {
            lines = (await readFile(join(root, name), "utf8")).split(/\r?\n/).filter(Boolean);
        } catch {
            evidence.errors.push(`${name}: unreadable`);
            continue;
        }
        for (const line of lines) {
            try {
                const row = map(JSON.parse(line));
                if (!row) throw new Error("not a record");
                if (name === "handshakes.jsonl") {
                    const client = map(row.clientInfo);
                    if (!client || typeof client.name !== "string" || typeof client.version !== "string")
                        throw new Error("missing client");
                    evidence.clients.push({ name: client.name, version: client.version });
                } else {
                    if (
                        typeof row.run !== "string" ||
                        !["start", "exit", "tool", "worker", "turn"].includes(String(row.kind))
                    )
                        throw new Error("invalid event");
                    if (
                        row.kind === "tool" &&
                        (typeof row.threadId !== "string" ||
                            typeof row.toolId !== "string" ||
                            typeof row.operation !== "string" ||
                            typeof row.accepted !== "boolean")
                    )
                        throw new Error("invalid tool event");
                    evidence.observations.push(JSON.parse(JSON.stringify(row)));
                }
            } catch {
                evidence.errors.push(`${name}: malformed evidence`);
            }
        }
    }
    return evidence;
}
/** Parent reads and assistant assertions cannot establish an independent host review. */
export function assessHostReview(evidence: CollectedEvidence): Check {
    const seen = new Set<string>();
    for (const row of evidence.observations.filter((row) => row.kind === "tool")) {
        const identity = `${row.run}:${row.threadId}:${row.toolId}`;
        if (seen.has(identity))
            return {
                id: "independent-host-review",
                outcome: "fail",
                detail: "Duplicate tool-call identity makes review provenance ambiguous.",
            };
        seen.add(identity);
    }
    if (evidence.errors.length)
        return { id: "independent-host-review", outcome: "fail", detail: "Host evidence is incomplete or malformed." };
    const completed = evidence.observations.filter((row) => row.operation === "review_complete" && row.accepted);
    if (!completed.length)
        return { id: "independent-host-review", outcome: "unproven", detail: "No accepted host review was observed." };
    for (const review of completed) {
        if (!review.submittedActionId)
            return {
                id: "independent-host-review",
                outcome: "unproven",
                detail: "The native event did not identify the submitted review action.",
            };
        const workers = evidence.observations
            .filter(
                (row) =>
                    row.kind === "worker" &&
                    row.threadId === review.threadId &&
                    row.run === review.run &&
                    row.freshContext === true,
            )
            .flatMap((row) => row.workerIds ?? []);
        const allReads = evidence.observations.filter(
            (row) =>
                row.kind === "tool" &&
                row.accepted &&
                row.run === review.run &&
                row.threadId !== review.threadId &&
                workers.includes(row.threadId ?? "") &&
                row.workflowId === review.workflowId &&
                row.actionId === review.submittedActionId,
        );
        const readers = new Set(allReads.map((row) => row.threadId));
        if (!readers.size)
            return {
                id: "independent-host-review",
                outcome: "fail",
                detail: "No independently observed reviewer read the submitted action.",
            };
        for (const reader of readers) {
            const reads = allReads.filter((row) => row.threadId === reader);
            if (
                !reads.some((row) => row.operation === "review_diff") ||
                !reads.some((row) => row.operation === "get_instructions")
            )
                return {
                    id: "independent-host-review",
                    outcome: "fail",
                    detail: "An accepted review lacks matching direct worker instruction and diff reads.",
                };
            if (
                evidence.observations.some(
                    (row) =>
                        row.run === review.run &&
                        readers.has(row.threadId) &&
                        row.operation === "get_instructions" &&
                        row.accepted &&
                        row.actionId !== review.submittedActionId,
                )
            )
                return {
                    id: "independent-host-review",
                    outcome: "fail",
                    detail: "The reviewer worker was reused across different actions.",
                };
            const scope = reads.find((row) => row.requiredScope)?.requiredScope;
            const listing = reads.find((row) => row.diffScope === scope && typeof row.diffFileCount === "number");
            if (!scope || !listing)
                return {
                    id: "independent-host-review",
                    outcome: "unproven",
                    detail: "The native evidence lacks the required diff inventory.",
                };
            const pages = reads.flatMap((row) => (row.diffRead?.scope === scope ? [row.diffRead] : []));
            const paths = new Set(pages.map((page) => page.path));
            if (paths.size !== listing.diffFileCount)
                return {
                    id: "independent-host-review",
                    outcome: "fail",
                    detail: "Reviewer reads do not cover the required file inventory.",
                };
            for (const path of paths) {
                const spans = pages.filter((page) => page.path === path).sort((a, b) => a.start - b.start);
                const size = spans[0].totalBytes;
                let end = 0;
                for (const span of spans) {
                    if (
                        ![span.start, span.end, span.totalBytes].every(Number.isSafeInteger) ||
                        span.totalBytes !== size ||
                        span.start < 0 ||
                        span.start > end ||
                        span.end < span.start ||
                        span.end > size
                    )
                        return {
                            id: "independent-host-review",
                            outcome: "fail",
                            detail: "Reviewer byte receipts contain gaps or inconsistent sizes.",
                        };
                    end = Math.max(end, span.end);
                }
                if (end !== size)
                    return {
                        id: "independent-host-review",
                        outcome: "fail",
                        detail: "Reviewer byte coverage is incomplete.",
                    };
            }
        }
    }
    return {
        id: "independent-host-review",
        outcome: "pass",
        detail: "Native spawn identities prove fresh workers directly fetched instructions and complete candidate-bound diff bytes.",
    };
}
export function assessHandshake(evidence: CollectedEvidence, version: string): Check {
    const passed =
        !evidence.errors.length &&
        evidence.clients.length > 0 &&
        evidence.clients.every((client) => client.name === "codex-mcp-client" && client.version === version);
    return {
        id: "native-mcp-identity",
        outcome: passed ? "pass" : "fail",
        detail: passed
            ? "The real Codex MCP handshake matches the executable version."
            : "MCP identity is missing or differs from the executable version.",
    };
}
/** Summaries keep identifiers and hashes, never result payloads or free-form worker output. */
export function delivered(result: JsonMap): boolean {
    return result.ok === true && field(result, "workflow", "nextAction", "kind") === "delivered";
}
export function hostedReview(result: JsonMap, kind: "review" | "code_review"): boolean {
    return (
        result.ok === true &&
        field(result, "workflow", "nextAction", "kind") === kind &&
        typeof field(result, "review", "url") === "string"
    );
}
function snapshotFiles(snapshot: JsonMap): JsonMap[] {
    return Array.isArray(snapshot.files) ? snapshot.files.flatMap((value) => (map(value) ? [map(value)!] : [])) : [];
}
function workflow(snapshot: JsonMap): JsonMap | null {
    const files = snapshotFiles(snapshot).filter(
        (file) => typeof file.path === "string" && file.path.includes("/workflows/") && file.path.endsWith(".json"),
    );
    if (files.length !== 1 || typeof files[0].text !== "string") return null;
    return map(JSON.parse(files[0].text));
}
export function assessExecution(before: JsonMap, implemented: JsonMap): Check {
    const record = workflow(implemented);
    const cwd = field(record, "execution", "executionCwd");
    const suffix = typeof cwd === "string" ? cwd.split("/runwield-home/")[1] : undefined;
    const prefix = suffix?.startsWith(".wld/worktrees/") ? `runwield-home/${suffix}` : null;
    const original = snapshotFiles(before).find((file) => file.path === "fixture/check.sh");
    const files = snapshotFiles(implemented);
    const passed =
        !!prefix &&
        field(record, "execution", "executionMode") === "worktree" &&
        files.some((file) => file.path === `${prefix}/greet.sh`) &&
        !files.some((file) => file.path === "fixture/greet.sh") &&
        typeof original?.sha256 === "string" &&
        files.some((file) => file.path === `${prefix}/check.sh` && file.sha256 === original.sha256);
    return {
        id: "execution-isolation",
        outcome: passed ? "pass" : "fail",
        detail: "Implementation must exist in Core's isolated checkout while the original validation command remains unchanged.",
    };
}
export function assessCi(killed: JsonMap, deliveredSnapshot: JsonMap): Check {
    const started = Array.isArray(killed.ciRuns) ? killed.ciRuns : [];
    const runs = Array.isArray(deliveredSnapshot.ciRuns) ? deliveredSnapshot.ciRuns : [];
    const finished = Array.isArray(deliveredSnapshot.ciFinished) ? deliveredSnapshot.ciFinished : [];
    const passed =
        started.length === 1 &&
        runs.length === 3 &&
        new Set(runs).size === 3 &&
        runs[0] === started[0] &&
        finished.length === 2 &&
        !finished.includes(started[0]) &&
        runs.slice(1).every((pid) => finished.includes(pid));
    return {
        id: "bounded-validation-runs",
        outcome: passed ? "pass" : "fail",
        detail: "The fixture expects one cancelled check, one restored check, and one check after the forced repair.",
    };
}
/** Confirm publication and the forced repair from durable artifacts, never from model prose. */
export async function assessDurableArtifacts(root: string): Promise<Check[]> {
    const snapshots: JsonMap[] = [];
    for (const name of ["inactive-before", "implemented", "ci-killed", "delivered"])
        snapshots.push(JSON.parse(await readFile(join(root, "snapshots", `${name}.json`), "utf8")));
    const [before, implemented, killed, final] = snapshots;
    const checks = [assessExecution(before, implemented), assessCi(killed, final)];
    const record = workflow(final);
    const planId = field(record, "plan", "planId"),
        planName = field(record, "plan", "planName");
    const files = snapshotFiles(final);
    const controllerFile = files.find(
        (file) =>
            typeof file.path === "string" &&
            file.path.endsWith(`/internal/controller/plans/${encodeURIComponent(String(planId))}.json`),
    );
    const controller = typeof controllerFile?.text === "string" ? map(JSON.parse(controllerFile.text)) : null;
    const receipt = field(controller, "state", "publicationReceipt");
    const commit = field(receipt, "publishedCommit"),
        validated = field(receipt, "validatedCommit");
    const workRecord = field(record, "closure", "workRecord");
    const path = field(workRecord, "path"),
        id = field(workRecord, "recordId");
    const document = files.find((file) => file.path === `published/${commit}/${path}`);
    let attrs: JsonMap = {};
    try {
        if (typeof document?.text === "string") attrs = extractYaml<JsonMap>(document.text).attrs;
    } catch {
        /* Unreadable published metadata cannot qualify delivery. */
    }
    const publication =
        field(record, "state") === "closed" &&
        field(record, "closure", "reason") === "delivered" &&
        typeof commit === "string" &&
        /^[a-f0-9]{40}$/.test(commit) &&
        typeof validated === "string" &&
        /^[a-f0-9]{40}$/.test(validated) &&
        field(workRecord, "status") === "generated" &&
        typeof id === "string" &&
        attrs.recordId === id &&
        attrs.kind === "work_record" &&
        attrs.status === "approved" &&
        attrs.completionMode === "verified" &&
        Array.isArray(field(attrs, "provenance", "sourcePlans")) &&
        (field(attrs, "provenance", "sourcePlans") as string[]).includes(String(planId)) &&
        files.some((file) => file.path === `published/${commit}/docs/plans/${planName}.md`);
    checks.push({
        id: "publication-work-record",
        outcome: publication ? "pass" : "fail",
        detail: "The closed delivered workflow must have a publication receipt and the published verified Work Record.",
    });
    let repaired = false;
    if (publication) {
        try {
            const notes = execFileSync("git", ["cat-file", "blob", `${commit}:NOTES.md`], {
                cwd: join(root, "fixture"),
                encoding: "utf8",
                timeout: 30_000,
            });
            repaired = notes.split(/\r?\n/).includes("acceptance: reviewed");
        } catch {
            /* Missing published repair is a failed check. */
        }
    }
    checks.push({
        id: "published-repair",
        outcome: repaired ? "pass" : "fail",
        detail: "The published commit must contain the exact marker required by the independent fixture review.",
    });
    return checks;
}
