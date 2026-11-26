import { withRetainedPlanFixture } from "../../shared/testing/retained-plan-fixture.ts";
import { makeValidationCheckpoint } from "../../shared/workflow/validation-checkpoint.ts";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rename as fsRename,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strictEqual as assertStrictEquals } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadPlan } from "../../shared/testing/plan-query-fixture.ts";
import { savePlanWithController as savePlan } from "../../shared/testing/plan-controller-fixture.ts";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.ts";
import { resolveProjectRuntimeLayout } from "../../shared/project-runtime-layout.ts";
import { restoreWorkRecordDocument } from "../../shared/work-records/store.ts";
import { buildWorkflowPresentation } from "../../shared/workflow/workflow-presentation.ts";
import { createOwnerWorkspaceApp } from "./server.ts";
import { projects } from "@runwield/projects";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { ownerSessionPlanWorkflowApi } from "./routes/owner-session-api.ts";
import { latestLiveWorkflowInteraction } from "./islands/SessionSurface.tsx";
import { WorkflowSidebar } from "./react/WorkflowSidebar.tsx";
import { loadOwnerDashboard } from "./server/owner-dashboard.ts";
import { createWorkspaceSessionContinuationService } from "./server/session-continuation.ts";
import { makeManagedSessionFixture, readTranscriptEvidence } from "../../testing/managed-session-fixture.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { withExistingRuntimeInteraction } from "./testing/live-interaction-fixture.ts";

function cookiePair(credential: string, csrf = "csrf-secret"): string {
    return `rw_owner_device=${encodeURIComponent(credential)}; rw_owner_csrf=${encodeURIComponent(csrf)}`;
}

function daysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function pairedApp(dir: string) {
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const pairing = store.createPairingRequest({ codeFactory: () => "OWNV2A", proofFactory: () => "proof" });
    store.approvePairingRequest(pairing.code);
    store.claimPairingRequest(pairing.proof, {
        credentialFactory: () => "credential-secret",
        csrfFactory: () => "csrf-secret",
    });
    const ownerApp = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    return {
        store,
        ownerApp,
        app: ownerApp.handler(),
    };
}

