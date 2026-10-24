import process from "node:process";
import { getCwd } from "../../constants.js";
import { spawnNativeProcess } from "../../shared/foreground-process.ts";
import { setCustomSetting } from "../../shared/settings.js";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import {
    mkdir as fsMkdir,
    writeFile as fsWriteFile,
    readFile as fsReadFile,
    rm as fsRm,
    rename as fsRename,
    symlink as fsSymlink,
} from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { queryUsageReport } from "../../shared/workflow/usage-reporting.ts";
import { getWorkflowMetricsFilePath } from "../../shared/workflow/metrics.js";
import { defineCommittedGitFixture } from "../../shared/git-test-fixture.ts";
import { withWorkflowMetricsFixture } from "../../testing/workflow-metrics-fixture.ts";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { createOwnerWorkspaceApp } from "./server.js";
import type { OwnerUsageReport } from "./server/owner-usage.ts";

interface FixtureRow {
    v: number;
    event: string;
    ts: string;
    eventId: string;
    [key: string]: string | number | boolean;
}
const period = { start: "2026-09-01", end: "2026-09-04" };
const origin = "http://127.0.0.1:8787";
const repo = defineCommittedGitFixture();
function row(event: string, ts: string, fields: Record<string, string | number | boolean> = {}): FixtureRow {
    return { v: 2, event, ts, eventId: crypto.randomUUID(), ...fields };
}
function usage(fields: Record<string, string | number | boolean> = {}) {
    return row("model_usage", "2026-09-01T16:00:00Z", {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        inputCacheBasis: "excludes_cache",
        aggregationBasis: "turn",
        costAmount: 0.5,
        costCurrency: "USD",
        costSource: "calculated",
        backend: "pi",
        provider: "test",
        model: "model",
        ...fields,
    });
}
async function journal(root: string, rows: FixtureRow[]) {
    const path = getWorkflowMetricsFilePath(root);
    await fsMkdir(dirname(path), { recursive: true });
    await fsWriteFile(
        path,
        [
            row("collection_epoch", "2026-08-30T00:00:00Z", { v: 1, enabled: true }),
            ...rows,
            row("collection_epoch", "2026-09-06T00:00:00Z", { v: 1, enabled: true }),
        ]
            .map((item) => JSON.stringify(item))
            .join("\n") + "\n",
    );
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
function reportUrl(projectId = "") {
    const params = new URLSearchParams(period);
    if (projectId) params.set("projectId", projectId);
    return `${origin}/api/owner/usage?${params}`;
}

test("owner usage preserves exact Core totals, mixed daily gaps, backend and model aggregates", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const second = join(projectRoot, "second");
        await fsMkdir(second);
        const a = store.registerProject({ root: projectRoot, displayName: "A" });
        const b = store.registerProject({ root: second, displayName: "B" });
        const roots = [a, b].map((project) => store.requireEnabledProjectRoot(project.projectId));
        await journal(roots[0], [usage(), row("measurement_gap", "2026-09-03T16:00:00Z")]);
        await journal(roots[1], [usage({ inputTokens: 20, backend: "claude-cli", model: "other", costAmount: 0.75 })]);
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        try {
            const response = await app.handler()(new Request(reportUrl(), { headers: pairedHeaders(store) }));
            assertEquals(response.status, 200);
            const result: OwnerUsageReport = await response.json();
            const core = queryUsageReport(roots, period, result.timeZone);
            for (const key of ["totals", "daily", "backends", "models"] as const) assertEquals(result[key], core[key]);
            assertEquals(result.totals.tokens.value, 48);
            assertEquals(result.totals.estimatedCostUsd.value, 1.25);
            assertEquals(
                result.daily.map((day) => day.tokens),
                [48, 0, null],
            );
            assertEquals(result.recordedThrough, "2026-09-06T00:00:00Z");
            assertEquals(
                result.projects.map((project) => project.aliases[0].projectId).sort(),
                [a.projectId, b.projectId].sort(),
            );
            const filteredResponse = await app.handler()(
                new Request(reportUrl(a.projectId), { headers: pairedHeaders(store) }),
            );
            const filtered: OwnerUsageReport = await filteredResponse.json();
            assertEquals(filtered.totals.tokens.value, 19);
            assertEquals(filtered.projects.length, 1);
            assertEquals(
                filtered.excludedProjects.find((project) => project.projectId === b.projectId)?.exclusionReason,
                "not selected",
            );
        } finally {
            await app.close();
            store.close();
        }
    });
});

