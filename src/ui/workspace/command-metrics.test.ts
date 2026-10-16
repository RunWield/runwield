import { assertEquals } from "../../testing/assertions.ts";
import { makeTempFile } from "../../testing/temp-file.ts";
import { test } from "node:test";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
} from "node:fs/promises";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { createOwnerWorkspaceApp } from "./server.js";
import { drainWorkflowMetrics, getWorkflowMetricsFilePath } from "../../shared/workflow/metrics.js";
import { setCustomSetting } from "../../shared/settings.js";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { encodeCwdForSessionDir } from "../../shared/session/root-session.js";
import { basename, join } from "node:path";

test("Owner command observations require authentication, catalog names, and a registered Project", async () => {
    await withWorkflowMetricsFixture(async ({ projectRoot }) => {
        const dbPath = await makeTempFile({ suffix: ".sqlite3" });
        const store = openOwnerCoordinationStore({ dbPath });
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
        try {
            const pairing = store.createPairingRequest({ codeFactory: () => "OWN123", proofFactory: () => "proof" });
            store.approvePairingRequest(pairing.code);
            const device = store.claimPairingRequest(pairing.proof, {
                credentialFactory: () => "credential-secret",
                csrfFactory: () => "csrf-secret",
            });
            const project = store.registerProject({ root: projectRoot, displayName: "Metrics fixture" });
            const canonicalRoot = store.requireEnabledProjectRoot(project.projectId);
            await setCustomSetting("workflowMetrics", true, "project", canonicalRoot);
            const endpoint = `http://127.0.0.1:8787/api/owner/projects/${project.projectId}/command-metrics`;
            const payload = {
                invocationId: "cmd-1",
                command: "settings",
                kind: "builtin",
                phase: "finish",
                outcome: "succeeded",
                durationMs: 12,
            };
            const send = (body: Record<string, string | number | boolean>) =>
                app.handler()(
                    new Request(endpoint, {
                        method: "POST",
                        headers: {
                            origin: "http://127.0.0.1:8787",
                            "content-type": "application/json",
                            cookie: `rw_owner_device=${device.credential}; rw_owner_csrf=csrf-secret`,
                            "x-runwield-csrf": "csrf-secret",
                        },
                        body: JSON.stringify(body),
                    }),
                );
            assertEquals(
                (await app.handler()(new Request(endpoint, { method: "POST", body: JSON.stringify(payload) }))).status,
                403,
            );
            assertEquals(
                (await send({ ...payload, command: "private submitted text", outcome: "succeeded" })).status,
                400,
            );
            assertEquals((await send({ ...payload, durationMs: -1 })).status, 400);
            assertEquals((await send({ ...payload, sessionId: "not-a-session" })).status, 400);
            assertEquals((await send({ ...payload, phase: "dispatched", outcome: "succeeded" })).status, 400);
            assertEquals((await send(payload)).status, 200);
            assertEquals(
                (await send({ invocationId: "cmd-picker", command: "model", kind: "builtin", phase: "opened" })).status,
                200,
            );
            assertEquals(
                (
                    await send({
                        invocationId: "cmd-picker",
                        command: "model",
                        kind: "builtin",
                        phase: "finish",
                        outcome: "canceled",
                        durationMs: 9,
                    })
                ).status,
                200,
            );
            assertEquals(
                (await send({ invocationId: "cmd-selected", command: "agent", kind: "builtin", phase: "opened" }))
                    .status,
                200,
            );
            assertEquals(
                (await send({ invocationId: "cmd-selected", command: "agent", kind: "builtin", phase: "dispatched" }))
                    .status,
                200,
            );
            assertEquals(
                (
                    await send({
                        invocationId: "cmd-selected",
                        command: "agent",
                        kind: "builtin",
                        phase: "finish",
                        outcome: "failed",
                        dispatched: true,
                        durationMs: 15,
                    })
                ).status,
                200,
            );
            assertEquals(
                (
                    await send({
                        ...payload,
                        command: "private submitted text",
                        outcome: "rejected",
                        invocationId: "cmd-unknown",
                    })
                ).status,
                200,
            );
            await drainWorkflowMetrics();
            const contents = await fsReadFile(getWorkflowMetricsFilePath(canonicalRoot), "utf8");
            const records = contents
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            assertEquals(records.length, 7);
            assertEquals(records[0].command, "settings");
            assertEquals(records[0].durationMs, 12);
            assertEquals(
                records.slice(1).map((row) => [row.event, row.phase, row.outcome]),
                [
                    ["command_started", "opened", undefined],
                    ["command_finished", "finish", "canceled"],
                    ["command_started", "opened", undefined],
                    ["command_dispatched", "dispatched", undefined],
                    ["command_finished", "finish", "failed"],
                    ["command_finished", "rejected", "rejected"],
                ],
            );
            assertEquals(records[1].commandId, records[2].commandId);
            assertEquals(new Set(records.slice(3, 6).map((row) => row.commandId)).size, 1);
            assertEquals(records[5].seq, 2);
            assertEquals(records[6].command, "unknown");
            assertEquals(
                (await send({ ...payload, invocationId: "cmd-alias", command: "model", alias: "models" })).status,
                200,
            );
            await drainWorkflowMetrics();
            const aliased = (await fsReadFile(getWorkflowMetricsFilePath(canonicalRoot), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
                .at(-1);
            assertEquals([aliased.command, aliased.alias], ["model", "models"]);
        } finally {
            store.close();
            await fsRm(dbPath).catch(() => {});
        }
    });
});

test("Owner rejects a real Session linked to another registered Project", async () => {
    const first = await makeManagedSessionFixture();
    const second = await makeManagedSessionFixture();
    const store = first.openStore();
    const otherProject = store.registerProject({ root: second.projectRoot, displayName: "Other Project" });
    const otherDir = join(first.home, ".wld", "sessions", encodeCwdForSessionDir(await fsRealpath(second.projectRoot)));
    await fsMkdir(otherDir, { recursive: true });
    const transcriptPath = join(otherDir, basename(second.transcriptPath));
    await fsCopyFile(second.transcriptPath, transcriptPath);
    const otherSession = await store.ensureSessionCatalogRecord({
        projectId: otherProject.projectId,
        piSessionId: "pi-managed-fixture",
        transcriptPath,
        transcriptCwd: second.projectRoot,
        source: "catalog",
    });
    const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    try {
        const pairing = store.createPairingRequest({ codeFactory: () => "OWN456", proofFactory: () => "proof-cross" });
        store.approvePairingRequest(pairing.code);
        const device = store.claimPairingRequest(pairing.proof, {
            credentialFactory: () => "cross-secret",
            csrfFactory: () => "csrf-cross",
        });
        const response = await app.handler()(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${first.project.projectId}/command-metrics`, {
                method: "POST",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    "content-type": "application/json",
                    cookie: `rw_owner_device=${device.credential}; rw_owner_csrf=${"csrf-cross"}`,
                    "x-runwield-csrf": "csrf-cross",
                },
                body: JSON.stringify({
                    invocationId: "cmd-cross-project",
                    command: "settings",
                    kind: "builtin",
                    sessionId: otherSession.runwieldSessionId,
                    phase: "finish",
                    outcome: "succeeded",
                    durationMs: 1,
                }),
            }),
        );
        assertEquals(response.status, 400);
    } finally {
        await app.close();
        store.close();
        await second.cleanup();
        await first.cleanup();
    }
});