test("unified Workspace search ranks canonical sources and opens Project artifacts", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-workspace-search-"));
    const root = `${dir}/project`;
    await fsMkdir(`${root}/docs/prd`, { recursive: true });
    await fsMkdir(`${root}/docs/adr`, { recursive: true });
    await fsWriteFile(`${root}/docs/prd/exact.md`, "# Searchable Compass\n\nProduct body needle.\n");
    await fsWriteFile(
        `${root}/docs/adr/heading.md`,
        "# Architecture note\n\n## Searchable Compass\n\nDecision body.\n",
    );
    await fsWriteFile(`${root}/docs/design-system.md`, "# Design System\n\nSearchable Compass appears in the body.\n");
    await fsWriteFile(`${root}/docs/domain-language.md`, "# Domain Language\n\nWorkspace Search is owner retrieval.\n");
    await fsWriteFile(`${root}/source.ts`, "export const forbidden = 'Searchable Compass';\n");
    await savePlan(root, "compass-plan", "# Plan heading\n\nSearchable Compass in the body.\n", {
        planId: "compass-plan-id",
        title: "Compass Plan",
        classification: "PLANNED_CHANGE",
        status: "on_hold",
    });
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        const project = store.projects.register({ root, displayName: "Search Project" });
        await ownerApp.workspaceSearch.refresh();
        const headers = { cookie: cookiePair("credential-secret") };
        const response = await app(
            new Request("http://127.0.0.1:8787/api/owner/search?q=Searchable%20Compass", { headers }),
        );
        assertEquals(response.status, 200);
        const payload = await response.json();
        assertEquals(
            payload.results.map((result: { contentType: string }) => result.contentType),
            ["prd", "adr", "plan", "design-system"],
        );
        assertEquals(
            payload.results.some((result: { sourceId: string }) => result.sourceId === "source.ts"),
            false,
        );
        assertEquals(
            payload.results.every((result: { projectId: string }) => result.projectId === project.projectId),
            true,
        );
        const prd = payload.results[0];
        const opened = await app(
            new Request(`http://127.0.0.1:8787${prd.destination}?return=%2Fsearch%3Fq%3DSearchable`, { headers }),
        );
        const html = await opened.text();
        assertEquals(opened.status, 200, html);
        assertStringIncludes(html, "Searchable Compass");
        assertStringIncludes(html, "Back to Search");
        assertEquals(html.includes(root), false);
        assertEquals(html.includes("imageBaseDir"), false);

        await fsWriteFile(`${root}/docs/prd/exact.md`, "# Replaced content\n\nThe old query is gone.\n");
        const changedResponse = await app(
            new Request("http://127.0.0.1:8787/api/owner/search?q=Searchable%20Compass", { headers }),
        );
        const changed = await changedResponse.json();
        assertEquals(
            changed.results.some((result: { contentType: string }) => result.contentType === "prd"),
            false,
        );
        const staleDestination = await app(new Request(`http://127.0.0.1:8787${prd.destination}`, { headers }));
        assertEquals(staleDestination.status, 200);
        assertStringIncludes(await staleDestination.text(), "Replaced content");

        store.projects.setStatus(project.projectId, "inactive");
        const inactiveResponse = await app(
            new Request("http://127.0.0.1:8787/api/owner/search?q=Searchable%20Compass", { headers }),
        );
        assertEquals((await inactiveResponse.json()).results, []);
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("every Workspace search result type opens its built destination", async () => {
    const fixture = await makeManagedSessionFixture();
    const root = fixture.projectRoot;
    await fsMkdir(`${root}/docs/prd`, { recursive: true });
    await fsMkdir(`${root}/docs/adr`, { recursive: true });
    await fsWriteFile(`${root}/docs/prd/destination.md`, "# PRD destination\n\nUniversal destination token.\n");
    await fsWriteFile(`${root}/docs/adr/destination.md`, "# ADR destination\n\nUniversal destination token.\n");
    await fsWriteFile(`${root}/docs/design-system.md`, "# Design System destination\n\nUniversal destination token.\n");
    await fsWriteFile(
        `${root}/docs/domain-language.md`,
        "# Domain Language destination\n\nUniversal destination token.\n",
    );
    await savePlan(root, "destination-plan", "# Plan destination\n\nUniversal destination token.\n", {
        planId: "destination-plan-id",
        classification: "PLANNED_CHANGE",
        status: "draft",
    });
    await restoreWorkRecordDocument(
        root,
        {
            kind: "work_record",
            recordId: "77777777-7777-4777-8777-777777777777",
            status: "approved",
            scope: "planned_change",
            origin: "internal",
            completionMode: "done_enough",
            createdAt: "2026-09-01T00:00:00.000Z",
            provenance: { sourcePlans: ["destination-plan-id"] },
        },
        "# Work Record destination\n\n## Summary\n\nUniversal destination token.\n\n## Deferred Work\n\nOne follow-up.\n",
        { fileName: "destination.md" },
    );
    const pairing = fixture.store.createPairingRequest({ codeFactory: () => "DEST01", proofFactory: () => "proof" });
    fixture.store.approvePairingRequest(pairing.code);
    fixture.store.claimPairingRequest(pairing.proof, {
        credentialFactory: () => "credential-secret",
        csrfFactory: () => "csrf-secret",
    });
    const ownerApp = createOwnerWorkspaceApp({
        mode: "owner",
        publicOrigin: "http://127.0.0.1:8787",
        store: fixture.store,
    });
    try {
        await ownerApp.workspaceSearch.refresh();
        const headers = { cookie: cookiePair("credential-secret") };
        const expectations = [
            ["plan", "Universal destination token", "Plan destination"],
            ["work-record", "Universal destination token", "Work Record destination"],
            ["prd", "Universal destination token", "PRD destination"],
            ["adr", "Universal destination token", "ADR destination"],
            ["design-system", "Universal destination token", "Design System destination"],
            ["domain-language", "Universal destination token", "Domain Language destination"],
            ["session", "Managed fixture", "Project Session"],
        ];
        for (const [contentType, query, visibleText] of expectations) {
            const response = await ownerApp.handler()(
                new Request(
                    `http://127.0.0.1:8787/api/owner/search?q=${encodeURIComponent(query)}&type=${contentType}`,
                    { headers },
                ),
            );
            const payload = await response.json();
            assertEquals(payload.results.length, 1, `${contentType} search result`);
            const opened = await ownerApp.handler()(
                new Request(
                    `http://127.0.0.1:8787${payload.results[0].destination}?return=%2Fsearch%3Fq%3Ddestination`,
                    { headers },
                ),
            );
            const html = await opened.text();
            assertEquals(opened.status, 200, `${contentType}: ${html}`);
            assertStringIncludes(html, visibleText);
        }
        const recordResponse = await ownerApp.handler()(
            new Request("http://127.0.0.1:8787/api/owner/search?q=Universal%20destination%20token&type=work-record", {
                headers,
            }),
        );
        const record = (await recordResponse.json()).results[0];
        const recordHtml = await (
            await ownerApp.handler()(new Request(`http://127.0.0.1:8787${record.destination}`, { headers }))
        ).text();
        assertStringIncludes(recordHtml, "/plans/destination-plan-id");
        assertStringIncludes(recordHtml, "Completion confidence: done enough.");
    } finally {
        await ownerApp.close();
        await fixture.cleanup();
    }
});

test("Project settings stays accessible when its root disappears or its registration is inactive", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-settings-recovery-"));
    const root = `${dir}/original`;
    const movedRoot = `${dir}/moved`;
    await fsMkdir(root);
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        const origin = "http://127.0.0.1:8787";
        const headers = { cookie: cookiePair("credential-secret") };
        const mutationHeaders = {
            ...headers,
            origin,
            "x-runwield-csrf": "csrf-secret",
            "content-type": "application/json",
        };
        const registered = await app(
            new Request(`${origin}/api/owner/projects`, {
                method: "POST",
                headers: mutationHeaders,
                body: JSON.stringify({ root, displayName: "Moved Project" }),
            }),
        );
        assertEquals(registered.status, 201);
        const { project } = await registered.json();
        const admitted = projects.checkout.inspect(root);
        if (admitted.kind !== "existing") throw new Error("Expected admitted Project identity.");
        assertEquals(project.projectId, admitted.identity.projectId);

        await fsRename(root, movedRoot);
        const settingsUrl = `${origin}/projects/${project.projectId}/settings`;
        const missing = await app(new Request(settingsUrl, { headers }));
        assertEquals(missing.status, 200);
        const html = await missing.text();
        assertStringIncludes(html, "Moved Project");
        assertStringIncludes(html, "Relink Project root");
        assertStringIncludes(html, "active · missing");
        assertStringIncludes(html, 'data-action="set-status" data-project-status="inactive"');
        assertStringIncludes(html, 'data-action="remove"');
        assertEquals(html.includes("Workspace request blocked"), false);
        const action = (body: { action: string; status?: string; newRoot?: string }) =>
            app(
                new Request(`${origin}/api/owner/projects/${project.projectId}/action`, {
                    method: "POST",
                    headers: mutationHeaders,
                    body: JSON.stringify(body),
                }),
            );
        assertEquals((await action({ action: "set-status", status: "archived" })).status, 400);
        assertEquals((await action({ action: "set-status" })).status, 400);
        assertEquals((await action({ action: "remove", status: "inactive" })).status, 400);
        assertEquals(store.projects.get(project.projectId)?.status, "active");
        const deactivated = await action({ action: "set-status", status: "inactive" });
        assertEquals(deactivated.status, 200);
        const {
            projects: [view],
        } = await deactivated.json();
        assertEquals(view.projectId, project.projectId);
        assertEquals(view.status, "inactive");
        assertEquals(view.healthStatus, "missing");
        assertEquals("enabled" in view, false);
        assertEquals("lifecycle" in view, false);
        const inactive = await app(new Request(settingsUrl, { headers }));
        assertEquals(inactive.status, 200);
        const inactiveHtml = await inactive.text();
        assertStringIncludes(inactiveHtml, 'data-action="set-status" data-project-status="active"');
        assertStringIncludes(inactiveHtml, "inactive · missing");
        assertEquals((await action({ action: "relink", newRoot: movedRoot })).status, 200);
        const inactiveHealth = store.projects.getHealth(project.projectId);
        assertEquals(inactiveHealth.projectStatus, "inactive");
        assertEquals(inactiveHealth.status, "available");
        assertEquals((await action({ action: "set-status", status: "active" })).status, 200);
        assertEquals(store.projects.getHealth(project.projectId).projectStatus, "active");
        const repaired = await app(new Request(settingsUrl, { headers }));
        assertEquals(repaired.status, 200);
        assertStringIncludes(await repaired.text(), "available");
        assertEquals((await action({ action: "remove" })).status, 200);
        assertEquals((await fsStat(movedRoot)).isDirectory(), true);
        assertEquals(store.projects.list(), []);
        assertEquals((await app(new Request(settingsUrl, { headers }))).status, 404);
        const projectsPage = await app(new Request("http://127.0.0.1:8787/projects", { headers }));
        assertEquals((await projectsPage.text()).includes("Moved Project"), false);
        const unknown = await app(new Request("http://127.0.0.1:8787/projects/not-registered/settings", { headers }));
        assertEquals(unknown.status, 404);
        assertStringIncludes(await unknown.text(), "Project settings not found");
        const malformed = await app(new Request(`${origin}/projects/%ZZ/sessions`, { headers }));
        assertEquals(malformed.status, 404);
        const malformedAction = await app(
            new Request(`${origin}/api/owner/projects/not-registered/action`, {
                method: "POST",
                headers: mutationHeaders,
                body: JSON.stringify({ action: "remove" }),
            }),
        );
        assertEquals(malformedAction.status, 404);
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Workspace retries winning clone choices and rejects stale or competing choices without exposing the Git remote", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-project-clone-choice-"));
    const fixture = defineCommittedGitFixture({ "README.md": "Test Project\n" });
    const original = await fixture.checkout();
    const clone = await fixture.checkout();
    const competitor = await fixture.checkout();
    const linked = await fixture.checkout();
    const roots = [original, clone, competitor, linked];
    const privateRemote = "https://private-token@github.example.com/team/test-project.git";
    for (const root of roots) await git(root, ["config", "remote.origin.url", privateRemote]);
    const { store, ownerApp, app } = pairedApp(dir);
    const origin = "http://127.0.0.1:8787";
    const headers = {
        cookie: cookiePair("credential-secret"),
        origin,
        "x-runwield-csrf": "csrf-secret",
        "content-type": "application/json",
    };
    const register = (root: string, cloneChoice?: { kind: string; token: string; projectId?: string }) =>
        app(
            new Request(`${origin}/api/owner/projects`, {
                method: "POST",
                headers,
                body: JSON.stringify({ root, displayName: "Repository", cloneChoice }),
            }),
        );
    try {
        const first = await register(original);
        assertEquals(first.status, 201);
        const { project } = await first.json();
        const pending = await register(clone);
        assertEquals(pending.status, 409);
        const pendingText = await pending.text();
        assertEquals(pendingText.includes("private-token"), false);
        assertEquals(pendingText.includes("remote"), false);
        const choice = JSON.parse(pendingText);
        assertEquals(choice.code, "project_clone_choice_required");
        assertEquals(choice.candidates, [{ projectId: project.projectId, displayName: "Repository" }]);
        assertEquals((await register(clone, { kind: "new", token: "stale" })).status, 409);
        assertEquals(store.projects.list().length, 1);

        const otherPending = await register(competitor);
        assertEquals(otherPending.status, 409);
        const { token: otherToken } = await otherPending.json();
        assertEquals((await register(clone, { kind: "new", token: otherToken })).status, 409);
        assertEquals((await register(competitor, { kind: "new", token: otherToken })).status, 201);
        const refreshed = await register(clone, { kind: "new", token: choice.token });
        assertEquals(refreshed.status, 409);
        const current = await refreshed.json();
        assertEquals(current.candidates.length, 2);
        assertEquals(projects.checkout.inspect(clone).kind, "pending");

        const newChoice = { kind: "new", token: current.token };
        const confirmed = await register(clone, newChoice);
        assertEquals(confirmed.status, 201);
        const { project: separate } = await confirmed.json();
        const recovered = await register(clone, newChoice);
        assertEquals(recovered.status, 201);
        assertEquals((await recovered.json()).project, separate);
        const competingLink = { kind: "link", token: current.token, projectId: project.projectId };
        assertEquals((await register(clone, competingLink)).status, 400);
        const admitted = projects.checkout.inspect(clone);
        if (admitted.kind !== "existing") throw new Error("Expected admitted clone identity.");
        assertEquals(separate.projectId, admitted.identity.projectId);
        assertEquals(separate.projectId === project.projectId, false);

        const linkPending = await register(linked);
        assertEquals(linkPending.status, 409);
        const { token: linkToken } = await linkPending.json();
        const linkChoice = { kind: "link", token: linkToken, projectId: project.projectId };
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await register(linked, linkChoice);
            assertEquals(result.status, 201);
            assertEquals((await result.json()).project, project);
        }
        assertEquals((await register(linked, { kind: "new", token: linkToken })).status, 400);
        assertEquals(store.projects.list().length, 3);
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
        for (const root of roots) await fsRm(root, { recursive: true });
    }
});

