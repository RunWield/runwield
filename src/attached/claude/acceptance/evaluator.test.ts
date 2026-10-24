import { test } from "node:test";
import { mkdtemp, mkdir, rename, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommittedGitFixture } from "../../../shared/git-test-fixture.ts";
import { collectEvidence } from "./collector.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../../testing/assertions.ts";
import { evaluateEvidence } from "./evaluator.ts";
import {
    PHASES,
    field,
    jsonMap,
    type AcceptanceEvidence,
    type JsonMap,
    type Phase,
    type Snapshot,
} from "./evidence.ts";
import { attachedValidationFixture } from "../../../shared/attached/validation-test-fixture.ts";
import { toDelivery } from "../../../shared/attached/delivery-test-fixture.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "../../../shared/attached/review-host.ts";
import { NO_OPEN_BROWSER_PORT } from "../../../shared/browser-port.ts";
import { pendingChat, reply, sendChat, reviewApi } from "../../../shared/attached/review-chat-test-fixture.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "../../../shared/attached/record-store.ts";
import { withProcessGlobalTestLock } from "../../../testing/process-global-lock.ts";
import {
    completeEvidence,
    coreProvenanceEvidence,
    editJson,
    putFile,
    RECORD,
    CONTROLLER,
    PLAN,
    WORK_RECORD,
} from "./evidence-test-fixture.ts";

function snapshot(evidence: AcceptanceEvidence, phase: Phase): Snapshot {
    const result = evidence.snapshots[phase];
    assert(result);
    return result;
}

test("complete durable observations pass all 16 steps and produce a privacy-safe matrix proposal", () => {
    const result = evaluateEvidence(completeEvidence());
    assertEquals(
        result.checks.filter((row) => row.outcome !== "pass"),
        [],
    );
    assertEquals(result.outcome, "pass");
    assertEquals(result.checks.filter((row) => /^step-\d+/.test(row.id)).length, 16);
    assertEquals(result.proposedMatrixEntry?.version, "2.1.303");
    assertEquals(result.provenance.acceptedOperations, result.provenance.matchedOperations);
    assert(result.provenance.acceptedOperations > 0);
});

