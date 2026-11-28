import { authenticatedProjectStoreRequest } from "../shared/remote/project-store-request.ts";
import { workRecords } from "@runwield/plans/work-records";
import { openNativeFileLock } from "@runwield/resources/fs";
import { workRecordFiles } from "@runwield/plans/work-record-files";
import { parseProjectId, projects, type HomeProjectOwner } from "@runwield/projects";
import { constants, tmpdir } from "node:os";
import { parseHistoryList, parseMilestoneDocuments } from "../shared/remote/project-store-protocol.ts";
import { test } from "node:test";
import { equal, deepEqual, rejects } from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readFile, writeFile, unlink, mkdir, mkdtemp, rm, rename, symlink, stat, utimes } from "node:fs/promises";
import { PreparedProjectStore, authorLocalPlan, savePlanProse, type ProjectStoreReply } from "./index.ts";
import type { ProjectStoreBinding } from "@runwield/plans/project-store-wire";
import type { SharedPlan } from "@runwield/plans/sharing";
import { PlanNotFoundError, type ProjectPlanDocument } from "@runwield/plans/store";
import type { ProjectStoreRequest } from "../shared/remote/project-store-protocol.ts";
import { ProjectStoreClient } from "../shared/remote/project-store-client.ts";
import type { composedRemoteFixture } from "../shared/remote/composed-store-fixture.ts";
import { withCollaborationServer } from "../cmd/plans/collaboration-command-test-fixture.ts";
import { loadPlan } from "../shared/testing/plan-query-fixture.ts";
import { packageFixture, startDriver } from "../shared/testing/plan-package-fixture.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("a lost receipt is reconciled before a later local edit and original retries preserve that edit", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Before\n" });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        const service = new PreparedProjectStore(fixture.root);
        const command = {
            kind: "save-prose" as const,
            planId: before.attrs.planId!,
            operationId: randomUUID(),
            expectedRevision: before.revision!,
            body: "# First\n",
        };
        const first = await service.execute(command);
        equal("status" in first.result && first.result.status, "completed");
        const directory = join(
            fixture.identity.executionAccountHome,
            ".wld",
            "projects",
            fixture.identity.projectId,
            "internal",
            "plan-packages",
        );
        const receiptPath = join(directory, "operations", `${command.operationId}.json`);
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        // Arrange the qualified owner crash boundary: resource replaced, completion receipt not yet committed.
        await writeFile(
            receiptPath,
            JSON.stringify({ ...receipt, outcome: { operationId: command.operationId, status: "unstarted" } }),
        );
        await writeFile(
            join(directory, "operation-effect.json"),
            JSON.stringify({
                version: 1,
                receipt,
                path: before.path,
                beforeHash: hash("# Before\n"),
                after: "# First\n",
                afterHash: hash("# First\n"),
            }),
        );
        const afterFirst = (await loadPlan(fixture.root, "proposal"))!;
        await savePlanProse(fixture.root, "proposal", "# Later\n", afterFirst.revision!);
        deepEqual(await service.execute(command), first);
        equal((await loadPlan(fixture.root, "proposal"))!.body, "# Later\n");
        await rejects(service.execute({ ...command, body: "# Different\n" }), /different request/);
        equal((await loadPlan(fixture.root, "proposal"))!.body, "# Later\n");
    } finally {
        await fixture.cleanup();
    }
});

test("concurrent duplicates have one outcome while a stale competing write is refused", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Before\n" });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        const service = new PreparedProjectStore(fixture.root);
        const command = {
            kind: "save-document" as const,
            resource: "context.md",
            planId: before.attrs.planId!,
            operationId: randomUUID(),
            expectedRevision: before.revision!,
            body: "# First\n",
        };
        const [first, second] = await Promise.all([service.execute(command), service.execute(command)]);
        deepEqual(first, second);
        await rejects(service.execute({ ...command, operationId: randomUUID(), body: "# Lost\n" }), /[Ss]tale|changed/);
        equal((await loadPlan(fixture.root, "proposal"))!.body, "# First\n");
    } finally {
        await fixture.cleanup();
    }
});

test("service mutation waits for another process holding the native Plan lock", async () => {
    const fixture = await packageFixture();
    let held: ReturnType<typeof startDriver> | undefined;
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Before\n" });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        held = startDriver({ identity: fixture.identity, command: "hold", planId: before.attrs.planId! });
        await held.ready();
        let settled = false;
        const mutation = new PreparedProjectStore(fixture.root)
            .execute({
                kind: "save-prose",
                planId: before.attrs.planId!,
                operationId: randomUUID(),
                expectedRevision: before.revision!,
                body: "# After\n",
            })
            .then((result) => {
                settled = true;
                return result;
            });
        await new Promise((resolve) => setTimeout(resolve, 80));
        equal(settled, false);
        held.child.kill("SIGKILL");
        await held.done;
        held = undefined;
        const outcome = (await mutation).result;
        equal("status" in outcome && outcome.status, "completed");
        equal((await loadPlan(fixture.root, "proposal"))!.body, "# After\n");
    } finally {
        if (held) {
            held.child.kill("SIGKILL");
            await held.done;
        }
        await fixture.cleanup();
    }
});

test("definition and lifecycle commands preserve owner policy and reject protected patches", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Before\n" });
        const service = new PreparedProjectStore(fixture.root);
        let plan = (await loadPlan(fixture.root, "proposal"))!;
        await service.execute({
            kind: "save-definition",
            operationId: randomUUID(),
            planId: plan.attrs.planId!,
            expectedRevision: plan.revision!,
            changes: { summary: "Edited through owner" },
        });
        plan = (await loadPlan(fixture.root, "proposal"))!;
        equal(plan.attrs.summary, "Edited through owner");
        const changes = { summary: "Forbidden", status: "verified" };
        await rejects(
            service.execute({
                kind: "save-definition",
                operationId: randomUUID(),
                planId: plan.attrs.planId!,
                expectedRevision: plan.revision!,
                changes,
            }),
            /protected field/,
        );
        equal((await loadPlan(fixture.root, "proposal"))!.revision, plan.revision);
        const event = {
            kind: "record-event" as const,
            operationId: randomUUID(),
            planId: plan.attrs.planId!,
            expectedRevision: plan.revision!,
            event: "review_approved" as const,
        };
        const outcome = await service.execute(event);
        equal((await loadPlan(fixture.root, "proposal"))!.attrs.status, "approved");
        deepEqual(await service.execute(event), outcome);
        const approved = (await loadPlan(fixture.root, "proposal"))!;
        await rejects(
            service.execute({
                ...event,
                operationId: randomUUID(),
                expectedRevision: approved.revision!,
                event: "hold_reset_to_draft",
            }),
            /hold|transition|event/i,
        );
        equal((await loadPlan(fixture.root, "proposal"))!.attrs.status, "approved");
    } finally {
        await fixture.cleanup();
    }
});

test("missing or corrupt receipts never turn a reserved identity into a new mutation", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Before\n" });
        const before = (await loadPlan(fixture.root, "proposal"))!;
        const service = new PreparedProjectStore(fixture.root);
        const command = {
            kind: "save-prose" as const,
            planId: before.attrs.planId!,
            operationId: randomUUID(),
            expectedRevision: before.revision!,
            body: "# First\n",
        };
        const first = await service.execute(command);
        const path = join(
            fixture.identity.executionAccountHome,
            ".wld",
            "projects",
            fixture.identity.projectId,
            "internal",
            "plan-packages",
            "operations",
            `${command.operationId}.json`,
        );
        const saved = await readFile(path, "utf8");
        await writeFile(path, "broken JSON");
        await rejects(service.execute(command));
        equal((await loadPlan(fixture.root, "proposal"))!.body, "# First\n");
        await unlink(path);
        await rejects(service.execute(command), /evidence is unavailable/);
        equal((await loadPlan(fixture.root, "proposal"))!.body, "# First\n");
        await writeFile(path, saved);
        deepEqual(await service.execute(command), first);
    } finally {
        await fixture.cleanup();
    }
});

test("a registered home-only Project authors and edits Plans without a source checkout", async () => {
    const owner = await projects.home.register({
        projectId: parseProjectId(randomUUID())!,
        repositoryId: randomUUID(),
        displayName: "Remote-only",
    });
    const service = new PreparedProjectStore(owner);
    const before = await service.author({ planName: "remote-only", contextMarkdown: "# Remote-only\n" });
    const request = {
        kind: "save-prose" as const,
        operationId: randomUUID(),
        planId: before.planId,
        expectedRevision: before.revision,
        body: "# Owner edit\n",
    };
    const outcome = await service.execute(request);
    equal("status" in outcome.result && outcome.result.status, "completed");
    const after = await service.execute({ kind: "read", planId: before.planId, resource: "context.md" });
    equal("body" in after.result && after.result.body, "# Owner edit\n");
    deepEqual(await new PreparedProjectStore(owner).execute(request), outcome);
    if (!("revision" in after.result)) throw new Error("Missing document revision");
    await service.execute({
        kind: "save-definition",
        operationId: randomUUID(),
        planId: before.planId,
        expectedRevision: after.result.revision!,
        changes: { summary: "Home-only definition" },
    });
    const definition = await service.execute({ kind: "read", planId: before.planId, resource: "context.md" });
    if (!("revision" in definition.result)) throw new Error("Missing document revision");
    await service.execute({
        kind: "record-event",
        event: "review_approved",
        operationId: randomUUID(),
        planId: before.planId,
        expectedRevision: definition.result.revision!,
    });
    const list = await service.execute({ kind: "list-history", planId: before.planId, offset: 0, snapshot: "" });
    ok("historyPage" in list.result);
    const { milestones } = parseHistoryList(list.result.historyPage.text, before.planId);
    const read = await service.execute({
        kind: "show-history",
        planId: before.planId,
        version: milestones[0].version,
        offset: 0,
        snapshot: "",
    });
    ok("historyPage" in read.result);
    equal(parseMilestoneDocuments(read.result.historyPage.text)["context.md"], "# Owner edit\n");
    await rejects(
        service.execute({ kind: "list-history", planId: "remote-only", offset: 0, snapshot: "" }),
        /requires an admitted Plan/,
    );
});

import { publicationFixture } from "../shared/workflow/testing/package-publication-fixture.ts";
import { git } from "../shared/git-test-fixture.ts";
import { ok } from "node:assert/strict";

test("home-owned snapshot publication retains frozen documents without touching the execution checkout", async () => {
    const fixture = await publicationFixture();
    let moved = false;
    let connection: Awaited<ReturnType<typeof connectOwner>> | undefined;
    try {
        const candidate = await git(fixture.workflow.executionCwd!, ["rev-parse", "HEAD"]);
        const registration = await projects.home.register({
            projectId: fixture.identity.projectId,
            repositoryId: fixture.identity.repositoryId,
            displayName: "Prepared owner",
        });
        connection = await connectOwner(registration);
        const service = connection.client;
        const initial = await service.execute({ kind: "read", planId: "plan-one", resource: "context.md" });
        ok("revision" in initial.result);
        await service.execute({
            kind: "freeze-publication-policy",
            operationId: randomUUID(),
            planId: "plan-one",
            expectedRevision: initial.result.revision!,
            attemptId: fixture.workflow.worktreeId!,
            policy: { plans: false, workRecords: false, autoGenerateRecords: false },
        });
        const before = await service.execute({ kind: "read", planId: "plan-one", resource: "context.md" });
        ok("revision" in before.result);
        await rename(fixture.root, `${fixture.root}-unavailable`);
        moved = true;
        const request = {
            kind: "seal-publication" as const,
            operationId: randomUUID(),
            planId: "plan-one",
            expectedRevision: before.result.revision!,
            attemptId: fixture.workflow.worktreeId!,
            validatedCommit: candidate,
            targetBranch: "main",
        };
        const sealed = await service.execute(request);
        ok("snapshotId" in sealed.result && sealed.result.snapshotId, JSON.stringify(sealed));
        ok(sealed.result.snapshotDigest);
        ok(sealed.result.attemptId);
        const read = await service.execute({
            kind: "read-frozen",
            planId: "plan-one",
            resource: "context.md",
            snapshotId: sealed.result.snapshotId,
            snapshotDigest: sealed.result.snapshotDigest,
            attemptId: sealed.result.attemptId,
        });
        equal("body" in read.result && read.result.body, "# A Plan\n\nProse — 世界\n");
        deepEqual(await service.execute(request), sealed);
        const current = await service.execute({ kind: "read", planId: "plan-one", resource: "context.md" });
        ok("revision" in current.result);
        const repeated = await service.execute({
            ...request,
            operationId: randomUUID(),
            expectedRevision: current.result.revision!,
        });
        ok("snapshotId" in repeated.result);
        equal(repeated.result.snapshotId, sealed.result.snapshotId);
    } finally {
        await connection?.close();
        if (moved) await rename(`${fixture.root}-unavailable`, fixture.root);
        await fixture.cleanup();
    }
});

