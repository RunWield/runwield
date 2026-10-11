// @ts-nocheck: focused service tests use the repository's JavaScript-style owner store.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { savePlan, writePlanMarkdownWithRevision } from "../../../plan-store.js";
import { openOwnerCoordinationStore } from "../../../shared/owner-coordination/index.js";
import { addEntry, withWorktreeRegistryLockAtPath } from "../../../shared/worktree-registry.js";
import { getRunWieldRuntimeDir } from "../../../constants.js";
import { formatWorkRecordMarkdown } from "../../../shared/work-records/markdown.js";
import { replaceWorkRecord, writeWorkRecord } from "../../../shared/work-records/store.js";
import {
    getWorkspaceSearchRefreshMarker,
    requestWorkspaceSearchRefresh,
} from "../../../shared/workspace-search-refresh.ts";
import { makeManagedSessionFixture, readTranscriptEvidence } from "../../../testing/managed-session-fixture.ts";
import { readProjectArtifact } from "./project-artifacts.ts";
import { loadWorkspaceDetail } from "./plan-adapter.js";
import { createWorkspaceSearchService, WORKSPACE_SEARCH_SCAN_INTERVAL_MS } from "./workspace-search.ts";
import { createOwnerWorkspaceApp, startWorkspaceServer } from "../server.js";

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return await condition();
}

async function searchFixture(name: string, searchOptions: { scanIntervalMs?: number } = {}) {
    const dir = await Deno.makeTempDir({ prefix: `runwield-search-${name}-` });
    const root = join(dir, "project");
    await Deno.mkdir(root, { recursive: true });
    const store = openOwnerCoordinationStore({ dbPath: join(dir, "owner.sqlite3") });
    const project = store.registerProject({ root, displayName: "Search Project" });
    const search = createWorkspaceSearchService({ store, dbPath: join(dir, "search.sqlite3"), ...searchOptions });
    await search.refresh();
    return {
        dir,
        root,
        store,
        project,
        search,
        async close() {
            await search.close();
            store.close();
            await Deno.remove(dir, { recursive: true });
        },
    };
}