interface MissingProof {
    name: string;
    check: string;
    change: (evidence: AcceptanceEvidence) => void;
}
const cases: MissingProof[] = [
    {
        name: "recovery drops the original receipt",
        check: "operation-provenance",
        change: (e) => {
            for (const phase of PHASES.slice(PHASES.indexOf("ci-resumed")))
                editJson(snapshot(e, phase), RECORD, (row) => {
                    delete (row.acceptedOperations as JsonMap)["interrupted-ci"];
                });
        },
    },
    {
        name: "original receipt appears only after the recovery checkpoint",
        check: "operation-provenance",
        change: (e) => {
            editJson(snapshot(e, "ci-resumed"), RECORD, (row) => {
                delete (row.acceptedOperations as JsonMap)["interrupted-ci"];
            });
        },
    },
    {
        name: "Core source changes during acceptance",
        check: "core-source",
        change: (e) => {
            e.metadata.coreSourceDigestAfter = "e".repeat(64);
        },
    },
    {
        name: "HEAD without a source fingerprint",
        check: "core-source",
        change: (e) => {
            delete e.metadata.coreSourceDigest;
        },
    },
    {
        name: "CI had already completed before the kill",
        check: "step-10-ci-and-resume",
        change: (e) => {
            snapshot(e, "ci-killed").ciFinished = [...snapshot(e, "ci-killed").ciRuns!];
        },
    },
    {
        name: "no held CI process at interruption",
        check: "step-10-ci-and-resume",
        change: (e) => {
            e.processes = e.processes.filter((row) => row.event !== "ci-held");
        },
    },
    {
        name: "recovered receipt without the original tool use",
        check: "operation-provenance",
        change: (e) => {
            e.tools = e.tools.filter((tool) => tool.operationId !== "interrupted-ci");
        },
    },
    {
        name: "recovered receipt without a durable interrupted operation",
        check: "operation-provenance",
        change: (e) => {
            editJson(snapshot(e, "ci-killed"), RECORD, (row) => {
                delete (row.validation as JsonMap).operationId;
            });
        },
    },
    {
        name: "recovery receipt changed its outcome",
        check: "operation-provenance",
        change: (e) => {
            editJson(snapshot(e, "ci-resumed"), RECORD, (row) => {
                const receipt = (row.acceptedOperations as JsonMap)["interrupted-ci"] as JsonMap;
                (receipt.result as JsonMap).ok = false;
            });
        },
    },

    {
        name: "lifecycle metrics belong to another Plan",
        check: "lifecycle-events",
        change: (e) => {
            const file = snapshot(e, "delivered").files.find((file) => file.path.endsWith("metrics.jsonl"))!;
            putFile(
                snapshot(e, "delivered"),
                file.path,
                file.text!.replaceAll('"planName":"feature"', '"planName":"other"'),
            );
        },
    },
    {
        name: "killed process belongs to a different host run",
        check: "step-15-interruptions",
        change: (e) => {
            for (const row of e.processes) if (row.pid === 42) row.runId = "validate";
        },
    },
    {
        name: "restore tool use has no successful Core response",
        check: "step-15-interruptions",
        change: (e) => {
            e.toolResults = e.toolResults.filter((row) => row.toolId !== "restore-status");
        },
    },

    {
        name: "controller belongs to another Plan",
        check: "step-09-implementation",
        change: (e) => {
            editJson(snapshot(e, "implemented"), CONTROLLER, (value) => {
                value.planId = "other-plan";
            });
        },
    },
    {
        name: "CI receipt belongs to another attempt",
        check: "step-10-ci-and-resume",
        change: (e) => {
            for (const file of snapshot(e, "ci-resumed").files)
                if (file.path.includes("/delivery-evidence/"))
                    file.path = file.path.replace("/wt-1/", "/other-attempt/");
        },
    },
    {
        name: "worktree registry has only an ID",
        check: "step-08-isolated-execution",
        change: (e) => {
            putFile(snapshot(e, "implemented"), "fixture/.wld/internal/worktrees.json", {
                version: 2,
                entries: [{ id: "wt-1" }],
            });
        },
    },
    {
        name: "operation assigned to a different host run",
        check: "operation-provenance",
        change: (e) => {
            e.tools.find((tool) => tool.operation === "task_completed")!.run = "other-run";
        },
    },
    {
        name: "accepted tool response has a different call ID",
        check: "operation-provenance",
        change: (e) => {
            e.toolResults.find((row) => row.run === "request")!.toolId = "other-tool";
        },
    },
    {
        name: "kill PID does not match a process start",
        check: "step-15-interruptions",
        change: (e) => {
            e.processes.find((row) => row.phase === "plan-killed" && row.event === "exit")!.pid = 999;
        },
    },
    {
        name: "no fresh restored Plan session",
        check: "step-15-interruptions",
        change: (e) => {
            e.processes = e.processes.filter((row) => row.phase !== "plan-restored");
        },
    },
    {
        name: "no published Plan document",
        check: "step-13-publication",
        change: (e) => {
            for (const phase of ["delivered", "inactive-after"] as const)
                snapshot(e, phase).files = snapshot(e, phase).files.filter(
                    (file) => !file.path.endsWith("/docs/plans/feature.md"),
                );
        },
    },
    {
        name: "CI marker predates validation",
        check: "step-10-ci-and-resume",
        change: (e) => {
            snapshot(e, "reinstalled").ciRuns = [...snapshot(e, "ci-started").ciRuns!];
        },
    },

    {
        name: "HTTP response belongs to a different review round",
        check: "step-06-plan-review-and-chat",
        change: (e) => {
            e.http.find((row) => row.phase === "plan-change")!.actionId = "other-round";
        },
    },
    {
        name: "code change still needs repair",
        check: "step-12-code-review-and-chat",
        change: (e) => {
            editJson(snapshot(e, "code-change"), RECORD, (value) => {
                jsonMap(value.validation)!.request = { kind: "repair" };
            });
        },
    },
    {
        name: "code change reuses an older CI pass receipt",
        check: "step-12-code-review-and-chat",
        change: (e) => {
            snapshot(e, "code-change").files = snapshot(e, "code-change").files.filter(
                (file) => !file.path.endsWith("/ci-3.json"),
            );
        },
    },
    {
        name: "no repair worker completion after finding",
        check: "step-11-finding-repair-rereview",
        change: (e) => {
            editJson(snapshot(e, "code-review"), RECORD, (value) => {
                const accepted = jsonMap(value.acceptedOperations)!;
                const last = Object.keys(accepted)
                    .filter((id) => id.startsWith("task_completed"))
                    .at(-1)!;
                delete accepted[last];
            });
        },
    },
    {
        name: "receipt host version differs in an earlier snapshot",
        check: "host-version",
        change: (e) => {
            editJson(snapshot(e, "triaged"), RECORD, (value) => {
                const receipts = jsonMap(value.acceptedOperations)!;
                const receipt = jsonMap(Object.values(receipts)[0])!;
                jsonMap(receipt.evidence)!.hostVersion = "1.0.0";
            });
        },
    },
    {
        name: "workflow replaced during restore",
        check: "workflow-identity",
        change: (e) => {
            editJson(snapshot(e, "plan-restored"), RECORD, (value) => {
                value.workflowId = "other-workflow";
            });
        },
    },
    {
        name: "provider log unreadable",
        check: "no-core-model-calls",
        change: (e) => {
            e.errors.push("proxy-sink.log: unreadable log");
        },
    },
    {
        name: "ordinary use changes a Core file",
        check: "inactive-before",
        change: (e) => {
            putFile(snapshot(e, "inactive-before"), "runwield-home/extra.json", { changed: true });
        },
    },

    {
        name: "ordinary host run absent",
        check: "evidence-readable",
        change: (e) => {
            e.hostRuns = e.hostRuns.filter((run) => run !== "inactive-before");
        },
    },
    {
        name: "ordinary prompt did not finish successfully",
        check: "inactive-before",
        change: (e) => {
            e.hostResults = e.hostResults.filter((row) => row.run !== "inactive-before");
        },
    },
    {
        name: "stale rejection from a different tool call",
        check: "stale-adapter",
        change: (e) => {
            e.toolResults[0].toolId = "unmatched";
        },
    },
    {
        name: "driver claim without a real stale tool result",
        check: "stale-adapter",
        change: (e) => {
            e.toolResults = [];
            e.processes.push({ phase: "stale-adapter", result: { rejection: { code: "incompatible_adapter" } } });
        },
    },

    {
        name: "Work Record absent",
        check: "step-14-work-record",
        change: (e) => {
            snapshot(e, "delivered").files = snapshot(e, "delivered").files.filter(
                (file) => !file.path.endsWith("/docs/work-records/feature.md"),
            );
        },
    },
    {
        name: "Plan not effectively verified",
        check: "step-13-publication",
        change: (e) => {
            putFile(snapshot(e, "delivered"), PLAN, "---\nplanId: plan-id\nstatus: implemented\n---\n# Plan\n");
            editJson(snapshot(e, "delivered"), CONTROLLER, (value) => {
                const state = jsonMap(value.state)!;
                delete state.verifiedAt;
                delete state.publicationReceipt;
            });
        },
    },
    {
        name: "duplicate CI after resume",
        check: "step-10-ci-and-resume",
        change: (e) => {
            snapshot(e, "ci-resumed").ciRuns!.push("duplicate");
        },
    },
    {
        name: "record created by stale adapter",
        check: "stale-adapter",
        change: (e) => {
            const record = snapshot(e, "activated").files.find((file) => file.path === RECORD)!;
            snapshot(e, "stale-adapter").files.push(record);
        },
    },
    {
        name: "ordinary prompt uses a RunWield tool before activation",
        check: "inactive-before",
        change: (e) => {
            e.tools.push({ run: "inactive-before", toolId: "ordinary", operation: "status", operationId: null });
        },
    },
    {
        name: "ordinary prompt uses a RunWield tool after delivery",
        check: "step-16-inactive-after",
        change: (e) => {
            e.tools.push({ run: "inactive-after", toolId: "ordinary", operation: "status", operationId: null });
        },
    },
    {
        name: "invoking branch changed",
        check: "invoking-branch",
        change: (e) => {
            snapshot(e, "implemented").git!.branch = "other";
        },
    },
    {
        name: "review URL survives the kill",
        check: "step-15-interruptions",
        change: (e) => {
            const row = e.http.find((row) => row.phase === "plan-killed")!;
            row.status = 200;
            row.errorCode = null;
        },
    },
    {
        name: "connection probe checked a different URL",
        check: "step-15-interruptions",
        change: (e) => {
            e.http.find((row) => row.phase === "plan-killed")!.url = "http://127.0.0.1:23456/other";
        },
    },
    {
        name: "accepted operation has no matching tool use",
        check: "operation-provenance",
        change: (e) => {
            e.tools = e.tools.filter((tool) => tool.operation !== "activate");
        },
    },
    {
        name: "operation ID matches but tool name does not",
        check: "operation-provenance",
        change: (e) => {
            e.tools.find((tool) => tool.run === "request" && tool.operation === "activate")!.operation =
                "triage_report";
        },
    },
    {
        name: "host version differs from CLI",
        check: "host-version",
        change: (e) => {
            editJson(snapshot(e, "activated"), RECORD, (value) => {
                jsonMap(value.evidence)!.hostVersion = "2.1.1";
            });
        },
    },
    {
        name: "unreported host assessment",
        check: "host-version",
        change: (e) => {
            editJson(snapshot(e, "activated"), RECORD, (value) => {
                jsonMap(value.evidence)!.compatibility = { status: "version_not_reported" };
            });
        },
    },
    {
        name: "finding only claimed fixed",
        check: "step-11-finding-repair-rereview",
        change: (e) => {
            editJson(snapshot(e, "code-review"), CONTROLLER, (value) => {
                value.state = {
                    validationCheckpoint: {
                        reviewState: {
                            reviewLedger: {
                                items: [{ id: "R1-1", status: "fix_claimed", openedInRound: 1, resolvedInRound: 2 }],
                            },
                        },
                    },
                };
            });
        },
    },
    {
        name: "repair resolves a different finding ID",
        check: "step-11-finding-repair-rereview",
        change: (e) => {
            editJson(snapshot(e, "code-review"), CONTROLLER, (value) => {
                value.state = {
                    validationCheckpoint: {
                        reviewState: {
                            reviewLedger: {
                                items: [{ id: "other", status: "fix_confirmed", openedInRound: 1, resolvedInRound: 2 }],
                            },
                        },
                    },
                };
            });
        },
    },
    {
        name: "publication commit not on target branch",
        check: "step-13-publication",
        change: (e) => {
            snapshot(e, "delivered").git!.refs["refs/heads/main"] = "unpublished";
        },
    },
    {
        name: "no review HTTP traffic",
        check: "step-06-plan-review-and-chat",
        change: (e) => {
            e.http = [];
        },
    },
    {
        name: "mutating shim argv",
        check: "read-only-driver",
        change: (e) => {
            e.shimArgv.push(["attached", "task-completed"]);
        },
    },
    {
        name: "Core model subprocess",
        check: "no-core-model-calls",
        change: (e) => {
            e.modelProcesses.push("claude");
        },
    },
    {
        name: "Core model proxy request",
        check: "no-core-model-calls",
        change: (e) => {
            e.proxyHosts.push("api.anthropic.com");
        },
    },
    {
        name: "sentinel leak",
        check: "sentinel-absence",
        change: (e) => {
            e.privacy.leaks.push("fixture/docs/work-records/record.md");
        },
    },
    {
        name: "privacy could not inspect a file",
        check: "sentinel-absence",
        change: (e) => {
            e.privacy.errors.push("unreadable database");
        },
    },
    {
        name: "permissions not disclosed",
        check: "run-identity",
        change: (e) => {
            delete e.metadata.permissions;
        },
    },
    {
        name: "metrics missing",
        check: "lifecycle-events",
        change: (e) => {
            snapshot(e, "delivered").files = snapshot(e, "delivered").files.filter(
                (file) => !file.path.endsWith("metrics.jsonl"),
            );
        },
    },
];
for (const scenario of cases)
    test(`fails closed: ${scenario.name}`, () => {
        const evidence = completeEvidence();
        scenario.change(evidence);
        const result = evaluateEvidence(evidence);
        assertEquals(result.checks.find((row) => row.id === scenario.check)?.outcome, "fail");
        assertEquals(result.outcome, "fail");
        assertEquals(result.proposedMatrixEntry, null);
    });

