import { authenticatedProjectStoreRequest } from "./project-store-request.ts";
import { test } from "node:test";
import type { ProjectStoreBinding } from "@runwield/plans/project-store-wire";
import type { ProjectStoreReply } from "../../plan-store/index.ts";
import type { PlanHistory } from "@runwield/plans/history";
import { deepEqual, equal, notEqual, ok, rejects } from "node:assert/strict";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projects } from "@runwield/projects";
import { plans } from "@runwield/plans";
import { openProjectPlanStore } from "../../plan-store/index.ts";
import { composedRemoteFixture } from "./composed-store-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { git } from "../git-test-fixture.ts";
import { serveHttp } from "../http-server.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import { ProjectStoreClient } from "./project-store-client.ts";
import type { ProjectStoreRequest } from "./project-store-protocol.ts";
import { tree } from "../testing/plan-package-fixture.ts";
import { readWorktreeRegistryAtPath, type WorktreeRegistryEntry } from "@runwield/project-runtime/registry-inspection";
import type { RecoveryJournal } from "../workflow/execution-recovery-proof.ts";

test("only authenticated, matching host observations settle canonical Plan recovery", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture(true);
        try {
            const seed: { planId: string; attemptId: string } = JSON.parse(await fixture.run("managed-recovery-seed"));
            const binding: ProjectStoreBinding = await (
                await fetch(`${fixture.endpoint}/project-store/admit`, { method: "POST", headers: fixture.headers })
            ).json();
            const client = new ProjectStoreClient(
                authenticatedProjectStoreRequest(fixture.endpoint, fixture.input.connection.credential),
                binding,
            );
            const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
            const packages = join(owner.executionAccountHome, ".wld", "projects", binding.projectId, "plans");
            const resolve = async () => {
                const { result } = await client.execute({ kind: "resolve-plan", reference: seed.planId });
                ok("plan" in result && result.plan);
                equal(result.plan.body, "# Canonical recovery\n");
                equal(result.plan.attrs.worktreeStatus, undefined);
                equal(result.plan.attrs.worktreePath, undefined);
                return result.plan;
            };
            const attempt = async () => {
                const { result } = await client.execute({ kind: "read-execution", planId: seed.planId });
                ok("execution" in result);
                return result.execution?.attemptId;
            };
            const recover = (action: "refresh" | "stop", expectedRevision: string) => ({
                kind: "recover-execution" as const,
                operationId: crypto.randomUUID(),
                planId: seed.planId,
                attemptId: seed.attemptId,
                expectedRevision,
                controllerRevision: null,
                action,
            });

            const initial = await fixture.withoutSsh(async () => {
                ok(plans.identity.isValid(seed.planId));
                const store = openProjectPlanStore(owner.projectId, { admitted: owner });
                const bytes = await tree(packages);
                const document = await store.read(seed.planId);
                equal(document.planId, seed.planId);
                equal(document.body, "# Canonical recovery\n");
                equal(document.attrs.status, "in_progress");
                equal(document.attrs.worktreeStatus, undefined);
                const resource = await resolve();
                equal(document.revision, resource.revision);
                deepEqual(await tree(packages), bytes);
                return resource;
            });
            const refresh = recover("refresh", initial.revision);
            const unauthenticated = await fetch(`${fixture.endpoint}/project-store`, {
                method: "POST",
                body: JSON.stringify({ binding, command: refresh }),
            });
            equal(unauthenticated.status, 401);
            const active = await client.execute(refresh);
            equal("status" in active.result && active.result.status, "completed");
            const refreshed = await resolve();
            equal(await attempt(), seed.attemptId);
            await rejects(client.execute(recover("stop", refreshed.revision)), /refused/);

            await fixture.run("managed-recovery-abandon", undefined, seed.attemptId);
            const before = await resolve();
            const bytes = await tree(packages);
            ok(Object.keys(bytes).some((path) => path.endsWith("/plan.wld.json")));
            const commandWithEvidence = await fetch(`${fixture.endpoint}/project-store`, {
                method: "POST",
                headers: fixture.headers,
                body: JSON.stringify({ binding, command: { ...recover("stop", before.revision), evidence: {} } }),
            });
            equal(commandWithEvidence.status, 400);
            for (const [section, field, value] of [
                ["request", "projectId", crypto.randomUUID()],
                ["request", "repositoryId", crypto.randomUUID()],
                ["request", "personalOwner", `${owner.personalOwner.identity}-different`],
                ["request", "planId", crypto.randomUUID()],
                ["request", "planName", "another-plan"],
                ["request", "attemptId", crypto.randomUUID()],
                ["request", "purpose", "active"],
                ["entry", "id", crypto.randomUUID()],
                ["entry", "planId", crypto.randomUUID()],
                ["entry", "planName", "another-plan"],
                ["entry", "status", "active"],
            ]) {
                await writeFile(fixture.recoveryFaultPath, JSON.stringify({ section, field, value }));
                await rejects(client.execute(recover("stop", before.revision)), /refused/, `${section}.${field}`);
                deepEqual(await resolve(), before);
                equal(await attempt(), seed.attemptId);
                deepEqual(await tree(packages), bytes);
            }
            await rm(fixture.recoveryFaultPath);
            const settled = await client.execute(recover("stop", before.revision));
            equal("status" in settled.result && settled.result.status, "completed");
            equal((await resolve()).attrs.status, "ready_for_work");
            equal(await attempt(), undefined);
        } finally {
            await fixture.cleanup();
        }
    }));