test("primary and worktree registrations share totals once and retain both labels", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir }) => {
        const primary = await repo.checkout();
        const worktree = `${primary}-worktree`;
        const command = await captureForegroundProcess("git", {
            cwd: primary,
            args: ["worktree", "add", "-b", "usage-alias", worktree],
        });
        assertEquals(command.code, 0);
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const a = store.registerProject({ root: primary, displayName: "Primary" });
        const b = store.registerProject({ root: worktree, displayName: "Worktree" });
        await journal(store.requireEnabledProjectRoot(a.projectId), [usage()]);
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        try {
            const headers = pairedHeaders(store);
            const response = await app.handler()(new Request(reportUrl(), { headers }));
            const result: OwnerUsageReport = await response.json();
            assertEquals(result.totals.tokens.value, 19);
            assertEquals(result.totals.estimatedCostUsd.value, 0.5);
            assertEquals(result.projects.length, 1);
            assertEquals(result.projects[0].aliases.map((alias) => alias.label).sort(), ["Primary", "Worktree"]);
            for (const project of [a, b]) {
                const selected: OwnerUsageReport = await (
                    await app.handler()(new Request(reportUrl(project.projectId), { headers }))
                ).json();
                assertEquals(selected.totals.tokens.value, 19);
                assertEquals(selected.projects[0].projectId, project.projectId);
            }
        } finally {
            await app.close();
            store.close();
            await fsRm(worktree, { recursive: true });
            await fsRm(primary, { recursive: true });
        }
    });
});

test("disabled, removed, unavailable and unregistered Projects cannot contribute or be queried", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const included = store.registerProject({ root: projectRoot });
        await journal(store.requireEnabledProjectRoot(included.projectId), [usage()]);
        const denied = [];
        for (const label of ["disabled", "removed", "unavailable"]) {
            const root = join(projectRoot, label);
            await fsMkdir(root);
            const project = store.registerProject({ root, displayName: label });
            await journal(store.requireEnabledProjectRoot(project.projectId), [usage({ inputTokens: 900 })]);
            if (label === "disabled") store.setProjectEnabled(project.projectId, false);
            if (label === "removed") store.removeProject(project.projectId);
            if (label === "unavailable") await fsRename(root, `${root}-moved`);
            denied.push(project.projectId);
        }
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        try {
            const headers = pairedHeaders(store);
            const result: OwnerUsageReport = await (await app.handler()(new Request(reportUrl(), { headers }))).json();
            assertEquals(result.totals.tokens.value, 19);
            assertEquals(result.availableProjects.length, 1);
            assert(result.excludedProjects.some((project) => project.displayName === "disabled"));
            assert(result.excludedProjects.some((project) => project.displayName === "unavailable"));
            for (const projectId of [...denied, "unregistered"]) {
                const response = await app.handler()(new Request(reportUrl(projectId), { headers }));
                assertEquals(response.status, 400);
                assertEquals("totals" in (await response.json()), false);
            }
        } finally {
            await app.close();
            store.close();
        }
    });
});