test("retained delivery permits owner-side record persistence and index reconciliation without a checkout", async () => {
    const fixture = await publicationFixture();
    let moved = false;
    let connection: Awaited<ReturnType<typeof connectOwner>> | undefined;
    try {
        const delivered = await fixture.drive();
        equal(delivered.code, 0, delivered.text);
        const registration = await projects.home.register({
            projectId: fixture.identity.projectId,
            repositoryId: fixture.identity.repositoryId,
            displayName: "Record owner",
        });
        connection = await connectOwner(registration);
        const service = connection.client;
        const before = await service.execute({ kind: "read", planId: "plan-one", resource: "context.md" });
        ok("revision" in before.result);
        await rename(fixture.root, `${fixture.root}-unavailable`);
        moved = true;
        const request = {
            kind: "save-record" as const,
            operationId: randomUUID(),
            planId: "plan-one",
            expectedRevision: before.result.revision!,
            title: "Retained delivery",
            summary: "Owner record evidence.",
        };
        const saved = await service.execute(request);
        equal("status" in saved.result && saved.result.status, "completed");
        deepEqual(await service.execute(request), saved);
        const receiptPath = join(
            registration.executionAccountHome,
            ".wld",
            "projects",
            registration.projectId,
            "internal",
            "plan-packages",
            "operations",
            `${request.operationId}.json`,
        );
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        receipt.outcome.status = "pending";
        await writeFile(receiptPath, JSON.stringify(receipt));
        deepEqual(await service.execute(request), saved);
        ok("recordId" in saved.result && saved.result.recordId);
        const readRequest = {
            kind: "read-record" as const,
            planId: "plan-one",
            recordId: saved.result.recordId,
        };
        const record = await service.execute(readRequest);
        ok("records" in record.result);
        equal(record.result.records.length, 1);
        const markdown = record.result.records[0]!.markdown;
        ok(markdown.includes("Owner record evidence."));
        const searchRequest = {
            kind: "search-records" as const,
            planId: "plan-one",
            query: "Owner record evidence",
            limit: 5,
        };
        const query = await service.execute(searchRequest);
        ok("records" in query.result);
        equal(query.result.records.length, 1);

        const duplicatePath = join(workRecordFiles.forOwner(registration).layout.records, "duplicate.md");
        const { attrs, body } = workRecords.documents.parse(markdown);
        // Introduce colliding durable evidence without changing the derived index.
        await writeFile(
            duplicatePath,
            workRecords.documents.format({ ...attrs, recordId: attrs.recordId.toUpperCase() }, body),
        );
        try {
            await rejects(service.execute(readRequest), /Project store request refused/);
            await rejects(service.execute(searchRequest), /Project store request refused/);
        } finally {
            await unlink(duplicatePath);
        }
        deepEqual(await service.execute(readRequest), record);
    } finally {
        await connection?.close();
        if (moved) await rename(`${fixture.root}-unavailable`, fixture.root);
        await fixture.cleanup();
    }
});

test("home-only admission refuses another account and a rebound repository", async () => {
    const owner = await projects.home.register({
        projectId: parseProjectId(randomUUID())!,
        repositoryId: randomUUID(),
        displayName: "Bound",
    });
    const service = new PreparedProjectStore(owner);
    const document = await service.author({ planName: "proposal", contextMarkdown: "# Bound owner\n" });
    const forged = { ...owner, personalOwner: { ...owner.personalOwner, identity: "/another-account" } };
    await rejects(
        Promise.resolve().then(() => new PreparedProjectStore(forged)),
        /authority changed/,
    );
    const path = join(owner.executionAccountHome, ".wld", "projects", owner.projectId, "project.wld.json");
    const original = await readFile(path, "utf8");
    const changed = JSON.parse(original);
    changed.repositories[0].remote = "ssh://different/repository";
    await writeFile(path, JSON.stringify(changed));
    try {
        await rejects(
            service.execute({
                kind: "save-prose",
                operationId: randomUUID(),
                planId: document.planId,
                expectedRevision: document.revision,
                body: "# Refused\n",
            }),
            /authority changed/,
        );
    } finally {
        await writeFile(path, original);
    }
    const retained = await service.execute({ kind: "read", planId: document.planId, resource: "context.md" });
    equal("body" in retained.result && retained.result.body, "# Bound owner\n");
});

import { updatePlanCollaborationMetadata } from "./index.ts";
import { getProjectSecretStoreLocation, putSecretRecord } from "../shared/collaboration/secrets.ts";
import { COLLABORATION_LOCK_BYPASS } from "@runwield/plans/collaboration-lock";

test("home-only collaboration uses owner credentials without returning them", async () => {
    const owner = await projects.home.register({
        projectId: parseProjectId(randomUUID())!,
        repositoryId: randomUUID(),
        displayName: "Shared",
    });
    const service = new PreparedProjectStore(owner);
    const document = await service.author({ planName: "shared", contextMarkdown: "# Shared\n" });
    const capability = "retained-owner-capability";
    let authenticated = false;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            authenticated = request.headers.get("authorization") === `Bearer ${capability}`;
            return Response.json({
                space: {
                    spaceId: "space-one",
                    planId: document.planId,
                    createdAt: "now",
                    updatedAt: "later",
                    latestRevision: 3,
                },
            });
        },
    });
    try {
        await projects.home.withOwner(owner, async () => {
            const location = projects.home.storeLocation(owner);
            await updatePlanCollaborationMetadata(
                location,
                "shared",
                {
                    collaborationState: "remote_canonical",
                    collaborationServerUrl: `http://127.0.0.1:${server.port}`,
                    collaborationSpaceId: "space-one",
                    collaborationRevision: 3,
                },
                COLLABORATION_LOCK_BYPASS.share,
            );
            await putSecretRecord(await getProjectSecretStoreLocation(location), `${document.planId}:space-one`, {
                planId: document.planId,
                spaceId: "space-one",
                contentKey: "private-content-key",
                maintainerCapability: capability,
                updatedAt: "now",
            });
        });
        const reply = await service.execute({ kind: "read-collaboration", planId: document.planId });
        equal(authenticated, true);
        deepEqual(reply.result, { planId: document.planId, spaceId: "space-one", latestRevision: 3 });
        equal(JSON.stringify(reply).includes(capability), false);
    } finally {
        server.stop(true);
    }
});

test("the personal owner resumes the same managed share receipt after an uncertain remote create", async () => {
    const owner = await projects.home.register({
        projectId: parseProjectId(randomUUID())!,
        repositoryId: randomUUID(),
        displayName: "Share recovery",
    });
    const service = new PreparedProjectStore(owner);
    const document = await service.author({ planName: "shared", contextMarkdown: "# Shared\n" });
    let requests = 0;
    await withCollaborationServer(
        async ({ adapter, serverUrl }) => {
            const command = {
                kind: "collaboration",
                operationId: randomUUID(),
                intent: { action: "share", options: { target: document.planId, planServer: serverUrl } },
            } satisfies ProjectStoreRequest["command"];
            await rejects(service.execute(command), /Retry sharing this Plan/);
            const original = adapter.database.handle.prepare("SELECT id FROM shared_spaces").get();
            ok(original);

            const restarted = new PreparedProjectStore(owner);
            const recovered = await restarted.execute(command);
            equal("status" in recovered.result && recovered.result.status, "completed");
            deepEqual(await restarted.execute(command), recovered);
            const { result } = await restarted.execute({
                kind: "read-collaboration-result",
                operationId: command.operationId,
            });
            ok("collaborationResult" in result && result.collaborationResult.action === "share");
            equal(result.collaborationResult.value.spaceId, original.id);
            equal(requests, 2);
        },
        async (request, serve) => {
            const response = await serve(request);
            return ++requests === 1 ? new Response("Create reply lost", { status: 502 }) : response;
        },
    );
});

import { startRemoteControlService } from "../shared/remote/control.ts";
async function connectOwner(owner: HomeProjectOwner) {
    const build = { buildId: "a".repeat(64), protocol: 1 };
    const control = startRemoteControlService(build);
    const binding = control.registerProjectStore(owner);
    const endpoint = `http://127.0.0.1:${control.port}`;
    const headers = { Authorization: `Bearer ${control.credential}` };
    try {
        for (const action of ["handshake", "readiness"]) {
            const response = await fetch(`${endpoint}/${action}`, {
                method: "POST",
                headers,
                body: action === "handshake" ? JSON.stringify(build) : undefined,
            });
            equal(response.status, 200);
            await response.text();
        }
    } catch (error) {
        await control.close();
        throw error;
    }
    // This synthetic connection must send the same health messages as a remote Client.
    const health = setInterval(() => {
        void fetch(`${endpoint}/health`, { method: "POST", headers })
            .then((response) => response.text())
            .catch(() => {});
    }, 1000);
    return {
        client: new ProjectStoreClient(authenticatedProjectStoreRequest(endpoint, control.credential), binding),
        async close() {
            clearInterval(health);
            await control.close();
        },
    };
}

test("family QA retries recover the child effect and finish the exact parent artifact", async () => {
    const fixture = await packageFixture();
    try {
        const {
            saveChildFeaturePlans,
            recordPlanEvent,
            withLocalPlanWorkflow,
            reservePlanExecution,
            readPlanResource,
        } = await import("./index.ts");
        await authorLocalPlan(fixture.root, {
            planName: "family",
            contextMarkdown: "# Family\n",
            definition: { classification: "PROJECT", type: "epic" },
        });
        await saveChildFeaturePlans(fixture.root, "family", [
            {
                title: "Child",
                summary: "A child",
                content: "# Child\n",
                dependencies: [],
                order: 1,
                affectedPaths: ["child.ts"],
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            },
        ]);
        await recordPlanEvent({
            cwd: fixture.root,
            planName: "family/child",
            event: "review_approved",
            currentStatus: "draft",
        });
        await recordPlanEvent({
            cwd: fixture.root,
            planName: "family/child",
            event: "readiness_passed",
            currentStatus: "approved",
        });
        await withLocalPlanWorkflow(fixture.root, "family/child", () =>
            reservePlanExecution("family/child", { targetBranch: "main" }),
        );
        const parent = (await loadPlan(fixture.root, "family"))!;
        const child = (await loadPlan(fixture.root, "family/child"))!;
        const service = new PreparedProjectStore(fixture.root);
        const command = {
            kind: "append-epic-qa" as const,
            planId: parent.attrs.planId!,
            expectedRevision: parent.revision!,
            childPlanId: child.attrs.planId!,
            childRevision: child.revision!,
            operationId: randomUUID(),
            childHeading: "Child",
            checklistMarkdown: "Manual verification steps for family/child\n- [ ] Inspect the child.",
        };
        await service.execute(command);
        const document = await readPlanResource(
            fixture.root,
            { planId: parent.attrs.planId!, planName: "family" },
            "manual-qa.md",
        );
        const directory = join(
            fixture.identity.executionAccountHome,
            ".wld",
            "projects",
            fixture.identity.projectId,
            "internal",
            "plan-packages",
        );
        const receiptPath = join(directory, "operations", `${command.operationId}.json`);
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        const pending = { ...receipt, outcome: { operationId: command.operationId, status: "pending" } };
        const childMetadataPath = join(child.path, "..", "plan.wld.json");
        const childMetadata = await readFile(childMetadataPath, "utf8");
        const childRevision = (await loadPlan(fixture.root, "family/child"))!.controllerRevision;
        await unlink(join(parent.path, "..", "manual-qa.md"));
        await writeFile(receiptPath, JSON.stringify(pending));
        await writeFile(
            join(directory, "operation-effect.json"),
            JSON.stringify({
                version: 1,
                receipt: pending,
                path: childMetadataPath,
                identityPath: childMetadataPath,
                targetPlanId: child.attrs.planId,
                beforeHash: hash(childMetadata),
                after: childMetadata,
                afterHash: hash(childMetadata),
            }),
        );
        const recovered = await service.execute(command);
        equal("status" in recovered.result && recovered.result.status, "completed");
        equal(
            (await readPlanResource(fixture.root, { planId: parent.attrs.planId!, planName: "family" }, "manual-qa.md"))
                .body,
            document.body,
        );
        equal((await loadPlan(fixture.root, "family/child"))!.controllerRevision, childRevision);
    } finally {
        await fixture.cleanup();
    }
});