interface ManagedRecreateSeed {
    planId: string;
    attemptId: string;
    original: WorktreeRegistryEntry;
    journalDirectory: string;
    registryPath: string;
}

interface ManagedRecreateResult {
    confirmations: number;
    executions: number;
    errors: string[];
}

test("approved managed Recreate switches the reservation only after matching evidence for its linked replacement", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture(true);
        const requests: ProjectStoreRequest[] = [];
        let accepted: ProjectStoreReply | undefined;
        const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            const path = new URL(request.url).pathname;
            const body = await request.text();
            const submitted: ProjectStoreRequest | undefined = path === "/project-store" ? JSON.parse(body) : undefined;
            const recreateRequest =
                submitted?.command.kind === "recover-execution" && submitted.command.action === "recreate"
                    ? requests.push(submitted)
                    : 0;
            if (recreateRequest === 1) return new Response(null, { status: 503 });
            const response = await fetch(`${fixture.endpoint}${path}`, {
                method: request.method,
                headers: request.headers,
                body: body || undefined,
            });
            if (recreateRequest === 2 && response.ok) {
                accepted = await response.json();
                return new Response(null, { status: 503 });
            }
            return response;
        });
        try {
            const seed: ManagedRecreateSeed = JSON.parse(await fixture.run("managed-recovery-seed"));
            const binding: ProjectStoreBinding = await (
                await fetch(`${fixture.endpoint}/project-store/admit`, { method: "POST", headers: fixture.headers })
            ).json();
            const client = new ProjectStoreClient(
                authenticatedProjectStoreRequest(fixture.endpoint, fixture.input.connection.credential),
                binding,
            );
            const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
            const packages = join(owner.executionAccountHome, ".wld", "projects", binding.projectId, "plans");
            const readPlan = async () => {
                const { result } = await client.execute({ kind: "resolve-plan", reference: seed.planId });
                ok("plan" in result && result.plan);
                return result.plan;
            };
            const readAttempt = async () => {
                const { result } = await client.execute({ kind: "read-execution", planId: seed.planId });
                ok("execution" in result);
                return result.execution;
            };
            const before = await readPlan();
            const reserved = await readAttempt();
            equal(reserved?.attemptId, seed.attemptId);
            const ownerBytes = await tree(packages);
            const originalGit = await git(fixture.root, ["worktree", "list", "--porcelain"]);

            const declined: ManagedRecreateResult = JSON.parse(
                await fixture.run("managed-recovery-decline-recreate", proxy.addr.port),
            );
            deepEqual(declined, { confirmations: 1, executions: 0, errors: [] });
            equal(requests.length, 0);
            deepEqual(await readPlan(), before);
            deepEqual(await readAttempt(), reserved);
            deepEqual(await tree(packages), ownerBytes);
            equal(await git(fixture.root, ["worktree", "list", "--porcelain"]), originalGit);

            const first: ManagedRecreateResult = JSON.parse(
                await fixture.run("managed-recovery-recreate", proxy.addr.port),
            );
            equal(first.confirmations, 1);
            equal(first.executions, 0);
            ok(first.errors.length, "Recovery did not report the refused owner call.");
            const [interrupted] = requests;
            ok(interrupted?.command.kind === "recover-execution" && interrupted.command.action === "recreate");
            const command = interrupted.command;
            equal(command.attemptId, seed.attemptId);
            equal(command.planId, seed.planId);
            equal(command.expectedRevision, before.revision);
            ok(command.replacementAttemptId);
            notEqual(command.replacementAttemptId, seed.attemptId);
            const replacementGit = await git(fixture.root, ["worktree", "list", "--porcelain"]);
            notEqual(replacementGit, originalGit);
            const replacementPath = replacementGit
                .split("\n")
                .filter((line) => line.startsWith("worktree ") && !originalGit.split("\n").includes(line))
                .map((line) => line.slice("worktree ".length));
            equal(replacementPath.length, 1);
            const sentinel = join(replacementPath[0], "retry-sentinel.txt");
            await writeFile(sentinel, "Preserve independent execution work.\n");

            const assertUnchanged = async () => {
                deepEqual(await readPlan(), before);
                deepEqual(await readAttempt(), reserved);
                deepEqual(await tree(packages), ownerBytes);
                equal(await git(fixture.root, ["worktree", "list", "--porcelain"]), replacementGit);
                equal(await readFile(sentinel, "utf8"), "Preserve independent execution work.\n");
            };
            await assertUnchanged();
            await rejects(client.execute({ ...command, expectedRevision: "0".repeat(64) }), /refused/);
            await assertUnchanged();
            const sameAttempt = await fetch(`${fixture.endpoint}/project-store`, {
                method: "POST",
                headers: fixture.headers,
                body: JSON.stringify({ binding, command: { ...command, replacementAttemptId: seed.attemptId } }),
            });
            equal(sameAttempt.status, 400);
            await assertUnchanged();
            for (const [label, changed] of [
                ["unknown replacement", { ...command, replacementAttemptId: crypto.randomUUID().slice(0, 8) }],
                ["unlinked operation", { ...command, operationId: crypto.randomUUID() }],
            ] as const) {
                await rejects(client.execute(changed), /refused/, label);
                await assertUnchanged();
            }
            const detachedPath = `${replacementPath[0]}.fixture-detached`;
            await rename(replacementPath[0], detachedPath);
            try {
                await rejects(client.execute(command), /refused/, "missing replacement checkout");
            } finally {
                await rename(detachedPath, replacementPath[0]);
            }
            await assertUnchanged();
            const journalPath = join(seed.journalDirectory, `${command.operationId}.json`);
            const journalBytes = await readFile(journalPath, "utf8");
            const journal: RecoveryJournal = JSON.parse(journalBytes);
            const settledEffect = journal.completedEffects?.find(
                ({ effect }) => effect === "recovery_recreate_registry_settled",
            );
            ok(settledEffect?.proof?.baseCommit);
            settledEffect.proof.baseCommit = "0".repeat(settledEffect.proof.baseCommit.length);
            await writeFile(journalPath, JSON.stringify(journal));
            try {
                await rejects(client.execute(command), /refused/, "handoff base differs from saved intent");
                await assertUnchanged();
            } finally {
                await writeFile(journalPath, journalBytes);
            }
            for (const [section, field, value] of [
                ["request", "personalOwner", `${owner.personalOwner.identity}-different`],
                ["request", "attemptId", crypto.randomUUID()],
                ["request.recreate", "operationId", crypto.randomUUID()],
                ["request.recreate", "expectedRevision", "0".repeat(64)],
                ["request.recreate", "replacementAttemptId", seed.attemptId],
                ["entry", "id", seed.attemptId],
                ["", "entry", null],
                ["", "transitionId", crypto.randomUUID()],
                ["entry", "planId", crypto.randomUUID()],
                ["entry", "status", "abandoned"],
            ]) {
                await writeFile(fixture.recoveryFaultPath, JSON.stringify({ section, field, value }));
                await rejects(client.execute(command), /refused/, `${section}.${field}`);
                await assertUnchanged();
            }
            await rm(fixture.recoveryFaultPath);

            const lostReply: ManagedRecreateResult = JSON.parse(
                await fixture.run("managed-recovery-resume-recreate", proxy.addr.port),
            );
            equal(lostReply.confirmations, 0);
            equal(lostReply.executions, 0);
            ok(lostReply.errors.length, "Recovery did not report the lost owner response.");
            deepEqual(requests, [interrupted, interrupted]);
            equal((await readAttempt())?.attemptId, command.replacementAttemptId);
            const settled = await readPlan();
            equal(settled.attrs.status, "ready_for_work");
            equal(settled.body, before.body);
            const settledBytes = await tree(packages);
            const retry: ManagedRecreateResult = JSON.parse(
                await fixture.run("managed-recovery-resume-recreate", proxy.addr.port),
            );
            deepEqual(retry, { confirmations: 0, executions: 1, errors: [] });
            deepEqual(requests, [interrupted, interrupted, interrupted]);
            const receipt = await client.execute(command);
            equal("status" in receipt.result && receipt.result.status, "completed");
            deepEqual(receipt, accepted);
            deepEqual(await readPlan(), settled);
            deepEqual(await tree(packages), settledBytes);
            equal(await git(fixture.root, ["worktree", "list", "--porcelain"]), replacementGit);
            equal(await readFile(sentinel, "utf8"), "Preserve independent execution work.\n");
        } finally {
            await proxy.shutdown();
            await fixture.cleanup();
        }
    }));