test("usage requires pairing and rejects invalid periods with sanitized errors", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        store.registerProject({ root: projectRoot });
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        try {
            assertEquals((await app.handler()(new Request(reportUrl()))).status, 401);
            const page = await app.handler()(new Request(`${origin}/usage`));
            assertEquals(page.status, 302);
            assertEquals(page.headers.get("location"), "/pair");
            const headers = pairedHeaders(store);
            const invalid = await app.handler()(
                new Request(`${origin}/api/owner/usage?start=bad&end=2026-09-04`, { headers }),
            );
            assertEquals(invalid.status, 400);
            const body = await invalid.text();
            assertStringIncludes(body, "invalid_usage_period");
            assertEquals(body.includes(projectRoot), false);
        } finally {
            await app.close();
            store.close();
        }
    });
});

test("usage links use managed Session and Plan IDs and omit missing or foreign targets", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const fixture = await makeManagedSessionFixture({
            home: homeDir,
            projectRoot,
            dbPath: join(homeDir, "owner.sqlite3"),
        });
        const store = fixture.store;
        const foreign = await makeManagedSessionFixture({
            home: homeDir,
            projectRoot: join(projectRoot, "foreign"),
            dbPath: join(homeDir, "foreign.sqlite3"),
        });
        store.registerProject({ root: foreign.projectRoot });
        const planId = crypto.randomUUID();
        const planPath = join(projectRoot, "docs", "plans", "usage-example.md");
        await fsMkdir(dirname(planPath), { recursive: true });
        await fsWriteFile(
            planPath,
            `---\nplanId: "${planId}"\nstatus: draft\nclassification: PLANNED_CHANGE\n---\n# Usage Example\n`,
        );
        await journal(store.requireEnabledProjectRoot(fixture.project.projectId), [
            usage({ managedSessionId: fixture.session.runwieldSessionId, planId }),
            usage({ managedSessionId: "missing-session", planId: "missing-plan" }),
            usage({ managedSessionId: foreign.session.runwieldSessionId }),
        ]);
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        try {
            const headers = pairedHeaders(store);
            const result: OwnerUsageReport = await (await app.handler()(new Request(reportUrl(), { headers }))).json();
            const links = result.projects.find((project) => project.projectId === fixture.project.projectId)!.links;
            const prefix = `/projects/${fixture.project.projectId}`;
            const valid = links.find((link) => link.sessionId === fixture.session.runwieldSessionId);
            assertEquals(valid?.sessionHref, `${prefix}/sessions/${fixture.session.runwieldSessionId}`);
            assertEquals(valid?.planHref, `${prefix}/plans/${planId}`);
            const missing = links.find((link) => link.sessionId === "missing-session");
            assert(missing);
            assertEquals(missing.sessionHref, undefined);
            assertEquals(missing?.planHref, undefined);
            const foreignLink = links.find((link) => link.sessionId === foreign.session.runwieldSessionId);
            assert(foreignLink);
            assertEquals(foreignLink.sessionHref, undefined);
            assertEquals(result.totals.tokens.value, 57);
            await fsRm(planPath);
            const deleted: OwnerUsageReport = await (await app.handler()(new Request(reportUrl(), { headers }))).json();
            assertEquals(
                deleted.projects.flatMap((project) => project.links).some((link) => link.planHref),
                false,
            );
            assertEquals(deleted.totals.tokens.value, 57);
        } finally {
            await app.close();
            await fixture.cleanup();
            await foreign.cleanup();
        }
    });
});

test("pending operations do not become settled spend", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const project = store.registerProject({ root: projectRoot });
        await journal(store.requireEnabledProjectRoot(project.projectId), [
            row("execution_started", "2026-09-01T15:00:00Z", { executionId: "active" }),
            usage({ executionId: "active" }),
        ]);
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        try {
            const result: OwnerUsageReport = await (
                await app.handler()(new Request(reportUrl(), { headers: pairedHeaders(store) }))
            ).json();
            assertEquals(result.totals.tokens.value, 0);
            assertEquals(result.totals.estimatedCostUsd.value, 0);
            assertEquals(result.coverage.incompleteOperations, 1);
            assertEquals(result.projects[0].incomplete[0].executionId, "active");
            assertEquals(result.daily[0].tokens, null);
        } finally {
            await app.close();
            store.close();
        }
    });
});