Deno.test("Workspace search ranks every valid candidate before paging", async () => {
    const fixture = await searchFixture("pagination");
    try {
        await Deno.mkdir(join(fixture.root, "docs", "prd"), { recursive: true });
        for (let index = 0; index < 505; index += 1) {
            await Deno.writeTextFile(
                join(fixture.root, "docs", "prd", `${String(index).padStart(3, "0")}.md`),
                `# Candidate ${index}\n\nNeedle ranking body.\n`,
            );
        }
        await Deno.writeTextFile(
            join(fixture.root, "docs", "prd", "exact.md"),
            "# Needle ranking\n\nExact title after a large candidate set.\n",
        );
        await fixture.search.refresh();
        const first = await fixture.search.search({ query: "Needle ranking", page: 1, pageSize: 20 });
        const second = await fixture.search.search({ query: "Needle ranking", page: 2, pageSize: 20 });
        assertEquals(first.total, 506);
        assertEquals(first.results[0].title, "Needle ranking");
        assertEquals(first.results.length, 20);
        assertEquals(second.results.length, 20);
        assertEquals(new Set([...first.results, ...second.results].map((result) => result.id)).size, 40);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search keeps deterministic order across Projects and applies the Project filter", async () => {
    const fixture = await searchFixture("project-filter");
    const secondRoot = join(fixture.dir, "second-project");
    try {
        await Deno.mkdir(join(fixture.root, "docs", "prd"), { recursive: true });
        await Deno.mkdir(join(secondRoot, "docs", "prd"), { recursive: true });
        await Deno.writeTextFile(
            join(fixture.root, "docs", "prd", "one.md"),
            "# Shared exact\n\nMulti Project needle.\n",
        );
        await Deno.writeTextFile(
            join(secondRoot, "docs", "prd", "two.md"),
            "# Shared exact\n\nMulti Project needle.\n",
        );
        const second = fixture.store.registerProject({ root: secondRoot, displayName: "Second Project" });
        await fixture.search.refresh();
        const all = await fixture.search.search({ query: "Shared exact" });
        const repeated = await fixture.search.search({ query: "Shared exact" });
        assertEquals(all.results.map((result) => result.id), repeated.results.map((result) => result.id));
        assertEquals(all.total, 2);
        const filtered = await fixture.search.search({ query: "Shared exact", projectId: second.projectId });
        assertEquals(filtered.results.map((result) => result.projectName), ["Second Project"]);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search hydrates current Work Record confidence, summary, links, and notices", async () => {
    const fixture = await searchFixture("work-record");
    try {
        const attrs = {
            kind: "work_record",
            recordId: "a1111111-1111-4111-8111-111111111111",
            status: "approved",
            scope: "planned_change",
            origin: "internal",
            completionMode: "verified",
            createdAt: "2026-09-01T00:00:00.000Z",
            provenance: { sourcePlans: ["old-plan"] },
        };
        const record = await writeWorkRecord(
            fixture.root,
            attrs,
            "# Search Record\n\n## Summary\n\nOld searchable summary.\n",
            { fileName: "record.md" },
        );
        await fixture.search.refresh();
        await replaceWorkRecord(
            fixture.root,
            record,
            formatWorkRecordMarkdown(
                { ...attrs, completionMode: "done_enough", provenance: { sourcePlans: ["current-plan"] } },
                "# Search Record\n\n## Summary\n\nCurrent searchable summary.\n\n## Deferred Work\n\nFollow up.\n",
            ),
        );
        const payload = await fixture.search.search({ query: "Search Record" });
        assertEquals(payload.results[0].summary, "Current searchable summary.");
        assertEquals(payload.results[0].completionMode, "done_enough");
        assertEquals(payload.results[0].sourceLinks, ["current-plan"]);
        assertEquals(payload.results[0].notices.length > 0, true);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search revokes removed Domain Language map entries at query and open time", async () => {
    const fixture = await searchFixture("domain-map");
    try {
        await Deno.mkdir(join(fixture.root, "docs", "context"), { recursive: true });
        await Deno.writeTextFile(
            join(fixture.root, "docs", "domain-language-map.md"),
            "# Map\n\n[Context](context/domain-language.md)\n",
        );
        await Deno.writeTextFile(
            join(fixture.root, "docs", "context", "domain-language.md"),
            "# Context Language\n\nRevocable glossary token.\n",
        );
        await fixture.search.refresh();
        assertEquals((await fixture.search.search({ query: "Revocable glossary" })).total, 1);
        await Deno.writeTextFile(join(fixture.root, "docs", "domain-language-map.md"), "# Map\n\nNo contexts.\n");
        assertEquals((await fixture.search.search({ query: "Revocable glossary" })).total, 0);
        let message = "";
        try {
            await readProjectArtifact(fixture.root, "domain-language", "docs/context/domain-language.md");
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        assertStringIncludes(message, "current map");
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search rejects Project reader symlink escapes and names the failed reader", async () => {
    const fixture = await searchFixture("escape");
    const outside = join(fixture.dir, "outside");
    try {
        await Deno.mkdir(outside);
        await Deno.writeTextFile(join(outside, "outside.md"), "# Outside Secret\n\nEscaped token.\n");
        await Deno.mkdir(join(fixture.root, "docs"), { recursive: true });
        await Deno.symlink(outside, join(fixture.root, "docs", "prd"));
        await fixture.search.refresh();
        const payload = await fixture.search.search({ query: "Escaped token" });
        assertEquals(payload.total, 0);
        assertEquals(payload.states[0].reader, "Documentation reader");
        assertEquals(payload.states[0].message, "Documentation reader indexing failed.");
        assertEquals(JSON.stringify(payload).includes(outside), false);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search discards rejected candidates before pagination", async () => {
    const fixture = await searchFixture("rejected-pagination");
    try {
        await fixture.search.refresh();
        await Deno.mkdir(join(fixture.root, "docs", "prd"), { recursive: true });
        for (let index = 0; index < 25; index += 1) {
            await Deno.writeTextFile(
                join(fixture.root, "docs", "prd", `${index}.md`),
                `# Paging ${index}\n\nRejected candidate needle.\n`,
            );
        }
        await fixture.search.refresh();
        for (let index = 0; index < 10; index += 1) {
            await Deno.remove(join(fixture.root, "docs", "prd", `${index}.md`));
        }
        const first = await fixture.search.search({ query: "Rejected candidate", page: 1, pageSize: 10 });
        const second = await fixture.search.search({ query: "Rejected candidate", page: 2, pageSize: 10 });
        assertEquals(first.total, 15);
        assertEquals(first.results.length, 10);
        assertEquals(second.results.length, 5);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search quarantines a newer database and rebuilds recoverable results across restart", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-search-corrupt-" });
    const root = join(dir, "project");
    const dbPath = join(dir, "search.sqlite3");
    await Deno.mkdir(join(root, "docs", "prd"), { recursive: true });
    await Deno.writeTextFile(join(root, "docs", "prd", "recovered.md"), "# Recovered\n\nRecovery needle.\n");
    const newer = new DatabaseSync(dbPath);
    newer.exec("PRAGMA user_version = 99");
    newer.close();
    const ownerDbPath = join(dir, "owner.sqlite3");
    const store = openOwnerCoordinationStore({ dbPath: ownerDbPath });
    store.registerProject({ root });
    let search = createWorkspaceSearchService({ store, dbPath });
    try {
        await search.refresh();
        assertEquals((await search.search({ query: "Recovery needle" })).total, 1);
        const names = [...Deno.readDirSync(dir)].map((entry) => entry.name);
        assertEquals(names.some((name) => name.startsWith("search.sqlite3.quarantine-")), true);
        await search.close();
        store.close();
        const restartedStore = openOwnerCoordinationStore({ dbPath: ownerDbPath });
        search = createWorkspaceSearchService({ store: restartedStore, dbPath });
        await search.refresh();
        assertEquals((await search.search({ query: "Recovery needle" })).total, 1);
        await search.close();
        restartedStore.close();
        search = null;
    } finally {
        if (search) await search.close();
        try {
            store.close();
        } catch {
            // The restart path already closed this handle.
        }
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Workspace search quarantines a corrupt database and rebuilds recoverable results", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-search-corrupt-" });
    const root = join(dir, "project");
    const dbPath = join(dir, "search.sqlite3");
    await Deno.mkdir(join(root, "docs", "prd"), { recursive: true });
    await Deno.writeTextFile(join(root, "docs", "prd", "recovered.md"), "# Recovered\n\nCorrupt recovery needle.\n");
    await Deno.writeTextFile(dbPath, "not a sqlite database");
    const store = openOwnerCoordinationStore({ dbPath: join(dir, "owner.sqlite3") });
    store.registerProject({ root });
    const search = createWorkspaceSearchService({ store, dbPath });
    try {
        await search.refresh();
        assertEquals((await search.search({ query: "Corrupt recovery needle" })).total, 1);
        const names = [...Deno.readDirSync(dir)].map((entry) => entry.name);
        assertEquals(names.some((name) => name.startsWith("search.sqlite3.quarantine-")), true);
    } finally {
        await search.close();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("owner Workspace app closes and reopens durable Search state", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-search-app-restart-" });
    const root = join(dir, "project");
    const ownerDbPath = join(dir, "owner.sqlite3");
    await Deno.mkdir(join(root, "docs", "prd"), { recursive: true });
    await Deno.writeTextFile(join(root, "docs", "prd", "restart.md"), "# App Restart\n\nApp restart needle.\n");
    let store = openOwnerCoordinationStore({ dbPath: ownerDbPath });
    store.registerProject({ root });
    let app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    try {
        await app.workspaceSearch.refresh();
        assertEquals((await app.workspaceSearch.search({ query: "App restart needle" })).total, 1);
        await app.close();
        store.close();

        store = openOwnerCoordinationStore({ dbPath: ownerDbPath });
        app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
        assertEquals((await app.workspaceSearch.search({ query: "App restart needle" })).total, 1);
    } finally {
        await app.close();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("production Workspace HTTP server closes and restarts Search", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-search-http-restart-" });
    const root = join(dir, "project");
    const ownerDbPath = join(dir, "owner.sqlite3");
    await Deno.mkdir(join(root, "docs", "prd"), { recursive: true });
    await Deno.writeTextFile(join(root, "docs", "prd", "restart.md"), "# HTTP Restart\n\nHTTP restart needle.\n");
    const reservation = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (reservation.addr as Deno.NetAddr).port;
    reservation.close();
    const origin = `http://127.0.0.1:${port}`;
    let store = openOwnerCoordinationStore({ dbPath: ownerDbPath });
    store.registerProject({ root });
    const pairing = store.createPairingRequest({ codeFactory: () => "SEA123", proofFactory: () => "proof" });
    store.approvePairingRequest(pairing.code);
    const claimed = store.claimPairingRequest(pairing.proof, {
        credentialFactory: () => "credential-secret",
        csrfFactory: () => "csrf-secret",
    });
    const headers = { cookie: `rw_owner_device=${encodeURIComponent(claimed.credential)}` };
    let server = startWorkspaceServer({ mode: "owner", host: "127.0.0.1", port, publicOrigin: origin, store });
    try {
        const indexed = async () => {
            const response = await fetch(`${origin}/api/owner/search?q=HTTP+restart+needle`, { headers });
            return response.ok && (await response.json()).total === 1;
        };
        assertEquals(await waitFor(indexed), true);
        await server.shutdown();
        store.close();

        store = openOwnerCoordinationStore({ dbPath: ownerDbPath });
        server = startWorkspaceServer({ mode: "owner", host: "127.0.0.1", port, publicOrigin: origin, store });
        assertEquals(await waitFor(indexed), true);
    } finally {
        await server.shutdown();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("nested and execution-worktree Plan writes request refresh for the primary Project", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-search-plan-refresh-" });
    try {
        await savePlan(dir, "new-plan", "# New Plan\n\nCreation refresh.\n", {
            planId: "new-plan-id",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        const marker = await getWorkspaceSearchRefreshMarker(dir);
        assertEquals((await Deno.stat(marker)).isFile, true);
        await Deno.remove(marker);

        await Deno.mkdir(join(dir, "docs", "plans", "epic"), { recursive: true });
        const planPath = join(dir, "docs", "plans", "epic", "child.md");
        const markdown = "# Child Plan\n\nRefresh nested Plan search.\n";
        await Deno.writeTextFile(planPath, markdown);
        await writePlanMarkdownWithRevision(planPath, `${markdown}\nUpdated.\n`);
        assertEquals((await Deno.stat(marker)).isFile, true);
        await Deno.remove(marker);

        const executionRoot = join(dir, "execution-worktree");
        await Deno.mkdir(join(dir, ".git", "worktrees", "execution"), { recursive: true });
        await Deno.mkdir(join(executionRoot, "docs", "plans", "sequence"), { recursive: true });
        await Deno.writeTextFile(
            join(executionRoot, ".git"),
            `gitdir: ${join(dir, ".git", "worktrees", "execution")}\n`,
        );
        const executionPlan = join(executionRoot, "docs", "plans", "sequence", "child.md");
        await Deno.writeTextFile(executionPlan, markdown);
        await writePlanMarkdownWithRevision(executionPlan, `${markdown}\nExecution update.\n`);
        assertEquals((await Deno.stat(marker)).isFile, true);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Workspace search rescans external edits without manual refresh", async () => {
    const fixture = await searchFixture("auto-scan", { scanIntervalMs: 100 });
    try {
        assertEquals(WORKSPACE_SEARCH_SCAN_INTERVAL_MS <= 30_000, true);
        const indexed = async () => (await fixture.search.search({ query: "Automatic needle" })).total;
        const ready = async () =>
            (await fixture.search.search({ query: "Automatic needle" })).states.some((state) =>
                state.state === "ready"
            );
        assertEquals(await waitFor(ready), true);
        await Deno.mkdir(join(fixture.root, "docs", "prd"), { recursive: true });
        const documentPath = join(fixture.root, "docs", "prd", "auto.md");
        await Deno.writeTextFile(documentPath, "# Auto Doc\n\nAutomatic needle body.\n");
        assertEquals(await waitFor(async () => (await indexed()) === 1), true);
        await Deno.remove(documentPath);
        assertEquals(await waitFor(async () => (await indexed()) === 0), true);
    } finally {
        await fixture.close();
    }
});

Deno.test("a refresh request triggers an earlier scan than the interval", async () => {
    const fixture = await searchFixture("marker-refresh", { scanIntervalMs: WORKSPACE_SEARCH_SCAN_INTERVAL_MS });
    try {
        const found = async () => (await fixture.search.search({ query: "Marker needle" })).total === 1;
        const ready = async () =>
            (await fixture.search.search({ query: "Marker needle" })).states.some((state) => state.state === "ready");
        assertEquals(await waitFor(ready), true);
        await Deno.mkdir(join(fixture.root, "docs", "prd"), { recursive: true });
        await Deno.writeTextFile(join(fixture.root, "docs", "prd", "marker.md"), "# Marker Doc\n\nMarker needle.\n");
        assertEquals(await found(), false);
        await requestWorkspaceSearchRefresh(fixture.root);
        assertEquals(await waitFor(found), true);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search verifies committed Session evidence and reads every catalog page", async () => {
    const fixture = await makeManagedSessionFixture();
    const search = createWorkspaceSearchService({
        store: fixture.store,
        dbPath: join(fixture.home, "session-search.sqlite3"),
    });
    try {
        for (let index = 0; index < 100; index += 1) {
            const piSessionId = `catalog-page-${index}`;
            const timestamp = new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString();
            const transcriptPath = join(fixture.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
            const transcript = `${
                JSON.stringify({
                    type: "session",
                    id: piSessionId,
                    timestamp,
                    cwd: fixture.projectRoot,
                    name: `Catalog page Session ${index}`,
                })
            }\n`;
            await Deno.writeTextFile(transcriptPath, transcript);
            let id = 0;
            const session = await fixture.store.ensureSessionCatalogRecord({
                projectId: fixture.project.projectId,
                piSessionId,
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
                source: "catalog",
                idFactory: () => `${piSessionId}-${++id}`,
                now: () => timestamp,
            });
            let proof = fixture.store.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: fixture.project.projectId,
                ownerInstanceId: `catalog-test-${index}`,
                ownerProcessKind: "test",
                operationId: `catalog-test-${index}`,
                expectedGeneration: null,
                phase: "bootstrap",
                now: () => timestamp,
            });
            proof = fixture.store.changeSessionActivationPhase(proof, "checkpointing", { now: () => timestamp });
            fixture.store.publishGenerationAndRelease(proof, {
                generation: 0,
                currentSegmentId: fixture.store.getCurrentSessionSegment(session.runwieldSessionId)?.segmentId ?? null,
                ...await readTranscriptEvidence(transcriptPath),
            }, { now: () => timestamp });
        }

        await search.refresh();
        const firstPage = await search.search({ query: "Managed fixture", contentType: "session" });
        assertEquals(firstPage.total, 1);
        assertEquals(firstPage.results[0].sourceId, fixture.session.runwieldSessionId);
        assertEquals(firstPage.results[0].snippet, "Hello");
        const lastCatalogPage = await search.search({ query: "Catalog page Session 0", contentType: "session" });
        assertEquals(lastCatalogPage.total, 1);

        await Deno.writeTextFile(fixture.transcriptPath, '{"changed":true}\n', { append: true });
        const appended = await search.search({ query: "Managed fixture", contentType: "session" });
        assertEquals(appended.total, 1);
        assertEquals(appended.results[0].snippet, "Hello");
        const committedBytes = await Deno.readTextFile(fixture.transcriptPath);
        await Deno.writeTextFile(
            fixture.transcriptPath,
            committedBytes.replace('"content":"Hello"', '"content":"Hallo"'),
        );
        const changed = await search.search({ query: "Managed fixture", contentType: "session" });
        assertEquals(changed.total, 0);
    } finally {
        await search.close();
        await fixture.cleanup();
    }
});

Deno.test("Workspace search and Plan opens reject a linked Plan directory after indexing", async () => {
    const fixture = await searchFixture("plan-open-containment");
    const outside = join(fixture.dir, "outside-plans");
    try {
        await savePlan(fixture.root, "contained", "# Contained Plan\n\nIssued destination needle.\n", {
            planId: "contained-plan-id",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        await fixture.search.refresh();
        assertEquals((await fixture.search.search({ query: "Issued destination" })).total, 1);
        await Deno.rename(join(fixture.root, "docs", "plans"), outside);
        await Deno.symlink(outside, join(fixture.root, "docs", "plans"));
        assertEquals((await fixture.search.search({ query: "Issued destination" })).total, 0);
        let message = "";
        try {
            await loadWorkspaceDetail(fixture.root, "contained-plan-id");
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        assertStringIncludes(message, "leaves the Project");
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search and Plan opens accept registered execution-worktree authority", async () => {
    const fixture = await searchFixture("execution-authority");
    const executionRoot = join(fixture.dir, "execution");
    try {
        await savePlan(fixture.root, "authority", "# Primary authority\n\nOld primary body.\n", {
            planId: "execution-authority-id",
            title: "Primary authority",
            classification: "PLANNED_CHANGE",
            status: "in_progress",
        });
        await Deno.mkdir(join(executionRoot, "docs", "plans"), { recursive: true });
        const primary = await Deno.readTextFile(join(fixture.root, "docs", "plans", "authority.md"));
        await Deno.writeTextFile(
            join(executionRoot, "docs", "plans", "authority.md"),
            primary.replaceAll("Primary authority", "Execution authority").replace(
                "Old primary body",
                "Execution needle",
            ),
        );
        const now = "2026-09-01T00:00:00.000Z";
        await addEntry(fixture.root, {
            id: "execution-attempt",
            planName: "authority",
            planId: "execution-authority-id",
            baseBranch: "main",
            baseRef: "refs/heads/main",
            baseCommit: "abc123",
            branch: "worktree/authority",
            path: executionRoot,
            status: "active",
            createdAt: now,
            updatedAt: now,
        });
        await fixture.search.refresh();
        const payload = await fixture.search.search({ query: "Execution needle", contentType: "plan" });
        assertEquals(payload.results[0].title, "Execution authority");
        assertEquals((await loadWorkspaceDetail(fixture.root, "execution-authority-id")).title, "Execution authority");

        const outsidePlans = join(fixture.dir, "outside-execution-plans");
        await Deno.rename(join(executionRoot, "docs", "plans"), outsidePlans);
        await Deno.symlink(outsidePlans, join(executionRoot, "docs", "plans"));
        assertEquals((await fixture.search.search({ query: "Execution needle", contentType: "plan" })).total, 0);
        let message = "";
        try {
            await loadWorkspaceDetail(fixture.root, "execution-authority-id");
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        assertStringIncludes(message, "leaves the Project");
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace refresh requested during a scan includes files added after that scan began", async () => {
    const fixture = await searchFixture("refresh-during-scan");
    const secondPath = join(fixture.dir, "blocked-project");
    await Deno.mkdir(secondPath);
    const secondRoot = await Deno.realPath(secondPath);
    const second = fixture.store.registerProject({ root: secondRoot, displayName: "ZZ Blocked Project" });
    await Deno.mkdir(join(fixture.root, "docs", "prd"), { recursive: true });
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Hold a real migration lock in the second Project so the scan has already read the first.
    const holding = withWorktreeRegistryLockAtPath(
        join(getRunWieldRuntimeDir(secondRoot), "worktrees.lock"),
        async () => {
            locked.resolve();
            await release.promise;
        },
    );
    try {
        await locked.promise;
        const scanning = fixture.search.refresh();
        assertEquals(
            await waitFor(async () => {
                const progress = await fixture.search.search({ query: "" });
                return progress.states.some((state) =>
                    state.projectId === second.projectId && state.state === "indexing"
                );
            }),
            true,
        );
        await Deno.writeTextFile(join(fixture.root, "docs", "prd", "new.md"), "# Fresh refresh needle\n");
        const refreshed = fixture.search.refresh();
        release.resolve();
        await Promise.all([scanning, refreshed, holding]);
        assertEquals((await fixture.search.search({ query: "Fresh refresh needle" })).total, 1);
    } finally {
        release.resolve();
        await holding;
        await fixture.close();
    }
});

Deno.test("Workspace search returns a large Plan result set", async () => {
    const fixture = await searchFixture("plan-volume");
    try {
        await savePlan(fixture.root, "template", "# Matching Plan\n\nShared volume needle.\n", {
            planId: "volume-0",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        const template = await Deno.readTextFile(join(fixture.root, "docs", "plans", "template.md"));
        for (let index = 1; index < 80; index++) {
            await Deno.writeTextFile(
                join(fixture.root, "docs", "plans", `volume-${index}.md`),
                template.replace("volume-0", `volume-${index}`),
            );
        }
        await fixture.search.refresh();
        const first = await fixture.search.search({ query: "Shared volume needle", contentType: "plan", pageSize: 50 });
        const second = await fixture.search.search({
            query: "Shared volume needle",
            contentType: "plan",
            pageSize: 50,
            page: 2,
        });
        assertEquals(first.total, 80);
        assertEquals(second.total, 80);
        assertEquals(new Set([...first.results, ...second.results].map((result) => result.sourceId)).size, 80);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search leaves a lone Plan without an ID unchanged", async () => {
    const fixture = await searchFixture("plan-identity-diagnostics");
    try {
        await Deno.mkdir(join(fixture.root, "docs", "plans"), { recursive: true });
        const path = join(fixture.root, "docs", "plans", "missing-id.md");
        const markdown = "---\nclassification: PLANNED_CHANGE\nstatus: draft\n---\n# Missing ID\n";
        await Deno.writeTextFile(path, markdown);
        await fixture.search.refresh();
        const payload = await fixture.search.search({ query: "Missing ID" });
        assertEquals(payload.results, []);
        assertEquals(payload.states[0].state, "ready");
        assertEquals(await Deno.readTextFile(path), markdown);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search skips a Plan without an ID and keeps other results", async () => {
    const fixture = await searchFixture("plan-identity-diagnostics");
    try {
        await savePlan(fixture.root, "valid", "# Searchable Plan\n\nShared needle.\n", {
            planId: "valid-id",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        const path = join(fixture.root, "docs", "plans", "missing-id.md");
        const markdown = "---\nclassification: PLANNED_CHANGE\nstatus: draft\n---\n# Missing ID\n\nShared needle.\n";
        await Deno.writeTextFile(path, markdown);
        await fixture.search.refresh();
        const payload = await fixture.search.search({ query: "Shared needle" });
        assertEquals(payload.results.map((result) => result.sourceId), ["valid-id"]);
        assertEquals(payload.states[0].state, "ready");
        assertEquals(await Deno.readTextFile(path), markdown);
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search reports duplicate Plan identity diagnostics", async () => {
    const fixture = await searchFixture("duplicate-plan-identities");
    try {
        await savePlan(fixture.root, "first", "# First duplicate Plan\n", {
            planId: "duplicate-plan-id",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        const first = await Deno.readTextFile(join(fixture.root, "docs", "plans", "first.md"));
        await Deno.writeTextFile(
            join(fixture.root, "docs", "plans", "second.md"),
            first.replace("First duplicate Plan", "Second duplicate Plan"),
        );
        await fixture.search.refresh();
        const payload = await fixture.search.search({ query: "duplicate Plan" });
        assertStringIncludes(payload.states[0].message, "Duplicate planId values");
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search reports duplicate Work Record identity diagnostics and excludes historical records", async () => {
    const fixture = await searchFixture("record-identities");
    try {
        const base = {
            kind: "work_record",
            recordId: "b2222222-2222-4222-8222-222222222222",
            scope: "planned_change",
            origin: "internal",
            completionMode: "verified",
            createdAt: "2026-09-01T00:00:00.000Z",
            provenance: { sourcePlans: ["plan-id"] },
        };
        await writeWorkRecord(
            fixture.root,
            { ...base, status: "approved" },
            "# Current Record\n\n## Summary\n\nCurrent record needle.\n",
            { fileName: "current.md" },
        );
        await writeWorkRecord(
            fixture.root,
            { ...base, recordId: "c3333333-3333-4333-8333-333333333333", status: "draft" },
            "# Draft Record\n\n## Summary\n\nDraft record needle.\n",
            { fileName: "draft.md" },
        );
        await writeWorkRecord(
            fixture.root,
            { ...base, recordId: "c3333333-3333-4333-8333-333333333334", status: "pending_verification" },
            "# Pending Verification Record\n\n## Summary\n\nPending verification record needle.\n",
            { fileName: "pending-verification.md" },
        );
        await writeWorkRecord(
            fixture.root,
            {
                ...base,
                recordId: "d4444444-4444-4444-8444-444444444444",
                status: "approved",
                archivedAt: "2026-09-02T00:00:00.000Z",
            },
            "# Archived Record\n\n## Summary\n\nArchived record needle.\n",
            { fileName: "archived.md" },
        );
        await writeWorkRecord(
            fixture.root,
            {
                ...base,
                recordId: "e5555555-5555-4555-8555-555555555555",
                status: "approved",
                supersededBy: "f6666666-6666-4666-8666-666666666666",
            },
            "# Superseded Record\n\n## Summary\n\nSuperseded record needle.\n",
            { fileName: "superseded.md" },
        );
        await fixture.search.refresh();
        assertEquals((await fixture.search.search({ query: "Current record needle" })).total, 1);
        assertEquals((await fixture.search.search({ query: "Draft record needle" })).total, 0);
        assertEquals((await fixture.search.search({ query: "Pending verification record needle" })).total, 0);
        assertEquals((await fixture.search.search({ query: "Archived record needle" })).total, 0);
        assertEquals((await fixture.search.search({ query: "Superseded record needle" })).total, 0);
        await writeWorkRecord(
            fixture.root,
            { ...base, status: "approved" },
            "# Duplicate Record\n\n## Summary\n\nDuplicate record.\n",
            {
                fileName: "duplicate.md",
            },
        );
        await fixture.search.refresh();
        const payload = await fixture.search.search({ query: "Current Record" });
        assertStringIncludes(payload.states[0].message, "duplicate durable identities");
    } finally {
        await fixture.close();
    }
});

Deno.test("Workspace search uses current authoritative Plan evidence", async () => {
    const fixture = await searchFixture("plan-evidence");
    try {
        await savePlan(fixture.root, "authority", "# Old authority\n\nCanonical needle.\n", {
            planId: "authority-plan",
            title: "Old authority",
            classification: "PLANNED_CHANGE",
            status: "draft",
        });
        await fixture.search.refresh();
        const planPath = join(fixture.root, "docs", "plans", "authority.md");
        const current = await Deno.readTextFile(planPath);
        await writePlanMarkdownWithRevision(planPath, current.replaceAll("Old authority", "Current authority"));
        const payload = await fixture.search.search({ query: "authority" });
        assertEquals(payload.results[0].title, "Current authority");
        assertEquals(payload.results[0].freshness, "changed");
    } finally {
        await fixture.close();
    }
});