for (const phase of PHASES)
    test(`missing ${phase} snapshot cannot pass`, () => {
        const evidence = completeEvidence();
        delete evidence.snapshots[phase];
        const result = evaluateEvidence(evidence);
        assertEquals(result.outcome, "fail");
        assertEquals(result.checks.find((row) => row.id === "evidence-readable")?.outcome, "fail");
    });

test("publication authority can verify a Plan whose invoking document is not updated", () => {
    const evidence = completeEvidence();
    for (const phase of ["delivered", "inactive-after"] as const) {
        for (const file of [...snapshot(evidence, phase).files]) {
            if (file.path.endsWith("/docs/plans/feature.md"))
                putFile(snapshot(evidence, phase), file.path, "---\nplanId: plan-id\nstatus: reviewed\n---\n# Plan\n");
        }
    }
    assertEquals(evaluateEvidence(evidence).outcome, "pass");
});

test("summary contains no raw prompts, chat, source, tokens, sentinel, or absolute home paths", () => {
    const evidence = completeEvidence();
    const secret = "private-sentinel /Users/private/home raw conversation";
    editJson(snapshot(evidence, "activated"), RECORD, (value) => {
        jsonMap(value.request)!.text = secret;
        value.projectRoot = secret;
    });
    evidence.http.push({ phase: "code-chat", request: secret, response: secret, url: secret });
    evidence.errors.push(secret);
    evidence.privacy.leaks.push(secret);
    const serialized = JSON.stringify(evaluateEvidence(evidence));
    assertEquals(serialized.includes(secret), false);
    assertEquals(serialized.includes("token=local"), false);
});