test("non-Git recovery uses trusted execution inspection without a laptop checkout", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    await withProcessGlobalTestLock(async () => {
        const { mkdtemp, mkdir, chmod, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { getHomeDir } = await import("../constants.ts");
        const temporary = await mkdtemp(join(tmpdir(), "managed-non-git-recovery-"));
        const root = join(temporary, "source");
        const remoteHome = join(temporary, "remote-home");
        const bin = join(temporary, "bin");
        for (const path of [root, remoteHome, bin]) await mkdir(path);
        const context = {
            executionAccountHome: remoteHome,
            personalOwner: { kind: "managed-remote" as const, identity: getHomeDir() },
        };
        const admitted = await projects.checkout.admit(root, { context });
        if (admitted.kind !== "existing") throw new Error("Non-Git execution identity was not admitted.");
        const owner = await projects.home.register({
            projectId: admitted.identity.projectId,
            repositoryId: admitted.identity.repositoryId,
            displayName: "Non-Git remote",
        });
        const configuration = {
            bun: process.execPath,
            cli: new URL("../cli.ts", import.meta.url).pathname,
            remoteHome,
        };
        await writeFile(
            join(bin, "ssh"),
            `#!/usr/bin/env python3
import json, os, subprocess, sys
config = json.loads(${JSON.stringify(JSON.stringify(configuration))})
request = json.loads(sys.stdin.readline())
env = dict(os.environ, HOME=config['remoteHome'], WLD_TEST_SANDBOX_HOME=config['remoteHome'], MNEMOTECA_DB_PATH=os.path.join(config['remoteHome'], 'mnemoteca.db'))
result = subprocess.run([config['bun'], config['cli'], '--remote-publication-proof'], input=json.dumps(request['proof']) + '\\n', text=True, env=env)
sys.exit(result.returncode)
`,
        );
        await chmod(join(bin, "ssh"), 0o700);
        const beforePath = process.env.PATH;
        process.env.PATH = `${bin}:${beforePath}`;
        try {
            const service = new PreparedProjectStore(
                owner,
                {
                    projectId: owner.projectId,
                    repositoryId: owner.repositoryId,
                    checkoutId: admitted.identity.checkoutId,
                    checkoutRoot: root,
                    repositoryRoot: root,
                    personalOwner: context.personalOwner,
                },
                { host: "fixture-host", cwd: root, remoteHome, executable: "/verified/runtime/wld" },
            );
            const plan = await service.author({ planName: "non-git", contextMarkdown: "# Non-Git recovery\n" });
            await service.execute({
                kind: "recover-execution",
                operationId: randomUUID(),
                planId: plan.planId,
                expectedRevision: plan.revision,
                attemptId: null,
                action: "non-git",
                controllerRevision: null,
            });
            const current = (await service.execute({ kind: "resolve-plan", reference: plan.planId })).result;
            if (!("plan" in current) || !current.plan) throw new Error("Recovered owner Plan is unavailable.");
            equal(current.plan.attrs.executionMode, "non_git_in_place");
            equal(current.plan.attrs.status, "draft");
            equal(Boolean(current.plan.attrs.verifiedAt), false);
            const git = await (
                await import("@runwield/resources/process")
            ).captureForegroundProcess("git", { cwd: root, args: ["init"] });
            equal(git.success, true);
            await rejects(
                service.execute({
                    kind: "recover-execution",
                    operationId: randomUUID(),
                    planId: plan.planId,
                    expectedRevision: current.plan.revision,
                    attemptId: null,
                    action: "non-git",
                    controllerRevision: null,
                }),
                /proof is unavailable/,
            );
            const after = (await service.execute({ kind: "resolve-plan", reference: plan.planId })).result;
            equal("plan" in after && after.plan?.revision, current.plan.revision);
        } finally {
            if (beforePath === undefined) delete process.env.PATH;
            else process.env.PATH = beforePath;
            await rm(temporary, { recursive: true, force: true });
        }
    });
});

test("managed milestone replay returns the first committed revision after later edits", async () => {
    const fixture = await packageFixture();
    try {
        await authorLocalPlan(fixture.root, { planName: "proposal", contextMarkdown: "# Approved\n" });
        const plan = (await loadPlan(fixture.root, "proposal"))!;
        const service = new PreparedProjectStore(fixture.root);
        const planId = plan.attrs.planId!;
        await service.execute({
            kind: "record-event",
            event: "review_approved",
            planId,
            operationId: randomUUID(),
            expectedRevision: plan.revision!,
        });
        const listed = (await service.execute({ kind: "list-history", reference: planId, offset: 0, snapshot: "" }))
            .result;
        if (!("historyPage" in listed)) throw new Error("Missing history.");
        const history = parseHistoryList(listed.historyPage.text);
        const version = history.milestones[0].version;
        const shown = (
            await service.execute({ kind: "show-history", reference: "proposal", version, offset: 0, snapshot: "" })
        ).result;
        equal("historyPage" in shown && parseMilestoneDocuments(shown.historyPage.text)["context.md"], "# Approved\n");
        const expectedRevision = await savePlanProse(fixture.root, "proposal", "# Changed\n", history.revision);
        const command = {
            kind: "restore-history" as const,
            version,
            operationId: randomUUID(),
            planId,
            expectedRevision,
        };
        const restored = await service.execute(command);
        if (!("revision" in restored.result) || !restored.result.revision) throw new Error("Missing restore outcome.");
        await savePlanProse(fixture.root, "proposal", "# Next\n", restored.result.revision);
        deepEqual(await service.execute(command), restored);
        equal((await loadPlan(fixture.root, "proposal"))!.body, "# Next\n");
    } finally {
        await fixture.cleanup();
    }
});

/** Hold the actual owner response after its operation commits and before execution receives it. */
function observeOwnerResponse(
    endpoint: string,
    observe: (
        kind: string,
        response: Response,
        operationId: string | undefined,
        payload: ProjectStoreRequest,
        body: string,
    ) => Response | Promise<Response>,
) {
    return Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const path = new URL(request.url).pathname;
            const body = path === "/project-store" ? await request.clone().text() : undefined;
            const upstream = await fetch(new Request(new URL(path, endpoint), request));
            if (body === undefined) return upstream;
            const payload: ProjectStoreRequest = JSON.parse(body);
            const { command } = payload;
            return await observe(
                command.kind,
                upstream,
                "operationId" in command ? command.operationId : undefined,
                payload,
                body,
            );
        },
    });
}

interface HistoricalAuthoringInput {
    contextMarkdown: string;
    expectedRevision?: string;
    planName: string;
}

interface HistoricalAuthoringRequest {
    kind: "author-plan" | "create-plan";
    input: HistoricalAuthoringInput;
    operationId?: string;
    planId?: string;
}

interface LegacyAuthoringFixture extends HistoricalAuthoringRequest {
    kind: "author-plan";
    operationId: string;
    planId: string;
}

/** Serialize the authoring fixture fields in the alphabetic order used before the upgrade. */
function historicalAuthoringDigest(
    { ownerId, projectId, repositoryId }: ProjectStoreBinding,
    { input: { contextMarkdown, expectedRevision, planName }, kind, operationId, planId }: HistoricalAuthoringRequest,
): string {
    return hash(
        JSON.stringify({
            binding: { ownerId, projectId, repositoryId },
            command: { input: { contextMarkdown, expectedRevision, planName }, kind, operationId, planId },
        }),
    );
}

function completedAuthoring({ result }: ProjectStoreReply) {
    ok("status" in result && result.status === "completed" && result.planId && result.revision);
    return { planId: result.planId, revision: result.revision };
}

test("checkout-backed authoring prepares the runtime only when an admitted request needs to write", async () => {
    const fixture = await packageFixture();
    try {
        const store = new PreparedProjectStore(fixture.root);
        const gitignore = join(fixture.root, ".gitignore");
        const invalidMarkdown = "---\nstatus: approved\n---\n# Draft\n";
        const create = {
            kind: "create-plan" as const,
            operationId: randomUUID(),
            input: { planName: "checkout-preparation", contextMarkdown: "# Draft\n" },
        };
        await rejects(
            store.execute({
                ...create,
                operationId: randomUUID(),
                input: { ...create.input, contextMarkdown: invalidMarkdown },
            }),
            /Live Plan documents contain Markdown only/,
        );
        await rejects(
            store.execute({
                kind: "revise-plan",
                operationId: randomUUID(),
                planId: randomUUID(),
                expectedRevision: "a".repeat(64),
                input: { contextMarkdown: invalidMarkdown },
            }),
            PlanNotFoundError,
        );
        await rejects(readFile(gitignore, "utf8"), { code: "ENOENT" });

        const created = await store.execute(create);
        const { planId, revision } = completedAuthoring(created);
        await unlink(gitignore);

        deepEqual(await new PreparedProjectStore(fixture.root).execute(create), created);
        await rejects(readFile(gitignore, "utf8"), { code: "ENOENT" });

        const revise = {
            kind: "revise-plan" as const,
            operationId: randomUUID(),
            planId,
            expectedRevision: revision,
            input: { contextMarkdown: "# Revised Plan\n" },
        };
        const revised = await store.execute(revise);
        equal(completedAuthoring(revised).planId, planId);
        await unlink(gitignore);
        deepEqual(await new PreparedProjectStore(fixture.root).execute(revise), revised);
        await rejects(readFile(gitignore, "utf8"), { code: "ENOENT" });
    } finally {
        await fixture.cleanup();
    }
});

test("an unstarted authoring request rechecks its original checkout alias after waiting for the catalog lock", async () => {
    const fixture = await packageFixture();
    const other = await packageFixture();
    const parent = await mkdtemp(join(tmpdir(), "wld-registered-checkout-"));
    try {
        const subdirectory = join(fixture.root, "registered");
        await mkdir(subdirectory);
        const alias = join(parent, "checkout");
        await symlink(subdirectory, alias, "junction");
        const store = new PreparedProjectStore(alias);
        const initial = {
            kind: "create-plan" as const,
            operationId: randomUUID(),
            input: { planName: "already-written", contextMarkdown: "# Written\n" },
        };
        const completed = await store.execute(initial);
        completedAuthoring(completed);

        const { planOperationReceiptDirectory } = await import("@runwield/plans/operation-receipts");
        const catalogPath = join(planOperationReceiptDirectory(fixture.identity), "locks", "catalog.lock");

        for (const target of [undefined, other.root]) {
            const create = {
                ...initial,
                operationId: randomUUID(),
                input: { planName: "must-not-write", contextMarkdown: "# Forbidden write\n" },
            };
            const lock = openNativeFileLock(catalogPath, false);
            const outcomes = await (async () => {
                try {
                    await lock.lock(true);
                    const denied = rejects(store.execute(create), /Project store authority changed/);
                    const replayed = store.execute(initial);
                    await unlink(alias);
                    if (target) await symlink(target, alias, "junction");
                    return { denied, replayed };
                } finally {
                    lock.close();
                }
            })();

            await outcomes.denied;
            deepEqual(await outcomes.replayed, completed);
            equal(await loadPlan(fixture.root, create.input.planName), null);
            equal(await loadPlan(other.root, create.input.planName), null);
            if (!target) await symlink(subdirectory, alias, "junction");
        }
    } finally {
        await rm(parent, { recursive: true, force: true });
        await other.cleanup();
        await fixture.cleanup();
    }
});