test("TUI Load Plan resumes a killed managed recreation only while the replacement Git evidence matches", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            const seed: ManagedRecreateSeed = JSON.parse(await fixture.run("managed-recovery-seed"));
            const binding: ProjectStoreBinding = await (
                await fetch(`${fixture.endpoint}/project-store/admit`, { method: "POST", headers: fixture.headers })
            ).json();
            const client = new ProjectStoreClient(
                authenticatedProjectStoreRequest(fixture.endpoint, fixture.input.connection.credential),
                binding,
            );
            const owner = projects.home.inspect(binding.projectId, binding.repositoryId);
            const packages = join(owner.executionAccountHome, ".wld", "projects", binding.projectId, "plans");
            const beforeBytes = await tree(packages);
            const readAttempt = async () => {
                const { result } = await client.execute({ kind: "read-execution", planId: seed.planId });
                ok("execution" in result);
                return result.execution?.attemptId;
            };
            equal(await readAttempt(), seed.attemptId);

            const rescueContents = "Preserve the committed original work.\n";
            await writeFile(join(seed.original.path, "original-work.txt"), rescueContents);
            await git(seed.original.path, ["add", "original-work.txt"]);
            await git(seed.original.path, ["commit", "-m", "Original execution work"]);
            const originalHead = await git(seed.original.path, ["rev-parse", "HEAD"]);

            const { interrupted, worktree: replacement } = await fixture.interruptRecreateAfterGitAdd();
            notEqual(interrupted.code, 0);
            const journals = (await readdir(seed.journalDirectory)).filter((name) => name.endsWith(".json"));
            equal(journals.length, 1);
            const journalPath = join(seed.journalDirectory, journals[0]);
            const journal: RecoveryJournal = JSON.parse(await readFile(journalPath, "utf8"));
            const worktreesAfterCrash = await git(fixture.root, ["worktree", "list", "--porcelain"]);
            const intent = journal.intendedPostconditions?.managedRecreation;
            ok(intent);
            equal(intent.originalAttemptId, seed.attemptId);
            equal(intent.baseCommit, replacement.baseCommit);
            notEqual(intent.replacementAttemptId, seed.attemptId);
            equal(
                journal.completedEffects?.some(({ effect }) => effect === "recovery_recreate_registry_settled"),
                false,
            );
            const readRegistry = () => readWorktreeRegistryAtPath(seed.registryPath);
            const records = await readRegistry();
            const pending = records.find(({ id }) => id === intent.replacementAttemptId);
            ok(pending?.creationContext, "Git creation finished before registry settlement");
            equal(pending.path, replacement.path);
            equal(pending.branch, replacement.branch);
            equal(records.find(({ id }) => id === seed.attemptId)?.status, "abandoned");
            equal(await git(replacement.path, ["rev-parse", "HEAD"]), replacement.baseCommit);
            const replacementMarker = join(replacement.path, "resume-sentinel.txt");
            const replacementContents = "Reuse the original replacement checkout.\n";
            await writeFile(replacementMarker, replacementContents);
            const gitLink = await readFile(join(replacement.path, ".git"), "utf8");

            const assertOriginalPreserved = async () => {
                equal(await git(fixture.root, ["rev-parse", seed.original.branch]), originalHead);
                equal(
                    await git(fixture.root, ["show", `${seed.original.branch}:original-work.txt`]),
                    rescueContents.trim(),
                );
            };
            const assertRefused = async () => {
                const rejected: ManagedRecreateResult = JSON.parse(
                    await fixture.run("managed-recovery-resume-recreate"),
                );
                equal(rejected.confirmations, 0);
                equal(rejected.executions, 0);
                ok(
                    rejected.errors.some((error) => /preserve|changed.*evidence/i.test(error)),
                    JSON.stringify(rejected),
                );
                equal(await readAttempt(), seed.attemptId);
                deepEqual(await tree(packages), beforeBytes);
                deepEqual(await readRegistry(), records);
                equal(await readFile(replacementMarker, "utf8"), replacementContents);
                await assertOriginalPreserved();
            };

            const wrongBranch = "fixture-wrong-recreation";
            await git(fixture.root, ["branch", wrongBranch, replacement.baseCommit]);
            await git(replacement.path, ["symbolic-ref", "HEAD", `refs/heads/${wrongBranch}`]);
            try {
                await assertRefused();
                equal(await git(replacement.path, ["branch", "--show-current"]), wrongBranch);
            } finally {
                await git(replacement.path, ["symbolic-ref", "HEAD", `refs/heads/${replacement.branch}`]);
            }
            await git(fixture.root, ["update-ref", `refs/heads/${replacement.branch}`, originalHead]);
            try {
                await assertRefused();
                equal(await git(replacement.path, ["rev-parse", "HEAD"]), originalHead);
            } finally {
                await git(fixture.root, ["update-ref", `refs/heads/${replacement.branch}`, replacement.baseCommit]);
            }

            const resume: ManagedRecreateResult = JSON.parse(await fixture.run("managed-recovery-resume-recreate"));
            deepEqual(resume, { confirmations: 0, executions: 1, errors: [] });
            equal(await readAttempt(), intent.replacementAttemptId);
            await rejects(readFile(journalPath), { code: "ENOENT" });
            equal(await git(fixture.root, ["worktree", "list", "--porcelain"]), worktreesAfterCrash);
            const finalRegistry = await readRegistry();
            deepEqual(finalRegistry.map(({ id }) => id).sort(), records.map(({ id }) => id).sort());
            const settled = finalRegistry.find(({ id }) => id === intent.replacementAttemptId);
            equal(settled?.path, replacement.path);
            equal(settled?.branch, replacement.branch);
            equal(settled?.creationContext, undefined);
            equal(await git(replacement.path, ["rev-parse", "HEAD"]), replacement.baseCommit);
            equal(await readFile(replacementMarker, "utf8"), replacementContents);
            equal(await readFile(join(replacement.path, ".git"), "utf8"), gitLink);
            await assertOriginalPreserved();
        } finally {
            await fixture.cleanup();
        }
    }));

