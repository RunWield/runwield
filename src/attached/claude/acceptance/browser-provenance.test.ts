import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals } from "../../../testing/assertions.ts";
import { withProcessGlobalTestLock } from "../../../testing/process-global-lock.ts";
import { attachedValidationFixture } from "../../../shared/attached/validation-test-fixture.ts";
import { toDelivery } from "../../../shared/attached/delivery-test-fixture.ts";
import { ensureReviewHosted, stopHostedAttachedReviews } from "../../../shared/attached/review-host.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows } from "../../../shared/attached/record-store.ts";
import { NO_OPEN_BROWSER_PORT } from "../../../shared/browser-port.ts";
import { reviewApi } from "../../../shared/attached/review-chat-test-fixture.ts";
import { evaluateEvidence } from "./evaluator.ts";
import { ReviewPage } from "./review.ts";
import {
    PHASES,
    field,
    jsonMap,
    type AcceptanceEvidence,
    type JsonMap,
    type Phase,
    type Snapshot,
} from "./evidence.ts";
import {
    completeEvidence,
    coreProvenanceEvidence,
    editJson,
    putFile,
    RECORD,
    CONTROLLER,
} from "./evidence-test-fixture.ts";

function snapshot(evidence: AcceptanceEvidence, phase: Phase): Snapshot {
    const result = evidence.snapshots[phase];
    assert(result);
    return result;
}
interface ReplyProofMutation {
    name: string;
    change: (evidence: AcceptanceEvidence) => void;
}

