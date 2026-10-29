import lockfile from "proper-lockfile";
import { test } from "node:test";
import { ok as assert, rejects } from "node:assert/strict";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withMetricsExportFixture } from "../../testing/metrics-export-fixture.ts";
import type { MetricsExportFixture } from "../../testing/metrics-export-fixture.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import {
    approveMetricsExporter,
    listInstalledMetricsExporters,
    removeMetricsExporterApprovals,
} from "../../shared/extensions/metrics-exporter.ts";
import { getCustomSetting, setCustomSetting } from "../../shared/settings.js";
import { readMetricsExportGrants } from "../../shared/workflow/metrics-export-grants.ts";
import { readMetricsExportStatus, runMetricsExportCycle } from "../../shared/workflow/metrics-export-scheduler.ts";
import { getWorkflowMetricsFilePath, recordWorkflowMetric } from "../../shared/workflow/metrics.js";
import { ExecutionMetricsRecorder } from "../../shared/workflow/execution-metrics.ts";
import { openNativeFileLock } from "../../shared/native-file-lock.ts";
import { encodeCwdForSessionDir } from "../../shared/session/root-session.js";
import type { OwnerUsageReport } from "./server/owner-usage.ts";
import { resolveCollectionEpoch, setWorkflowMetricsRecording } from "../../shared/workflow/metrics-journal.ts";
import { queryUsageReport } from "../../shared/workflow/usage-reporting.ts";
import { createOwnerWorkspaceApp } from "./server.js";
import type { UsageSettingsRequest, UsageSettingsResponse, UsageSettingsView } from "./server/owner-usage-settings.ts";