test("owner creation restores a missing guard for an unstarted receipt with the original Plan ID", async () => {
    const fixture = await packageFixture();
    try {
        const owner = new PreparedProjectStore(fixture.root);
        const command = {
            kind: "create-plan" as const,
            operationId: randomUUID(),
            input: { planName: "interrupted", contextMarkdown: "# Original Plan\n" },
        };
        const planId = randomUUID();
        const digest = historicalAuthoringDigest(owner.binding, command);
        const directory = join(
            fixture.identity.executionAccountHome,
            ".wld",
            "projects",
            fixture.identity.projectId,
            "internal",
            "plan-packages",
        );
        const receiptPath = join(directory, "operations", `${command.operationId}.json`);
        const guardPath = join(directory, "operation-identities", `${command.operationId}.json`);
        const interrupted = JSON.stringify({
            version: 1,
            operationId: command.operationId,
            digest,
            planId,
            outcome: { operationId: command.operationId, status: "unstarted" },
        });
        await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
        await writeFile(receiptPath, interrupted);
        await rejects(
            owner.execute({ ...command, input: { ...command.input, contextMarkdown: "# Changed request\n" } }),
            /different request/,
        );
        equal(await readFile(receiptPath, "utf8"), interrupted);
        await rejects(readFile(guardPath, "utf8"), { code: "ENOENT" });

        const completed = await new PreparedProjectStore(fixture.root).execute(command);
        equal(completedAuthoring(completed).planId, planId);
        equal((await loadPlan(fixture.root, "interrupted"))?.attrs.planId, planId);
        const guard = await readFile(guardPath, "utf8");
        deepEqual(JSON.parse(guard), { digest });
        await unlink(guardPath);
        await rejects(owner.execute(command), /reservation evidence is unavailable/);
        await writeFile(guardPath, guard);

        const receipt = await readFile(receiptPath, "utf8");
        await unlink(receiptPath);
        await rejects(owner.execute(command), /operation evidence is unavailable/);
        await writeFile(receiptPath, receipt);
        deepEqual(await owner.execute(command), completed);
        equal((await loadPlan(fixture.root, "interrupted"))?.body, command.input.contextMarkdown);
    } finally {
        await fixture.cleanup();
    }
});

async function connectAuthoringOwner(fixture: Awaited<ReturnType<typeof composedRemoteFixture>>) {
    const admission = await fetch(fixture.endpoint + "/project-store/admit", {
        method: "POST",
        headers: fixture.headers,
    });
    equal(admission.status, 200);
    const binding: ProjectStoreBinding = await admission.json();
    const client = new ProjectStoreClient(
        authenticatedProjectStoreRequest(fixture.endpoint, fixture.input.connection.credential),
        binding,
    );
    const send = <Command>(command: Command) =>
        fetch(fixture.endpoint + "/project-store", {
            method: "POST",
            headers: { ...fixture.headers, "Content-Type": "application/json" },
            body: JSON.stringify({ binding, command }),
        });
    return { binding, client, send };
}

test("Desktop resumes a managed CLI share from a linked checkout after losing the owner receipt and links", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(() =>
        withCollaborationServer(async ({ adapter, serverUrl }) => {
            const f = await composedRemoteFixture();
            const requests: ProjectStoreRequest[] = [];
            const linkRequests: string[] = [];
            let lostOwnerReply: ProjectStoreReply | undefined;
            let lostLinksReply: ProjectStoreReply | undefined;
            const proxy = observeOwnerResponse(f.endpoint, async (_kind, response, _id, request) => {
                const { command } = request;
                if (command.kind === "collaboration" && command.intent.action === "share") {
                    requests.push(request);
                    if (response.ok && !lostOwnerReply) {
                        lostOwnerReply = await response.json();
                        return new Response("Owner share reply lost", { status: 503 });
                    }
                }
                if (command.kind === "read-collaboration-result") {
                    linkRequests.push(command.operationId);
                    if (response.ok && !lostLinksReply) {
                        lostLinksReply = await response.json();
                        return new Response("Owner share links lost", { status: 503 });
                    }
                }
                return response;
            });
            try {
                const planId = await f.run("managed-author");
                const linked = await f.addLinkedCheckout();
                const first = await f.runRaw("managed-share", proxy.port, { planServer: serverUrl });
                const stderr = new TextDecoder().decode(first.stderr);
                equal(first.code, 1, stderr);
                ok(lostOwnerReply);
                equal("status" in lostOwnerReply.result && lostOwnerReply.result.status, "completed");
                equal(requests.length, 1);
                deepEqual(linkRequests, []);
                const { command } = requests[0];
                ok(command.kind === "collaboration" && command.intent.action === "share");

                const { client } = await connectAuthoringOwner(f);
                const { result } = await client.execute({
                    kind: "read-collaboration-result",
                    operationId: command.operationId,
                });
                ok("collaborationResult" in result && result.collaborationResult.action === "share");
                const original = result.collaborationResult.value;
                equal(original.planId, planId);
                ok(original.reviewerUrl && original.maintainerUrl);
                const readSpaces = () =>
                    adapter.database.handle
                        .prepare("SELECT id FROM shared_spaces")
                        .all()
                        .map(({ id }) => id);
                deepEqual(readSpaces(), [original.spaceId]);

                const alternateRequests: string[] = [];
                const resumed = await withCollaborationServer(
                    async ({ adapter: alternate, serverUrl: alternateUrl }) => {
                        const options = { planServer: alternateUrl, planId, cwd: linked };
                        const second = await f.runRaw("managed-share-desktop", proxy.port, options);
                        equal(second.code, 1, new TextDecoder().decode(second.stderr));
                        ok(lostLinksReply);
                        deepEqual(lostLinksReply.result, result);
                        deepEqual(requests.slice(1), [requests[0]]);
                        deepEqual(linkRequests, [command.operationId]);
                        const retry: SharedPlan = JSON.parse(await f.run("managed-share-desktop", proxy.port, options));
                        deepEqual(alternate.database.handle.prepare("SELECT id FROM shared_spaces").all(), []);
                        return retry;
                    },
                    (request, serve) => {
                        alternateRequests.push(request.method);
                        return serve(request);
                    },
                );
                equal(resumed.planId, original.planId);
                equal(resumed.spaceId, original.spaceId);
                equal(resumed.serverUrl, serverUrl);
                deepEqual(resumed.links, {
                    reviewerUrl: original.reviewerUrl,
                    maintainerUrl: original.maintainerUrl,
                });
                deepEqual(alternateRequests, []);
                deepEqual(requests.slice(1), [requests[0], requests[0]]);
                deepEqual(linkRequests, [command.operationId, command.operationId]);
                deepEqual(readSpaces(), [original.spaceId]);
            } finally {
                proxy.stop(true);
                await f.cleanup();
            }
        }),
    );
});

test("recovering a successful owner receipt clears the original attempt before unshare and reshare", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        let attemptPath: string;
        let rememberedAttempt: string;
        let originalRequestId: string | null = null;
        let interrupted = false;
        await withCollaborationServer(
            async ({ adapter, serverUrl }) => {
                const f = await composedRemoteFixture();
                const { client, binding } = await connectAuthoringOwner(f);
                const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
                const ownerDirectory = join(owner.executionAccountHome, ".wld");
                const planId = await f.run("managed-author");
                attemptPath = join(
                    ownerDirectory,
                    "plan-share-attempts",
                    `${hash(JSON.stringify([binding.projectId, planId]))}.json`,
                );
                const proxy = observeOwnerResponse(f.endpoint, async (_kind, response, _id, { command }) => {
                    if (
                        command.kind !== "collaboration" ||
                        command.intent.action !== "share" ||
                        !response.ok ||
                        interrupted
                    )
                        return response;
                    const receiptPath = join(
                        ownerDirectory,
                        "projects",
                        binding.projectId,
                        "internal",
                        "plan-packages",
                        "operations",
                        `${command.operationId}.json`,
                    );
                    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
                    // Reproduce interruption after the share result was retained and before the attempt was cleared.
                    await writeFile(attemptPath, rememberedAttempt, { mode: 0o600 });
                    await writeFile(
                        receiptPath,
                        JSON.stringify({
                            ...receipt,
                            outcome: { operationId: command.operationId, status: "pending" },
                        }),
                    );
                    interrupted = true;
                    return new Response("Owner stopped after retaining the result", { status: 503 });
                });
                try {
                    const options = { planServer: serverUrl, planId };
                    const first = await f.runRaw("managed-share-desktop", proxy.port, options);
                    equal(first.code, 1);
                    ok(interrupted);
                    const restored: SharedPlan = JSON.parse(await f.run("managed-share-desktop", proxy.port, options));
                    await rejects(stat(attemptPath), { code: "ENOENT" });

                    const unshared = await client.execute({
                        kind: "collaboration",
                        operationId: randomUUID(),
                        intent: { action: "unshare", options: { target: planId, force: true } },
                    });
                    ok("status" in unshared.result && unshared.result.status === "completed");
                    deepEqual(adapter.database.handle.prepare("SELECT id FROM shared_spaces").all(), []);

                    const alternateRequests: (string | null)[] = [];
                    await withCollaborationServer(
                        async ({ serverUrl: alternateUrl }) => {
                            const shared: SharedPlan = JSON.parse(
                                await f.run("managed-share-desktop", undefined, { planServer: alternateUrl, planId }),
                            );
                            equal(shared.serverUrl, alternateUrl);
                            ok(shared.spaceId !== restored.spaceId);
                            equal(alternateRequests.length, 1);
                            ok(alternateRequests[0] && alternateRequests[0] !== originalRequestId);
                        },
                        (request, serve) => {
                            alternateRequests.push(request.headers.get("Idempotency-Key"));
                            return serve(request);
                        },
                    );
                } finally {
                    proxy.stop(true);
                    await f.cleanup();
                }
            },
            async (request, serve) => {
                const response = await serve(request);
                if (new URL(request.url).pathname === "/api/spaces/replay") {
                    equal(originalRequestId, null, "Owner recovery should use the retained share result.");
                    originalRequestId = request.headers.get("Idempotency-Key");
                    ok(originalRequestId && response.ok);
                    const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
                    rememberedAttempt = JSON.stringify({ ...attempt, created: await response.clone().json() });
                }
                return response;
            },
        );
    });
});