test("Removing and re-adding a Project preserves file-authoritative Session history", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        const { store, project, projectRoot, transcriptPath, session } = fixture;
        const transcript = await fsReadFile(transcriptPath, "utf8");
        store.projects.remove(project.projectId);
        assertEquals(store.projects.get(project.projectId), null);
        assertEquals(await fsReadFile(transcriptPath, "utf8"), transcript);
        const added = store.projects.register({ root: projectRoot });
        assertEquals(added.projectId, project.projectId);
        await store.catalogProjectSessions(added.projectId, { fullRescan: true });
        const rediscovered = await store.listProjectSessions(added.projectId);
        assertEquals(
            rediscovered.sessions.some((item) => item.runwieldSessionId === session.runwieldSessionId),
            true,
        );
        assertEquals(await fsReadFile(transcriptPath, "utf8"), transcript);
    } finally {
        await fixture.cleanup();
    }
});

test("Dashboard uses the persistent Workspace shell", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-dashboard-shell-"));
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        const response = await app(
            new Request("http://127.0.0.1:8787/", { headers: { cookie: cookiePair("credential-secret") } }),
        );
        assertEquals(response.status, 200);
        const html = await response.text();
        assertStringIncludes(html, "data-owner-dashboard");
        assertStringIncludes(html, "data-astro-transition-persist");
        assertStringIncludes(html, "astro-view-transitions-enabled");
        assertStringIncludes(html, "Attention Dashboard");
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("live Plan reviews use Plan titles and ordinary questions retain their Session identity", async () => {
    for (const type of ["plan_review", "text"] as const)
        await withRuntimeCommandFixture("dashboard-live-names-", async (fixture) => {
            await savePlan(fixture.projectRoot, "review-me", "# Review the searchable artifacts\n", {
                planId: "review-plan-id",
                title: "Review the searchable artifacts",
                classification: "PLANNED_CHANGE",
                status: "draft",
            });
            await withExistingRuntimeInteraction(
                fixture,
                {
                    type,
                    prompt: "Choose the next direction",
                    _meta:
                        type === "plan_review"
                            ? { planId: "review-plan-id", planName: "review-me", planningAgentName: "planner" }
                            : undefined,
                },
                async ({ store, service, reference }) => {
                    const payload = await loadOwnerDashboard(store, service);
                    const items =
                        payload.dashboard.sections.find((section) => section.key === "needs-you")?.items || [];
                    assertEquals(items.length, 1);
                    assertStringIncludes(items[0].href, reference.runwieldSessionId);
                    if (type === "plan_review") {
                        assertEquals(items[0].title, "Review the searchable artifacts");
                        assertEquals(items[0].actionLabel, "Review Plan");
                    } else {
                        assertEquals(items[0].title, "Choose Terraform folder name");
                    }
                },
                undefined,
                async (service) => {
                    const created = await service.runtime.createSession({
                        cwd: fixture.projectRoot,
                        agentName: "operator",
                    });
                    await service.runtime.renameSession(created.sessionId, "Choose Terraform folder name");
                    const managed = service.runtime.getSessionSnapshot(created.sessionId)?.managed;
                    if (!managed) throw new Error("Missing managed Session");
                    await service.runtime.closeSessionWhenIdle(created.sessionId);
                    const generation = service.store.inspectSessionActivation(managed.runwieldSessionId).generation;
                    if (!generation) throw new Error("Missing committed generation");
                    return { runwieldSessionId: managed.runwieldSessionId, expectedGeneration: generation.generation };
                },
            );
        });
});

test("Dashboard shares concurrent reads but refreshes evidence after they finish", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-dashboard-concurrent-"));
    const projectRoot = `${dir}/project`;
    await fsMkdir(projectRoot);
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const sessions = createWorkspaceSessionContinuationService({ store });
    try {
        store.projects.register({ root: projectRoot, displayName: "Project" });
        const first = loadOwnerDashboard(store, sessions);
        const concurrent = loadOwnerDashboard(store, sessions);
        assertStrictEquals(first, concurrent);
        const initial = await first;
        assertEquals(initial.dashboard.sections.flatMap((section) => section.items).length, 0);

        await savePlan(projectRoot, "finished", "# Finished\n", {
            planId: "finished-plan",
            classification: "PLANNED_CHANGE",
            status: "user_verified",
            userVerifiedAt: new Date().toISOString(),
        });
        const refreshed = await loadOwnerDashboard(store, sessions);
        assertEquals(
            refreshed.dashboard.sections
                .find((section) => section.key === "recently-finished")
                ?.items.some((item) => item.planId === "finished-plan"),
            true,
        );
    } finally {
        await sessions.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("personal remote Workspace v2 Dashboard returns eligible completions for client expansion", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-dashboard-acceptance-"));
    const projectOne = `${dir}/one`;
    const projectTwo = `${dir}/two`;
    await fsMkdir(projectOne);
    await fsMkdir(projectTwo);
    for (let index = 0; index < 6; index += 1) {
        await savePlan(projectOne, `done-${index}`, `# Done ${index}\n`, {
            planId: `one-done-${index}`,
            classification: "PLANNED_CHANGE",
            status: "user_verified",
            userVerifiedAt: daysAgo(index),
        });
        await savePlan(projectTwo, `done-${index}`, `# Done ${index}\n`, {
            planId: `two-done-${index}`,
            classification: "PLANNED_CHANGE",
            status: "user_verified",
            userVerifiedAt: daysAgo(index),
        });
    }
    await savePlan(projectOne, "held", "# Held\n", {
        planId: "held-plan",
        classification: "PLANNED_CHANGE",
        status: "on_hold",
    });
    await savePlan(projectOne, "sequence", "# Sequence\n", {
        planId: "sequence-plan",
        classification: "PROJECT",
        type: "sequence",
        status: "ready_for_decomposition",
    });
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        const registeredOne = store.projects.register({ root: projectOne, displayName: "One" });
        store.projects.register({ root: projectTwo, displayName: "Two" });
        const response = await app(
            new Request("http://127.0.0.1:8787/api/owner/dashboard", {
                headers: { cookie: cookiePair("credential-secret"), accept: "application/json" },
            }),
        );
        assertEquals(response.status, 200);
        const payload = await response.json();
        const recentlyFinished = payload.dashboard.sections.find(
            (section: { key: string }) => section.key === "recently-finished",
        ).items;
        assertEquals(recentlyFinished.length, 12);
        assertEquals(
            recentlyFinished.filter((item: { projectId: string }) => item.projectId === registeredOne.projectId).length,
            6,
        );
        assertEquals(JSON.stringify(payload.dashboard).includes("held-plan"), false);
        assertEquals(JSON.stringify(payload.dashboard).includes("sequence-plan"), false);
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("personal remote Workspace v2 workflow presentation exposes connected actions without fabricated reviews", () => {
    const presentation = buildWorkflowPresentation({
        planName: "Feature Plan",
        classification: "PLANNED_CHANGE",
        status: "validated_ci",
        progressFacts: [
            {
                kind: "validation_checkpoint",
                phase: "semantic",
                state: "awaiting_repair",
                repairKind: "semantic",
            },
        ],
        hasCodeReview: true,
    });
    assertEquals(presentation.currentStage?.id, "code_review");
    assertEquals(presentation.action?.kind, "review_code");
    assertEquals(
        presentation.connections.some((connection) => connection.kind === "repair_return"),
        false,
    );

    const html = renderToStaticMarkup(createElement(WorkflowSidebar, { presentation }));
    assertEquals(html.includes("Repair returns to AI review"), false);

    assertEquals(html.includes("<strong>current</strong>"), false);
    assertEquals(html.includes("<strong>upcoming</strong>"), false);
    assertEquals(html.includes('aria-current="step"'), true);
    const missingLiveFacts = buildWorkflowPresentation({ planName: "Feature Plan" });
    assertEquals(missingLiveFacts.action?.kind, "open_plan");
});

test("Dashboard ignores historical attention flags and sorts all ready Plans by updated time", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-dashboard-attention-"));
    const root = `${dir}/project`;
    await fsMkdir(root);
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        store.projects.register({ root, displayName: "Project" });
        for (const status of [
            "draft",
            "feedback",
            "validated",
            "approved",
            "failed",
            "ci_failed",
            "review_failed",
            "blocked",
        ]) {
            await savePlan(root, status, `# ${status}\n`, {
                planId: status,
                classification: "PLANNED_CHANGE",
                status,
                humanReviewMode: "always",
                humanReviewDecision: "changes_requested",
                validationCheckpoint: makeValidationCheckpoint({
                    attemptId: "historical",
                    generation: "historical",
                    status: "ci_failed",
                    phase: "mechanical",
                    state: "awaiting_repair",
                }),
            });
        }
        for (let index = 0; index < 7; index++) {
            await savePlan(root, `ready-${index}`, `# Ready ${index}\n`, {
                planId: `ready-${index}`,
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
                humanReviewMode: "always",
                humanReviewDecision: "changes_requested",
                validationCheckpoint: makeValidationCheckpoint({
                    attemptId: "historical",
                    generation: "historical",
                    status: "ci_failed",
                    phase: "mechanical",
                    state: "awaiting_repair",
                }),
                updatedAt: `2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
            });
        }
        const response = await app(
            new Request("http://127.0.0.1:8787/api/owner/dashboard", {
                headers: { cookie: cookiePair("credential-secret") },
            }),
        );
        const payload = await response.json();
        assertEquals(
            payload.dashboard.sections.find((section: { key: string }) => section.key === "needs-you").items,
            [],
        );
        assertEquals(
            payload.dashboard.sections
                .find((section: { key: string }) => section.key === "ready")
                .items.map((item: { planId: string }) => item.planId),
            ["ready-6", "ready-5", "ready-4", "ready-3", "ready-2", "ready-1", "ready-0"],
        );
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Dashboard distinguishes stopped execution from an active Agent and an ordinary idle Session", async () => {
    const fixture = await makeManagedSessionFixture();
    const { store, session, project } = fixture;
    const service = createWorkspaceSessionContinuationService({ store });
    try {
        await savePlan(fixture.projectRoot, "unfinished", "# Unfinished\n", {
            planId: "unfinished",
            classification: "PLANNED_CHANGE",
            status: "in_progress",
        });
        const before = await loadOwnerDashboard(store, service);
        assertEquals(before.dashboard.sections.find((section) => section.key === "needs-you")?.items.length, 0);
        let proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "dashboard-test",
            ownerProcessKind: "test",
            expectedGeneration: 0,
        });
        const segment = store.getCurrentSessionSegment(session.runwieldSessionId)!;
        store.stagePlanAssociation(proof, {
            planId: "unfinished",
            planName: "unfinished",
            purpose: "execution",
            segmentId: segment.segmentId,
            segmentKind: segment.kind,
            recordedAt: new Date().toISOString(),
        });
        proof = store.changeSessionActivationPhase(proof, "hydrated");
        proof = store.changeSessionActivationPhase(proof, "checkpointing");
        store.publishGenerationAndRelease(proof, {
            generation: 1,
            currentSegmentId: segment.segmentId,
            ...(await readTranscriptEvidence(fixture.transcriptPath)),
        });
        const stopped = await loadOwnerDashboard(store, service);
        const attention = stopped.dashboard.sections.find((section) => section.key === "needs-you")?.items;
        assertEquals(
            attention?.map((item) => item.planId),
            ["unfinished"],
        );
        assertEquals(attention?.[0].href, `/projects/${project.projectId}/sessions/${session.runwieldSessionId}`);
        proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "dashboard-test",
            ownerProcessKind: "test",
            expectedGeneration: 1,
        });
        try {
            const running = await loadOwnerDashboard(store, service);
            assertEquals(running.dashboard.sections.find((section) => section.key === "needs-you")?.items.length, 0);
            assertEquals(
                running.dashboard.sections.find((section) => section.key === "in-progress")?.items[0]?.planId,
                "unfinished",
            );
        } finally {
            store.releaseUnchangedActivation(proof);
        }
    } finally {
        await service.close();
        await fixture.cleanup();
    }
});

test("personal remote Workspace v2 owner home has bounded refresh and visible failure handling", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-refresh-acceptance-"));
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        const response = await app(
            new Request("http://127.0.0.1:8787/", {
                headers: { cookie: cookiePair("credential-secret") },
            }),
        );
        const html = await response.text();
        for (const label of ["Needs You", "Ready to Continue", "In Progress", "Recently Finished"]) {
            assertStringIncludes(html, `<h2>${label}</h2>`);
        }
        assertStringIncludes(html, "Loading…");
        assertStringIncludes(html, "/api/owner/dashboard/stream");
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("personal remote Workspace v2 Dashboard promotes associated live questions and keeps terminal Session history", async () => {
    for (const type of ["text", "plan_review", "code_review"] as const) {
        await withRuntimeCommandFixture("dashboard-real-associated-", async (fixture) => {
            await savePlan(fixture.projectRoot, "active", "# Active\n", {
                planId: "active-plan",
                classification: "PLANNED_CHANGE",
                status: "in_progress",
            });
            await savePlan(fixture.projectRoot, "done", "# Done\n", {
                planId: "done-plan",
                classification: "PLANNED_CHANGE",
                status: "user_verified",
                userVerifiedAt: new Date().toISOString(),
            });
            let completedSessionId = "";
            await withExistingRuntimeInteraction(
                fixture,
                {
                    type,
                    prompt: "Choose.",
                    _meta: { planId: "active-plan", planName: "active", planningAgentName: "planner" },
                },
                async ({ store, service, reference, settle }) => {
                    const payload = await loadOwnerDashboard(store, service);
                    const needsYou =
                        payload.dashboard.sections.find((section) => section.key === "needs-you")?.items || [];
                    assertEquals(needsYou.length, 1);
                    assertEquals(needsYou[0].planId, "active-plan");
                    assertEquals(
                        needsYou[0].href,
                        `/projects/${reference.projectId}/sessions/${reference.runwieldSessionId}#interaction-${reference.interactionId}`,
                    );
                    if (type !== "text") {
                        assertEquals(needsYou[0].actionLabel, type === "plan_review" ? "Review Plan" : "Review code");
                        assertEquals(
                            needsYou[0].statusLabel,
                            type === "plan_review" ? "Plan ready for review" : "Code ready for review",
                        );
                    }
                    assertEquals(
                        payload.projects[0].sessions.some(
                            (session) => session.runwieldSessionId === completedSessionId,
                        ),
                        true,
                    );
                    assertEquals(
                        payload.projects[0].sessions.some(
                            (session) => session.runwieldSessionId === reference.runwieldSessionId,
                        ),
                        false,
                    );
                    await settle();
                    const answered = await loadOwnerDashboard(store, service);
                    assertEquals(
                        answered.dashboard.sections.find((section) => section.key === "needs-you")?.items.length,
                        0,
                    );
                },
                undefined,
                async (service) => {
                    for (const name of ["done", "active"]) {
                        const created = await service.runtime.createSession({
                            cwd: fixture.projectRoot,
                            agentName: "operator",
                        });
                        await service.runtime.renameSession(
                            created.sessionId,
                            name === "done" ? "Done Session" : "Question Session",
                        );
                        await service.runtime.recordPlanAssociation(created.sessionId, {
                            planId: `${name}-plan`,
                            planName: name,
                            purpose: "planning",
                        });
                        const managed = service.runtime.getSessionSnapshot(created.sessionId)?.managed;
                        if (!managed) throw new Error("Missing managed Session");
                        await service.runtime.closeSessionWhenIdle(created.sessionId);
                        if (name === "done") completedSessionId = managed.runwieldSessionId;
                        else {
                            const generation = service.store.inspectSessionActivation(
                                managed.runwieldSessionId,
                            ).generation;
                            if (!generation) throw new Error("Missing committed generation");
                            return {
                                runwieldSessionId: managed.runwieldSessionId,
                                expectedGeneration: generation.generation,
                            };
                        }
                    }
                    throw new Error("Question Session was not prepared");
                },
            );
        });
    }
});