test("shared history links resolve targets in a second authorized worktree", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir }) => {
        const primary = await repo.checkout();
        const worktree = `${primary}-worktree`;
        assertEquals(
            (
                await captureForegroundProcess("git", {
                    cwd: primary,
                    args: ["worktree", "add", "-b", "usage-links", worktree],
                })
            ).code,
            0,
        );
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const primaryProject = store.registerProject({ root: primary, displayName: "Primary" });
        const fixture = await makeManagedSessionFixture({
            home: homeDir,
            projectRoot: worktree,
            dbPath: join(homeDir, "owner.sqlite3"),
        });
        const planId = crypto.randomUUID();
        const planPath = join(worktree, "docs", "plans", "worktree-only.md");
        await fsMkdir(dirname(planPath), { recursive: true });
        await fsWriteFile(
            planPath,
            `---\nplanId: "${planId}"\nstatus: draft\nclassification: PLANNED_CHANGE\n---\n# Worktree-only Plan\n`,
        );
        await journal(store.requireEnabledProjectRoot(primaryProject.projectId), [
            usage({ managedSessionId: fixture.session.runwieldSessionId, planId }),
        ]);
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store: fixture.store });
        try {
            const result: OwnerUsageReport = await (
                await app.handler()(new Request(reportUrl(), { headers: pairedHeaders(fixture.store) }))
            ).json();
            assertEquals(result.projects.length, 1);
            assertEquals(result.projects[0].aliases.length, 2);
            assertEquals(result.totals.tokens.value, 19);
            const link = result.projects[0].links[0];
            const prefix = `/projects/${fixture.project.projectId}`;
            assertEquals(link.sessionHref, `${prefix}/sessions/${fixture.session.runwieldSessionId}`);
            assertEquals(link.planHref, `${prefix}/plans/${planId}`);
        } finally {
            await app.close();
            await fixture.cleanup();
            store.close();
            await fsRm(worktree, { recursive: true });
            await fsRm(primary, { recursive: true });
        }
    });
});

test("owner usage explains a pending history clear and reads again after recovery", async () => {
    await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
        const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
        const project = store.registerProject({ root: projectRoot, displayName: "A" });
        const root = store.requireEnabledProjectRoot(project.projectId);
        await journal(root, [usage()]);
        await setCustomSetting("workflowMetrics", false, "project", root);
        const marker = join(dirname(getWorkflowMetricsFilePath(root)), "clear.json");
        const historyMarker =
            JSON.stringify({
                v: 1,
                event: "history_epoch",
                historyEpoch: "fresh",
                collectionEpoch: "off",
                enabled: false,
                ts: "2026-09-02T00:00:00Z",
            }) + "\n";
        await fsWriteFile(
            marker,
            JSON.stringify({
                state: {
                    v: 1,
                    historyEpoch: "fresh",
                    collectionEpoch: { id: "off", enabled: false },
                    journalBytes: new TextEncoder().encode(historyMarker).length,
                    journalLines: 1,
                },
                marker: historyMarker,
            }),
        );
        const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
        try {
            const headers = pairedHeaders(store);
            const intentBeforeRead = await fsReadFile(marker, "utf8");
            const response = await app.handler()(new Request(reportUrl(), { headers }));
            assertEquals(response.status, 200);
            assertEquals(await fsReadFile(marker, "utf8"), intentBeforeRead);
            const pending: OwnerUsageReport = await response.json();
            assertEquals(JSON.stringify(pending).includes("history_clear_pending"), false);
            assertEquals(pending.projects[0].coverage.historyClearPending, true);
            assertEquals(pending.projects[0].links, []);
            assertEquals(pending.totals.tokens.value, 0);
            assertEquals(pending.daily[0].tokens, null);
            assertEquals(pending.recording.projects[0].enabled, false);
            const retried = await app.handler()(
                new Request(`${origin}/api/owner/usage/clear`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ projectIds: [project.projectId], confirmed: true }),
                }),
            );
            assertEquals(retried.status, 200);
            assertEquals((await retried.json()).result.cleared[0].cleared, true);
            const recovered = await app.handler()(new Request(reportUrl(), { headers }));
            assertEquals(recovered.status, 200);
            const settled: OwnerUsageReport = await recovered.json();
            assertEquals(settled.projects[0].coverage.historyClearPending, false);
            assertEquals(settled.totals.tokens.value, 0);
            assertEquals(settled.recording.projects[0].enabled, false);
        } finally {
            await app.close();
            store.close();
        }
    });
});

