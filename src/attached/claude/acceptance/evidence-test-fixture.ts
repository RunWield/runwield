import { createHash } from "node:crypto";
import { PHASES, REQUIRED_HOST_RUNS, field, type AcceptanceEvidence, type JsonMap, type Snapshot } from "./evidence.ts";

export const RECORD = "runwield-home/.wld/attached/project/workflows/workflow.json";
export const CONTROLLER = "fixture/.wld/internal/controller/plans/plan-id.json";
export const PLAN = "fixture/docs/plans/feature.md";
export const WORK_RECORD = "fixture/docs/work-records/feature.md";
export const INITIAL_COMMIT = "a".repeat(40);
export const PUBLISHED_COMMIT = "b".repeat(40);
export const METADATA: JsonMap = {
    claudeVersion: "2.1.303",
    coreVersion: "acceptance-core",
    coreCommit: "c".repeat(40),
    coreCommitAfter: "c".repeat(40),
    coreSourceDigest: "f".repeat(64),
    coreSourceDigestAfter: "f".repeat(64),
    coreSourceDirty: true,
    adapterContract: 1,
    adapterVersion: "0.2.0",
    testDate: "2026-10-07T12:00:00.000Z",
    permissions: "bypass-in-throwaway",
};

export function putFile(snapshot: Snapshot, path: string, value: string | JsonMap): void {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    snapshot.files = snapshot.files.filter((file) => file.path !== path);
    snapshot.files.push({ path, text, sha256: createHash("sha256").update(text).digest("hex") });
    snapshot.files.sort((a, b) => a.path.localeCompare(b.path));
}
export function editJson(snapshot: Snapshot, path: string, edit: (value: JsonMap) => void): void {
    const file = snapshot.files.find((file) => file.path === path);
    if (!file?.text) throw new Error(`Missing test artifact ${path}`);
    const value: JsonMap = JSON.parse(file.text);
    edit(value);
    putFile(snapshot, path, value);
}

/**
 * Serialized observations for pure evaluator tests; no workflow machinery is substituted.
 * Includes Core's code-chat and browser approval validation_decision receipts.
 */