test("managed sharing resumes after a server upgrade and settles a tombstone across a lost owner reply", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        let upgraded = false;
        let dropCreateReply = true;
        let dropOwnerReply = false;
        const serverRequests: string[] = [];
        await withCollaborationServer(
            async ({ adapter, serverUrl }) => {
                const f = await composedRemoteFixture();
                const ownerOperations: string[] = [];
                const proxy = observeOwnerResponse(f.endpoint, (_kind, response, _id, { command }) => {
                    if (command.kind === "collaboration" && command.intent.action === "share") {
                        ownerOperations.push(command.operationId);
                        if (dropOwnerReply && response.ok) {
                            dropOwnerReply = false;
                            return new Response("Owner receipt lost", { status: 503 });
                        }
                    }
                    return response;
                });
                try {
                    const planId = await f.run("managed-author");
                    const options = { planServer: serverUrl, planId };
                    const retry = () => f.runRaw("managed-share-desktop", proxy.port, options);
                    const old = await retry();
                    equal(old.code, 1);
                    ok(new TextDecoder().decode(old.stderr).includes("Upgrade it and retry"));
                    deepEqual(adapter.database.handle.prepare("SELECT id FROM shared_spaces").all(), []);

                    upgraded = true;
                    const lost = await retry();
                    equal(lost.code, 1);
                    const original = adapter.database.handle.prepare("SELECT id FROM shared_spaces").get() as {
                        id: string;
                    } | null;
                    ok(original);
                    adapter.deleteSharedSpace(original.id);
                    dropOwnerReply = true;
                    const lostTombstone = await retry();
                    equal(lostTombstone.code, 1);
                    ok(new TextDecoder().decode(lostTombstone.stderr).includes("503"));
                    const tombstone = await retry();
                    equal(tombstone.code, 1);
                    ok(new TextDecoder().decode(tombstone.stderr).includes("previous share attempt was removed"));
                    deepEqual(adapter.database.handle.prepare("SELECT id FROM shared_spaces").all(), []);
                    deepEqual(ownerOperations, Array(4).fill(ownerOperations[0]));
                    deepEqual(serverRequests, Array(3).fill(serverRequests[0]));

                    const shared: SharedPlan = JSON.parse(await f.run("managed-share-desktop", proxy.port, options));
                    ok(shared.spaceId !== original.id);
                    ok(ownerOperations[4] !== ownerOperations[0]);
                    ok(serverRequests[3] !== serverRequests[0]);
                    deepEqual(adapter.database.handle.prepare("SELECT id FROM shared_spaces").all(), [
                        { id: shared.spaceId },
                    ]);
                } finally {
                    proxy.stop(true);
                    await f.cleanup();
                }
            },
            async (request, serve) => {
                equal(new URL(request.url).pathname, "/api/spaces/replay");
                const requestId = request.headers.get("Idempotency-Key");
                ok(requestId);
                serverRequests.push(requestId);
                if (!upgraded) return new Response(null, { status: 404 });
                const response = await serve(request);
                if (dropCreateReply && response.ok) {
                    dropCreateReply = false;
                    return new Response("Create reply lost", { status: 502 });
                }
                return response;
            },
        );
    });
});

test("a managed CLI share refused before publication does not block Desktop from reopening the share", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(() =>
        withCollaborationServer(async ({ adapter, serverUrl }) => {
            const f = await composedRemoteFixture();
            try {
                const planId = await f.run("managed-author");
                const planServer = { planServer: serverUrl };
                const first = await f.run("managed-share", undefined, planServer);
                const repeat = await f.runRaw("managed-share", undefined, planServer);
                equal(repeat.code, 1);
                ok(new TextDecoder().decode(repeat.stderr).includes("Plan sharing was refused before publication."));

                const opened: SharedPlan = JSON.parse(
                    await f.run("managed-share-desktop", undefined, { ...planServer, planId }),
                );
                equal(opened.planId, planId);
                equal(opened.serverUrl, serverUrl);
                ok(opened.links?.reviewerUrl && opened.links.maintainerUrl);
                ok(first.split("\n").includes(opened.links.reviewerUrl));
                ok(first.split("\n").includes(opened.links.maintainerUrl));
                deepEqual(
                    adapter.database.handle
                        .prepare("SELECT id FROM shared_spaces")
                        .all()
                        .map(({ id }) => id),
                    [opened.spaceId],
                );
            } finally {
                await f.cleanup();
            }
        }),
    );
});

test("managed Plan creation reuses its owner receipt when either the write reply or subsequent read is lost", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        const requests: ProjectStoreRequest[] = [];
        let lost: ProjectStoreReply | undefined;
        let lostResourcePlanId: string | undefined;
        const proxy = observeOwnerResponse(f.endpoint, async (kind, response, _operationId, payload) => {
            if (kind === "create-plan" || kind === "author-plan") requests.push(payload);
            if (kind === "create-plan" && response.ok && !lost) {
                lost = await response.json();
                return new Response("lost", { status: 503 });
            }
            if (payload.command.kind === "plan-resource" && response.ok && lost && !lostResourcePlanId) {
                lostResourcePlanId = payload.command.planId;
                return new Response("lost Plan resource", { status: 503 });
            }
            return response;
        });
        try {
            const first = await f.runRaw("managed-author", proxy.port);
            equal(first.code, 1, new TextDecoder().decode(first.stderr));
            ok(lost);
            const [request] = requests;
            const { command } = request;
            ok(command.kind === "create-plan");
            deepEqual(command, {
                kind: "create-plan",
                operationId: command.operationId,
                input: { planName: "repeatable", contextMarkdown: "# New Plan\n" },
            });
            const created = completedAuthoring(lost);
            ok(created.planId !== command.operationId);
            const { client, send } = await connectAuthoringOwner(f);
            const duplicates = await Promise.all([client.execute(command), client.execute(command)]);
            deepEqual(duplicates, [lost, lost]);
            equal((await send({ ...command, planId: randomUUID() })).status, 400);
            equal((await send({ ...command, input: { ...command.input, planId: randomUUID() } })).status, 400);
            equal((await send({ ...command, input: { ...command.input, contextMarkdown: "Changed" } })).status, 409);
            const readFailed = await f.runRaw("managed-author", proxy.port);
            equal(readFailed.code, 1, new TextDecoder().decode(readFailed.stderr));
            equal(lostResourcePlanId, created.planId);
            const original = await f.run("managed-author", proxy.port);
            equal(original, created.planId);
            deepEqual(requests.slice(0, 3), [request, request, request]);
            const duplicate = await f.runRaw("managed-author", proxy.port);
            ok(duplicate.code !== 0);
            ok(new TextDecoder().decode(duplicate.stderr).includes("Plan already exists."));
            equal(await f.run("managed-author-rename"), original);
            const next = await f.run("managed-author", proxy.port);
            ok(original !== next);
            equal(requests.length, 5);
            equal(new Set(requests.map(({ command }) => "operationId" in command && command.operationId)).size, 3);
            deepEqual(await client.execute(command), lost);
            const { result } = await client.execute({ kind: "list-plans" });
            ok("plans" in result);
            deepEqual(result.plans.map((plan) => [plan.name, plan.attrs.planId]).sort(), [
                ["renamed", original],
                ["repeatable", next],
            ]);
        } finally {
            proxy.stop(true);
            await f.cleanup();
        }
    });
});

test("managed Plan revision requires an exact ID and revision and replays after an independent edit", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        const requests: ProjectStoreRequest[] = [];
        let lost: ProjectStoreReply | undefined;
        const proxy = observeOwnerResponse(f.endpoint, async (kind, response, _operationId, payload) => {
            if (kind === "revise-plan" || kind === "author-plan") requests.push(payload);
            if (kind === "revise-plan" && response.ok && !lost) {
                lost = await response.json();
                return new Response(null, { status: 503 });
            }
            return response;
        });
        try {
            const planId = await f.run("managed-author");
            const { client, send } = await connectAuthoringOwner(f);
            const read = async () => {
                const { result } = await client.execute({ kind: "read", planId, resource: "context.md" });
                ok("body" in result && result.revision);
                return { body: result.body, revision: result.revision };
            };
            const before = await read();
            const contextMarkdown = "# Revised\n";
            const changes = { planId, expectedRevision: before.revision, contextMarkdown };
            const first = await f.runRaw("managed-author-revise", proxy.port, JSON.stringify(changes));
            equal(first.code, 1, new TextDecoder().decode(first.stderr));
            ok(lost);
            const [request] = requests;
            const { command } = request;
            ok(command.kind === "revise-plan");
            deepEqual(command, {
                kind: "revise-plan",
                operationId: command.operationId,
                planId,
                expectedRevision: before.revision,
                input: { contextMarkdown },
            });
            const revised = completedAuthoring(lost);
            equal(revised.planId, planId);
            deepEqual(await read(), { body: contextMarkdown, revision: revised.revision });

            const { expectedRevision: _revision, ...withoutRevision } = command;
            const { planId: _planId, ...withoutPlanId } = command;
            equal((await send(withoutRevision)).status, 400);
            equal((await send(withoutPlanId)).status, 400);
            equal((await send({ ...command, input: { ...command.input, planName: "repeatable" } })).status, 400);
            // "repeatable" is syntactically valid as a legacy Plan ID, but only names this Plan.
            equal(
                (
                    await send({
                        ...command,
                        operationId: randomUUID(),
                        planId: "repeatable",
                        expectedRevision: revised.revision,
                    })
                ).status,
                404,
            );
            equal((await send({ ...command, operationId: randomUUID() })).status, 412);
            equal((await send({ ...command, input: { contextMarkdown: "# Different\n" } })).status, 409);

            const laterBody = "# Independent edit\n";
            const later = completedAuthoring(
                await client.execute({
                    kind: "revise-plan",
                    operationId: randomUUID(),
                    planId,
                    expectedRevision: revised.revision,
                    input: { contextMarkdown: laterBody },
                }),
            );
            const retry: ProjectPlanDocument = JSON.parse(
                await f.run("managed-author-revise", proxy.port, JSON.stringify(changes)),
            );
            equal(retry.planId, planId);
            deepEqual(requests, [request, request]);
            deepEqual(await Promise.all([client.execute(command), client.execute(command)]), [lost, lost]);
            deepEqual(await read(), { body: laterBody, revision: later.revision });
            const wrongName = await f.runRaw(
                "managed-author-by-reference",
                proxy.port,
                JSON.stringify({ ...changes, planName: "another-name", expectedRevision: later.revision }),
            );
            equal(wrongName.code, 1);
            ok(new TextDecoder().decode(wrongName.stderr).includes("The bound Plan identity changed."));
            deepEqual(requests, [request, request]);
            const stale = await f.runRaw(
                "managed-author-revise",
                proxy.port,
                JSON.stringify({ ...changes, contextMarkdown: "# Competing change\n" }),
            );
            equal(stale.code, 1);
            ok(/revision|stale/i.test(new TextDecoder().decode(stale.stderr)));
            deepEqual(await read(), { body: laterBody, revision: later.revision });

            const archived = await client.execute({
                kind: "archive-plan",
                operationId: randomUUID(),
                planId,
                expectedRevision: later.revision,
                reason: "Test retained receipts",
                force: true,
                now: "",
            });
            ok("status" in archived.result && archived.result.status === "completed");
            const fresh = {
                ...command,
                operationId: randomUUID(),
                expectedRevision: later.revision,
                input: { contextMarkdown: "# Must stay archived\n" },
            };
            equal((await send(fresh)).status, 404);
            await rejects(client.execute(fresh), PlanNotFoundError);
            const archivedRevision = await f.runRaw(
                "managed-author-revise",
                proxy.port,
                JSON.stringify({
                    planId,
                    expectedRevision: fresh.expectedRevision,
                    contextMarkdown: fresh.input.contextMarkdown,
                }),
            );
            equal(archivedRevision.code, 1);
            ok(new TextDecoder().decode(archivedRevision.stderr).includes("PlanNotFoundError"));
            deepEqual(await client.execute(command), lost);
        } finally {
            proxy.stop(true);
            await f.cleanup();
        }
    });
});