test("fresh managed process replays a lost settlement acknowledgement after real Git publication exactly once", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        let lost: ProjectStoreRequest | undefined;
        let accepted = "";
        let published = "";
        let recording: ProjectStoreRequest | undefined;
        const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            const url = new URL(request.url);
            const bytes = await request.text();
            const input: ProjectStoreRequest | undefined =
                url.pathname === "/project-store" ? JSON.parse(bytes) : undefined;
            if (input?.command.kind === "prepare-record") recording = input;
            const response = await fetch(`${fixture.endpoint}${url.pathname}`, {
                method: request.method,
                headers: request.headers,
                body: bytes || undefined,
            });
            const body = await response.text();
            if (!lost && input?.command.kind === "settle-publication" && response.ok) {
                published = await git(fixture.upstream, ["rev-parse", "main"]);
                equal(await git(fixture.upstream, ["show", "main:managed-sentinel"]), "Delivered sentinel");
                lost = input;
                accepted = body;
                return new Response(null, { status: 503 });
            }
            return new Response(body || null, { status: response.status, headers: response.headers });
        });
        try {
            const personal: { path: string } = JSON.parse(await fixture.run("manual-seed"));
            const before = await readFile(personal.path, "utf8");
            const interrupted = await fixture.runRaw("managed-deliver", proxy.addr.port);
            ok(interrupted.code !== 0);
            ok(lost?.command.kind === "settle-publication", new TextDecoder().decode(interrupted.stderr));
            ok(recording?.command.kind === "prepare-record");
            const client = new ProjectStoreClient(
                authenticatedProjectStoreRequest(fixture.endpoint, fixture.input.connection.credential),
                recording.binding,
            );
            for (const change of [
                { planId: "second-id" },
                { attemptId: "other-attempt" },
                { expectedRevision: "0".repeat(64) },
            ]) {
                await rejects(
                    client.execute({ ...recording.command, ...change, operationId: crypto.randomUUID() }),
                    /refused/,
                );
            }
            const replay = await captureForegroundProcess(process.execPath, {
                cwd: fixture.root,
                args: [
                    new URL("./composed-replay-process.ts", import.meta.url).pathname,
                    fixture.endpoint,
                    fixture.input.connection.credential,
                    JSON.stringify(lost),
                ],
            });
            equal(replay.code, 0, new TextDecoder().decode(replay.stderr));
            deepEqual(JSON.parse(new TextDecoder().decode(replay.stdout)), JSON.parse(accepted));
            const settled: { records: string[] } = JSON.parse(
                await fixture.run("managed-resume", undefined, lost.command.reference.attemptId),
            );
            equal(settled.records.length, 1);
            equal(await git(fixture.upstream, ["rev-parse", "main"]), published);
            equal(await readFile(personal.path, "utf8"), before);
        } finally {
            await proxy.shutdown();
            await fixture.cleanup();
        }
    }));

