import { test } from "node:test";
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