function approvalReceipt(evidence: AcceptanceEvidence, edit: (row: JsonMap) => void): void {
    for (const phase of PHASES.slice(PHASES.indexOf("code-approved")))
        editJson(snapshot(evidence, phase), RECORD, (row) => {
            edit(jsonMap(field(row, "acceptedOperations", "browser-code-approval"))!);
        });
}
const approvalMutations: ReplyProofMutation[] = [
    {
        name: "missing action identity throughout observations",
        change(e) {
            editJson(snapshot(e, "code-change"), RECORD, (row) => {
                delete jsonMap(row.validation)!.actionId;
            });
            const http = e.http.find((row) => row.phase === "code-approved")!;
            delete http.actionId;
            delete jsonMap(http.response)!.actionId;
        },
    },
    ...["operationId", "actionId", "workflowId", "attemptId", "generation", "decisionKey", "ok"].map((key) => ({
        name: `wrong HTTP receipt ${key}`,
        change(e: AcceptanceEvidence) {
            jsonMap(e.http.find((row) => row.phase === "code-approved")!.response)![key] =
                key === "ok" ? false : "wrong";
        },
    })),
    ...["operationId", "actionId", "workflowId", "attemptId", "generation", "decisionKey", "ok"].map((key) => ({
        name: `missing HTTP receipt ${key}`,
        change(e: AcceptanceEvidence) {
            delete jsonMap(e.http.find((row) => row.phase === "code-approved")!.response)![key];
        },
    })),
    ...["response", "request"].map((key) => ({
        name: `missing HTTP ${key}`,
        change(e: AcceptanceEvidence) {
            delete e.http.find((row) => row.phase === "code-approved")![key];
        },
    })),
    ...["status", "method", "url", "actionId", "errorCode", "phase", "kind"].map((key) => ({
        name: `invalid HTTP ${key}`,
        change(e: AcceptanceEvidence) {
            e.http.find((row) => row.phase === "code-approved")![key] = key === "status" ? 409 : "wrong";
        },
    })),
    {
        name: "request did not approve",
        change(e) {
            jsonMap(e.http.find((row) => row.phase === "code-approved")!.request)!.approved = false;
        },
    },
    {
        name: "request lacks approval",
        change(e) {
            delete jsonMap(e.http.find((row) => row.phase === "code-approved")!.request)!.approved;
        },
    },
    {
        name: "unknown response",
        change(e) {
            e.http.find((row) => row.phase === "code-approved")!.response = "unknown";
        },
    },
    {
        name: "no durable approval receipt",
        change(e) {
            for (const phase of PHASES.slice(PHASES.indexOf("code-approved")))
                editJson(snapshot(e, phase), RECORD, (row) => {
                    delete jsonMap(row.acceptedOperations)!["browser-code-approval"];
                });
        },
    },
    {
        name: "failed durable decision",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(row.result)!.ok = false;
            });
        },
    },
    {
        name: "unrelated durable operation",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(row.result)!.operation = "status";
            });
        },
    },
    {
        name: "wrong durable workflow",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(field(row, "result", "workflow"))!.workflowId = "wrong";
            });
        },
    },
    {
        name: "wrong durable phase",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(field(row, "result", "workflow"))!.state = "closed";
            });
        },
    },
    {
        name: "wrong durable revision",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(field(row, "result", "workflow"))!.revision = 99;
            });
        },
    },
    {
        name: "wrong durable attempt",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(field(row, "result", "workflow", "nextAction", "request", "identity"))!.attemptId = "wrong";
            });
        },
    },
    {
        name: "no recorder transition",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(field(row, "result", "workflow", "nextAction"))!.kind = "code_review";
            });
        },
    },
    {
        name: "wrong recorder action",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(field(row, "result", "workflow", "nextAction"))!.actionId = "wrong";
            });
        },
    },
    {
        name: "changed carrier evidence",
        change(e) {
            approvalReceipt(e, (row) => {
                jsonMap(row.evidence)!.hostVersion = "wrong";
            });
        },
    },
    {
        name: "receipt before approval phase",
        change(e) {
            const saved = JSON.parse(snapshot(e, "code-approved").files.find((file) => file.path === RECORD)!.text!);
            editJson(snapshot(e, "code-change"), RECORD, (row) => {
                jsonMap(row.acceptedOperations)!["browser-code-approval"] =
                    saved.acceptedOperations["browser-code-approval"];
            });
        },
    },
    {
        name: "unrelated unmatched validation receipt",
        change(e) {
            for (const phase of PHASES.slice(PHASES.indexOf("code-approved")))
                editJson(snapshot(e, phase), RECORD, (row) => {
                    jsonMap(row.acceptedOperations)!.unrelated = structuredClone(
                        jsonMap(row.acceptedOperations)!["browser-code-approval"],
                    );
                });
        },
    },
    {
        name: "superseded candidate",
        change(e) {
            editJson(snapshot(e, "code-change"), RECORD, (row) => {
                jsonMap(field(row, "validation", "request", "identity"))!.key = "other-candidate:3";
            });
        },
    },
    {
        name: "unknown pending decision",
        change(e) {
            editJson(snapshot(e, "code-change"), CONTROLLER, (row) => {
                delete jsonMap(field(row, "state", "validationCheckpoint"))!.pendingHostDecision;
            });
        },
    },
    {
        name: "wrong controller attempt",
        change(e) {
            editJson(snapshot(e, "code-approved"), CONTROLLER, (row) => {
                jsonMap(field(row, "state", "validationCheckpoint"))!.attemptId = "other";
            });
        },
    },
    {
        name: "wrong controller generation",
        change(e) {
            editJson(snapshot(e, "code-approved"), CONTROLLER, (row) => {
                jsonMap(field(row, "state", "validationCheckpoint"))!.generation = "other";
            });
        },
    },
    {
        name: "missing durable approved choice",
        change(e) {
            editJson(snapshot(e, "code-approved"), CONTROLLER, (row) => {
                jsonMap(field(row, "state", "validationCheckpoint"))!.hostDecisionChoices = {};
            });
        },
    },
    {
        name: "durable choice was feedback",
        change(e) {
            editJson(snapshot(e, "code-approved"), CONTROLLER, (row) => {
                jsonMap(field(row, "state", "validationCheckpoint", "hostDecisionChoices", "candidate-2"))!.outcome =
                    "feedback";
            });
        },
    },
];
for (const scenario of approvalMutations)
    test(`browser approval provenance rejects ${scenario.name}`, () => {
        const evidence = completeEvidence();
        scenario.change(evidence);
        assertEquals(
            evaluateEvidence(evidence).checks.find((row) => row.id === "operation-provenance")?.outcome,
            "fail",
        );
    });