test("managed load-plan path imports explicitly while name lookup leaves checkout documents untouched", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            const result: { planId: string } = JSON.parse(await fixture.run("managed-route-import"));
            equal(result.planId, "explicit-id");
        } finally {
            await fixture.cleanup();
        }
    }));

test("managed history inspection leaves a fresh Project unadmitted", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            await fixture.run("managed-history-missing");
            const response = await fetch(`${fixture.endpoint}/project-store/inspect`, {
                method: "POST",
                headers: fixture.headers,
            });
            equal(response.status, 200);
            equal(await response.json(), null);
        } finally {
            await fixture.cleanup();
        }
    }));

test("retrying the restore CLI after a lost reply preserves an intervening edit", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        let lost: ProjectStoreRequest | undefined;
        let receipt: ProjectStoreReply | undefined;
        const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            const url = new URL(request.url);
            const bytes = await request.text();
            const input: ProjectStoreRequest | undefined =
                url.pathname === "/project-store" ? JSON.parse(bytes) : undefined;
            const response = await fetch(`${fixture.endpoint}${url.pathname}`, {
                method: request.method,
                headers: request.headers,
                body: bytes || undefined,
            });
            if (!lost && input?.command.kind === "restore-history" && response.ok) {
                lost = input;
                receipt = await response.json();
                return new Response(null, { status: 503 });
            }
            return response;
        });
        try {
            const history: PlanHistory = JSON.parse(await fixture.run("managed-history-seed"));
            const version = history.milestones[0].version;
            const interrupted = await fixture.runRaw("managed-history-restore", proxy.addr.port, version);
            ok(interrupted.code !== 0);
            ok(
                lost && receipt && "revision" in receipt.result && receipt.result.revision,
                new TextDecoder().decode(interrupted.stderr),
            );
            const firstRevision = receipt.result.revision;
            const client = new ProjectStoreClient(
                authenticatedProjectStoreRequest(fixture.endpoint, fixture.input.connection.credential),
                lost.binding,
            );
            const later = (
                await client.execute({
                    kind: "save-prose",
                    planId: history.planId,
                    expectedRevision: firstRevision,
                    operationId: crypto.randomUUID(),
                    body: "# Later edit\n",
                })
            ).result;
            ok("revision" in later);
            equal(
                await fixture.run("managed-history-restore", undefined, version),
                `Restored ${version} to Plan ${history.planId} at revision ${firstRevision}.`,
            );
            const after = (await client.execute({ kind: "resolve-plan", reference: history.planId })).result;
            ok("plan" in after && after.plan);
            equal(after.plan.body, "# Later edit\n");
            equal(after.plan.revision, later.revision);
            await fixture.run("managed-history-restore", undefined, version);
            const deliberate = (await client.execute({ kind: "resolve-plan", reference: history.planId })).result;
            ok("plan" in deliberate && deliberate.plan);
            equal(deliberate.plan.body, "# Original\n");
        } finally {
            await proxy.shutdown();
            await fixture.cleanup();
        }
    }));