const origin = "http://127.0.0.1:8787";
interface SettingsFixture extends MetricsExportFixture {
    store: ReturnType<typeof openOwnerCoordinationStore>;
    app: ReturnType<typeof createOwnerWorkspaceApp>;
    projectId: string;
    headers: Record<string, string>;
    get(): Promise<UsageSettingsView>;
    post(action: string, body: UsageSettingsRequest): Promise<Response>;
}
function pairedHeaders(store: ReturnType<typeof openOwnerCoordinationStore>) {
    const pairing = store.createPairingRequest();
    store.approvePairingRequest(pairing.code);
    const device = store.claimPairingRequest(pairing.proof);
    return {
        cookie: `rw_owner_device=${encodeURIComponent(device.credential)}; rw_owner_csrf=${encodeURIComponent(device.csrf)}`,
        "x-runwield-csrf": device.csrf,
        origin,
        "content-type": "application/json",
    };
}
async function withSettingsFixture(run: (fixture: SettingsFixture) => Promise<void>) {
    await withMetricsExportFixture(async (fixture) => {
        const manifestPath = join(fixture.packageRoot, "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.wld.metricsExporter.credentials = [{ key: "secretKey", label: "Secret key", secret: true }];
        await writeFile(manifestPath, JSON.stringify(manifest));
        const store = openOwnerCoordinationStore({ dbPath: join(fixture.home, "owner.sqlite3") });
        const project = store.registerProject({ root: fixture.project, displayName: "A" });
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        const headers = pairedHeaders(store);
        const handler = app.handler();
        async function get() {
            const response = await handler(new Request(`${origin}/api/owner/usage/settings`, { headers }));
            assertEquals(response.status, 200);
            const view: UsageSettingsView = await response.json();
            assertSafe(view, fixture);
            return view;
        }
        try {
            await run({
                ...fixture,
                store,
                app,
                projectId: project.projectId,
                headers,
                get,
                post: async (action, body) => {
                    const response = await handler(
                        new Request(
                            `${origin}/api/owner/usage/${action === "clear" ? "clear" : `settings/${action}`}`,
                            {
                                method: "POST",
                                headers,
                                body: JSON.stringify(body),
                            },
                        ),
                    );
                    assertSafe(await response.clone().json(), fixture);
                    return response;
                },
            });
        } finally {
            fixture.release();
            await app.close();
            store.close();
        }
    });
}
function assertSafe<T>(value: T, fixture: MetricsExportFixture, secret = "") {
    const json = JSON.stringify(value);
    for (const forbidden of [fixture.home, fixture.project, fixture.packageRoot, secret].filter(Boolean)) {
        assertEquals(json.includes(forbidden), false, `Response contains private value ${forbidden}`);
    }
}
async function create(f: SettingsFixture, extra: UsageSettingsRequest = {}) {
    const view = await f.get();
    return await f.post("create", {
        exporterKey: view.exporters[0]?.exporterKey,
        endpoint: f.endpoint(),
        externalProject: "vendor-project",
        allowInsecureLocalEndpoint: true,
        projectIds: [f.projectId],
        ...extra,
    });
}

test("settings exporter inventory refuses absent, unapproved, and unknown exporters without writing grants", async () => {
    await withSettingsFixture(async (f) => {
        await setCustomSetting("packages", [], "global");
        assertEquals((await f.get()).exporters, []);
        assertEquals((await create(f, { exporterKey: "missing" })).status, 400);
        await setCustomSetting("packages", [f.packageRoot], "global");
        await removeMetricsExporterApprovals(f.packageRoot);
        const unapproved = await f.get();
        assertEquals(unapproved.exporters[0].state, "installed_unapproved");
        assertEquals((await create(f)).status, 400);
        assertEquals(getCustomSetting("metricsExport", "global"), undefined);
        await approveMetricsExporter((await listInstalledMetricsExporters())[0]);
        assertEquals((await f.get()).exporters[0].state, "approved");
        assertEquals((await create(f, { exporterKey: "missing" })).status, 400);
        assertEquals(getCustomSetting("metricsExport", "global"), undefined);
    });
});

test("settings creates explicit Core grants, never approves new Projects, and keeps unavailable roots on edits", async () => {
    await withSettingsFixture(async (f) => {
        const response = await create(f);
        assertEquals(response.status, 200);
        const created: UsageSettingsResponse = await response.json();
        assertSafe(created, f);
        const [grant] = readMetricsExportGrants();
        assertEquals(
            grant.projects.map((p) => p.projectRoot),
            [f.project],
        );
        const secondRoot = join(f.project, "second");
        await mkdir(secondRoot);
        const b = f.store.registerProject({ root: secondRoot, displayName: "B" });
        assertEquals(
            (await f.get()).destinations[0].projects.map((p) => p.projectId),
            [f.projectId],
        );
        assertEquals(
            (await f.post("projects", { destinationId: grant.destinationId, projectIds: [f.projectId, b.projectId] }))
                .status,
            200,
        );
        f.store.setProjectEnabled(b.projectId, false);
        assertEquals((await f.get()).destinations[0].unavailableProjectCount, 1);
        assertEquals((await f.post("projects", { destinationId: grant.destinationId, projectIds: [] })).status, 200);
        assertEquals(
            readMetricsExportGrants()[0].projects.map((p) => p.projectRoot),
            [secondRoot],
        );
        assertEquals((await f.get()).destinations[0].projects, []);
    });
});

test("settings credentials are write-only, mode 0600, declared-only, and malformed JSON never echoes a secret", async () => {
    await withSettingsFixture(async (f) => {
        const output: string[] = [];
        const original = { log: console.log, warn: console.warn, error: console.error };
        const capture: typeof console.log = (...values) => output.push(values.map(String).join(" "));
        console.log = console.warn = console.error = capture;
        try {
            const secret = `sk-SECRET-${crypto.randomUUID()}`;
            const created = await create(f, { credentials: { secretKey: secret } });
            assertEquals(created.status, 200);
            assertSafe(await created.json(), f, secret);
            const [grant] = readMetricsExportGrants();
            const credentialsPath = join(f.home, ".wld", "metrics-export", "credentials.json");
            assertStringIncludes(await readFile(credentialsPath, "utf8"), secret);
            assertEquals((await stat(credentialsPath)).mode & 0o777, 0o600);
            assertEquals((await readFile(join(f.home, ".wld", "settings.json"), "utf8")).includes(secret), false);
            const view = await f.get();
            assertSafe(view, f, secret);
            assertEquals(view.destinations[0].credentials, { configured: true });
            for (const credentials of [
                { undeclared: secret },
                { secretKey: "bad\nvalue" },
                { secretKey: "x".repeat(4097) },
            ]) {
                const rejected = await f.post("credentials", { destinationId: grant.destinationId, credentials });
                assertEquals(rejected.status, 400);
                assertSafe(await rejected.json(), f, secret);
            }
            for (const path of ["settings/credentials", "settings/create", "settings/recording", "clear"]) {
                const malformed = await f.app.handler()(
                    new Request(`${origin}/api/owner/usage/${path}`, {
                        method: "POST",
                        headers: f.headers,
                        body: `{\"secretKey\":\"${secret}\" broken`,
                    }),
                );
                assertEquals(malformed.status, 400);
                assertEquals(await malformed.json(), { error: "Invalid request body." });
            }
            const cleared = await f.post("credentials", { destinationId: grant.destinationId, clearCredentials: true });
            assertEquals(cleared.status, 200);
            assertEquals((await f.get()).destinations[0].credentials, { configured: false });
            assertEquals(output.join("\n").includes(secret), false);
        } finally {
            Object.assign(console, original);
        }
    });
});

for (const path of ["/present", "/drop", "/400"]) {
    test(`settings delivery snapshot equals Core after ${path}`, async () => {
        await withSettingsFixture(async (f) => {
            await f.grant(path);
            await f.record();
            await runMetricsExportCycle();
            const [core] = await readMetricsExportStatus();
            const [view] = (await f.get()).destinations;
            for (const key of ["counts", "latestCodes", "lastAttemptAt", "credentials", "exporterApproved"] as const) {
                assertEquals(view[key], core[key]);
            }
            if (path === "/present") assertEquals(view.counts.confirmed, 1);
            if (path === "/drop") assertEquals(view.counts.unconfirmed, 1);
            if (path === "/400") assertEquals(view.counts.rejected, 1);
        });
    });
}

test("settings endpoint change requires confirmation, starts a new boundary, and abandons old pending payloads", async () => {
    await withSettingsFixture(async (f) => {
        const old = await f.grant("/503");
        await f.record();
        await runMetricsExportCycle();
        const change = {
            destinationId: old.destinationId,
            endpoint: f.endpoint("/present"),
            externalProject: "changed",
            projectIds: [f.projectId],
            allowInsecureLocalEndpoint: true,
        };
        assertEquals((await f.post("destination", change)).status, 400);
        assertEquals(readMetricsExportGrants()[0].grantId, old.grantId);
        const response = await f.post("destination", { ...change, confirmed: true });
        assertEquals(response.status, 200);
        const body: UsageSettingsResponse = await response.json();
        assertEquals(body.result?.newBoundary, true);
        assert(readMetricsExportGrants()[0].grantId !== old.grantId);
        const count = f.requests.length;
        await runMetricsExportCycle();
        assertEquals(f.requests.length, count);
    });
});

test("settings revoke reports an in-flight request and stops later sends", async () => {
    await withSettingsFixture(async (f) => {
        await f.grant();
        await f.record();
        f.hold();
        const cycle = runMetricsExportCycle({ deadlineMs: 2000 });
        try {
            await f.waitForRequest();
            const response = await f.post("revoke", { destinationId: "fixture", confirmed: true });
            assertEquals(response.status, 200);
            const result: UsageSettingsResponse = await response.json();
            assertEquals(result.result?.deliveryInFlight, true);
            assertEquals(readMetricsExportGrants(), []);
        } finally {
            f.release();
            await cycle;
        }
        const count = f.requests.length;
        await f.record();
        await runMetricsExportCycle();
        assertEquals(f.requests.length, count);
    });
});

test("settings clear requires consent, preserves Project files and settings, reports in-flight delivery, and leaves usage readable", async () => {
    await withSettingsFixture(async (f) => {
        await f.grant();
        await f.record();
        const session = join(f.project, "session.jsonl");
        const plan = join(f.project, "plan.md");
        await writeFile(session, "session evidence");
        await writeFile(plan, "plan evidence");
        const before = getCustomSetting("workflowMetrics", "project", f.project);
        assertEquals((await f.post("clear", { projectIds: [f.projectId] })).status, 400);
        assert(
            queryUsageReport([f.project], { start: "2020-01-01", end: "2030-01-01" }, "UTC").totals.tokens.value > 0,
        );
        f.hold();
        const cycle = runMetricsExportCycle({ deadlineMs: 2000 });
        try {
            await f.waitForRequest();
            const response = await f.post("clear", { confirmed: true, projectIds: [f.projectId] });
            assertEquals(response.status, 200);
            const result: UsageSettingsResponse = await response.json();
            assertEquals(result.result?.cleared?.[0].cleared, true);
            assertEquals(result.result?.deliveryInFlight, true);
        } finally {
            f.release();
            await cycle;
        }
        assertEquals(await readFile(session, "utf8"), "session evidence");
        assertEquals(await readFile(plan, "utf8"), "plan evidence");
        assertEquals(getCustomSetting("workflowMetrics", "project", f.project), before);
        const report = await f.app.handler()(new Request(`${origin}/api/owner/usage`, { headers: f.headers }));
        assertEquals(report.status, 200);
        const body = await report.json();
        assertEquals(body.totals.tokens.value, 0);
        assertEquals(body.recording, (await f.get()).recording);
    });
});

test("usage settings enforce pairing, origin, CSRF, and Project access without writes", async () => {
    await withSettingsFixture(async (f) => {
        const handler = f.app.handler();
        const url = `${origin}/api/owner/usage/settings`;
        assertEquals((await handler(new Request(url))).status, 401);
        assertEquals(
            (await handler(new Request(`${url}/create`, { method: "POST", headers: { origin } }))).status,
            401,
        );
        const headers = { ...f.headers };
        delete headers["x-runwield-csrf"];
        assertEquals(
            (await handler(new Request(`${url}/recording`, { method: "POST", headers, body: "{}" }))).status,
            403,
        );
        assertEquals(
            (
                await handler(
                    new Request(`${url}/recording`, {
                        method: "POST",
                        headers: { ...f.headers, origin: "https://other.example" },
                        body: "{}",
                    }),
                )
            ).status,
            403,
        );
        await f.grant();
        const before = readMetricsExportGrants();
        f.store.setProjectEnabled(f.projectId, false);
        for (const projectId of [f.projectId, "unknown", f.project]) {
            for (const action of ["projects", "clear"]) {
                assertEquals(
                    (await f.post(action, { destinationId: "fixture", projectIds: [projectId], confirmed: true }))
                        .status,
                    400,
                );
                assertEquals(readMetricsExportGrants(), before);
            }
        }
    });
});

test("settings require HTTPS or explicit loopback HTTP permission", async () => {
    await withSettingsFixture(async (f) => {
        for (const endpoint of ["http://example.com", f.endpoint()]) {
            assertEquals((await create(f, { endpoint, allowInsecureLocalEndpoint: false })).status, 400);
        }
        assertEquals(
            (await create(f, { endpoint: "http://example.com", allowInsecureLocalEndpoint: true })).status,
            400,
        );
        assertEquals(readMetricsExportGrants(), []);
        assertEquals((await create(f)).status, 200);
        assertEquals((await f.get()).destinations[0].insecureLocalEndpoint, true);
    });
});

test("global recording preserves object settings and Project overrides while enabling an ordinary Project", async () => {
    await withSettingsFixture(async (f) => {
        await setCustomSetting("workflowMetrics", false, "project", f.project);
        await setCustomSetting("workflowMetrics", { enabled: false, retained: "value" }, "global");
        const otherRoot = join(f.project, "ordinary");
        await mkdir(otherRoot);
        const other = f.store.registerProject({ root: otherRoot, displayName: "Ordinary" });
        const response = await f.post("recording", { enabled: true });
        assertEquals(response.status, 200);
        const view: UsageSettingsResponse = await response.json();
        assertEquals(getCustomSetting("workflowMetrics", "global"), { enabled: true, retained: "value" });
        assertEquals(view.recording.projects.find((p) => p.projectId === f.projectId)?.setBy, "project");
        assertEquals(view.recording.projects.find((p) => p.projectId === f.projectId)?.enabled, false);
        assertEquals(view.recording.projects.find((p) => p.projectId === other.projectId)?.enabled, true);
        await f.record("model_usage", undefined, otherRoot);
        assert(
            queryUsageReport([otherRoot], { start: "2020-01-01", end: "2030-01-01" }, "UTC").totals.tokens.value > 0,
        );
    });
});

test("owner recording control fences captures across off and on without an intervening append", async () => {
    await withSettingsFixture(async (f) => {
        const root = join(f.project, "ordinary");
        await mkdir(root);
        f.store.registerProject({ root, displayName: "Ordinary" });
        assertEquals((await f.post("recording", { enabled: true })).status, 200);
        const path = getWorkflowMetricsFilePath(root);
        const metric = {
            v: 2,
            category: "command",
            event: "command_started",
            recorderId: "control",
            seq: 0,
            command: "help",
        };
        assertEquals((await recordWorkflowMetric(metric, root)).persisted, true);
        const state = resolveCollectionEpoch(path, true);
        const capture = {
            collectionEnabledAtCall: true,
            collectionEpoch: state.collectionEpoch.id,
            historyEpoch: state.historyEpoch,
        };
        assertEquals((await f.post("recording", { enabled: false })).status, 200);
        assertEquals((await f.post("recording", { enabled: true })).status, 200);
        const stale = await recordWorkflowMetric({ ...metric, ...capture, seq: 1 }, root);
        assertEquals(stale.persisted, false);
        assertEquals(stale.reason, "collection_boundary");
        const fresh = await recordWorkflowMetric({ ...metric, seq: 2 }, root);
        assertEquals(fresh.persisted, true);
        assert(fresh.collectionEpoch !== capture.collectionEpoch);
    });
});

for (const surface of ["report", "settings"]) {
    test(`busy legacy adoption keeps owner ${surface} available without authorizing export`, async () => {
        await withSettingsFixture(async (f) => {
            await f.grant();
            await f.record();
            const exporterKey = (await f.get()).exporters[0].exporterKey;
            const consent = getCustomSetting("metricsExport", "global");
            const path = getWorkflowMetricsFilePath(f.project);
            const legacy = join(f.home, ".wld", "workflow-metrics", encodeCwdForSessionDir(f.project));
            await rename(dirname(path), legacy);
            const guard = openNativeFileLock(join(legacy, ".journal.guard"));
            assert(guard.tryLockSync(true));
            async function report() {
                const response = await f.app.handler()(
                    new Request(`${origin}/api/owner/usage?start=2020-01-01&end=2030-01-01`, { headers: f.headers }),
                );
                assertEquals(response.status, 200);
                return (await response.json()) as OwnerUsageReport;
            }
            try {
                if (surface === "report") {
                    const view = await report();
                    assertEquals(view.projects[0].coverage.unavailable, true);
                    assertEquals(view.totals.tokens.value, 0);
                } else {
                    const settings = await f.get();
                    assertEquals(settings.exportAvailable, false);
                    assert(settings.unavailableReason);
                    assertEquals(
                        (
                            await f.post("create", {
                                exporterKey,
                                endpoint: f.endpoint(),
                                externalProject: "vendor-project",
                                allowInsecureLocalEndpoint: true,
                                projectIds: [f.projectId],
                            })
                        ).status,
                        400,
                    );
                    assertEquals(getCustomSetting("metricsExport", "global"), consent);
                }
                assertEquals(f.requests, []);
            } finally {
                guard.close();
            }
            const recovered = await report();
            assertEquals(recovered.projects[0].coverage.unavailable, false);
            assertEquals(recovered.totals.tokens.value, 6);
            assertEquals((await f.get()).destinations.length, 1);
        });
    });
}

test("empty Project recording settings inherit global generations and UI attribution", async () => {
    await withSettingsFixture(async (f) => {
        await setCustomSetting("workflowMetrics", {}, "project", f.project);
        await setCustomSetting("workflowMetrics", { enabled: false }, "global");
        assertEquals((await f.post("recording", { enabled: true })).status, 200);
        const stale = new ExecutionMetricsRecorder({ projectRoot: f.project });
        await stale.recordExecutionStart();
        assertEquals((await f.post("recording", { enabled: false })).status, 200);
        assertEquals((await f.get()).recording.projects[0].enabled, false);
        assertEquals((await f.post("recording", { enabled: true })).status, 200);
        await stale.recordModelUsage({
            sourceId: "stale",
            usageKind: "request",
            aggregationBasis: "request",
            inputTokens: 99,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        });
        const fresh = new ExecutionMetricsRecorder({ projectRoot: f.project });
        await fresh.recordExecutionStart();
        await fresh.recordModelUsage({
            sourceId: "fresh",
            usageKind: "request",
            aggregationBasis: "request",
            inputTokens: 7,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        });
        await stale.settleExecution("succeeded");
        await fresh.settleExecution("succeeded");
        assertEquals(
            queryUsageReport([f.project], { start: "2020-01-01", end: "2030-01-01" }, "UTC").totals.inputTokens.value,
            7,
        );
        assertEquals((await f.get()).recording.projects[0].setBy, "global");
        let expected = 7;
        for (const override of [true, false, { enabled: true }, { enabled: false }]) {
            await setCustomSetting("workflowMetrics", override, "project", f.project);
            const capture = new ExecutionMetricsRecorder({ projectRoot: f.project });
            await capture.recordExecutionStart();
            assertEquals((await f.post("recording", { enabled: false })).status, 200);
            assertEquals((await f.post("recording", { enabled: true })).status, 200);
            await capture.recordModelUsage({
                inputTokens: 7,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            });
            await capture.settleExecution("succeeded");
            const enabled = typeof override === "boolean" ? override : override.enabled;
            if (enabled) expected += 7;
            const setting = (await f.get()).recording.projects[0];
            assertEquals([setting.setBy, setting.enabled], ["project", enabled]);
            assertEquals(
                queryUsageReport([f.project], { start: "2020-01-01", end: "2030-01-01" }, "UTC").totals.inputTokens
                    .value,
                expected,
            );
        }
    });
});

test("a failed settings write after generation commit rejects old captures without disabling fresh work", async () => {
    await withSettingsFixture(async (f) => {
        const root = join(f.project, "ordinary");
        await mkdir(root);
        await setWorkflowMetricsRecording(true);
        const stale = new ExecutionMetricsRecorder({ projectRoot: root });
        await stale.recordExecutionStart();
        const generationPath = join(f.home, ".wld", "workflow-metrics", "recording.json");
        const before = await readFile(generationPath, "utf8");
        const release = lockfile.lockSync(join(f.home, ".wld", "settings.json"), { realpath: false });
        try {
            await rejects(() => setWorkflowMetricsRecording(false), /already being held/);
        } finally {
            release();
        }
        assertEquals(getCustomSetting("workflowMetrics", "global"), true);
        const observation = { inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        await stale.recordModelUsage(observation);
        const fresh = new ExecutionMetricsRecorder({ projectRoot: root });
        await fresh.recordExecutionStart();
        await fresh.recordModelUsage(observation);
        await stale.settleExecution("succeeded");
        await fresh.settleExecution("succeeded");
        assertEquals(
            queryUsageReport([root], { start: "2020-01-01", end: "2030-01-01" }, "UTC").totals.inputTokens.value,
            7,
        );
        assert((await readFile(generationPath, "utf8")) !== before);
    });
});