test("managed legacy share retries use retained owner evidence and refuse a reused Plan label", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(() =>
        withCollaborationServer(async ({ adapter: privateServer, serverUrl: privateUrl }) => {
            const f = await composedRemoteFixture();
            const replays: ProjectStoreRequest[] = [];
            const proxy = observeOwnerResponse(f.endpoint, (_kind, response, _id, request) => {
                if (request.command.kind === "collaboration") replays.push(request);
                return response;
            });
            try {
                const originalId = await f.run("managed-author");
                const { client, binding } = await connectAuthoringOwner(f);
                const journalDirectory = await f.run("managed-author-legacy-directory");
                const retainShare = async (target: string) => {
                    const intent = { action: "share" as const, options: { target, planServer: privateUrl } };
                    const command = { kind: "collaboration" as const, operationId: randomUUID(), intent };
                    const { ownerId, projectId, repositoryId } = binding;
                    const key = hash(
                        JSON.stringify({
                            binding: { ownerId, projectId, repositoryId },
                            command: {
                                intent: { action: "share", options: { planServer: privateUrl, target } },
                                kind: "collaboration",
                            },
                        }),
                    );
                    const path = join(journalDirectory, `managed-operation-${key}.json`);
                    const body = JSON.stringify({ binding, command });
                    await writeFile(path, body);
                    return { path, body, command };
                };
                const { result: original } = await client.execute({ kind: "plan-resource", planId: originalId });
                ok("planResource" in original);
                const oldName = original.planResource.name;
                const ambiguous = await retainShare(oldName);
                await client.execute({
                    kind: "rename-plan",
                    operationId: randomUUID(),
                    planId: originalId,
                    expectedRevision: original.planResource.revision,
                    name: "renamed-original",
                });
                const create = async (planName: string) => {
                    const reply = await client.execute({
                        kind: "create-plan",
                        operationId: randomUUID(),
                        input: { planName, contextMarkdown: "# Replacement text\n" },
                    });
                    return completedAuthoring(reply).planId;
                };
                const replacement = await create(oldName);
                const unrelated = await create("unrelated");
                const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
                const { operationReceiptResultPath, planOperationReceiptDirectory } =
                    await import("@runwield/plans/operation-receipts");
                const effect = operationReceiptResultPath(
                    planOperationReceiptDirectory(owner),
                    ambiguous.command.operationId,
                    "collaboration-effects",
                );
                await withCollaborationServer(async ({ serverUrl }) => {
                    const attempt = await f.runRaw("managed-share-desktop", proxy.port, {
                        planServer: serverUrl,
                        planId: replacement,
                    });
                    equal(attempt.code, 1);
                    ok(new TextDecoder().decode(attempt.stderr).includes("without durable identity"));
                    equal(await readFile(ambiguous.path, "utf8"), ambiguous.body);
                    deepEqual(replays, []);
                    deepEqual(privateServer.database.handle.prepare("SELECT id FROM shared_spaces").all(), []);

                    const fresh: SharedPlan = JSON.parse(
                        await f.run("managed-share-desktop", proxy.port, { planServer: serverUrl, planId: unrelated }),
                    );
                    equal(fresh.planId, unrelated);
                    equal(fresh.serverUrl, serverUrl);
                    deepEqual(privateServer.database.handle.prepare("SELECT id FROM shared_spaces").all(), []);

                    await mkdir(dirname(effect), { recursive: true });
                    await writeFile(effect, JSON.stringify({ started: true }));
                    const uncertain = await f.runRaw("managed-share-desktop", proxy.port, {
                        planServer: serverUrl,
                        planId: originalId,
                    });
                    equal(uncertain.code, 1);
                    ok(new TextDecoder().decode(uncertain.stderr).includes("may have published"));
                    equal(replays.length, 1);
                    equal(await readFile(ambiguous.path, "utf8"), ambiguous.body);
                    await unlink(effect);

                    const verified = await retainShare("renamed-original");
                    await client.execute(verified.command);
                    const { result } = await client.execute({
                        kind: "read-collaboration-result",
                        operationId: verified.command.operationId,
                    });
                    ok("collaborationResult" in result && result.collaborationResult.action === "share");
                    const originalShare = result.collaborationResult.value;
                    // Model historical storage whose label changed after the owner recorded the legacy outcome.
                    const { readPlanPackage, renamePlanPackage } = await import("@runwield/plans/package-storage");
                    const saved = await readPlanPackage(owner, { planId: originalId });
                    ok(saved.kind === "loaded");
                    await renamePlanPackage(owner, originalId, saved.metadata.revision, "relabelled-after-sharing");
                    await create("renamed-original");
                    const resumed: SharedPlan = JSON.parse(
                        await f.run("managed-share-desktop", proxy.port, { planServer: serverUrl, planId: originalId }),
                    );
                    deepEqual(replays.at(-1), { binding, command: verified.command });
                    equal(resumed.serverUrl, privateUrl);
                    equal(resumed.spaceId, originalShare.spaceId);
                    equal(resumed.links?.reviewerUrl, originalShare.reviewerUrl);
                    equal(resumed.links?.maintainerUrl, originalShare.maintainerUrl);
                    deepEqual(privateServer.database.handle.prepare("SELECT id FROM shared_spaces").all(), [
                        { id: originalShare.spaceId },
                    ]);
                    await rejects(readFile(verified.path), { code: "ENOENT" });
                    equal(await readFile(ambiguous.path, "utf8"), ambiguous.body);
                });
            } finally {
                proxy.stop(true);
                await f.cleanup();
            }
        }),
    );
});

test("managed authoring delivers unsent legacy create and revise journals and replays their original receipts", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        const deliveries: { body: string; reply: ProjectStoreReply }[] = [];
        const dropped = new Set<string>();
        const proxy = observeOwnerResponse(f.endpoint, async (kind, response, operationId, _payload, body) => {
            if (kind === "author-plan" && response.ok && operationId) {
                const reply: ProjectStoreReply = await response.clone().json();
                deliveries.push({ body, reply });
                if (!dropped.has(operationId)) {
                    dropped.add(operationId);
                    return new Response("lost legacy reply", { status: 503 });
                }
            }
            return response;
        });
        try {
            const { client, binding } = await connectAuthoringOwner(f);
            const journalDirectory = await f.run("managed-author-legacy-directory");
            await writeFile(join(journalDirectory, `managed-operation-${hash("unrelated")}.json`), "broken JSON");
            const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
            const ownerDirectory = join(
                owner.executionAccountHome,
                ".wld",
                "projects",
                owner.projectId,
                "internal",
                "plan-packages",
            );
            // The pre-upgrade client prepared a local journal before sending the request.
            const retain = async (command: LegacyAuthoringFixture) => {
                const { kind, operationId, planId, input } = command;
                const intent = input.expectedRevision === undefined ? { kind, input } : { kind, planId, input };
                const key = historicalAuthoringDigest(binding, intent);
                const body = JSON.stringify({ binding, command });
                const journalPath = join(journalDirectory, `managed-operation-${key}.json`);
                await writeFile(journalPath, body);
                const identityPath = join(ownerDirectory, "operation-identities", `${operationId}.json`);
                const digest = historicalAuthoringDigest(binding, command);
                const receiptPath = join(ownerDirectory, "operations", `${operationId}.json`);
                await rejects(readFile(identityPath, "utf8"), { code: "ENOENT" });
                await rejects(readFile(receiptPath, "utf8"), { code: "ENOENT" });
                return async () => {
                    equal(deliveries.length, 1);
                    const [delivery] = deliveries.splice(0);
                    equal(delivery.body, body);
                    const receipt = await readFile(receiptPath, "utf8");
                    deepEqual(JSON.parse(receipt), {
                        version: 1,
                        operationId,
                        digest,
                        planId,
                        outcome: delivery.reply.result,
                    });
                    deepEqual(JSON.parse(await readFile(identityPath, "utf8")), { digest });
                    return { receipt, ...completedAuthoring(delivery.reply) };
                };
            };

            const planId = randomUUID();
            const verifyCreationDelivery = await retain({
                kind: "author-plan",
                operationId: randomUUID(),
                planId,
                input: { planName: "repeatable", contextMarkdown: "# New Plan\n" },
            });
            equal((await f.runRaw("managed-author", proxy.port)).code, 1);
            const created = await verifyCreationDelivery();
            equal(created.planId, planId);
            equal(await f.run("managed-author", proxy.port), planId);
            deepEqual(await verifyCreationDelivery(), created);

            const expectedRevision = created.revision;
            const contextMarkdown = "# From the older client\n";
            const verifyRevisionDelivery = await retain({
                kind: "author-plan",
                operationId: randomUUID(),
                planId,
                input: { contextMarkdown, expectedRevision, planName: "repeatable" },
            });
            const changes = JSON.stringify({ planId, contextMarkdown, expectedRevision });
            equal((await f.runRaw("managed-author-revise", proxy.port, changes)).code, 1);
            const revised = await verifyRevisionDelivery();
            equal(revised.planId, planId);
            const laterBody = "# Independent edit after the upgrade\n";
            const later = completedAuthoring(
                await client.execute({
                    kind: "revise-plan",
                    operationId: randomUUID(),
                    planId,
                    expectedRevision: revised.revision,
                    input: { contextMarkdown: laterBody },
                }),
            );
            const retry: ProjectPlanDocument = JSON.parse(await f.run("managed-author-revise", proxy.port, changes));
            equal(retry.planId, planId);
            deepEqual(await verifyRevisionDelivery(), revised);
            const { result } = await client.execute({ kind: "read", planId, resource: "context.md" });
            ok("body" in result);
            equal(result.body, laterBody);
            equal(result.revision, later.revision);
        } finally {
            proxy.stop(true);
            await f.cleanup();
        }
    });
});

test("managed multi-file edit resumes a dropped successful response and preserves independent source edits", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        let dropped = false;
        const proxy = observeOwnerResponse(f.endpoint, (kind, r) => {
            if (kind === "edit-documents" && r.ok && !dropped) {
                dropped = true;
                return new Response(null, { status: 503 });
            }
            return r;
        });
        try {
            await f.run("managed-mixed-seed");
            const edit = async (port?: number) => JSON.parse(await f.run("managed-mixed-edit", port));
            equal((await edit(proxy.port)).isError, true);
            equal(dropped, true);
            const after = JSON.parse(await f.run("managed-mixed-inspect"));
            equal(after.body, "Updated Plan");
            equal(after.source, "Original source");
            const source = join(f.root, "source.txt");
            const retainedSource = join(f.root, "retained-source.txt");
            await rename(source, retainedSource);
            await writeFile(source, "Original source");
            equal((await edit()).isError, true);
            equal(await readFile(source, "utf8"), "Original source");
            await unlink(source);
            await symlink(retainedSource, source, "file");
            equal((await edit()).isError, true);
            equal(await readFile(retainedSource, "utf8"), "Original source");
            await unlink(source);
            await rename(retainedSource, source);
            await writeFile(source, "Independent edit");
            equal((await edit()).isError, true);
            equal(await readFile(source, "utf8"), "Independent edit");
            await writeFile(source, "Original source");
            equal((await edit()).isError, undefined);
            deepEqual(JSON.parse(await f.run("managed-mixed-inspect")), {
                body: "Updated Plan",
                revision: after.revision,
                source: "Updated source",
            });
        } finally {
            proxy.stop(true);
            await f.cleanup();
        }
    });
});

async function markEarlierSourceMtime(path: string) {
    const before = await stat(path, { bigint: true });
    // macOS can move the birth time when utimes predates it.
    const historicTime = new Date(Number(before.birthtimeMs) + 1);
    await utimes(path, historicTime, historicTime);
    const marked = await stat(path, { bigint: true });
    equal(marked.birthtimeNs, before.birthtimeNs);
    return marked.mtimeNs;
}

test("a managed multi-file retry preserves independent changes to already settled source files", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        const source = join(f.root, "source.txt");
        const cleared = join(f.root, "clear.txt");
        const conflict = join(f.root, "conflict.txt");
        let interfere = true;
        const proxy = observeOwnerResponse(f.endpoint, async (kind, response) => {
            if (kind === "edit-documents" && response.ok && interfere) {
                interfere = false;
                await writeFile(conflict, "Independent edit");
            }
            return response;
        });
        try {
            await f.run("managed-mixed-seed");
            await writeFile(cleared, "Remove me");
            await writeFile(conflict, "Before");
            const edit = async () => JSON.parse(await f.run("managed-mixed-batch-edit", proxy.port));
            equal((await edit()).isError, true);
            equal(interfere, false);
            const first = JSON.parse(await f.run("managed-mixed-inspect"));
            equal(first.body, "Updated Plan");
            equal(first.source, "Updated source");
            equal(await readFile(cleared, "utf8"), "");
            equal(await readFile(conflict, "utf8"), "Independent edit");

            // The bytes look like a completed prefix whose original suffix was never truncated.
            await writeFile(source, "Updated sourcee");
            await writeFile(conflict, "Before");
            equal((await edit()).isError, true);
            equal(await readFile(source, "utf8"), "Updated sourcee");
            equal(await readFile(conflict, "utf8"), "Before");

            await writeFile(source, "Updated source");
            await writeFile(cleared, "Remove me");
            equal((await edit()).isError, true);
            equal(await readFile(cleared, "utf8"), "Remove me");

            await writeFile(cleared, "");
            const sourceTime = await markEarlierSourceMtime(source);
            const clearedTime = await markEarlierSourceMtime(cleared);
            const settled = await edit();
            equal(settled.isError, undefined, JSON.stringify(settled));
            equal((await stat(source, { bigint: true })).mtimeNs, sourceTime);
            equal((await stat(cleared, { bigint: true })).mtimeNs, clearedTime);
            equal(await readFile(conflict, "utf8"), "After");
            deepEqual(JSON.parse(await f.run("managed-mixed-inspect")), first);
        } finally {
            proxy.stop(true);
            await f.cleanup();
        }
    });
});

