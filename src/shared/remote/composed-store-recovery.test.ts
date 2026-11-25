import { test } from "node:test";
import type { ProjectStoreBinding, ProjectStoreReply } from "../../plan-store/index.ts";
import type { PlanHistory } from "@runwield/plans/history";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { composedRemoteFixture } from "./composed-store-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { git } from "../git-test-fixture.ts";
import { serveHttp } from "../http-server.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { ProjectStoreClient } from "./project-store-client.ts";
import type { ProjectStoreRequest } from "./project-store-protocol.ts";

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
                fixture.endpoint,
                fixture.input.connection.credential,
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
            const client = new ProjectStoreClient(fixture.endpoint, fixture.input.connection.credential, lost.binding);
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
            const client = new ProjectStoreClient(fixture.endpoint, fixture.input.connection.credential, binding);
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
                    fixture.endpoint,
                    fixture.input.connection.credential,
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
