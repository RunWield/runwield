import { HostedSession } from "../session/hosted-session.ts";
import { createPlanWrittenTool } from "../../tools/plan-written.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { equal, ok, rejects } from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { remoteBackgroundTaskLogDirectory } from "./background-task-logs.ts";
import { join } from "node:path";
import { stdinStream } from "../../testing/stdin-stream.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { activateRemoteProjectOwner, type RemoteInteractiveConfig } from "./entry.ts";
import {
    recordPlanEvent,
    withLocalPlanWorkflow,
    loadPublishedWorkRecordSource,
    listOwnedWorkRecords,
    readPlanRecordingContext,
    readRecordingPublication,
    type ProjectStoreBinding,
    planDocumentsForCheckout,
} from "../../plan-store/index.ts";
import { ProjectStoreClient } from "./project-store-client.ts";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "../workflow/execution-start.ts";
import { finalizePlanImplementation } from "../workflow/implementation-checkpoint.ts";
import { runValidationAttempt } from "../workflow/validation-supervisor.ts";
import { rememberNonGitExecutionConsent } from "../non-git-execution-consent.ts";
import { setExactProjectCustomSetting } from "../settings.ts";
import { retryWorkRecordForPlan } from "../work-records/auto-generation.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";

const lines = processLines(stdinStream());
const input: Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection"> = JSON.parse(
    (await lines.read()).value || "{}",
);
await lines.cancel();
const clear = await activateRemoteProjectOwner(input);
try {
    const planningSession = new HostedSession({ id: "managed-planner", cwd: input.cwd });
    const body = "# In-place result\n";
    let reviewedPlanId: string | undefined;
    planningSession.setInteractionAdapter({
        requestInteraction(request) {
            equal(request.type, "plan_review");
            const id = request._meta?.planId;
            ok(typeof id === "string" && id.length > 0);
            reviewedPlanId = id;
            return { outcome: "canceled" };
        },
    });
    try {
        const submitted = await createPlanWrittenTool({ hostedSession: planningSession }).execute(
            "create-managed-plan",
            {
                planName: "in-place",
                contextMarkdown: body,
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
            undefined,
            undefined,
            {} as ExtensionToolContext,
        );
        ok(reviewedPlanId, JSON.stringify(submitted));
        const authored = await planDocumentsForCheckout(input.cwd).byId(reviewedPlanId);
        equal(authored.body, body);
        equal(authored.attrs.status, "draft");
    } finally {
        planningSession.dispose();
    }
    await rememberNonGitExecutionConsent("featurePlan", input.cwd);
    setExactProjectCustomSetting("verification_command", "test -f result.txt", input.cwd);
    setExactProjectCustomSetting("codereview", "none", input.cwd);
    await withLocalPlanWorkflow(input.cwd, "in-place", async () => {
        for (const [event, currentStatus] of [
            ["review_approved", "draft"],
            ["readiness_passed", "approved"],
        ] as const)
            await recordPlanEvent({ cwd: input.cwd, planName: "in-place", event, currentStatus });
        const ready = await planDocumentsForCheckout(input.cwd).load("in-place");
        ok(ready);
        const execution = await startActiveExecutionWorkflow({
            cwd: input.cwd,
            planName: "in-place",
            currentStatus: "ready_for_work",
            triageMeta: ready.attrs,
            ports: createExecutionStartPorts(),
        });
        equal(execution.executionMode, "non_git_in_place");
        await rejects(
            recordPlanEvent({
                cwd: input.cwd,
                planName: "in-place",
                event: "validation_passed",
                currentStatus: "reviewed",
                details: { worktreeId: "another-attempt", executionMode: "non_git_in_place" },
            }),
        );
        await writeFile(join(input.cwd, "result.txt"), "Completed in place.\n");
        await finalizePlanImplementation({ projectRoot: input.cwd, planName: "in-place", executionContext: execution });
        let result = await runValidationAttempt({
            projectRoot: input.cwd,
            planName: "in-place",
            runtime: { kind: "host" },
        });
        equal(
            result.kind,
            "host_request",
            JSON.stringify(result) +
                (await readFile(
                    join(remoteBackgroundTaskLogDirectory()!, "debug/validation-errors.jsonl"),
                    "utf8",
                ).catch(() => "")),
        );
        ok(result.hostRequest?.kind === "recorder", JSON.stringify(result));
        const reviewed = await planDocumentsForCheckout(input.cwd).load("in-place");
        ok(reviewed?.attrs.planId);
        const endpoint = `http://127.0.0.1:${input.connection.port}`;
        const admission = await fetch(`${endpoint}/project-store/admit`, {
            method: "POST",
            headers: { Authorization: `Bearer ${input.connection.credential}` },
        });
        equal(admission.status, 200);
        const binding: ProjectStoreBinding = await admission.json();
        const owner = new ProjectStoreClient(endpoint, input.connection.credential, binding);
        await rejects(
            owner.execute({
                kind: "settle-in-place",
                planId: reviewed.attrs.planId,
                operationId: crypto.randomUUID(),
                expectedRevision: reviewed.revision,
                attemptId: "another-attempt",
            }),
            /409/,
        );
        await rejects(
            owner.execute({
                kind: "execution-checkpoint",
                planId: reviewed.attrs.planId,
                operationId: crypto.randomUUID(),
                expectedRevision: reviewed.revision,
                attemptId: "another-attempt",
                checkpoint: { event: "validation_passed", details: {} },
            }),
            /409/,
        );
        equal((await planDocumentsForCheckout(input.cwd).load("in-place"))?.revision, reviewed.revision);
        result = await runValidationAttempt({
            projectRoot: input.cwd,
            planName: "in-place",
            runtime: { kind: "host" },
            hostResume: {
                kind: "recorder",
                identity: result.hostRequest.identity,
                sections: JSON.stringify({ title: "In-place delivery", summary: "Completed managed non-Git work." }),
            },
        });
        equal(
            result.kind,
            "verified",
            JSON.stringify(result) +
                (await readFile(
                    join(remoteBackgroundTaskLogDirectory()!, "debug/validation-errors.jsonl"),
                    "utf8",
                ).catch(() => "")),
        );
        const completed = await planDocumentsForCheckout(input.cwd).load("in-place");
        equal(completed?.attrs.status, "verified");
        equal(completed?.attrs.executionMode, "non_git_in_place");
        equal(completed?.attrs.deliveryEvidence?.mode, "non_git_in_place");
        ok(!completed?.attrs.validatedCommit);
        ok(!completed?.attrs.validationCheckpoint);
        const recording = await readPlanRecordingContext("in-place", false);
        ok(recording?.publishedReference);
        const published = await readRecordingPublication(input.cwd, "in-place", recording.publishedReference);
        equal(published.validatedCommit, "");
        equal(published.targetBranch, "");
        equal(published.copies.length, 0);
        const settledAgain = await owner.execute({
            kind: "settle-in-place",
            planId: reviewed.attrs.planId,
            operationId: crypto.randomUUID(),
            expectedRevision: reviewed.revision,
            attemptId: recording.publishedReference.attemptId,
        });
        ok("status" in settledAgain.result && settledAgain.result.status === "completed");
        equal(
            (await planDocumentsForCheckout(input.cwd).load("in-place"))?.attrs.verifiedAt,
            completed?.attrs.verifiedAt,
        );
        const source = await loadPublishedWorkRecordSource(input.cwd, "in-place");
        equal(source?.body, "# In-place result\n");
        equal(source?.attrs.status, "verified");
        const records = await listOwnedWorkRecords(input.cwd);
        equal(records.length, 1);
        equal(records[0].attrs.status, "approved");
        const retried = await retryWorkRecordForPlan({
            cwd: input.cwd,
            planName: "in-place",
            mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
            runRecorderStep: () => {
                throw new Error("Accepted Recorder sections must survive in-place completion.");
            },
        });
        equal(retried.recordId, records[0].attrs.recordId);
        console.log(JSON.stringify({ planId: completed?.attrs.planId, recordId: records[0].attrs.recordId }));
    });
} finally {
    clear();
}