test("a managed multi-file retry preserves a partial source after a crash before its checkpoint", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        const source = join(f.root, "source.txt");
        const cleared = join(f.root, "clear.txt");
        const later = join(f.root, "conflict.txt");
        try {
            await f.run("managed-mixed-seed");
            await writeFile(cleared, "Remove me");
            await writeFile(later, "Before");
            const before = JSON.parse(await f.run("managed-mixed-inspect"));
            const crash = await f.runRaw("managed-mixed-batch-edit", undefined, "before-checkpoint");
            equal(crash.code, 128 + constants.signals.SIGKILL, new TextDecoder().decode(crash.stderr));
            const interrupted = JSON.parse(await f.run("managed-mixed-inspect"));
            equal(interrupted.body, "Updated Plan");
            equal(interrupted.revision === before.revision, false);
            equal(interrupted.source, "Updginal source");
            const { mtimeNs } = await stat(source, { bigint: true });

            const retry = JSON.parse(await f.run("managed-mixed-batch-edit"));
            equal(retry.isError, true);
            equal(retry.content[0].text, "File changed before edit: " + source);
            equal((await stat(source, { bigint: true })).mtimeNs, mtimeNs);
            equal(await readFile(cleared, "utf8"), "Remove me");
            equal(await readFile(later, "utf8"), "Before");
            deepEqual(JSON.parse(await f.run("managed-mixed-inspect")), interrupted);

            await writeFile(source, before.source);
            const restored = JSON.parse(await f.run("managed-mixed-batch-edit"));
            equal(restored.isError, undefined, JSON.stringify(restored));
            deepEqual(JSON.parse(await f.run("managed-mixed-inspect")), { ...interrupted, source: "Updated source" });
            equal(await readFile(cleared, "utf8"), "");
            equal(await readFile(later, "utf8"), "After");
        } finally {
            await f.cleanup();
        }
    });
});

test("a managed multi-file retry syncs a truncated source and settles later edits", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        const source = join(f.root, "source.txt");
        const cleared = join(f.root, "clear.txt");
        const later = join(f.root, "conflict.txt");
        try {
            await f.run("managed-mixed-seed");
            await writeFile(cleared, "Remove me");
            await writeFile(later, "Before");
            const failed = JSON.parse(await f.run("managed-mixed-batch-edit", undefined, "after-truncate"));
            equal(failed.isError, true);
            equal(failed.content[0].text, "Interrupted while syncing the truncated source file.");
            const first = JSON.parse(await f.run("managed-mixed-inspect"));
            equal(first.body, "Updated Plan");
            equal(first.source, "Updated source");
            equal(await readFile(cleared, "utf8"), "Remove me");
            equal(await readFile(later, "utf8"), "Before");

            const sourceTime = await markEarlierSourceMtime(source);
            // A failed sync must leave this file pending on the next attempt too.
            for (let attempt = 0; attempt < 2; attempt++) {
                const retryFailed = JSON.parse(await f.run("managed-mixed-batch-edit", undefined, "retry-sync"));
                equal(retryFailed.isError, true);
                equal(retryFailed.content[0].text, "Interrupted while syncing the settled source on retry.");
                equal((await stat(source, { bigint: true })).mtimeNs, sourceTime);
                equal(await readFile(cleared, "utf8"), "Remove me");
                equal(await readFile(later, "utf8"), "Before");
            }

            const settled = JSON.parse(await f.run("managed-mixed-batch-edit"));
            equal(settled.isError, undefined, JSON.stringify(settled));
            equal((await stat(source, { bigint: true })).mtimeNs, sourceTime);
            equal(await readFile(cleared, "utf8"), "");
            equal(await readFile(later, "utf8"), "After");
            deepEqual(JSON.parse(await f.run("managed-mixed-inspect")), first);
        } finally {
            await f.cleanup();
        }
    });
});

test("managed artifact retries replay unresolved receipts and fresh calls receive a new disposition", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    const { ProjectStoreClient } = await import("../shared/remote/project-store-client.ts");
    const { operationDigest } = await import("@runwield/plans/operation-receipts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        const requests: string[] = [];
        let dropReply = false;
        let lostRevision = "";
        const proxy = observeOwnerResponse(f.endpoint, async (kind, response, operationId) => {
            if (kind !== "save-epic-artifact" && kind !== "append-epic-qa") return response;
            if (operationId) requests.push(operationId);
            if (!dropReply || !response.ok) return response;
            dropReply = false;
            const reply: import("./index.ts").ProjectStoreReply = await response.json();
            if ("revision" in reply.result) lostRevision = reply.result.revision!;
            return new Response(null, { status: 503 });
        });
        try {
            const seeded: import("@runwield/plans/store").ProjectPlanDocument = JSON.parse(
                await f.run("managed-artifact-seed"),
            );
            const admission = await fetch(f.endpoint + "/project-store/admit", { method: "POST", headers: f.headers });
            equal(admission.status, 200);
            const client = new ProjectStoreClient(
                authenticatedProjectStoreRequest(f.endpoint, f.input.connection.credential),
                await admission.json(),
            );
            let currentRevision = seeded.revision;
            for (const revisionSource of ["explicit", "observed"]) {
                requests.length = 0;
                dropReply = true;
                lostRevision = "";
                const body = `# First ${revisionSource} report\n`;
                const later = `# Later ${revisionSource} report\n`;
                const revision = revisionSource === "explicit" ? currentRevision : undefined;
                const payload = JSON.stringify({ body, revision });
                const first = await f.runRaw("managed-artifact-save", proxy.port, payload);
                equal(first.code, 1);
                equal(dropReply, false);
                ok(lostRevision);
                const write = await client.execute({
                    kind: "save-epic-artifact",
                    planId: seeded.planId,
                    resource: "integration-report.md",
                    operationId: randomUUID(),
                    body: later,
                    expectedRevision: lostRevision,
                });
                ok("revision" in write.result && write.result.revision);
                currentRevision = write.result.revision;

                const retry: import("@runwield/plans/store").ProjectPlanArtifact = JSON.parse(
                    await f.run("managed-artifact-save", proxy.port, payload),
                );
                equal(retry.body, body);
                equal(retry.revision, lostRevision);
                equal(requests.length, 2);
                equal(requests[0], requests[1]);

                if (revisionSource === "explicit") {
                    const journals = new Bun.Glob("**/managed-operations/managed-operation-*.json");
                    let journalDirectory = "";
                    for await (const path of journals.scan({ cwd: f.remoteHome, absolute: true, dot: true })) {
                        if ((await readFile(path, "utf8")).includes(requests[0])) {
                            journalDirectory = dirname(path);
                            break;
                        }
                    }
                    ok(journalDirectory);
                    const legacyIntent = {
                        kind: "save-epic-artifact",
                        planId: seeded.planId,
                        expectedRevision: revision,
                        resource: "integration-report.md",
                        body,
                    };
                    const binding = client.binding;
                    const legacyKey = operationDigest(JSON.stringify({ binding, command: legacyIntent }));
                    await writeFile(
                        join(journalDirectory, `managed-operation-${legacyKey}.json`),
                        JSON.stringify({ binding, command: { ...legacyIntent, operationId: requests[0] } }),
                    );

                    const fresh = await f.runRaw("managed-artifact-save", proxy.port, payload);
                    ok(new TextDecoder().decode(fresh.stderr).includes("StalePlanWriteError"));
                    equal(fresh.code, 1);
                    ok(requests[2] && requests[2] !== requests[0]);
                }
                const stored = await client.execute({
                    kind: "read-documents",
                    planId: seeded.planId,
                    resource: "integration-report.md",
                });
                ok("documentView" in stored.result);
                equal(stored.result.documentView.body, later);
                equal(stored.result.documentView.revision, currentRevision);
            }

            await f.run("managed-artifact-prepare-qa");
            requests.length = 0;
            dropReply = true;
            equal((await f.runRaw("managed-artifact-qa", proxy.port)).code, 1);
            equal(dropReply, false);
            equal(await f.run("managed-artifact-qa", proxy.port), "recorded");
            equal(await f.run("managed-artifact-qa", proxy.port), "already_present");
            equal(requests.length, 3);
            equal(requests[0], requests[1]);
            ok(requests[2] && requests[2] !== requests[0]);
        } finally {
            proxy.stop(true);
            await f.cleanup();
        }
    });
});

test("managed Work Record creation recovers a lost reply with the owner's exact record", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        let writeRequests = 0;
        let lost: import("../shared/remote/project-store-protocol.ts").ProjectStoreRequest | undefined;
        const proxy = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(request) {
                const path = new URL(request.url).pathname;
                const forward = () => fetch(new Request(new URL(path, f.endpoint), request));
                if (path === "/project-store") {
                    const payload: import("../shared/remote/project-store-protocol.ts").ProjectStoreRequest =
                        await request.clone().json();
                    if (payload.command.kind === "create-project-work-record") writeRequests++;
                    if (!lost && payload.command.kind === "create-project-work-record") {
                        const reply = await forward();
                        if (reply.status === 200) {
                            lost = payload;
                            return new Response(null, { status: 502 });
                        }
                        return reply;
                    }
                }
                return await forward();
            },
        });
        try {
            const send = <Payload>(payload: Payload) =>
                fetch(f.endpoint + "/project-store", {
                    method: "POST",
                    headers: { ...f.headers, "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
            const admission = await fetch(f.endpoint + "/project-store/admit", { method: "POST", headers: f.headers });
            equal(admission.status, 200);
            const first = await f.runRaw("managed-create-project-record", proxy.port);
            equal(first.code, 1, new TextDecoder().decode(first.stderr));
            if (!lost || lost.command.kind !== "create-project-work-record")
                throw new Error(
                    `Expected an owner-confirmed creation with a lost reply. ${new TextDecoder().decode(first.stderr)}`,
                );
            const { binding, command } = lost;
            const read = async () => {
                const response = await send({ binding, command: { kind: "record-catalog" } });
                equal(response.status, 200);
                const { result }: import("./index.ts").ProjectStoreReply = await response.json();
                if (!("recordResources" in result)) throw new Error("Missing canonical Work Record catalog.");
                return result.recordResources.map((record) => record.attrs.recordId);
            };
            const beforeRetry = await read();
            equal(beforeRetry.length, 1);
            const journals = new Bun.Glob("**/managed-operations/managed-operation-*.json");
            let journalPath: string | undefined;
            let journal: string | undefined;
            for await (const path of journals.scan({ cwd: f.remoteHome, absolute: true, dot: true })) {
                const text = await readFile(path, "utf8");
                if (text.includes(command.operationId)) {
                    journalPath = path;
                    journal = text;
                    break;
                }
            }
            ok(journalPath && journal);
            const beforeRejectedRetries = writeRequests;
            for (const [retained, message] of [
                [{ binding: { ...binding, ownerId: "0".repeat(64) }, command }, /operation owner changed/],
                [
                    { binding, command: { ...command, input: { ...command.input, body: "Other work" } } },
                    /operation intent changed/,
                ],
                [{ binding, command: { ...command, operationId: "bad" } }, /Invalid operation identity/],
                [
                    { binding, command: { ...command, operationId: "bad" }, acknowledged: true },
                    /Invalid operation identity/,
                ],
                [{ binding, command, acknowledged: "false" }, /Invalid managed operation journal/],
            ] as const) {
                await writeFile(journalPath, JSON.stringify(retained));
                const rejected = await f.runRaw("managed-create-project-record", proxy.port);
                equal(rejected.code, 1);
                ok(message.test(new TextDecoder().decode(rejected.stderr)));
                equal(await readFile(journalPath, "utf8"), JSON.stringify(retained));
            }
            equal(writeRequests, beforeRejectedRetries);
            await writeFile(journalPath, journal);
            const createdId = await f.run("managed-create-project-record", proxy.port);
            equal(createdId, beforeRetry[0]);
            deepEqual(await read(), beforeRetry);
            equal(
                (await send({ binding, command: { ...command, input: { ...command.input, recordId: randomUUID() } } }))
                    .status,
                400,
            );
            equal(
                (
                    await send({
                        binding,
                        command: { ...command, input: { ...command.input, body: command.input.body + "\n" } },
                    })
                ).status,
                409,
            );
            const { recordAttrs } = await import("../shared/work-records/test-fixtures/package-records.ts");
            const serialized = workRecords.documents.format(recordAttrs(), command.input.body);
            equal(
                (
                    await send({
                        binding,
                        command: {
                            ...command,
                            operationId: randomUUID(),
                            input: { ...command.input, body: serialized },
                        },
                    })
                ).status,
                400,
            );
            equal((await send({ binding: { ...binding, ownerId: "0".repeat(64) }, command })).status, 403);
            equal(
                (await send({ binding, command: { kind: "repair-owner", operationId: command.operationId } })).status,
                409,
            );
            const repairId = randomUUID();
            equal((await send({ binding, command: { kind: "repair-owner", operationId: repairId } })).status, 200);
            equal((await send({ binding, command: { ...command, operationId: repairId } })).status, 409);

            const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
            const receiptPath = join(
                workRecordFiles.forOwner(owner).layout.internal,
                "creations",
                `${command.operationId}.json`,
            );
            const receipt: { markdown: string } = JSON.parse(await readFile(receiptPath, "utf8"));
            await unlink(receiptPath);
            equal((await send({ binding, command })).status, 409);
            await writeFile(receiptPath, JSON.stringify({ ...receipt, markdown: receipt.markdown + "\nAltered." }));
            equal((await send({ binding, command })).status, 409);
            deepEqual(await read(), beforeRetry);

            const second = await f.run("managed-create-project-record", proxy.port);
            equal(second === createdId, false);
            deepEqual((await read()).sort(), [createdId, second].sort());
        } finally {
            proxy.stop(true);
            await f.cleanup();
        }
    });
});