test("managed history CLI reads large catalogs and multi-document milestones across reply boundaries", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        try {
            const history: PlanHistory = JSON.parse(await fixture.run("managed-history-seed"));
            const binding: ProjectStoreBinding = await (
                await fetch(`${fixture.endpoint}/project-store/admit`, { method: "POST", headers: fixture.headers })
            ).json();
            const client = new ProjectStoreClient(
                authenticatedProjectStoreRequest(fixture.endpoint, fixture.input.connection.credential),
                binding,
            );
            const { planId } = history;
            let revision = history.revision;
            const context = "📚".repeat(155000) + "\n";
            const validation = "Ω".repeat(310000) + "\n";
            for (const [resource, body] of [
                ["context.md", context],
                ["validation.md", validation],
            ]) {
                const saved = (
                    await client.execute({
                        kind: "save-document",
                        planId,
                        expectedRevision: revision,
                        operationId: crypto.randomUUID(),
                        resource,
                        body,
                    })
                ).result;
                ok("revision" in saved && saved.revision);
                revision = saved.revision;
            }
            const reason = "R".repeat(600000);
            const closed = (
                await client.execute({
                    kind: "lifecycle-decision",
                    planId,
                    expectedRevision: revision,
                    operationId: crypto.randomUUID(),
                    decision: {
                        event: "manual_closed_without_verification",
                        details: { closedWithoutVerificationReason: reason },
                    },
                })
            ).result;
            ok("revision" in closed && closed.revision);
            const archived = (
                await client.execute({
                    kind: "archive-plan",
                    planId,
                    expectedRevision: closed.revision,
                    operationId: crypto.randomUUID(),
                    reason,
                    force: false,
                    now: "",
                })
            ).result;
            ok("revision" in archived && archived.revision);
            const lines = (await fixture.run("managed-history-list")).split("\n");
            equal(lines.length, 3);
            const [version, milestone, , why] = lines[1].split("\t");
            equal(milestone, "closed");
            equal(why, reason);
            equal(lines[2].split("\t")[3], reason);
            equal(
                await fixture.run("managed-history-show", undefined, version),
                `# context.md\n\n${context}\n# validation.md\n\n${validation}`.trim(),
            );
        } finally {
            await fixture.cleanup();
        }
    }));