test("delivery can prove canonical documents that exist only on the published branch", () => {
    const evidence = completeEvidence();
    for (const phase of ["delivered", "inactive-after"] as const) {
        snapshot(evidence, phase).files = snapshot(evidence, phase).files.filter(
            (file) => file.path !== PLAN && file.path !== WORK_RECORD,
        );
    }
    assertEquals(evaluateEvidence(evidence).outcome, "pass");
});

interface ReplyProofMutation {
    name: string;
    change: (evidence: AcceptanceEvidence) => void;
}
function changeReceipt(evidence: AcceptanceEvidence, edit: (receipt: JsonMap) => void): void {
    for (const phase of PHASES.slice(PHASES.indexOf("code-change")))
        editJson(snapshot(evidence, phase), RECORD, (record) => {
            edit(jsonMap(field(record, "acceptedOperations", "code-change-reply"))!);
        });
}
function changeProvenResult(evidence: AcceptanceEvidence, edit: (result: JsonMap) => void): void {
    changeReceipt(evidence, (row) => edit(jsonMap(row.result)!));
    edit(jsonMap(evidence.toolResults.find((row) => row.toolId === "tool-code-change-reply")!.body)!);
}
const replyProofMutations: ReplyProofMutation[] = [
    {
        name: "superseded source round",
        change: (e) => {
            editJson(snapshot(e, "code-chat"), RECORD, (row) => {
                row.revision = 10;
            });
        },
    },
    {
        name: "wrong host run",
        change: (e) => {
            e.tools.find((tool) => tool.operationId === "code-change-reply")!.run = "other-run";
        },
    },
    {
        name: "unrecorded host run",
        change: (e) => {
            e.hostRuns = e.hostRuns.filter((run) => run !== "ci-resumed");
        },
    },
    {
        name: "receipt before the change phase",
        change: (e) => {
            const saved = jsonMap(
                JSON.parse(snapshot(e, "code-change").files.find((file) => file.path === RECORD)!.text!),
            )!;
            editJson(snapshot(e, "review-blocked"), RECORD, (row) => {
                jsonMap(row.acceptedOperations)!["code-change-reply"] = field(
                    saved,
                    "acceptedOperations",
                    "code-change-reply",
                );
            });
        },
    },
    {
        name: "forged carrier evidence",
        change: (e) => {
            changeReceipt(e, (row) => {
                jsonMap(row.evidence)!.hostVersion = "forged";
            });
        },
    },
    {
        name: "wrong durable phase",
        change: (e) => {
            changeProvenResult(e, (result) => {
                jsonMap(result.workflow)!.state = "closed";
            });
        },
    },
    {
        name: "missing host call",
        change: (e) => {
            e.tools = e.tools.filter((tool) => tool.operationId !== "code-change-reply");
        },
    },
    {
        name: "missing host response",
        change: (e) => {
            e.toolResults = e.toolResults.filter((row) => row.toolId !== "tool-code-change-reply");
        },
    },
    {
        name: "missing MCP arguments",
        change: (e) => {
            delete e.tools.find((tool) => tool.operationId === "code-change-reply")!.input;
        },
    },
    {
        name: "forged operation ID",
        change: (e) => {
            e.tools.find((tool) => tool.operationId === "code-change-reply")!.input!.operationId = "forged";
        },
    },
    {
        name: "forged workflow ID",
        change: (e) => {
            e.tools.find((tool) => tool.operationId === "code-change-reply")!.input!.workflowId = "forged";
        },
    },
    {
        name: "wrong source revision",
        change: (e) => {
            e.tools.find((tool) => tool.operationId === "code-change-reply")!.input!.expectedRevision = 21;
        },
    },
    {
        name: "wrong turn ID",
        change: (e) => {
            jsonMap(e.tools.find((tool) => tool.operationId === "code-change-reply")!.input!.payload)!.turnId =
                "forged";
        },
    },
    {
        name: "no code change",
        change: (e) => {
            delete jsonMap(e.tools.find((tool) => tool.operationId === "code-change-reply")!.input!.payload)!.change;
        },
    },
    {
        name: "missing HTTP request",
        change: (e) => {
            e.http = e.http.filter((row) => row.phase !== "code-change");
        },
    },
    {
        name: "wrong HTTP action",
        change: (e) => {
            e.http.find((row) => row.phase === "code-change")!.actionId = "other";
        },
    },
    {
        name: "HTTP failure",
        change: (e) => {
            e.http.find((row) => row.phase === "code-change")!.status = 409;
        },
    },
    {
        name: "HTTP read instead of change",
        change: (e) => {
            e.http.find((row) => row.phase === "code-change")!.method = "GET";
        },
    },
    {
        name: "missing authenticated listener",
        change: (e) => {
            e.http.find((row) => row.phase === "code-change")!.url = "http://127.0.0.1:12345/api/review/deny";
        },
    },
    {
        name: "wrong HTTP endpoint",
        change: (e) => {
            e.http.find((row) => row.phase === "code-change")!.url =
                "http://127.0.0.1:12345/api/review/deny-forged?token=local";
        },
    },
    {
        name: "structured feedback instead of chat",
        change: (e) => {
            jsonMap(e.http.find((row) => row.phase === "code-change")!.request)!.conversationTurn = false;
        },
    },
    {
        name: "wrong result outcome",
        change: (e) => {
            changeProvenResult(e, (result) => {
                result.ok = false;
            });
        },
    },
    {
        name: "wrong result kind",
        change: (e) => {
            changeProvenResult(e, (result) => {
                jsonMap(field(result, "workflow", "nextAction", "request"))!.kind = "reviewer";
            });
        },
    },
    {
        name: "wrong attempt",
        change: (e) => {
            changeProvenResult(e, (result) => {
                jsonMap(field(result, "workflow", "nextAction", "request", "identity"))!.attemptId = "other";
            });
        },
    },
    {
        name: "forged durable workflow",
        change: (e) => {
            changeProvenResult(e, (result) => {
                jsonMap(field(result, "workflow"))!.workflowId = "forged";
            });
        },
    },
    {
        name: "unrelated unmatched receipt",
        change: (e) => {
            for (const phase of PHASES.slice(PHASES.indexOf("code-approved")))
                editJson(snapshot(e, phase), RECORD, (row) => {
                    const receipts = jsonMap(row.acceptedOperations)!;
                    receipts.unrelated = structuredClone(receipts["code-change-reply"]);
                });
        },
    },
];
for (const scenario of replyProofMutations)
    test(`code-change provenance rejects ${scenario.name}`, () => {
        const evidence = completeEvidence();
        scenario.change(evidence);
        assertEquals(
            evaluateEvidence(evidence).checks.find((row) => row.id === "operation-provenance")?.outcome,
            "fail",
        );
    });