test("managed bulk document edits publish one generation only if every Plan still matches", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        try {
            equal(await f.run("managed-edit-documents"), "verified");
        } finally {
            await f.cleanup();
        }
    });
});

test("managed pruning changes laptop records and bound execution copies while manual SSH retains execution-account records", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        try {
            await f.run("manual-prune-seed");
            const admission = await fetch(f.endpoint + "/project-store/admit", { method: "POST", headers: f.headers });
            equal(admission.status, 200);
            const binding: import("@runwield/plans/project-store-wire").ProjectStoreBinding = await admission.json();
            const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
            const cwd = projects.home.storeLocation(owner);
            const { readLocalHomeStore } = await import("./index.ts");
            const { restoreWorkRecordDocument, listWorkRecords } = await import("../shared/work-records/store.ts");
            const { recordAttrs, recordBody } = await import("../shared/work-records/test-fixtures/package-records.ts");
            const { retainWorkRecordLocation, workRecordDigest } = await import("../shared/work-records/import.ts");
            const copy = join(f.root, "delivered-record.md");
            await projects.home.withOwner(owner, () =>
                readLocalHomeStore(
                    cwd,
                    async () => {
                        const record = await restoreWorkRecordDocument(cwd, recordAttrs(), recordBody);
                        await writeFile(copy, record.markdown);
                        await retainWorkRecordLocation(record.attrs.recordId, {
                            kind: "copy",
                            sourcePath: copy,
                            repositoryPath: "delivered-record.md",
                            repositoryId: binding.repositoryId,
                            digest: workRecordDigest(record.markdown),
                        });
                    },
                    () => {
                        throw new Error("Missing laptop store.");
                    },
                ),
            );
            const localRoot = await mkdtemp(join(tmpdir(), "laptop-prune-decoy-"));
            const decoy = join(localRoot, "delivered-record.md");
            const pendingBytes = await readFile(copy);
            await writeFile(decoy, pendingBytes);
            const executionCopy = join(f.root, "parked-execution-copy.md");
            let observed = false;
            const proxy = Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                async fetch(request) {
                    const path = new URL(request.url).pathname;
                    const forward = () => fetch(new Request(new URL(path, f.endpoint), request));
                    if (
                        path !== "/project-store" ||
                        (await request.clone().json()).command?.kind !== "confirm-retention"
                    )
                        return await forward();
                    // Both hosts name the same absolute path. Give each request its own file at that path.
                    await rename(copy, executionCopy);
                    await rename(decoy, copy);
                    try {
                        const response = await forward();
                        deepEqual(await readFile(copy), pendingBytes);
                        observed = response.ok;
                        return response;
                    } finally {
                        await rename(copy, decoy);
                        await rename(executionCopy, copy);
                    }
                },
            });
            let result: string;
            try {
                result = await f.run("managed-prune", proxy.port);
                equal(observed, true);
                deepEqual(await readFile(decoy), pendingBytes);
            } finally {
                proxy.stop(true);
                await rm(localRoot, { recursive: true, force: true });
            }

            equal(result.includes("Pruned 1 Work Record"), true, result);
            await rejects(readFile(copy), { code: "ENOENT" });
            await projects.home.withOwner(owner, async () => equal((await listWorkRecords(cwd)).length, 0));
            deepEqual(JSON.parse(await f.run("manual-prune-list")), ["aaaa1111-1111-4111-8111-111111111111"]);
        } finally {
            await f.cleanup();
        }
    });
});

test("a retained publication pins its declared predecessor before the Recorder writes output", async () => {
    const f = await packageFixture();
    try {
        const { create } = await import("../shared/testing/plan-package-fixture.ts");
        const { withWorkRecordOwner } = await import("../shared/work-records/owner.ts");
        const { capturePlanPackageInput, retainPlanPackagePublication } =
            await import("@runwield/plans/package-storage");
        const { localConfirmRetention, localRetentionPreview } = await import("./retention.ts");
        const { recordAttrs, recordBody } = await import("../shared/work-records/test-fixtures/package-records.ts");
        const { restoreWorkRecordDocument } = await import("../shared/work-records/store.ts");
        const predecessor = await withWorkRecordOwner(f.root, f.identity, () =>
            restoreWorkRecordDocument(f.root, recordAttrs({ provenance: { sourcePlans: ["other-plan"] } }), recordBody),
        );
        const plan = await create(f.identity, {
            definition: {
                classification: "PLANNED_CHANGE",
                status: "verified",
                supersedes: [predecessor.attrs.recordId.toUpperCase()],
            },
        });
        const planId = plan.metadata.planId;
        const attemptId = randomUUID();
        const member = {
            metadata: plan.metadata,
            controller: {},
            input: await capturePlanPackageInput(f.identity, planId),
        };
        const source = await retainPlanPackagePublication(f.identity, {
            planId,
            attemptId,
            validatedCommit: "abc123",
            targetBranch: "main",
            planCopies: false,
            copies: [],
            members: [member],
        });
        const immediate = { retentionDays: 0, keepLast: 0 };
        const policy = { plans: immediate, records: immediate };
        const [approved] = (await localRetentionPreview(f.root, () => Promise.resolve({ policy, pending: [] }))).records
            .due;
        const pending = () => Promise.resolve({ policy, pending: [{ planId, attemptId, source }] });
        deepEqual((await localRetentionPreview(f.root, pending)).records.due, []);
        equal((await localConfirmRetention(f.root, "records", approved.token, pending)).deleted, false);
    } finally {
        await f.cleanup();
    }
});

test(
    "prune retry resumes detached copies and preserves each saved version",
    { skip: process.platform === "win32" },
    async () => {
        const f = await packageFixture();
        try {
            const fs = await import("node:fs/promises");
            const { checkedProjectRuntimeLayout } = await import("@runwield/project-runtime/layout");
            const { withWorkRecordOwner } = await import("../shared/work-records/owner.ts");
            const { restoreWorkRecordDocument } = await import("../shared/work-records/store.ts");
            const { retainWorkRecordLocation } = await import("../shared/work-records/import.ts");
            const { recordAttrs, recordBody } = await import("../shared/work-records/test-fixtures/package-records.ts");
            const { createWorkRecordMnemotecaFixture } =
                await import("../shared/work-records/test-fixtures/mnemoteca-port.ts");
            const { setCustomSetting } = await import("../shared/settings.ts");
            const { previewRecordRetention, confirmRetention } = await import("./index.ts");
            const { localConfirmRetention } = await import("./retention.ts");
            await setCustomSetting("workRecords", { retentionDays: 0, retentionKeepLast: 0 }, "project", f.root);
            const port = createWorkRecordMnemotecaFixture();
            const runtime = await checkedProjectRuntimeLayout(f.root);
            const directory = join(runtime.selected.internalRoot, "prune-copies");
            await fs.mkdir(directory, { recursive: true });
            const identityOf = async (path: string) => {
                const stat = await fs.stat(path, { bigint: true });
                return [stat.dev, stat.ino, stat.birthtimeNs].join("/");
            };
            for (const scenario of ["approved", "edited", "two-saves", "moved-directory"] as const) {
                const filename = scenario + "/copy.md";
                const parent = join(f.root, scenario);
                await fs.mkdir(parent);
                const path = join(f.root, filename);
                const digest = await withWorkRecordOwner(f.root, f.identity, async () => {
                    const record = await restoreWorkRecordDocument(f.root, recordAttrs(), recordBody);
                    await fs.writeFile(path, record.markdown);
                    const digest = hash(record.markdown);
                    await retainWorkRecordLocation(record.attrs.recordId, {
                        kind: "copy",
                        sourcePath: path,
                        repositoryPath: filename,
                        repositoryId: f.identity.repositoryId,
                        digest,
                    });
                    return digest;
                });
                const [{ token }] = (await previewRecordRetention(f.root)).due;
                equal((await localConfirmRetention(f.root, "records", token, undefined, port)).deleted, true);
                const stageId = randomUUID();
                const stageName = "RunWield recovered copy " + stageId + ".md";
                const staged = join(parent, stageName);
                const journalKey = hash(JSON.stringify([f.identity.checkoutId, "records", token, filename, digest]));
                const journalPath = join(directory, journalKey + ".json");
                await fs.writeFile(
                    journalPath,
                    JSON.stringify({
                        path,
                        digest,
                        stageId,
                        parent: await identityOf(parent),
                        original: await identityOf(path),
                        settled: false,
                    }),
                );
                if (scenario !== "approved") {
                    const editor = join(f.root, "editor.tmp");
                    await fs.writeFile(editor, "First editor save.");
                    await fs.rename(editor, path);
                }
                await fs.rename(path, staged);
                if (scenario === "edited" && process.getuid?.() !== 0) {
                    await fs.chmod(parent, 0o555);
                    try {
                        await rejects(confirmRetention(f.root, "records", token, port), /Could not restore/);
                        equal(await fs.readFile(staged, "utf8"), "First editor save.");
                    } finally {
                        await fs.chmod(parent, 0o755);
                    }
                }
                if (scenario === "moved-directory") await fs.rename(parent, join(f.root, "relocated"));
                if (scenario === "two-saves") await fs.writeFile(path, "Second editor save.");
                await confirmRetention(f.root, "records", token, port);
                if (scenario !== "two-saves") await rejects(fs.stat(staged), { code: "ENOENT" });
                if (scenario === "approved") await rejects(fs.stat(path), { code: "ENOENT" });
                else if (scenario === "edited") equal(await fs.readFile(path, "utf8"), "First editor save.");
                else if (scenario === "moved-directory")
                    equal(await fs.readFile(join(f.root, "relocated", stageName), "utf8"), "First editor save.");
                else {
                    equal(await fs.readFile(path, "utf8"), "Second editor save.");
                    equal(await fs.readFile(staged, "utf8"), "First editor save.");
                }
                equal(JSON.parse(await fs.readFile(journalPath, "utf8")).settled, true);
            }
        } finally {
            await f.cleanup();
        }
    },
);
