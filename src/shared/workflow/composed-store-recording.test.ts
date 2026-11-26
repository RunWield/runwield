import { openWorkflow } from "@runwield/workflow";
import { test } from "node:test";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { realpath, writeFile, stat, lstat, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { captureForegroundProcess } from "../captured-process.ts";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import {
    authorLocalPlan,
    recordPlanEvent,
    withLocalPlanWorkflow,
    savePlanProse,
    readPlanPublicationReference,
    readRecordingPublication,
    listOwnedWorkRecords,
    searchOwnedWorkRecords,
} from "../../plan-store/index.ts";
import { loadPlan } from "../testing/plan-query-fixture.ts";
import { startActiveExecutionWorkflow, createExecutionStartPorts } from "./execution-start.ts";
import type { HostTurnValidationResult, ValidationHostResume } from "@runwield/workflow/host-contract";
import { setExactProjectCustomSetting } from "../settings.ts";
import { retryWorkRecordForPlan } from "../work-records/auto-generation.ts";
import { createWorkRecordMnemotecaFixture } from "../work-records/test-fixtures/mnemoteca-port.ts";

import { rebuildWorkRecordIndex } from "../work-records/index-adapter.ts";

const repository = defineCommittedGitFixture({ "README.md": "Recording composition\n" });
const driver = new URL("./testing/composed-validation-process.ts", import.meta.url).pathname;
const sessionDriver = new URL("./testing/composed-session-process.ts", import.meta.url).pathname;
interface SessionObservation {
    path: string;
    sessionId: string;
    projectId: string;
    cwd?: string;
    historicalCwd?: string;
    contention?: string;
}
async function sessionCommand(command: string, root: string, locator: string): Promise<SessionObservation> {
    const result = await captureForegroundProcess(process.execPath, {
        cwd: root,
        args: [sessionDriver, command, root, locator],
    });
    equal(result.code, 0, new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split("\n").at(-1)!);
}

test("first canonical record after cleanup keeps sealed prose, record identity and original delivery provenance", async () => {
    const root = await realpath(await repository.checkout());
    const remote = `${root}-upstream.git`;
    const moved = `${root}-moved`;
    try {
        await git(root, ["clone", "--bare", root, remote]);
        await git(root, ["remote", "add", "origin", remote]);
        await git(root, ["config", "branch.main.remote", "origin"]);
        await git(root, ["config", "branch.main.merge", "refs/heads/main"]);
        setExactProjectCustomSetting("plans", { deliveryCopies: false }, root);
        setExactProjectCustomSetting("workRecords", { deliveryCopies: false }, root);
        setExactProjectCustomSetting("codereview", "none", root);
        await authorLocalPlan(root, {
            planName: "delivery",
            contextMarkdown: "# Sealed sentinel scope\n",
            definition: {
                classification: "PLANNED_CHANGE",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
                targetBranch: "main",
            },
        });
        const workflow = await withLocalPlanWorkflow(root, "delivery", async () => {
            await recordPlanEvent({
                cwd: root,
                planName: "delivery",
                event: "review_approved",
                currentStatus: "draft",
            });
            await recordPlanEvent({
                cwd: root,
                planName: "delivery",
                event: "readiness_passed",
                currentStatus: "approved",
            });
            const plan = await loadPlan(root, "delivery");
            ok(plan);
            const workflow = await startActiveExecutionWorkflow({
                cwd: root,
                planName: "delivery",
                currentStatus: "ready_for_work",
                triageMeta: plan.attrs,
                ports: createExecutionStartPorts(),
            });
            ok(workflow.executionCwd);
            await writeFile(join(workflow.executionCwd, "sentinel.ts"), 'export const delivered = "original";\n');
            await (
                await openWorkflow({ cwd: root, planName: "delivery" }).resumeAttempt({
                    attemptId: workflow.packageAttemptId || workflow.worktreeId,
                })
            ).acceptCompletion({});
            await recordPlanEvent({
                cwd: root,
                planName: "delivery",
                event: "mechanical_validation_passed",
                currentStatus: "implemented",
            });
            await recordPlanEvent({
                cwd: root,
                planName: "delivery",
                event: "semantic_review_passed",
                currentStatus: "implemented",
            });
            return workflow;
        });
        const validatedCommit = await git(workflow.executionCwd!, ["rev-parse", "HEAD"]);
        let resume: ValidationHostResume | undefined;
        const historicalCwd = await realpath(workflow.executionCwd!);
        const savedSession = await sessionCommand("create", root, workflow.executionCwd!);
        let recordId = "";
        for (let turn = 0; turn < 5; turn++) {
            let result: HostTurnValidationResult;
            if (turn === 0) {
                const child = spawn(process.execPath, [driver, root, "delivery", "", "hold"], {
                    cwd: root,
                    stdio: ["ignore", "pipe", "pipe"],
                });
                let output = "";
                let errors = "";
                child.stderr.on("data", (chunk) => {
                    errors += chunk.toString();
                });
                const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
                try {
                    result = await new Promise<HostTurnValidationResult>((resolve, reject) => {
                        child.once("error", reject);
                        child.once("exit", () =>
                            reject(new Error(`Validation stopped before durable wait: ${output} ${errors}`)),
                        );
                        child.stdout.on("data", (chunk) => {
                            output += chunk.toString();
                            const line = output.split("\n").find((line) => line.startsWith('{"kind"'));
                            if (line) resolve(JSON.parse(line));
                        });
                    });
                    ok(result.kind === "host_request" && result.request.kind === "recorder", JSON.stringify(result));
                    equal((await listOwnedWorkRecords(root)).length, 0);
                } finally {
                    child.kill("SIGKILL");
                    await exited;
                }
            } else {
                const restarted = await captureForegroundProcess(process.execPath, {
                    cwd: root,
                    args: [driver, root, "delivery", JSON.stringify(resume)],
                });
                equal(restarted.code, 0, new TextDecoder().decode(restarted.stderr));
                const line = new TextDecoder().decode(restarted.stdout).trim().split("\n").at(-1)!;
                result = JSON.parse(line);
            }
            if (result.kind === "verified") break;
            ok(result.kind === "host_request" && result.request.kind === "recorder", JSON.stringify(result));
            const request: { successorRecordId: string } = JSON.parse(result.request.prompt.split("\n")[0]);
            if (recordId) equal(request.successorRecordId, recordId);
            recordId = request.successorRecordId;
            resume = {
                kind: "recorder",
                identity: result.request.identity,
                sections: "invalid external Recorder response",
            };
        }
        ok(recordId);
        equal((await loadPlan(root, "delivery"))?.attrs.status, "verified");
        await rejects(stat(workflow.executionCwd!), { code: "ENOENT" });
        equal((await listOwnedWorkRecords(root)).length, 0);
        equal(await git(remote, ["show", "main:sentinel.ts"]), 'export const delivered = "original";');
        const publishedHead = await git(remote, ["rev-parse", "main"]);
        ok(!(await git(remote, ["log", "--format=%B", "main"])).includes("RunWield-Publication-Attempt:"));
        ok(!(await git(remote, ["ls-tree", "-r", "--name-only", "main"])).includes("docs/"));
        const reference = await readPlanPublicationReference(root, "delivery");
        ok(reference);
        const sealed = await withLocalPlanWorkflow(root, "delivery", () =>
            readRecordingPublication(root, "delivery", reference),
        );
        equal(sealed.preparedRecord, undefined);
        equal(sealed.validatedCommit, validatedCommit);
        equal(sealed.targetBranch, "main");
        equal(sealed.attemptId, reference.attemptId);
        equal(sealed.planId, reference.planId);
        const current = await loadPlan(root, "delivery");
        ok(current);
        await savePlanProse(root, "delivery", "# Later live prose must not be recorded\n", current.revision);
        const result = await withLocalPlanWorkflow(root, "delivery", () =>
            retryWorkRecordForPlan({
                cwd: root,
                planName: "delivery",
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
                runRecorderStep: (prompt) => {
                    ok(prompt.includes("Sealed sentinel scope"));
                    ok(!prompt.includes("Later live prose"));
                    return Promise.resolve({ title: "Retained delivery", summary: "Original sealed outcome." });
                },
            }),
        );
        equal(result.status, "generated", JSON.stringify(result));
        const records = await listOwnedWorkRecords(root);
        equal(records.length, 1);
        equal(records[0].attrs.recordId, recordId);
        equal(records[0].attrs.status, "approved");
        deepEqual(records[0].attrs.provenance?.sourcePlans, [reference.planId]);
        deepEqual(await readPlanPublicationReference(root, "delivery"), reference);
        equal(await git(remote, ["rev-parse", "main"]), publishedHead);
        await rejects(stat(workflow.executionCwd!), { code: "ENOENT" });
        await rename(root, moved);
        const holder = spawn(process.execPath, [sessionDriver, "hold", moved, savedSession.path], {
            cwd: moved,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let holderErrors = "";
        holder.stderr.on("data", (chunk) => {
            holderErrors += chunk.toString();
        });
        const holderExit = new Promise<number | null>((resolve) => holder.once("exit", resolve));
        try {
            await new Promise<void>((resolve, reject) => {
                holder.once("error", reject);
                holder.once("exit", () => reject(new Error(`Session holder exited: ${holderErrors}`)));
                holder.stdout.once("data", (chunk) => {
                    equal(chunk.toString().trim(), "held");
                    resolve();
                });
            });
            const contended = await sessionCommand("contend", moved, savedSession.path);
            equal(contended.sessionId, savedSession.sessionId);
            equal(contended.projectId, savedSession.projectId);
            equal(contended.contention, "managed_operation_in_progress");
        } finally {
            holder.stdin.end("release\n");
            equal(await holderExit, 0, holderErrors);
        }
        const continued = await sessionCommand("resume", moved, savedSession.path);
        equal(continued.sessionId, savedSession.sessionId);
        equal(continued.projectId, savedSession.projectId);
        equal(continued.cwd, moved);
        equal(continued.historicalCwd, historicalCwd);
        equal((await listOwnedWorkRecords(moved))[0].attrs.recordId, recordId);
        const indexOptions = { mnemotecaPort: createWorkRecordMnemotecaFixture() };
        const rebuilt = await rebuildWorkRecordIndex(moved, indexOptions);
        equal(rebuilt.added, 1);
        equal(rebuilt.failed, 0);
        const found = await searchOwnedWorkRecords(moved, "Retained delivery", indexOptions);
        equal(found.records.length, 1);
        equal(found.records[0].recordId, recordId);
        equal(found.records[0].path, records[0].path);
        for (const path of [".wld/internal", ".wld/plans"]) await rejects(lstat(join(moved, path)), { code: "ENOENT" });
    } finally {
        await rm(remote, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
        await rm(moved, { recursive: true, force: true });
    }
});
