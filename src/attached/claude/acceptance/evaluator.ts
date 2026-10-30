import { compactResult } from "../../../shared/attached/presentation.ts";
import type { AttachedOperationResult } from "../../../shared/attached/operations.ts";
import { isDeepStrictEqual } from "node:util";
import { extractYaml } from "../../../shared/front-matter.ts";
import {
    PHASES,
    REQUIRED_HOST_RUNS,
    field,
    jsonMap,
    type AcceptanceEvidence,
    type AcceptanceSummary,
    type CheckResult,
    type Json,
    type JsonMap,
    type Phase,
    type Snapshot,
} from "./evidence.ts";

interface JsonArtifact {
    path: string;
    value: JsonMap;
}
interface MarkdownArtifact {
    path: string;
    attrs: JsonMap;
}
interface Artifacts {
    json: JsonArtifact[];
    markdown: MarkdownArtifact[];
    metrics: JsonMap[];
}

function parseArtifacts(snapshot: Snapshot | undefined, errors: string[]): Artifacts {
    const result: Artifacts = { json: [], markdown: [], metrics: [] };
    for (const file of snapshot?.files ?? []) {
        try {
            if (file.path.endsWith(".json") && file.text !== undefined) {
                const value = jsonMap(JSON.parse(file.text));
                if (value) result.json.push({ path: file.path, value });
            }
            if (file.path.includes("/workflow-metrics/") && file.path.endsWith(".jsonl") && file.text !== undefined) {
                for (const line of file.text.split(/\r?\n/).filter(Boolean)) {
                    const value = jsonMap(JSON.parse(line));
                    if (!value) throw new Error("Malformed metric");
                    result.metrics.push(value);
                }
            }
            if (file.path.endsWith(".md") && file.text?.startsWith("---")) {
                const attrs = jsonMap(extractYaml<JsonMap>(file.text).attrs);
                if (!attrs) throw new Error("Malformed front matter");
                result.markdown.push({ path: file.path, attrs });
            }
        } catch {
            errors.push(`${file.path}: malformed artifact`);
        }
    }
    return result;
}
function rows(value: Json | undefined): JsonMap[] {
    return Array.isArray(value) ? value.map(jsonMap).filter((row): row is JsonMap => row !== null) : [];
}
function populated(value: Json | undefined): boolean {
    return typeof value === "string" && value.trim().length > 0;
}
function sameState(left: Snapshot | undefined, right: Snapshot | undefined): boolean {
    return (
        !!left &&
        !!right &&
        !!left.git &&
        !!right.git &&
        left.ciRuns !== null &&
        right.ciRuns !== null &&
        !left.errors.length &&
        !right.errors.length &&
        JSON.stringify(left.files.map(({ path, sha256 }) => ({ path, sha256 }))) ===
            JSON.stringify(right.files.map(({ path, sha256 }) => ({ path, sha256 }))) &&
        JSON.stringify(left.git) === JSON.stringify(right.git) &&
        JSON.stringify(left.ciRuns) === JSON.stringify(right.ciRuns)
    );
}
function reaches(snapshot: Snapshot | undefined, receipt: Json | undefined): boolean {
    const target = field(receipt, "targetBranch"),
        published = field(receipt, "publishedCommit");
    if (!snapshot?.git || typeof target !== "string" || typeof published !== "string") return false;
    const tip = snapshot.git.refs[`refs/heads/${target}`];
    const queue = tip ? [tip] : [],
        seen = new Set<string>();
    while (queue.length) {
        const commit = queue.pop()!;
        if (commit === published) return true;
        if (seen.has(commit)) continue;
        seen.add(commit);
        queue.push(...(snapshot.git.parents[commit] ?? []));
    }
    return false;
}

