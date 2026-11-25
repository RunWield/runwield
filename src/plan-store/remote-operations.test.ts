import { workRecords } from "@runwield/plans/work-records";
import { workRecordFiles } from "@runwield/plans/work-record-files";
import { parseProjectId, projects, type HomeProjectOwner } from "@runwield/projects";
import { tmpdir } from "node:os";
import { parseHistoryList, parseMilestoneDocuments } from "../shared/remote/project-store-protocol.ts";
import { test } from "node:test";
import { equal, deepEqual, rejects } from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile, unlink, mkdtemp, rm, rename } from "node:fs/promises";
import { PreparedProjectStore, authorLocalPlan, savePlanProse } from "./index.ts";
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
import { COLLABORATION_LOCK_BYPASS } from "../shared/collaboration/lock.ts";

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

import { startRemoteControlService } from "../shared/remote/control.ts";
import { ProjectStoreClient } from "../shared/remote/project-store-client.ts";
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
        client: new ProjectStoreClient(endpoint, control.credential, binding),
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
                await import("../shared/captured-process.ts")
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
    observe: (kind: string, response: Response, operationId?: string) => Response | Promise<Response>,
) {
    return Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            const path = new URL(request.url).pathname;
            const command = path === "/project-store" ? (await request.clone().json()).command : null;
            const upstream = await fetch(new Request(new URL(path, endpoint), request));
            return command ? await observe(command.kind, upstream, command.operationId) : upstream;
        },
    });
}

test("managed authorship retries a lost result and can reuse the name after rename", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        let lost = false;
        const requests: string[] = [];
        const proxy = observeOwnerResponse(f.endpoint, (kind, response, operationId) => {
            if (kind === "author-plan" && operationId) requests.push(operationId);
            if (kind === "author-plan" && response.ok && !lost) {
                lost = true;
                return new Response("lost", { status: 503 });
            }
            return response;
        });
        try {
            const first = await f.runRaw("managed-author", proxy.port);
            equal(first.code === 0, false);
            equal(lost, true);
            const original = await f.run("managed-author", proxy.port);
            const duplicate = await f.runRaw("managed-author", proxy.port);
            ok(duplicate.code !== 0);
            ok(new TextDecoder().decode(duplicate.stderr).includes("Plan already exists."));
            equal(await f.run("managed-author-rename"), original);
            const next = await f.run("managed-author", proxy.port);
            ok(original !== next);
            equal(requests.length, 4);
            equal(requests[0], requests[1]);
            equal(new Set(requests).size, 3);
            const admitted = await fetch(f.endpoint + "/project-store/admit", { method: "POST", headers: f.headers });
            const binding = await admitted.json();
            const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
            ok(owner);
            await projects.home.withOwner(owner, async () => {
                const { loadPlan } = await import("../shared/testing/plan-query-fixture.ts");
                const cwd = projects.home.storeLocation(owner);
                equal((await loadPlan(cwd, "renamed"))?.attrs.planId, original);
                equal((await loadPlan(cwd, "repeatable"))?.attrs.planId, next);
            });
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

test("managed Work Record creation recovers a lost reply with the owner's exact record", async () => {
    const { withProcessGlobalTestLock } = await import("../testing/process-global-lock.ts");
    const { composedRemoteFixture } = await import("../shared/remote/composed-store-fixture.ts");
    await withProcessGlobalTestLock(async () => {
        const f = await composedRemoteFixture();
        let lost: import("../shared/remote/project-store-protocol.ts").ProjectStoreRequest | undefined;
        const proxy = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            async fetch(request) {
                const path = new URL(request.url).pathname;
                const forward = () => fetch(new Request(new URL(path, f.endpoint), request));
                if (path === "/project-store" && !lost) {
                    const payload: import("../shared/remote/project-store-protocol.ts").ProjectStoreRequest =
                        await request.clone().json();
                    if (payload.command.kind === "create-project-work-record") {
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
                const { result }: import("./project-service.ts").ProjectStoreReply = await response.json();
                if (!("recordResources" in result)) throw new Error("Missing canonical Work Record catalog.");
                return result.recordResources.map((record) => record.attrs.recordId);
            };
            const beforeRetry = await read();
            equal(beforeRetry.length, 1);
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
            const binding: import("./index.ts").ProjectStoreBinding = await admission.json();
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
        const { capturePlanPackageInput, retainPlanPackagePublication } = await import("./packages.ts");
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
            const { checkedProjectRuntimeLayout } = await import("../shared/project-runtime-layout.ts");
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