test("actual Core code-change receipt matches only its public review reply", async () => {
    await withProcessGlobalTestLock(async () => {
        const fixture = await attachedValidationFixture();
        try {
            const started = await toDelivery(fixture);
            assert(started.workflow.nextAction.kind === "code_review");
            const hosted = await ensureReviewHosted(fixture.root, started.workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            await sendChat(hosted.url, "Export value 3.");
            const current = await fixture.status();
            const location = locateAttachedWorkflows(fixture.root);
            const before = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(before.status === "found");
            const operationId = crypto.randomUUID();
            const payload = {
                turnId: pendingChat(current).turnId,
                text: "I will change it.",
                change: { summary: "Export value 3." },
            };
            const changed = await reply(fixture.root, current, payload, operationId);
            assert(
                changed.ok &&
                    changed.workflow.nextAction.kind === "validation" &&
                    changed.workflow.nextAction.request.kind === "repair",
            );
            const after = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(after.status === "found");
            assertEquals(after.record.acceptedOperations[operationId].result.operation, "validation_decision");
            assertEquals(changed.operation, "review_reply");
            const beforeJson: JsonMap = JSON.parse(JSON.stringify(before.record));
            const afterJson: JsonMap = JSON.parse(JSON.stringify(after.record));
            const evidence = coreProvenanceEvidence(beforeJson, afterJson, operationId);
            evidence.tools.push({
                run: "core-contract",
                toolId: "actual-reply",
                operation: "review_reply",
                operationId,
                input: {
                    workflowId: fixture.workflowId,
                    operationId,
                    expectedRevision: current.revision,
                    payload,
                },
            });
            evidence.toolResults.push({
                run: "core-contract",
                toolId: "actual-reply",
                body: JSON.parse(JSON.stringify(changed)),
            });
            evidence.http.push({
                phase: "code-change",
                kind: "change",
                actionId: started.workflow.nextAction.actionId,
                method: "POST",
                status: 200,
                url: reviewApi(hosted.url, "deny").href,
                request: { conversationTurn: true },
            });
            assertEquals(evaluateEvidence(evidence).provenance, {
                acceptedOperations: 1,
                matchedOperations: 1,
                httpRequests: 1,
                shimCalls: 2,
            });
        } finally {
            await stopHostedAttachedReviews();
            await fixture.close();
        }
    });
});

test("collector retains review reply arguments from the actual MCP message block only", async () => {
    const root = await mkdtemp(join(tmpdir(), "acceptance-reply-provenance-"));
    const base = defineCommittedGitFixture();
    try {
        await rename(await base.checkout(), join(root, "fixture"));
        await mkdir(join(root, "runwield-home"));
        await mkdir(join(root, "logs/claude"), { recursive: true });
        const input = {
            operationId: "reply-operation",
            workflowId: "workflow",
            expectedRevision: 7,
            payload: { turnId: "turn", text: "Reply", change: { summary: "Change the value." } },
        };
        await writeFile(
            join(root, "logs/claude/request.jsonl"),
            JSON.stringify({
                type: "assistant",
                message: {
                    content: [
                        { type: "text", text: JSON.stringify({ input: { operationId: "not-a-call" } }) },
                        {
                            type: "tool_use",
                            id: "other",
                            name: "mcp__other__review_reply",
                            input: { operationId: "not-runwield" },
                        },
                        {
                            type: "tool_use",
                            id: "reply-tool",
                            name: "mcp__plugin_runwield_runwield__review_reply",
                            input,
                        },
                    ],
                },
            }) + "\n",
        );
        const evidence = await collectEvidence(root, ["private-ordinary-sentinel"]);
        assertEquals(evidence.tools, [
            { run: "request", toolId: "reply-tool", operation: "review_reply", operationId: "reply-operation", input },
        ]);
        assertEquals(JSON.stringify(evaluateEvidence(evidence)).includes("Change the value."), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("code-change provenance uses Core-stamped evidence, not model-supplied MCP evidence", () => {
    const evidence = completeEvidence();
    const tool = evidence.tools.find((row) => row.operationId === "code-change-reply");
    assert(tool?.input);
    assertEquals(tool.input.evidence, undefined);
    tool.input.evidence = { hostVersion: "model-supplied-value" };
    assertEquals(evaluateEvidence(evidence).checks.find((row) => row.id === "operation-provenance")?.outcome, "pass");
});