test("a restore rejected before commit can retry against a fresh revision", () =>
    withProcessGlobalTestLock(async () => {
        const fixture = await composedRemoteFixture();
        let edited = false;
        const proxy = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
            const path = new URL(request.url).pathname;
            const body = await request.text();
            const input: ProjectStoreRequest | undefined = path === "/project-store" ? JSON.parse(body) : undefined;
            if (!edited && input?.command.kind === "restore-history") {
                const owner = new ProjectStoreClient(
                    authenticatedProjectStoreRequest(fixture.endpoint, fixture.input.connection.credential),
                    input.binding,
                );
                await owner.execute({
                    kind: "save-prose",
                    planId: input.command.planId,
                    expectedRevision: input.command.expectedRevision,
                    operationId: crypto.randomUUID(),
                    body: "# Concurrent\n",
                });
                edited = true;
            }
            return await fetch(`${fixture.endpoint}${path}`, {
                method: request.method,
                headers: request.headers,
                body: body || undefined,
            });
        });
        try {
            const history: PlanHistory = JSON.parse(await fixture.run("managed-history-seed"));
            const version = history.milestones[0].version;
            const stale = await fixture.runRaw("managed-history-restore", proxy.addr.port, version);
            ok(stale.code !== 0);
            ok(new TextDecoder().decode(stale.stderr).includes("Plan revision changed before restore"));
            ok(edited);
            ok((await fixture.run("managed-history-restore", undefined, version)).startsWith(`Restored ${version}`));
        } finally {
            await proxy.shutdown();
            await fixture.cleanup();
        }
    }));