/** Decide from durable artifacts and observed host/HTTP traffic, never from assistant claims. */
export function evaluateEvidence(evidence: AcceptanceEvidence): AcceptanceSummary {
    const errors = [...evidence.errors, ...evidence.privacy.errors];
    const artifacts = new Map(PHASES.map((phase) => [phase, parseArtifacts(evidence.snapshots[phase], errors)]));
    const snapshot = (phase: Phase) => evidence.snapshots[phase];
    const record = (phase: Phase) =>
        artifacts
            .get(phase)
            ?.json.find(
                ({ path, value }) =>
                    path.startsWith("runwield-home/.wld/attached/") &&
                    path.endsWith(`/workflows/${value.workflowId}.json`) &&
                    value.schemaVersion === 1 &&
                    populated(value.workflowId),
            )?.value;
    const controller = (phase: Phase) => {
        const planId = field(record(phase), "plan", "planId"),
            planName = field(record(phase), "plan", "planName");
        return artifacts
            .get(phase)
            ?.json.find(
                ({ path, value }) =>
                    typeof planId === "string" &&
                    path === `fixture/.wld/internal/controller/plans/${encodeURIComponent(planId)}.json` &&
                    value.planId === planId &&
                    value.planName === planName,
            )?.value;
    };
    const publicationAt = (phase: Phase) => field(controller(phase), "state", "publicationReceipt");
    const publishedPath = (phase: Phase, path: string) =>
        `published/${field(publicationAt(phase), "publishedCommit")}/${path}`;
    const planDocument = (phase: Phase) => {
        const name = field(record(phase), "plan", "planName"),
            id = field(record(phase), "plan", "planId");
        const documents = artifacts
            .get(phase)
            ?.markdown.filter(
                ({ path, attrs }) =>
                    typeof name === "string" && path.endsWith(`/docs/plans/${name}.md`) && attrs.planId === id,
            );
        return documents?.find(({ path }) => path === publishedPath(phase, `docs/plans/${name}.md`)) ?? documents?.[0];
    };
    const plan = (phase: Phase) => planDocument(phase)?.attrs;
    const receiptRows = (phase: Phase) => {
        const name = field(record(phase), "plan", "planName"),
            attempt = field(record(phase), "execution", "worktreeId");
        if (typeof name !== "string" || typeof attempt !== "string") return [];
        const prefix = `fixture/.wld/internal/delivery-evidence/${encodeURIComponent(name)}/${encodeURIComponent(attempt)}/`;
        return artifacts.get(phase)?.json.filter(({ path }) => path.startsWith(prefix)) ?? [];
    };
    const ledger = (phase: Phase) =>
        rows(field(controller(phase), "state", "validationCheckpoint", "reviewState", "reviewLedger", "items"));
    const http = (phase: Phase, kind: string) =>
        evidence.http.filter((row) => row.phase === phase && row.kind === kind);
    const httpBasis: Partial<Record<Phase, Phase>> = {
        "plan-chat": "plan-review",
        "plan-change": "plan-chat",
        "plan-feedback": "plan-change",
        "plan-approved": "plan-restored",
        "code-chat": "code-review",
        "code-change": "code-chat",
        "code-approved": "code-change",
    };
    const successfulHttp = (phase: Phase, kind: string, endpoint: string) => {
        const basis = record(httpBasis[phase] ?? phase);
        const actionId = field(basis, "validation", "actionId") ?? field(basis, "review", "actionId");
        return (
            populated(actionId) &&
            http(phase, kind).some(
                (row) =>
                    row.actionId === actionId &&
                    row.method === "POST" &&
                    row.status === 200 &&
                    typeof row.url === "string" &&
                    row.url.includes(`/api/review/${endpoint}`),
            )
        );
    };
    const operations = (phase: Phase) =>
        Object.values(jsonMap(field(record(phase), "acceptedOperations")) ?? {})
            .map(jsonMap)
            .filter((row): row is JsonMap => !!row);
    const hasOperation = (phase: Phase, name: string) =>
        operations(phase).some(
            (row) => field(row, "result", "operation") === name && field(row, "result", "ok") === true,
        );
    const newOperation = (before: Phase, after: Phase, name: string) => {
        const old = jsonMap(field(record(before), "acceptedOperations")) ?? {};
        return Object.entries(jsonMap(field(record(after), "acceptedOperations")) ?? {}).some(
            ([id, row]) =>
                !(id in old) && field(row, "result", "operation") === name && field(row, "result", "ok") === true,
        );
    };
    const isCodeReview = (phase: Phase) =>
        field(record(phase), "validation", "request", "kind") === "decision" &&
        field(record(phase), "validation", "request", "interaction", "type") === "code_review";
    const command = (phase: Phase, verb: string) =>
        evidence.plugins.some(
            (row) =>
                row.phase === phase &&
                row.exitCode === 0 &&
                Array.isArray(row.args) &&
                row.args[0] === "plugin" &&
                row.args[1] === verb,
        );
    const checks: CheckResult[] = [];
    const check = (id: string, passed: boolean, ...pointers: string[]) =>
        checks.push({ id, outcome: passed ? "pass" : "fail", evidence: pointers });
    const phasePointers = (...phases: Phase[]) => phases.map((phase) => `snapshots/${phase}.json`);
    const completeSnapshots = PHASES.every((phase) => {
        const value = snapshot(phase);
        return value && value.git && value.ciRuns !== null && value.ciFinished !== null && value.errors.length === 0;
    });
    check(
        "evidence-readable",
        errors.length === 0 && completeSnapshots && REQUIRED_HOST_RUNS.every((run) => evidence.hostRuns.includes(run)),
        "run.json",
        "snapshots/",
        "logs/",
    );
    const readable = (...paths: string[]) => !errors.some((error) => paths.some((path) => error.startsWith(path)));
    const ordinarySuccess = (run: string) =>
        readable(`logs/claude/${run}.jsonl`) && evidence.hostResults.some((row) => row.run === run && row.success);
    const metadata = evidence.metadata;
    const version =
        typeof metadata.claudeVersion === "string" && /^\d+(?:\.\d+)+$/.test(metadata.claudeVersion)
            ? metadata.claudeVersion
            : null;
    const coreVersion =
        typeof metadata.coreVersion === "string" && /^[a-zA-Z0-9.+-]+$/.test(metadata.coreVersion)
            ? metadata.coreVersion
            : null;
    const coreCommit =
        typeof metadata.coreCommit === "string" && /^[a-f0-9]{40}$/.test(metadata.coreCommit)
            ? metadata.coreCommit
            : null;
    const sourceDigest =
        typeof metadata.coreSourceDigest === "string" && /^[a-f0-9]{64}$/.test(metadata.coreSourceDigest)
            ? metadata.coreSourceDigest
            : null;
    check(
        "core-source",
        !!sourceDigest &&
            metadata.coreSourceDigestAfter === sourceDigest &&
            metadata.coreCommitAfter === coreCommit &&
            typeof metadata.coreSourceDirty === "boolean",
        "run.json",
    );
    const contract =
        typeof metadata.adapterContract === "number" &&
        Number.isSafeInteger(metadata.adapterContract) &&
        metadata.adapterContract > 0
            ? metadata.adapterContract
            : null;
    const adapterVersion =
        typeof metadata.adapterVersion === "string" && /^\d+(?:\.\d+)+$/.test(metadata.adapterVersion)
            ? metadata.adapterVersion
            : null;
    const testDate =
        typeof metadata.testDate === "string" &&
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(metadata.testDate) &&
        !Number.isNaN(Date.parse(metadata.testDate))
            ? metadata.testDate
            : null;
    const permissions = metadata.permissions === "bypass-in-throwaway" ? metadata.permissions : null;
    check(
        "run-identity",
        !!version && !!coreVersion && !!coreCommit && !!contract && !!adapterVersion && !!testDate && !!permissions,
        "run.json",
    );

    check(
        "stale-adapter",
        !record("initial") &&
            !record("stale-adapter") &&
            sameState(snapshot("initial"), snapshot("stale-adapter")) &&
            evidence.tools.some((tool) => tool.run === "stale-adapter" && tool.operation === "activate") &&
            evidence.toolResults.some(
                (row) =>
                    row.run === "stale-adapter" &&
                    field(row.body, "ok") === false &&
                    field(row.body, "rejection", "code") === "incompatible_adapter" &&
                    evidence.tools.some(
                        (tool) => tool.run === row.run && tool.toolId === row.toolId && tool.operation === "activate",
                    ),
            ),
        ...phasePointers("initial", "stale-adapter"),
        "logs/claude/stale-adapter.jsonl",
        "logs/processes.jsonl",
    );
    check(
        "step-01-install",
        command("installed", "install") &&
            evidence.plugins.some(
                (row) =>
                    row.phase === "installed" &&
                    row.exitCode === 0 &&
                    Array.isArray(row.args) &&
                    row.args[0] === "plugin" &&
                    row.args[1] === "marketplace" &&
                    row.args[2] === "add",
            ),
        "logs/plugins.jsonl",
    );
    check(
        "inactive-before",
        ordinarySuccess("inactive-before") &&
            sameState(snapshot("installed"), snapshot("inactive-before")) &&
            !evidence.tools.some((tool) => tool.run === "inactive-before"),
        ...phasePointers("installed", "inactive-before"),
        "logs/claude/inactive-before.jsonl",
    );
    const initialFiles = snapshot("initial")?.files;
    check(
        "step-02-uninitialized-activation",
        !!initialFiles &&
            !initialFiles.some((file) => file.path.startsWith("fixture/.wld/") || file.path === "fixture/AGENTS.md") &&
            field(record("activated"), "state") === "triaging" &&
            hasOperation("activated", "activate"),
        ...phasePointers("initial", "activated"),
    );
    check(
        "step-03-explicit-request",
        populated(field(record("activated"), "request", "hostRequestId")) &&
            populated(field(record("activated"), "request", "text")) &&
            evidence.tools.some((tool) => tool.run === "request" && tool.operation === "activate"),
        ...phasePointers("activated"),
        "logs/claude/request.jsonl",
    );
    check(
        "step-04-triage",
        field(record("triaged"), "triageOutcome", "workKind") === "FEATURE" &&
            field(record("triaged"), "state") === "awaiting_planning" &&
            hasOperation("triaged", "triage_report"),
        ...phasePointers("triaged"),
    );
    check(
        "step-05-plan",
        field(record("plan-review"), "state") === "awaiting_review" &&
            !!plan("plan-review") &&
            field(record("plan-review"), "review", "status") === "pending" &&
            hasOperation("plan-review", "plan_written"),
        ...phasePointers("plan-review"),
    );
    const chatAnswered = (phase: Phase, section: string) =>
        rows(field(record(phase), section, "chat", "turns")).some(
            (turn) => populated(turn.turnId) && populated(turn.reply),
        ) &&
        successfulHttp(phase, "question", "deny") &&
        hasOperation(phase, "review_reply");
    const reviewRound = (phase: Phase) => field(record(phase), "review", "round");
    const originalRound = reviewRound("plan-review"),
        changedRound = reviewRound("plan-change"),
        feedbackRound = reviewRound("plan-feedback");
    check(
        "step-06-plan-review-and-chat",
        chatAnswered("plan-chat", "review") &&
            successfulHttp("plan-change", "change", "deny") &&
            successfulHttp("plan-feedback", "feedback", "deny") &&
            typeof originalRound === "number" &&
            typeof changedRound === "number" &&
            typeof feedbackRound === "number" &&
            originalRound < changedRound &&
            changedRound < feedbackRound,
        ...phasePointers("plan-review", "plan-chat", "plan-change", "plan-feedback"),
        "logs/http.jsonl",
    );
    check(
        "step-07-plan-approval",
        field(record("plan-restored"), "state") === "awaiting_review" &&
            field(record("plan-approved"), "state") === "plan_ready" &&
            successfulHttp("plan-approved", "approve", "decision") &&
            ["approved", "ready_for_work"].includes(String(field(plan("plan-approved"), "status"))),
        ...phasePointers("plan-restored", "plan-approved"),
        "logs/http.jsonl",
    );
    const execution = field(record("implemented"), "execution");
    const registries =
        artifacts
            .get("implemented")
            ?.json.filter(
                ({ path, value }) => path === "fixture/.wld/internal/worktrees.json" && value.version === 2,
            ) ?? [];
    check(
        "step-08-isolated-execution",
        field(execution, "executionMode") === "worktree" &&
            populated(field(execution, "executionCwd")) &&
            registries.some(({ value }) =>
                rows(value.entries).some(
                    (entry) =>
                        entry.id === field(execution, "worktreeId") &&
                        entry.planId === field(record("implemented"), "plan", "planId") &&
                        entry.planName === field(record("implemented"), "plan", "planName") &&
                        entry.path === field(execution, "executionCwd") &&
                        entry.branch === field(execution, "worktreeBranch") &&
                        populated(entry.branch) &&
                        populated(entry.executionBaselineTree) &&
                        entry.executionBaselineTree === field(execution, "baselineTree") &&
                        entry.status === "completed",
                ),
            ) &&
            hasOperation("implemented", "start_execution"),
        ...phasePointers("implemented"),
    );
    check(
        "step-09-implementation",
        field(record("implemented"), "state") === "implemented" &&
            hasOperation("implemented", "task_completed") &&
            populated(field(controller("implemented"), "state", "implementedAt")),
        ...phasePointers("implemented"),
    );
    check(
        "disable",
        ordinarySuccess("disabled") &&
            command("disabled", "disable") &&
            sameState(snapshot("implemented"), snapshot("disabled")) &&
            !evidence.tools.some((tool) => tool.run === "disabled"),
        ...phasePointers("implemented", "disabled"),
        "logs/plugins.jsonl",
        "logs/claude/disabled.jsonl",
    );
    check(
        "uninstall",
        ordinarySuccess("uninstalled") &&
            command("uninstalled", "uninstall") &&
            sameState(snapshot("disabled"), snapshot("uninstalled")) &&
            !evidence.tools.some((tool) => tool.run === "uninstalled"),
        ...phasePointers("disabled", "uninstalled"),
        "logs/plugins.jsonl",
        "logs/claude/uninstalled.jsonl",
    );
    check(
        "reinstall",
        command("reinstalled", "install") && sameState(snapshot("uninstalled"), snapshot("reinstalled")),
        ...phasePointers("uninstalled", "reinstalled"),
        "logs/plugins.jsonl",
    );
    const started = snapshot("ci-started")?.ciRuns,
        killed = snapshot("ci-killed")?.ciRuns,
        resumed = snapshot("ci-resumed")?.ciRuns;
    check(
        "step-10-ci-and-resume",
        !!started?.length &&
            started.length === (snapshot("reinstalled")?.ciRuns?.length ?? -1) + 1 &&
            JSON.stringify(started) === JSON.stringify(killed) &&
            !!killed &&
            !!resumed &&
            resumed.length === killed.length + 1 &&
            started.every((run, index) => run === resumed[index]) &&
            !snapshot("ci-started")?.ciFinished?.includes(started.at(-1)!) &&
            !snapshot("ci-killed")?.ciFinished?.includes(started.at(-1)!) &&
            !!snapshot("ci-resumed")?.ciFinished?.includes(resumed.at(-1)!) &&
            evidence.processes.some(
                (row) =>
                    row.event === "ci-held" &&
                    row.phase === "ci-killed" &&
                    row.runId === snapshot("ci-started")?.hostRun &&
                    typeof row.ciPid === "number" &&
                    row.ciPid > 0 &&
                    String(row.ciPid) === started.at(-1),
            ) &&
            receiptRows("ci-resumed").some(
                ({ path, value }) =>
                    value.kind === "ci" &&
                    value.outcome === "Exit 0" &&
                    !receiptRows("reinstalled").some((prior) => prior.path === path),
            ),
        ...phasePointers("ci-started", "ci-killed", "ci-resumed"),
    );
    const opened = ledger("review-blocked"),
        resolved = ledger("code-review");
    check(
        "step-11-finding-repair-rereview",
        opened.length > 0 &&
            field(record("review-blocked"), "validation", "request", "kind") === "repair" &&
            newOperation("review-blocked", "code-review", "task_completed") &&
            isCodeReview("code-review") &&
            receiptRows("review-blocked").some(
                ({ value }) => value.kind === "ai" && value.outcome === "Changes requested",
            ) &&
            opened.every(
                (finding) =>
                    populated(finding.id) &&
                    finding.status !== "fix_confirmed" &&
                    resolved.some(
                        (fixed) =>
                            fixed.id === finding.id &&
                            fixed.status === "fix_confirmed" &&
                            typeof fixed.resolvedInRound === "number" &&
                            typeof finding.openedInRound === "number" &&
                            fixed.resolvedInRound > finding.openedInRound,
                    ),
            ) &&
            receiptRows("code-review").some(({ value }) => value.kind === "ai" && value.outcome === "Approved"),
        ...phasePointers("review-blocked", "code-review"),
    );
    const beforeChangeCi = snapshot("code-review")?.ciRuns,
        afterChangeCi = snapshot("code-change")?.ciRuns;
    check(
        "step-12-code-review-and-chat",
        isCodeReview("code-chat") &&
            isCodeReview("code-change") &&
            chatAnswered("code-chat", "validation") &&
            successfulHttp("code-change", "change", "deny") &&
            field(record("code-change"), "validation", "actionId") !==
                field(record("code-review"), "validation", "actionId") &&
            !!beforeChangeCi &&
            !!afterChangeCi &&
            afterChangeCi.length === beforeChangeCi.length + 1 &&
            receiptRows("code-change").some(
                ({ path, value }) =>
                    value.kind === "ci" &&
                    value.outcome === "Exit 0" &&
                    !receiptRows("code-review").some((prior) => prior.path === path),
            ) &&
            successfulHttp("code-approved", "approve", "decision"),
        ...phasePointers("code-review", "code-chat", "code-change", "code-approved"),
        "logs/http.jsonl",
    );
    const publication = field(controller("delivered"), "state", "publicationReceipt");
    const effectiveVerified =
        field(plan("delivered"), "status") === "verified" ||
        (populated(field(controller("delivered"), "state", "verifiedAt")) && !!jsonMap(publication));
    check(
        "step-13-publication",
        field(record("delivered"), "state") === "closed" &&
            field(record("delivered"), "closure", "reason") === "delivered" &&
            effectiveVerified &&
            planDocument("delivered")?.path ===
                publishedPath("delivered", `docs/plans/${field(record("delivered"), "plan", "planName")}.md`) &&
            populated(field(publication, "validatedCommit")) &&
            reaches(snapshot("delivered"), publication),
        ...phasePointers("delivered"),
    );
    const workRecord = field(record("delivered"), "closure", "workRecord");
    const workRecordPath = field(workRecord, "path"),
        workRecordId = field(workRecord, "recordId");
    check(
        "step-14-work-record",
        field(workRecord, "status") === "generated" &&
            populated(workRecordId) &&
            typeof workRecordPath === "string" &&
            !!artifacts
                .get("delivered")
                ?.markdown.some(
                    ({ path, attrs }) =>
                        path === publishedPath("delivered", workRecordPath) &&
                        attrs.kind === "work_record" &&
                        attrs.recordId === workRecordId &&
                        attrs.status === "approved" &&
                        attrs.completionMode === "verified" &&
                        Array.isArray(field(attrs, "provenance", "sourcePlans")) &&
                        (field(attrs, "provenance", "sourcePlans") as Json[]).includes(
                            field(record("delivered"), "plan", "planId") ?? null,
                        ),
                ),
        ...phasePointers("delivered"),
    );
    const stoppedReview = evidence.http.some(
        (row) =>
            row.phase === "plan-killed" &&
            row.kind === "liveness" &&
            row.status === null &&
            row.errorCode === "ECONNREFUSED" &&
            evidence.http.some(
                (before) => before.phase === "plan-feedback" && before.status === 200 && before.url === row.url,
            ),
    );
    const killedProcess = (phase: Phase) =>
        evidence.processes.find(
            (row) =>
                row.phase === phase &&
                row.event === "exit" &&
                row.signal === "SIGKILL" &&
                row.runId === snapshot(phase)?.hostRun &&
                typeof row.pid === "number" &&
                row.pid > 0 &&
                typeof row.runId === "string" &&
                evidence.hostRuns.includes(row.runId) &&
                evidence.processes.some(
                    (start) => start.event === "start" && start.pid === row.pid && start.runId === row.runId,
                ),
        );
    const restoredProcess = (killedPhase: Phase, restoredPhase: Phase, operation: string) => {
        const killed = killedProcess(killedPhase),
            run = snapshot(restoredPhase)?.hostRun;
        return (
            !!killed &&
            typeof run === "string" &&
            run !== killed.runId &&
            evidence.hostRuns.includes(run) &&
            evidence.processes.some(
                (start) =>
                    start.event === "start" &&
                    start.phase === restoredPhase &&
                    start.runId === run &&
                    start.pid !== killed.pid,
            ) &&
            evidence.tools.some(
                (tool) =>
                    tool.run === run &&
                    tool.operation === operation &&
                    evidence.toolResults.some(
                        (result) =>
                            result.run === run &&
                            result.toolId === tool.toolId &&
                            field(result.body, "ok") === true &&
                            field(result.body, "workflow", "workflowId") === field(record("activated"), "workflowId"),
                    ),
            )
        );
    };
    check(
        "step-15-interruptions",
        stoppedReview &&
            restoredProcess("plan-killed", "plan-restored", "status") &&
            restoredProcess("ci-killed", "ci-resumed", "start_validation") &&
            field(record("plan-killed"), "state") === "awaiting_review" &&
            field(record("plan-killed"), "review", "status") === "pending",
        ...phasePointers("plan-killed", "plan-restored", "ci-killed", "ci-resumed"),
        "logs/http.jsonl",
        "logs/processes.jsonl",
    );
    check(
        "step-16-inactive-after",
        ordinarySuccess("inactive-after") &&
            sameState(snapshot("delivered"), snapshot("inactive-after")) &&
            !evidence.tools.some((tool) => tool.run === "inactive-after"),
        ...phasePointers("delivered", "inactive-after"),
        "logs/claude/inactive-after.jsonl",
    );
    const events = artifacts.get("delivered")?.metrics ?? [];
    check(
        "lifecycle-events",
        [
            "plan_event:readiness_passed",
            "plan_review_feedback",
            "plan_review_approved",
            "plan_event:execution_started",
            "plan_event:implementation_finished",
            "plan_event:mechanical_validation_passed",
            "plan_event:semantic_review_feedback",
            "plan_event:semantic_review_passed",
            "plan_event:validation_passed",
        ].every((operation) =>
            events.some((row) =>
                row.v === 2
                    ? row.event === "workflow_transition_committed" &&
                      row.outcome === "succeeded" &&
                      typeof row.planId === "string" &&
                      row.planId === field(record("delivered"), "plan", "planId") &&
                      row.operation === operation
                    : row.planName === field(record("delivered"), "plan", "planName") &&
                      (row.event === "plan_transition_committed" || row.event === "semantic_transition_committed") &&
                      field(row, "details", "operation") === operation,
            ),
        ),
        ...phasePointers("delivered"),
    );
    const branch = snapshot("initial")?.git?.branch;
    check(
        "invoking-branch",
        !!branch &&
            PHASES.every((phase) => snapshot(phase)?.git?.branch === branch) &&
            PHASES.slice(0, PHASES.indexOf("code-approved")).every(
                (phase) => snapshot(phase)?.git?.head === snapshot("initial")?.git?.head,
            ),
        "snapshots/",
    );

    const accepted = new Map<string, JsonMap>();
    const allReceipts: JsonMap[] = [];
    const hosts: JsonMap[] = [];
    let receiptsConsistent = true;
    const workflowId = field(record("activated"), "workflowId");
    check(
        "workflow-identity",
        populated(workflowId) &&
            PHASES.slice(PHASES.indexOf("activated")).every(
                (phase) => field(record(phase), "workflowId") === workflowId,
            ),
        "snapshots/",
    );
    for (const phase of PHASES) {
        const item = record(phase);
        if (!item) continue;
        const host = jsonMap(item.evidence);
        if (host) hosts.push(host);
        for (const [id, row] of Object.entries(jsonMap(item.acceptedOperations) ?? {})) {
            const operation = jsonMap(row);
            if (!operation) {
                receiptsConsistent = false;
                continue;
            }
            if (accepted.has(id) && !isDeepStrictEqual(accepted.get(id), operation)) receiptsConsistent = false;
            accepted.set(id, operation);
            allReceipts.push(operation);
        }
    }
    const firstRun = new Map<string, string | null>();
    const firstPhase = new Map<string, Phase>();
    for (const phase of PHASES)
        for (const id of Object.keys(jsonMap(field(record(phase), "acceptedOperations")) ?? {})) {
            if (!firstRun.has(id)) {
                firstRun.set(id, snapshot(phase)?.hostRun ?? null);
                firstPhase.set(id, phase);
            }
        }
    // Code changes are public review replies, but Core deliberately saves the
    // validation decision result. Do not treat other operation aliases as equal.
    const codeChangeMatch = (id: string, row: JsonMap) => {
        if (
            firstPhase.get(id) !== "code-change" ||
            !Object.hasOwn(jsonMap(field(record("code-change"), "acceptedOperations")) ?? {}, id) ||
            Object.hasOwn(jsonMap(field(record("code-chat"), "acceptedOperations")) ?? {}, id) ||
            field(row, "result", "ok") !== true ||
            field(row, "result", "operation") !== "validation_decision" ||
            !isCodeReview("code-chat")
        )
            return false;
        const attempt = field(record("code-chat"), "validation", "request", "identity", "attemptId");
        const action = field(row, "result", "workflow", "nextAction");
        const request = field(action, "request");
        if (
            !populated(attempt) ||
            field(action, "kind") !== "validation" ||
            field(request, "kind") !== "repair" ||
            field(request, "identity", "attemptId") !== attempt ||
            !isDeepStrictEqual(
                field(row, "result", "workflow", "execution"),
                field(record("code-chat"), "execution"),
            ) ||
            field(row, "result", "workflow", "workflowId") !== workflowId ||
            field(row, "result", "workflow", "state") !== "validating"
        )
            return false;
        const sent = http("code-change", "change").some((row) => {
            try {
                const url = new URL(String(row.url));
                return (
                    row.actionId === field(record("code-chat"), "validation", "actionId") &&
                    row.method === "POST" &&
                    row.status === 200 &&
                    !row.errorCode &&
                    url.protocol === "http:" &&
                    url.hostname === "127.0.0.1" &&
                    !!url.searchParams.get("token") &&
                    url.pathname === "/api/review/deny" &&
                    field(row.request, "conversationTurn") === true
                );
            } catch {
                return false;
            }
        });
        const carrierEvidence = { ...jsonMap(field(record("code-chat"), "evidence")) };
        delete carrierEvidence.compatibility;
        return (
            sent &&
            evidence.tools.some((tool) => {
                const input = tool.input;
                const summary = field(input, "payload", "change", "summary");
                const revision = field(input, "expectedRevision");
                const sourceRevision = field(record("code-chat"), "revision");
                if (
                    tool.operationId !== id ||
                    tool.operation !== "review_reply" ||
                    tool.run !== firstRun.get(id) ||
                    tool.run !== snapshot("code-change")?.hostRun ||
                    !evidence.hostRuns.includes(tool.run) ||
                    field(input, "operationId") !== id ||
                    field(input, "workflowId") !== workflowId ||
                    !isDeepStrictEqual(row.evidence, carrierEvidence) ||
                    typeof revision !== "number" ||
                    typeof sourceRevision !== "number" ||
                    // The HTTP chat enqueue can add one revision after the checkpoint.
                    (revision !== sourceRevision && revision !== sourceRevision + 1) ||
                    field(row, "result", "workflow", "revision") !== revision + 2 ||
                    !populated(field(input, "payload", "turnId")) ||
                    typeof summary !== "string" ||
                    !summary.trim() ||
                    typeof field(request, "prompt") !== "string" ||
                    !String(field(request, "prompt")).includes(summary)
                )
                    return false;
                return evidence.toolResults.some((result) => {
                    if (
                        result.run !== tool.run ||
                        result.toolId !== tool.toolId ||
                        field(result.body, "operation") !== "review_reply" ||
                        field(result.body, "reviewReply", "turnId") !== field(input, "payload", "turnId") ||
                        field(result.body, "reviewReply", "text") !== field(input, "payload", "text")
                    )
                        return false;
                    const durable = structuredClone(jsonMap(result.body)!);
                    durable.operation = "validation_decision";
                    delete durable.reviewReply;
                    // The public carrier adds these fields after it saves the receipt.
                    delete durable.instructions;
                    delete durable.compatibility;
                    const receipt: AttachedOperationResult = JSON.parse(JSON.stringify(row.result));
                    const projected = JSON.parse(JSON.stringify(compactResult(receipt)));
                    return isDeepStrictEqual(durable, projected);
                });
            })
        );
    };
    const directMatch = (id: string, row: JsonMap) =>
        evidence.tools.some(
            (tool) =>
                tool.operationId === id &&
                tool.operation === field(row, "result", "operation") &&
                tool.run === firstRun.get(id) &&
                evidence.hostRuns.includes(tool.run) &&
                evidence.toolResults.some(
                    (result) =>
                        result.toolId === tool.toolId &&
                        result.run === tool.run &&
                        field(result.body, "ok") === true &&
                        field(result.body, "operation") === tool.operation &&
                        field(result.body, "workflow", "workflowId") === workflowId,
                ),
        );
    const interrupted = field(record("ci-killed"), "validation");
    const interruptedId = field(interrupted, "operationId");
    const recoveredMatch = (id: string, row: JsonMap) =>
        id === interruptedId &&
        evidence.tools.some(
            (tool) =>
                tool.operationId === id &&
                tool.operation === field(interrupted, "operation") &&
                tool.run === snapshot("ci-killed")?.hostRun,
        ) &&
        restoredProcess("ci-killed", "ci-resumed", "start_validation") &&
        isDeepStrictEqual(row.evidence, field(interrupted, "evidence")) &&
        [...accepted].some(
            ([recoveryId, recovery]) =>
                recoveryId !== id &&
                firstRun.get(recoveryId) === snapshot("ci-resumed")?.hostRun &&
                directMatch(recoveryId, recovery) &&
                isDeepStrictEqual(row.result, {
                    ...jsonMap(recovery.result),
                    operation: field(interrupted, "operation"),
                }),
        );
    // Only the exact successful HTTP approval can account for a browser-created receipt.
    // Its source identity binds the action to one attempt, generation, and reviewed candidate.
    const browserApprovalMatch = (id: string, row: JsonMap) => {
        const before = record("code-change"),
            after = record("code-approved");
        const identity = field(before, "validation", "request", "identity");
        const decisionKey = field(identity, "key");
        const attemptId = field(identity, "attemptId");
        const generation = field(identity, "generation");
        const result = row.result;
        const workflow = field(result, "workflow");
        const action = field(workflow, "nextAction");
        const revision = field(before, "revision");
        const priorCheckpoint = field(controller("code-change"), "state", "validationCheckpoint");
        const checkpoint = field(controller("code-approved"), "state", "validationCheckpoint");
        if (
            firstPhase.get(id) !== "code-approved" ||
            !populated(id) ||
            !populated(field(before, "validation", "actionId")) ||
            !isCodeReview("code-change") ||
            field(before, "state") !== "validating" ||
            !populated(attemptId) ||
            !populated(generation) ||
            !populated(decisionKey) ||
            field(identity, "kind") !== "decision" ||
            !isDeepStrictEqual(field(priorCheckpoint, "pendingHostDecision"), field(before, "validation", "request")) ||
            field(priorCheckpoint, "attemptId") !== attemptId ||
            field(priorCheckpoint, "generation") !== generation ||
            field(checkpoint, "attemptId") !== attemptId ||
            field(checkpoint, "generation") !== generation ||
            field(checkpoint, "hostDecisionChoices", String(decisionKey).replace(/:\d+$/, ""), "outcome") !==
                "approved" ||
            field(result, "ok") !== true ||
            field(result, "operation") !== "validation_decision" ||
            !isDeepStrictEqual(row.evidence, before?.evidence) ||
            field(workflow, "workflowId") !== workflowId ||
            field(after, "workflowId") !== workflowId ||
            field(workflow, "state") !== "validating" ||
            field(after, "state") !== "validating" ||
            typeof revision !== "number" ||
            field(workflow, "revision") !== revision + 2 ||
            field(after, "revision") !== revision + 2 ||
            !isDeepStrictEqual(field(workflow, "execution"), before?.execution) ||
            !isDeepStrictEqual(after?.execution, before?.execution) ||
            field(action, "kind") !== "recorder" ||
            field(action, "request", "kind") !== "recorder" ||
            field(action, "request", "identity", "attemptId") !== attemptId ||
            !isDeepStrictEqual(field(action, "request"), field(after, "validation", "request")) ||
            field(action, "actionId") !== field(after, "validation", "actionId") ||
            !populated(field(action, "actionId"))
        )
            return false;
        return http("code-approved", "approve").some((row) => {
            try {
                const url = new URL(String(row.url));
                const response = row.response;
                return (
                    row.method === "POST" &&
                    row.status === 200 &&
                    !row.errorCode &&
                    row.actionId === field(before, "validation", "actionId") &&
                    url.protocol === "http:" &&
                    url.hostname === "127.0.0.1" &&
                    !!url.searchParams.get("token") &&
                    url.pathname === "/api/review/decision" &&
                    typeof field(row.request, "reviewRevision") === "number" &&
                    field(row.request, "approved") === true &&
                    field(row.request, "conversationTurn") !== true &&
                    field(response, "ok") === true &&
                    field(response, "operationId") === id &&
                    field(response, "workflowId") === workflowId &&
                    field(response, "actionId") === row.actionId &&
                    field(response, "attemptId") === attemptId &&
                    field(response, "generation") === generation &&
                    field(response, "decisionKey") === decisionKey
                );
            } catch {
                return false;
            }
        });
    };
    const browserApprovals = [...accepted].filter(([id, row]) => browserApprovalMatch(id, row));
    const matched = [...accepted].filter(
        ([id, row]) =>
            directMatch(id, row) ||
            codeChangeMatch(id, row) ||
            recoveredMatch(id, row) ||
            browserApprovalMatch(id, row),
    );
    check(
        "operation-provenance",
        receiptsConsistent &&
            browserApprovals.length === 1 &&
            accepted.size > 0 &&
            matched.length === accepted.size &&
            typeof interruptedId === "string" &&
            !!jsonMap(field(record("ci-resumed"), "acceptedOperations", interruptedId)) &&
            firstRun.get(interruptedId) === snapshot("ci-resumed")?.hostRun,
        "snapshots/",
        "logs/claude/",
        "logs/http.jsonl",
    );
    const activationAssessment = field(record("activated"), "evidence", "compatibility", "status");
    const assessed = activationAssessment === "compatible" || activationAssessment === "untested_newer";
    check(
        "host-version",
        !!version &&
            hosts.length > 0 &&
            hosts.every(
                (host) =>
                    host.hostVersion === version &&
                    host.adapterContract === contract &&
                    host.coreVersion === coreVersion &&
                    host.adapterVersion === adapterVersion,
            ) &&
            allReceipts.every(
                (row) =>
                    field(row, "evidence", "hostVersion") === version &&
                    field(row, "evidence", "adapterContract") === contract &&
                    field(row, "evidence", "coreVersion") === coreVersion &&
                    field(row, "evidence", "adapterVersion") === adapterVersion,
            ) &&
            assessed,
        "run.json",
        "snapshots/",
    );
    check(
        "read-only-driver",
        readable("shim-argv.jsonl") &&
            evidence.shimArgv.length > 0 &&
            evidence.shimArgv.every(
                (args) =>
                    args.length >= 2 &&
                    args[0] === "attached" &&
                    (args[1] === "mcp" ? args.length === 2 : args[1] === "status"),
            ),
        "shim-argv.jsonl",
    );
    check(
        "no-core-model-calls",
        readable("sentinel-binaries.log", "proxy-sink.log") &&
            evidence.modelProcesses.length === 0 &&
            evidence.proxyHosts.length === 0,
        "sentinel-binaries.log",
        "proxy-sink.log",
    );
    check(
        "sentinel-absence",
        evidence.privacy.leaks.length === 0 && evidence.privacy.errors.length === 0,
        "runwield-home/",
        "fixture/",
        "fixture/git/",
    );
    const passed = checks.every((row) => row.outcome === "pass");
    return {
        schemaVersion: 1,
        outcome: passed ? "pass" : "fail",
        testDate,
        claudeVersion: version,
        coreVersion,
        coreCommit,
        coreSourceDigest: sourceDigest,
        coreSourceDirty: typeof metadata.coreSourceDirty === "boolean" ? metadata.coreSourceDirty : null,
        adapterContract: contract,
        adapterVersion,
        activationAssessment: typeof activationAssessment === "string" && assessed ? activationAssessment : null,
        permissions,
        checks,
        provenance: {
            acceptedOperations: accepted.size,
            matchedOperations: matched.length,
            httpRequests: evidence.http.length,
            shimCalls: evidence.shimArgv.length,
        },
        proposedMatrixEntry: passed
            ? {
                  version,
                  testDate,
                  coreVersion,
                  coreCommit,
                  coreSourceDigest: sourceDigest,
                  coreSourceDirty: metadata.coreSourceDirty,
                  adapterContract: contract,
                  evidenceSource: `src/attached/claude/acceptance/results/claude-code-${version}.json`,
                  capabilities: checks.filter((row) => row.id.startsWith("step-")).map((row) => row.id),
                  limits: [
                      "Claude Code FEATURE Preview only",
                      "MCP_TOOL_TIMEOUT=600000",
                      "No /runwield:init",
                      "No hooks or tool restrictions",
                      "Role boundaries are instructions, not enforcement",
                      "Headless permissions bypassed only in the throwaway world",
                  ],
              }
            : null,
    };
}