test(
    "repeated concurrent history changes return a readable report and keep stable Projects",
    {
        skip: process.platform === "win32",
    },
    async () => {
        await withWorkflowMetricsFixture(async ({ homeDir, projectRoot }) => {
            const store = openOwnerCoordinationStore({ dbPath: join(homeDir, "owner.sqlite3") });
            const unstable = store.registerProject({ root: projectRoot, displayName: "Clearing" });
            const stableRoot = join(projectRoot, "stable");
            await fsMkdir(stableRoot);
            const stable = store.registerProject({ root: stableRoot, displayName: "Stable" });
            const root = store.requireEnabledProjectRoot(unstable.projectId);
            await journal(root, [usage()]);
            await journal(store.requireEnabledProjectRoot(stable.projectId), [usage()]);
            const statePath = join(dirname(getWorkflowMetricsFilePath(root)), "state.json");
            const pipes = Array.from({ length: 9 }, (_, index) => `${statePath}.${index}`);
            assertEquals((await captureForegroundProcess("mkfifo", { args: pipes, cwd: getCwd() })).code, 0);
            await fsSymlink(pipes[0], statePath);
            // A real filesystem boundary supplies two consistent reads followed by a new
            // epoch at the final snapshot check, for each of the three bounded attempts.
            // Each read has its own pipe; replacing the link before sending guarantees EOF
            // without sleeps or a writer racing to reopen the same reader.
            const writer = spawnNativeProcess(process.execPath, {
                args: [
                    "-e",
                    `
                const fs = require("node:fs");
                const path = process.argv[1];
                for (let read = 0; read < 9; read++) {
                    const epoch = read % 3 === 2 ? "changed" : "initial";
                    const fd = fs.openSync(path + "." + read, "w");
                    if (read < 8) fs.symlinkSync(path + "." + (read + 1), path + ".next");
                    else fs.writeFileSync(path + ".next", JSON.stringify({ historyEpoch: "settled" }));
                    fs.renameSync(path + ".next", path);
                    fs.writeSync(fd, JSON.stringify({ historyEpoch: epoch }));
                    fs.closeSync(fd);
                }
            `,
                    statePath,
                ],
                cwd: getCwd(),
                stdin: "null",
                stdout: "null",
                stderr: "piped",
            });
            const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
            try {
                const response = await app.handler()(new Request(reportUrl(), { headers: pairedHeaders(store) }));
                assertEquals(response.status, 200);
                const report: OwnerUsageReport = await response.json();
                const clearing = report.projects.find((project) => project.projectId === unstable.projectId)!;
                assertEquals(clearing.coverage.historyClearPending, true);
                assertEquals(clearing.links, []);
                assertEquals(clearing.totals.tokens.value, 0);
                assertEquals(
                    report.projects.find((project) => project.projectId === stable.projectId)?.totals.tokens.value,
                    19,
                );
                assertEquals(report.totals.tokens.value, 19);
            } finally {
                writer.kill();
                await writer.status;
                await app.close();
                store.close();
            }
        });
    },
);