test("personal remote Workspace v2 Dashboard uses live evidence for active work and retained completion proof", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-dashboard-evidence-"));
    const projectRoot = `${dir}/project`;
    await fsMkdir(projectRoot);
    await savePlan(projectRoot, "inactive", "# Inactive\n", {
        planId: "inactive-plan",
        classification: "PLANNED_CHANGE",
        status: "in_progress",
    });
    await savePlan(projectRoot, "published", "# Published\n", {
        planId: "published-plan",
        classification: "PLANNED_CHANGE",
        status: "validated",
        verifiedAt: new Date().toISOString(),
    });
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    store.projects.register({ root: projectRoot });
    const sessionContinuation = createWorkspaceSessionContinuationService({ store });
    try {
        const payload = await loadOwnerDashboard(store, sessionContinuation);
        const dashboardText = JSON.stringify(payload.dashboard);
        assertEquals(dashboardText.includes("inactive-plan"), false);
        const recentlyFinished = payload.dashboard.sections.find(
            (section: { key: string }) => section.key === "recently-finished",
        ).items;
        assertEquals(
            recentlyFinished.some((item: { planId: string }) => item.planId === "published-plan"),
            true,
        );
    } finally {
        sessionContinuation.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("personal remote Workspace v2 Dashboard does not mark READY status ready when readiness evidence is broken", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-dashboard-readiness-"));
    const projectRoot = `${dir}/project`;
    const store = openOwnerCoordinationStore({
        dbPath: join(dir, "owner.sqlite3"),
        sessionBaseDir: join(dir, "sessions"),
    });
    const sessionContinuation = createWorkspaceSessionContinuationService({ store });
    try {
        await fsMkdir(join(projectRoot, ".wld"), { recursive: true });
        const registration = store.projects.register({ root: projectRoot, displayName: "Project" });
        await withRetainedPlanFixture(projectRoot, async () => {
            await savePlan(projectRoot, "ready", "# Ready\n", {
                planId: "ready-plan",
                classification: "PLANNED_CHANGE",
                status: "ready_for_work",
            });
            assertEquals((await loadPlan(projectRoot, "ready"))?.readAvailability?.kind, "ready");
            await fsWriteFile(resolveProjectRuntimeLayout(projectRoot).primary.worktreeRegistryPath, "{ broken");
            const payload = await loadOwnerDashboard(store, sessionContinuation);
            const readyItems = payload.dashboard.sections.find((section) => section.key === "ready").items;
            assertEquals(
                readyItems.some((item) => item.planId === "ready-plan"),
                false,
            );
            const needsYou = payload.dashboard.sections.find((section) => section.key === "needs-you").items;
            assertEquals(needsYou.length, 0);
            await assertRejects(() => loadPlan(projectRoot, "ready"), Error, "JSON Parse error");
            assertEquals(payload.projects[0].projectId, registration.projectId);
            assertEquals(
                payload.projects[0].diagnostics.some((item) => item.source === "registry-reader"),
                true,
            );
        });
    } finally {
        sessionContinuation.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("Plan workflow API refuses a stale committed generation without starting work", async () => {
    const fixture = await makeManagedSessionFixture();
    const service = createWorkspaceSessionContinuationService({ store: fixture.store });
    await savePlan(fixture.projectRoot, "validate", "# Validate\n\nBody\n", {
        planId: "validate-plan",
        classification: "PLANNED_CHANGE",
        status: "implemented",
    });
    try {
        const before = fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId);
        const response = await ownerSessionPlanWorkflowApi({
            req: new Request("http://workspace.local", {
                method: "POST",
                body: JSON.stringify({ action: "recover", planId: "validate-plan", expectedGeneration: 99 }),
            }),
            params: { projectId: fixture.project.projectId, runwieldSessionId: fixture.session.runwieldSessionId },
            state: { store: fixture.store, sessionContinuation: service },
        });
        assertEquals(response.status, 409);
        assertStringIncludes((await response.json()).error, "exact committed generation");
        assertEquals(fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId), before);
        assertEquals(service.operations.size, 0);
        assertEquals((await loadPlan(fixture.projectRoot, "validate")).attrs.status, "implemented");
    } finally {
        service.close();
        await fixture.cleanup();
    }
});

test("personal remote Workspace v2 live workflow evidence ignores historical interactions", () => {
    const live = latestLiveWorkflowInteraction([
        { kind: "code-review", interactionId: "old", source: "committed", reviewUrl: "/old" },
        { kind: "interaction", interactionId: "current", source: "transient" },
    ]);

    assertEquals(live?.interactionId, "current");
    assertEquals(
        latestLiveWorkflowInteraction([{ kind: "plan-review", interactionId: "old", source: "committed" }]),
        null,
    );
});