export function completeEvidence(): AcceptanceEvidence {
    const result: AcceptanceEvidence = {
        metadata: structuredClone(METADATA),
        snapshots: {},
        tools: [],
        toolResults: [],
        hostRuns: [...REQUIRED_HOST_RUNS],
        hostResults: ["inactive-before", "disabled", "uninstalled", "inactive-after"].map((run) => ({
            run,
            success: true,
        })),
        http: [],
        processes: [],
        plugins: [],
        shimArgv: [
            ["attached", "mcp"],
            ["attached", "status"],
        ],
        modelProcesses: [],
        proxyHosts: [],
        privacy: { leaks: [], errors: [] },
        errors: [],
    };
    const host: JsonMap = {
        host: "claude-code",
        hostVersion: METADATA.claudeVersion,
        adapterContract: 1,
        adapterVersion: "0.2.0",
        coreVersion: METADATA.coreVersion,
        compatibility: { status: "compatible" },
    };
    const carrierEvidence: JsonMap = {
        host: host.host,
        hostVersion: host.hostVersion,
        adapterContract: host.adapterContract,
        adapterVersion: host.adapterVersion,
    };
    const accepted: JsonMap = {};
    const workflow: JsonMap = {
        schemaVersion: 1,
        workflowId: "workflow",
        state: "triaging",
        evidence: host,
        acceptedOperations: accepted,
        request: { hostRequestId: "request-1", text: "Add a value" },
        plan: { planId: "plan-id", planName: "feature" },
    };
    const state: JsonMap = {};
    result.hostRuns.push("plan-restored", "validate", "ci-resumed");
    const codeRequest: JsonMap = {
        kind: "decision",
        identity: { attemptId: "wt-1", generation: "validation-1", kind: "decision", key: "candidate-1:1" },
        interaction: { type: "code_review" },
    };
    let current: Snapshot = {
        hostRun: null,
        files: [],
        errors: [],
        ciRuns: [],
        ciFinished: [],
        git: {
            branch: "main",
            head: INITIAL_COMMIT,
            status: "",
            refs: { "refs/heads/main": INITIAL_COMMIT },
            parents: { [INITIAL_COMMIT]: [] },
        },
    };
    const operation = (name: string) => {
        const run = current.hostRun!;
        const id = `${name}-${Object.keys(accepted).length}`;
        accepted[id] = { result: { ok: true, operation: name, workflow: { workflowId: "workflow" } }, evidence: host };
        result.tools.push({ run, operation: name, operationId: id, toolId: `tool-${id}` });
        result.toolResults.push({
            run,
            toolId: `tool-${id}`,
            body: { ok: true, operation: name, workflow: { workflowId: "workflow" } },
        });
    };
    const http = (phase: string, kind: string, endpoint: string) =>
        result.http.push({
            phase,
            kind,
            status: 200,
            method: endpoint === "conversation" ? "GET" : "POST",
            actionId: phase.startsWith("plan")
                ? `plan-round-${phase === "plan-feedback" ? 2 : phase === "plan-approved" ? 3 : 1}`
                : `code-round-${phase === "code-approved" ? 2 : 1}`,
            url: `http://127.0.0.1:12345/api/review/${endpoint}?token=local`,
        });
    const savePlan = (status: string) =>
        putFile(current, PLAN, `---\nplanId: plan-id\nstatus: ${status}\n---\n# Feature\n`);
    const saveController = () =>
        putFile(current, CONTROLLER, { version: 1, planId: "plan-id", planName: "feature", state });
    for (const phase of PHASES) {
        current = structuredClone(current);
        const index = PHASES.indexOf(phase);
        current.hostRun =
            index < PHASES.indexOf("activated")
                ? phase
                : index < PHASES.indexOf("plan-restored")
                  ? "request"
                  : index < PHASES.indexOf("disabled")
                    ? "plan-restored"
                    : index < PHASES.indexOf("ci-started")
                      ? phase
                      : index < PHASES.indexOf("ci-resumed")
                        ? "validate"
                        : phase === "inactive-after"
                          ? phase
                          : "ci-resumed";
        if (phase === "stale-adapter") {
            result.tools.push({ run: phase, toolId: "stale-tool", operation: "activate", operationId: "stale-id" });
            result.toolResults.push({
                run: phase,
                toolId: "stale-tool",
                body: { ok: false, rejection: { code: "incompatible_adapter" } },
            });
        }
        if (phase === "installed")
            result.plugins.push(
                { phase, args: ["plugin", "marketplace", "add", "local-marketplace"], exitCode: 0 },
                { phase, args: ["plugin", "install", "runwield@runwield", "--scope", "local"], exitCode: 0 },
            );
        if (phase === "activated") operation("activate");
        if (phase === "triaged") {
            workflow.state = "awaiting_planning";
            workflow.triageOutcome = { workKind: "FEATURE" };
            operation("triage_report");
        }
        if (phase === "plan-review") {
            workflow.state = "awaiting_review";
            workflow.review = { round: 1, actionId: "plan-round-1", status: "pending" };
            savePlan("draft");
            operation("plan_written");
        }
        if (phase === "plan-chat") {
            workflow.review = {
                round: 1,
                actionId: "plan-round-1",
                status: "pending",
                chat: { turns: [{ turnId: "plan-turn", reply: "Answer" }] },
            };
            operation("review_reply");
            http(phase, "question", "deny");
        }
        if (phase === "plan-change") {
            workflow.review = { round: 2, actionId: "plan-round-2", status: "pending" };
            operation("plan_written");
            http(phase, "change", "deny");
        }
        if (phase === "plan-feedback") {
            workflow.review = { round: 3, actionId: "plan-round-3", status: "pending" };
            operation("plan_written");
            http(phase, "feedback", "deny");
            http(phase, "liveness", "conversation");
        }
        if (phase === "plan-killed") {
            result.processes.push({ phase: "request", event: "start", runId: "request", pid: 42 });
            result.processes.push({ phase, event: "exit", runId: "request", pid: 42, signal: "SIGKILL" });
            result.http.push({
                phase,
                kind: "liveness",
                status: null,
                errorCode: "ECONNREFUSED",
                url: "http://127.0.0.1:12345/api/review/conversation?token=local",
            });
        }
        if (phase === "plan-restored") {
            result.processes.push({ phase, event: "start", runId: "plan-restored", pid: 44 });
            result.tools.push({
                run: "plan-restored",
                toolId: "restore-status",
                operation: "status",
                operationId: null,
            });
        }
        if (phase === "plan-restored")
            result.toolResults.push({
                run: "plan-restored",
                toolId: "restore-status",
                body: { ok: true, operation: "status", workflow: { workflowId: "workflow" } },
            });
        if (phase === "plan-approved") {
            workflow.state = "plan_ready";
            savePlan("approved");
            http(phase, "approve", "decision");
        }
        if (phase === "implemented") {
            operation("start_execution");
            operation("task_completed");
            workflow.state = "implemented";
            workflow.execution = {
                executionMode: "worktree",
                executionCwd: "/throwaway/execution",
                worktreeId: "wt-1",
                worktreeBranch: "runwield/feature",
                baselineTree: INITIAL_COMMIT,
            };
            state.implementedAt = "2026-10-07T12:00:00Z";
            savePlan("implemented");
            putFile(current, "fixture/.wld/internal/worktrees.json", {
                version: 2,
                entries: [
                    {
                        id: "wt-1",
                        planId: "plan-id",
                        planName: "feature",
                        path: "/throwaway/execution",
                        branch: "runwield/feature",
                        executionBaselineTree: INITIAL_COMMIT,
                        status: "completed",
                    },
                ],
            });
        }
        if (phase === "disabled" || phase === "uninstalled" || phase === "reinstalled")
            result.plugins.push({
                phase,
                args: [
                    "plugin",
                    phase === "disabled" ? "disable" : phase === "uninstalled" ? "uninstall" : "install",
                    "runwield@runwield",
                ],
                exitCode: 0,
            });
        if (phase === "ci-started") {
            current.ciRuns = ["101"];
            workflow.state = "validating";
            workflow.validation = { operationId: "interrupted-ci", operation: "start_validation", evidence: host };
            result.tools.push({
                run: "validate",
                toolId: "tool-interrupted-ci",
                operation: "start_validation",
                operationId: "interrupted-ci",
            });
        }
        if (phase === "ci-killed") {
            result.processes.push({ phase: "validate", event: "start", runId: "validate", pid: 43 });
            result.processes.push({ phase, event: "exit", runId: "validate", pid: 43, signal: "SIGKILL" });
            result.processes.push({ phase, event: "ci-held", runId: "validate", ciPid: 101 });
        }
        if (phase === "ci-resumed") {
            result.processes.push({ phase, event: "start", runId: "ci-resumed", pid: 45 });
            current.ciRuns = ["101", "102"];
            current.ciFinished = ["102"];
            operation("start_validation");
            accepted["interrupted-ci"] = structuredClone(Object.values(accepted).at(-1)!);
            workflow.validation = { actionId: "reviewer-1", request: { kind: "reviewer" } };
            putFile(current, "fixture/.wld/internal/delivery-evidence/feature/wt-1/ci-1.json", {
                version: 1,
                kind: "ci",
                outcome: "Exit 0",
            });
        }
        if (phase === "review-blocked") {
            state.validationCheckpoint = {
                reviewState: { reviewLedger: { items: [{ id: "R1-1", status: "new", openedInRound: 1 }] } },
            };
            workflow.validation = { actionId: "repair-1", request: { kind: "repair" } };
            putFile(current, "fixture/.wld/internal/delivery-evidence/feature/wt-1/ai-1.json", {
                version: 1,
                kind: "ai",
                outcome: "Changes requested",
            });
        }
        if (phase === "code-review") {
            current.ciRuns = ["101", "102", "103"];
            current.ciFinished = ["102", "103"];
            state.validationCheckpoint = {
                reviewState: {
                    reviewLedger: {
                        items: [{ id: "R1-1", status: "fix_confirmed", openedInRound: 1, resolvedInRound: 2 }],
                    },
                },
            };
            workflow.validation = { actionId: "code-round-1", request: codeRequest };
            operation("task_completed");
            operation("review_complete");
            putFile(current, "fixture/.wld/internal/delivery-evidence/feature/wt-1/ai-2.json", {
                version: 1,
                kind: "ai",
                outcome: "Approved",
            });
        }
        if (phase === "code-chat") {
            workflow.revision = 19;
            workflow.validation = {
                actionId: "code-round-1",
                request: codeRequest,
                chat: { turns: [{ turnId: "code-turn", reply: "Answer" }] },
            };
            operation("review_reply");
            http(phase, "question", "deny");
        }
        if (phase === "code-change") {
            // Core dispatches this public reply through validation_decision. The durable
            // result is the repair request, not the later task_completed result.
            const id = "code-change-reply";
            const repairRequest: JsonMap = {
                kind: "repair",
                identity: { attemptId: "wt-1", generation: "repair-1", repairGeneration: "repair-1" },
                repairGeneration: "repair-1",
                prompt: "Repair: Export value 3.",
            };
            const replyResult: JsonMap = {
                ok: true,
                operation: "review_reply",
                workflow: {
                    workflowId: "workflow",
                    revision: 22,
                    state: "validating",
                    execution: workflow.execution,
                    nextAction: { kind: "validation", actionId: "repair-2", request: repairRequest },
                },
                reviewReply: { turnId: "code-change-turn", text: "I will change it." },
            };
            const durableResult = structuredClone(replyResult);
            durableResult.operation = "validation_decision";
            delete durableResult.reviewReply;
            accepted[id] = { result: durableResult, evidence: { ...carrierEvidence, coreVersion: host.coreVersion } };
            result.tools.push({
                run: current.hostRun!,
                toolId: `tool-${id}`,
                operation: "review_reply",
                operationId: id,
                input: {
                    operationId: id,
                    workflowId: "workflow",
                    expectedRevision: 20,
                    payload: {
                        turnId: "code-change-turn",
                        text: "I will change it.",
                        change: { summary: "Export value 3." },
                    },
                },
            });
            result.toolResults.push({ run: current.hostRun!, toolId: `tool-${id}`, body: replyResult });
            workflow.revision = 24;
            const revisedRequest = structuredClone(codeRequest);
            (revisedRequest.identity as JsonMap).key = "candidate-2:2";
            workflow.validation = { actionId: "code-round-2", request: revisedRequest };
            workflow.state = "validating";
            const checkpoint = state.validationCheckpoint as JsonMap;
            checkpoint.attemptId = "wt-1";
            checkpoint.generation = "validation-1";
            checkpoint.pendingHostDecision = revisedRequest;
            putFile(current, "fixture/.wld/internal/delivery-evidence/feature/wt-1/ci-3.json", {
                version: 1,
                kind: "ci",
                outcome: "Exit 0",
            });
            current.ciRuns = ["101", "102", "103", "104"];
            current.ciFinished = ["102", "103", "104"];
            operation("task_completed");
            http(phase, "change", "deny");
            result.http.at(-1)!.request = { conversationTurn: true, feedback: "Export value 3.", reviewRevision: 0 };
        }
        if (phase === "code-approved") {
            const id = "browser-code-approval";
            const request: JsonMap = {
                kind: "recorder",
                identity: { attemptId: "wt-1", generation: "validation-1:recorder:record-1:0" },
                prompt: "Write the Work Record.",
                cwd: "/throwaway/execution",
            };
            workflow.revision = 26;
            workflow.validation = { actionId: "recorder-1", request };
            accepted[id] = {
                evidence: host,
                result: {
                    ok: true,
                    operation: "validation_decision",
                    workflow: {
                        workflowId: "workflow",
                        state: "validating",
                        revision: 26,
                        execution: workflow.execution,
                        nextAction: { kind: "recorder", actionId: "recorder-1", request },
                    },
                },
            };
            const checkpoint = state.validationCheckpoint as JsonMap;
            delete checkpoint.pendingHostDecision;
            checkpoint.hostDecisionChoices = { "candidate-2": { outcome: "approved" } };
            http(phase, "approve", "decision");
            result.http.at(-1)!.request = { approved: true, reviewRevision: 2 };
            result.http.at(-1)!.response = {
                ok: true,
                operationId: id,
                workflowId: "workflow",
                actionId: "code-round-2",
                attemptId: "wt-1",
                generation: "validation-1",
                decisionKey: "candidate-2:2",
            };
        }
        if (phase === "delivered") {
            workflow.state = "closed";
            workflow.closure = {
                reason: "delivered",
                workRecord: { status: "generated", recordId: "record-1", path: "docs/work-records/feature.md" },
            };
            state.verifiedAt = "2026-10-07T12:00:00Z";
            state.publicationReceipt = {
                validatedCommit: INITIAL_COMMIT,
                publishedCommit: PUBLISHED_COMMIT,
                targetBranch: "main",
            };
            savePlan("verified");
            putFile(
                current,
                WORK_RECORD,
                "---\nkind: work_record\nrecordId: record-1\nstatus: approved\ncompletionMode: verified\nprovenance:\n    sourcePlans: [plan-id]\n---\n# Record\n",
            );
            const operations = [
                "plan_event:readiness_passed",
                "plan_review_feedback",
                "plan_review_approved",
                "plan_event:execution_started",
                "plan_event:implementation_finished",
                "plan_event:mechanical_validation_passed",
                "plan_event:semantic_review_feedback",
                "plan_event:semantic_review_passed",
                "plan_event:validation_passed",
            ];
            putFile(
                current,
                "runwield-home/.wld/workflow-metrics/project/metrics.jsonl",
                operations
                    .map((operation) =>
                        JSON.stringify({
                            planName: "feature",
                            event: "plan_transition_committed",
                            details: { operation },
                        }),
                    )
                    .join("\n"),
            );
            current.git = {
                branch: "main",
                head: PUBLISHED_COMMIT,
                status: "",
                refs: { "refs/heads/main": PUBLISHED_COMMIT },
                parents: { [PUBLISHED_COMMIT]: [INITIAL_COMMIT], [INITIAL_COMMIT]: [] },
            };
        }
        if (PHASES.indexOf(phase) >= PHASES.indexOf("activated")) putFile(current, RECORD, workflow);
        if (PHASES.indexOf(phase) >= PHASES.indexOf("implemented")) saveController();
        if (phase === "delivered" || phase === "inactive-after") {
            for (const path of [PLAN, WORK_RECORD]) {
                const file = current.files.find((file) => file.path === path)!;
                putFile(current, `published/${PUBLISHED_COMMIT}/${path.replace(/^fixture\//, "")}`, file.text!);
            }
        }
        result.snapshots[phase] = structuredClone(current);
    }
    return result;
}

/** Keep actual Core receipts and operation IDs intact. Other journey checks are not under test here. */
export function coreProvenanceEvidence(before: JsonMap, after: JsonMap, operationId: string): AcceptanceEvidence {
    const evidence = completeEvidence();
    evidence.snapshots = {};
    evidence.tools = [];
    evidence.toolResults = [];
    evidence.http = [];
    evidence.hostRuns = ["core-contract"];
    for (const phase of ["activated", "code-chat", "code-change"] as const) {
        const record = structuredClone(phase === "code-change" ? after : before);
        record.acceptedOperations =
            phase === "code-change" ? { [operationId]: field(after, "acceptedOperations", operationId) } : {};
        const saved: Snapshot = {
            hostRun: "core-contract",
            files: [],
            git: null,
            ciRuns: [],
            ciFinished: [],
            errors: [],
        };
        putFile(saved, `runwield-home/.wld/attached/project/workflows/${record.workflowId}.json`, record);
        evidence.snapshots[phase] = saved;
    }
    return evidence;
}