test("actual Core browser approval links its durable receipt and fails closed when identity is lost", async () => {
    await withProcessGlobalTestLock(async () => {
        const fixture = await attachedValidationFixture();
        try {
            const started = await toDelivery(fixture);
            assert(started.workflow.nextAction.kind === "code_review");
            const hosted = await ensureReviewHosted(fixture.root, started.workflow, NO_OPEN_BROWSER_PORT);
            assert(hosted);
            const location = locateAttachedWorkflows(fixture.root);
            const before = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(before.status === "found");
            // Auth and stale-tab guards must reject before Core creates a receipt.
            for (const invalid of ["token", "revision"]) {
                const url = reviewApi(hosted.url, "decision");
                if (invalid === "token") url.searchParams.set("token", "wrong");
                const rejected = await fetch(url, {
                    method: "POST",
                    body: JSON.stringify({ reviewRevision: invalid === "revision" ? -1 : 0 }),
                });
                assertEquals(rejected.status, invalid === "token" ? 401 : 409);
                if (invalid === "token") {
                    assertEquals(await rejected.text(), "Review token required.");
                } else {
                    const refusal = await rejected.json();
                    assertEquals(refusal.error, "stale_code_review");
                    assertEquals(field(refusal, "operationId"), undefined);
                }
                const unchanged = await loadAttachedWorkflowRecord(location, fixture.workflowId);
                assert(unchanged.status === "found");
                assertEquals(unchanged.record.acceptedOperations, before.record.acceptedOperations);
            }
            const beforePlan = await fixture.plan();
            await mkdir(join(fixture.root, "logs"));
            const page = new ReviewPage(fixture.root, JSON.parse(JSON.stringify({ ...started, review: hosted })));
            await page.approve("code-approved");
            const httpRows: JsonMap[] = (await readFile(join(fixture.root, "logs/http.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            const http = httpRows.find((row) => row.kind === "approve")!;
            assertEquals(http.status, 200);
            assertEquals(field(http.response, "ok"), true);
            const after = await loadAttachedWorkflowRecord(location, fixture.workflowId);
            assert(after.status === "found");
            const newIds = Object.keys(after.record.acceptedOperations).filter(
                (id) => !(id in before.record.acceptedOperations),
            );
            assertEquals(newIds.length, 1);
            const receipt = after.record.acceptedOperations[newIds[0]];
            assertEquals(receipt.result.operation, "validation_decision");
            assert(receipt.result.ok && receipt.result.workflow.nextAction.kind === "recorder");
            const beforeJson: JsonMap = JSON.parse(JSON.stringify(before.record));
            const afterJson: JsonMap = JSON.parse(JSON.stringify(after.record));
            const evidence = coreProvenanceEvidence(beforeJson, afterJson, newIds[0]);
            evidence.snapshots["code-approved"] = evidence.snapshots["code-change"];
            evidence.snapshots["code-change"] = structuredClone(evidence.snapshots["code-chat"]!);
            const afterPlan = await fixture.plan();
            for (const [phase, plan] of [
                ["code-change", beforePlan],
                ["code-approved", afterPlan],
            ] as const) {
                putFile(
                    snapshot(evidence, phase),
                    `fixture/.wld/internal/controller/plans/${before.record.plan!.planId}.json`,
                    {
                        planId: before.record.plan!.planId,
                        planName: before.record.plan!.planName,
                        state: { validationCheckpoint: JSON.parse(JSON.stringify(plan.attrs.validationCheckpoint)) },
                    },
                );
            }
            evidence.http = [http];
            assertEquals(field(http.response, "operationId"), newIds[0]);
            assertEquals(evaluateEvidence(evidence).provenance.matchedOperations, 1);
            for (const key of [
                "operationId",
                "actionId",
                "workflowId",
                "attemptId",
                "generation",
                "decisionKey",
                "ok",
            ]) {
                const changed = structuredClone(evidence);
                jsonMap(changed.http[0].response)![key] = key === "ok" ? false : "wrong";
                assertEquals(evaluateEvidence(changed).provenance.matchedOperations, 0, key);
            }
            const absent = structuredClone(evidence);
            delete absent.http[0].response;
            assertEquals(evaluateEvidence(absent).provenance.matchedOperations, 0);
        } finally {
            await stopHostedAttachedReviews();
            await fixture.close();
        }
    });
});
