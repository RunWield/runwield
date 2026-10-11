import { assertEquals, assertStrictEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { savePlan } from "../../plan-store.js";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { resolveProjectRuntimeLayout } from "../../shared/project-runtime-layout.ts";
import { writeWorkRecord } from "../../shared/work-records/store.js";
import { buildWorkflowPresentation } from "../../shared/workflow/workflow-presentation.ts";
import { createOwnerWorkspaceApp } from "./server.js";
import { ownerProjectSessionsApi, ownerSessionPlanWorkflowApi } from "./routes/owner-session-api.js";
import { latestLiveWorkflowInteraction } from "./islands/SessionSurface.jsx";
import { WorkflowSidebar } from "./react/WorkflowSidebar.tsx";
import { loadOwnerDashboard } from "./server/owner-dashboard.ts";
import { createWorkspaceSessionContinuationService } from "./server/session-continuation.js";
import { makeManagedSessionFixture, readTranscriptEvidence } from "../../testing/managed-session-fixture.ts";

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

Deno.test("unified Workspace search ranks canonical sources and opens Project artifacts", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-workspace-search-" });
    const root = `${dir}/project`;
    await Deno.mkdir(`${root}/docs/prd`, { recursive: true });
    await Deno.mkdir(`${root}/docs/adr`, { recursive: true });
    await Deno.writeTextFile(`${root}/docs/prd/exact.md`, "# Searchable Compass\n\nProduct body needle.\n");
    await Deno.writeTextFile(
        `${root}/docs/adr/heading.md`,
        "# Architecture note\n\n## Searchable Compass\n\nDecision body.\n",
    );
    await Deno.writeTextFile(
        `${root}/docs/design-system.md`,
        "# Design System\n\nSearchable Compass appears in the body.\n",
    );
    await Deno.writeTextFile(
        `${root}/docs/domain-language.md`,
        "# Domain Language\n\nWorkspace Search is owner retrieval.\n",
    );
    await Deno.writeTextFile(`${root}/source.ts`, "export const forbidden = 'Searchable Compass';\n");
    await savePlan(root, "compass-plan", "# Plan heading\n\nSearchable Compass in the body.\n", {
        planId: "compass-plan-id",
        title: "Compass Plan",
        classification: "FEATURE",
        status: "on_hold",
    });
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        const project = store.registerProject({ root, displayName: "Search Project" });
        await ownerApp.workspaceSearch.refresh();
        const headers = { cookie: cookiePair("credential-secret") };
        const response = await app(
            new Request("http://127.0.0.1:8787/api/owner/search?q=Searchable%20Compass", { headers }),
        );
        assertEquals(response.status, 200);
        const payload = await response.json();
        assertEquals(payload.results.map((result: { contentType: string }) => result.contentType), [
            "prd",
            "adr",
            "plan",
            "design-system",
        ]);
        assertEquals(payload.results.some((result: { sourceId: string }) => result.sourceId === "source.ts"), false);
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

        await Deno.writeTextFile(`${root}/docs/prd/exact.md`, "# Replaced content\n\nThe old query is gone.\n");
        const changedResponse = await app(
            new Request("http://127.0.0.1:8787/api/owner/search?q=Searchable%20Compass", { headers }),
        );
        const changed = await changedResponse.json();
        assertEquals(changed.results.some((result: { contentType: string }) => result.contentType === "prd"), false);
        const staleDestination = await app(new Request(`http://127.0.0.1:8787${prd.destination}`, { headers }));
        assertEquals(staleDestination.status, 200);
        assertStringIncludes(await staleDestination.text(), "Replaced content");

        store.setProjectEnabled(project.projectId, false);
        const disabledResponse = await app(
            new Request("http://127.0.0.1:8787/api/owner/search?q=Searchable%20Compass", { headers }),
        );
        assertEquals((await disabledResponse.json()).results, []);
    } finally {
        await ownerApp.close();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("every Workspace search result type opens its built destination", async () => {
    const fixture = await makeManagedSessionFixture();
    const root = fixture.projectRoot;
    await Deno.mkdir(`${root}/docs/prd`, { recursive: true });
    await Deno.mkdir(`${root}/docs/adr`, { recursive: true });
    await Deno.writeTextFile(`${root}/docs/prd/destination.md`, "# PRD destination\n\nUniversal destination token.\n");
    await Deno.writeTextFile(`${root}/docs/adr/destination.md`, "# ADR destination\n\nUniversal destination token.\n");
    await Deno.writeTextFile(
        `${root}/docs/design-system.md`,
        "# Design System destination\n\nUniversal destination token.\n",
    );
    await Deno.writeTextFile(
        `${root}/docs/domain-language.md`,
        "# Domain Language destination\n\nUniversal destination token.\n",
    );
    await savePlan(root, "destination-plan", "# Plan destination\n\nUniversal destination token.\n", {
        planId: "destination-plan-id",
        classification: "PLANNED_CHANGE",
        status: "draft",
    });
    await writeWorkRecord(
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
            new Request(
                "http://127.0.0.1:8787/api/owner/search?q=Universal%20destination%20token&type=work-record",
                { headers },
            ),
        );
        const record = (await recordResponse.json()).results[0];
        const recordHtml = await (await ownerApp.handler()(
            new Request(
                `http://127.0.0.1:8787${record.destination}`,
                { headers },
            ),
        )).text();
        assertStringIncludes(recordHtml, "/plans/destination-plan-id");
        assertStringIncludes(recordHtml, "Completion confidence: done enough.");
    } finally {
        await ownerApp.close();
        await fixture.cleanup();
    }
});

Deno.test("Project settings stays accessible when its root disappears or its registration is disabled", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-project-settings-recovery-" });
    const root = `${dir}/original`;
    const movedRoot = `${dir}/moved`;
    await Deno.mkdir(root);
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        const project = store.registerProject({ root, displayName: "Moved Project" });
        await Deno.rename(root, movedRoot);
        const settingsUrl = `http://127.0.0.1:8787/projects/${project.projectId}/settings`;
        const headers = { cookie: cookiePair("credential-secret") };
        const missing = await app(new Request(settingsUrl, { headers }));
        assertEquals(missing.status, 200);
        const html = await missing.text();
        assertStringIncludes(html, "Moved Project");
        assertStringIncludes(html, "Relink Project root");
        assertStringIncludes(html, 'data-action="remove"');
        assertEquals(html.includes("Workspace request blocked"), false);
        const action = (body: { action: string; newRoot?: string }) =>
            app(
                new Request(
                    `http://127.0.0.1:8787/api/owner/projects/${project.projectId}/action`,
                    {
                        method: "POST",
                        headers: {
                            ...headers,
                            origin: "http://127.0.0.1:8787",
                            "x-runwield-csrf": "csrf-secret",
                            "content-type": "application/json",
                        },
                        body: JSON.stringify(body),
                    },
                ),
            );
        assertEquals((await action({ action: "disable" })).status, 200);
        const disabled = await app(new Request(settingsUrl, { headers }));
        assertEquals(disabled.status, 200);
        assertStringIncludes(await disabled.text(), 'data-action="enable"');
        assertEquals((await action({ action: "relink", newRoot: movedRoot })).status, 200);
        assertEquals((await action({ action: "enable" })).status, 200);
        assertEquals(store.getProjectHealth(project.projectId).status, "available");
        const repaired = await app(new Request(settingsUrl, { headers }));
        assertEquals(repaired.status, 200);
        assertStringIncludes(await repaired.text(), "available");
        assertEquals((await action({ action: "remove" })).status, 200);
        assertEquals((await Deno.stat(movedRoot)).isDirectory, true);
        assertEquals(store.listProjects(), []);
        assertEquals((await app(new Request(settingsUrl, { headers }))).status, 404);
        const projectsPage = await app(new Request("http://127.0.0.1:8787/projects", { headers }));
        assertEquals((await projectsPage.text()).includes("Moved Project"), false);
        const unknown = await app(new Request("http://127.0.0.1:8787/projects/not-registered/settings", { headers }));
        assertEquals(unknown.status, 404);
        assertStringIncludes(await unknown.text(), "Project settings not found");
    } finally {
        await ownerApp.close();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Removing and re-adding a Project preserves file-authoritative Session history", async () => {
    const fixture = await makeManagedSessionFixture();
    try {
        const { store, project, projectRoot, transcriptPath, session } = fixture;
        const transcript = await Deno.readTextFile(transcriptPath);
        store.removeProject(project.projectId);
        assertEquals(store.getProjectById(project.projectId), null);
        assertEquals(await Deno.readTextFile(transcriptPath), transcript);
        const added = store.registerProject({ root: projectRoot });
        assertEquals(added.projectId === project.projectId, false);
        await store.catalogProjectSessions(added.projectId, { fullRescan: true });
        const rediscovered = await store.listProjectSessions(added.projectId);
        assertEquals(rediscovered.sessions.some((item) => item.runwieldSessionId === session.runwieldSessionId), true);
        assertEquals(await Deno.readTextFile(transcriptPath), transcript);
    } finally {
        await fixture.cleanup();
    }
});

Deno.test("Dashboard uses the persistent Workspace shell", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-dashboard-shell-" });
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
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("unassociated live Plan reviews use Plan names and ordinary questions use Session names", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-dashboard-review-names-" });
    const { store, ownerApp } = pairedApp(dir);
    try {
        const project = store.registerProject({ root: dir });
        await savePlan(dir, "review-me", "# Review the searchable artifacts\n", {
            planId: "review-plan-id",
            title: "Review the searchable artifacts",
            classification: "FEATURE",
            status: "draft",
        });
        const continuation = {
            operations: new Map([
                ["browser-op", {
                    projectId: project.projectId,
                    runwieldSessionId: "browser-session",
                    status: "running",
                    liveInteraction: {
                        interactionId: "review-1",
                        request: {
                            type: "plan_review",
                            planReview: { planId: "review-plan-id", planName: "review-me" },
                        },
                    },
                }],
                ["tui-op", {
                    projectId: project.projectId,
                    runwieldSessionId: "tui-session",
                    status: "running",
                    liveInteraction: {
                        interactionId: "review-2",
                        request: { type: "plan_review", _meta: { planName: "A new Plan in a worktree" } },
                    },
                }],
                ["question-op", {
                    projectId: project.projectId,
                    runwieldSessionId: "question-session",
                    status: "running",
                    liveInteraction: { interactionId: "question", request: { type: "text", prompt: "Which file?" } },
                }],
            ]),
            listSessions: () =>
                Promise.resolve({
                    sessions: [
                        { runwieldSessionId: "question-session", displayName: "Choose Terraform folder name" },
                    ],
                }),
        };
        const dashboard = await loadOwnerDashboard(store, continuation);
        const items = dashboard.dashboard.sections.find((section) => section.key === "needs-you")?.items || [];
        assertEquals(items.length, 3);
        assertEquals(items.find((item) => item.planId === "review-plan-id")?.title, "Review the searchable artifacts");
        assertEquals(items.some((item) => item.title === "A new Plan in a worktree"), true);
        assertEquals(items.some((item) => item.title === "Choose Terraform folder name"), true);
        assertEquals(items.some((item) => item.title === "Session is waiting for you"), false);
    } finally {
        await ownerApp.close();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Dashboard shares concurrent reads but refreshes evidence after they finish", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-dashboard-concurrent-" });
    const projectRoot = `${dir}/project`;
    await Deno.mkdir(projectRoot);
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const sessions = createWorkspaceSessionContinuationService({ store });
    try {
        store.registerProject({ root: projectRoot, displayName: "Project" });
        const first = loadOwnerDashboard(store, sessions);
        const concurrent = loadOwnerDashboard(store, sessions);
        assertStrictEquals(first, concurrent);
        const initial = await first;
        assertEquals(initial.dashboard.sections.flatMap((section) => section.items).length, 0);

        await savePlan(projectRoot, "finished", "# Finished\n", {
            planId: "finished-plan",
            classification: "FEATURE",
            status: "user_verified",
            userVerifiedAt: new Date().toISOString(),
        });
        const refreshed = await loadOwnerDashboard(store, sessions);
        assertEquals(
            refreshed.dashboard.sections.find((section) => section.key === "recently-finished")?.items
                .some((item) => item.planId === "finished-plan"),
            true,
        );
    } finally {
        await sessions.close();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("personal remote Workspace v2 Dashboard returns eligible completions for client expansion", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-dashboard-acceptance-" });
    const projectOne = `${dir}/one`;
    const projectTwo = `${dir}/two`;
    await Deno.mkdir(projectOne);
    await Deno.mkdir(projectTwo);
    for (let index = 0; index < 6; index += 1) {
        await savePlan(projectOne, `done-${index}`, `# Done ${index}\n`, {
            planId: `one-done-${index}`,
            classification: "FEATURE",
            status: "user_verified",
            userVerifiedAt: daysAgo(index),
        });
        await savePlan(projectTwo, `done-${index}`, `# Done ${index}\n`, {
            planId: `two-done-${index}`,
            classification: "FEATURE",
            status: "user_verified",
            userVerifiedAt: daysAgo(index),
        });
    }
    await savePlan(projectOne, "held", "# Held\n", {
        planId: "held-plan",
        classification: "FEATURE",
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
        const registeredOne = store.registerProject({ root: projectOne, displayName: "One" });
        store.registerProject({ root: projectTwo, displayName: "Two" });
        const response = await app(
            new Request("http://127.0.0.1:8787/api/owner/dashboard", {
                headers: { cookie: cookiePair("credential-secret"), accept: "application/json" },
            }),
        );
        assertEquals(response.status, 200);
        const payload = await response.json();
        const recentlyFinished = payload.dashboard.sections.find((section: { key: string }) =>
            section.key === "recently-finished"
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
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("personal remote Workspace v2 workflow presentation exposes connected actions without fabricated reviews", () => {
    const presentation = buildWorkflowPresentation({
        planName: "Feature Plan",
        classification: "PLANNED_CHANGE",
        status: "validated_ci",
        progressFacts: [{
            kind: "validation_checkpoint",
            phase: "semantic",
            state: "awaiting_repair",
            repairKind: "semantic",
        }],
        hasCodeReview: true,
    });
    assertEquals(presentation.currentStage?.id, "code_review");
    assertEquals(presentation.action?.kind, "review_code");
    assertEquals(presentation.connections.some((connection) => connection.kind === "repair_return"), false);

    const html = renderToStaticMarkup(createElement(WorkflowSidebar, { presentation }));
    assertEquals(html.includes("Repair returns to AI review"), false);

    assertEquals(html.includes("<strong>current</strong>"), false);
    assertEquals(html.includes("<strong>upcoming</strong>"), false);
    assertEquals(html.includes('aria-current="step"'), true);
    const missingLiveFacts = buildWorkflowPresentation({ planName: "Feature Plan" });
    assertEquals(missingLiveFacts.action?.kind, "open_plan");
});

Deno.test("Dashboard ignores historical attention flags and sorts all ready Plans by updated time", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-dashboard-attention-" });
    const root = `${dir}/project`;
    await Deno.mkdir(root);
    const { store, ownerApp, app } = pairedApp(dir);
    try {
        store.registerProject({ root, displayName: "Project" });
        for (
            const status of [
                "draft",
                "feedback",
                "validated",
                "approved",
                "failed",
                "ci_failed",
                "review_failed",
                "blocked",
            ]
        ) {
            await savePlan(root, status, `# ${status}\n`, {
                planId: status,
                classification: "FEATURE",
                status,
                humanReviewMode: "pair",
                humanReviewDecision: "pending",
                validationCheckpoint: { state: "awaiting_repair" },
            });
        }
        for (let index = 0; index < 7; index++) {
            await savePlan(root, `ready-${index}`, `# Ready ${index}\n`, {
                planId: `ready-${index}`,
                classification: "FEATURE",
                status: "ready_for_work",
                humanReviewMode: "pair",
                humanReviewDecision: "pending",
                validationCheckpoint: { state: "awaiting_repair" },
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
            payload.dashboard.sections.find((section: { key: string }) => section.key === "ready").items.map((
                item: { planId: string },
            ) => item.planId),
            ["ready-6", "ready-5", "ready-4", "ready-3", "ready-2", "ready-1", "ready-0"],
        );
    } finally {
        await ownerApp.close();
        store.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("Dashboard distinguishes stopped execution from an active Agent and an ordinary idle Session", async () => {
    const fixture = await makeManagedSessionFixture();
    const { store, session, project } = fixture;
    const service = createWorkspaceSessionContinuationService({ store });
    try {
        await savePlan(fixture.projectRoot, "unfinished", "# Unfinished\n", {
            planId: "unfinished",
            classification: "FEATURE",
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
            ...await readTranscriptEvidence(fixture.transcriptPath),
        });
        const stopped = await loadOwnerDashboard(store, service);
        const attention = stopped.dashboard.sections.find((section) => section.key === "needs-you")?.items;
        assertEquals(attention?.map((item) => item.planId), ["unfinished"]);
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

Deno.test("personal remote Workspace v2 owner home has bounded refresh and visible failure handling", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-refresh-acceptance-" });
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
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("personal remote Workspace v2 Dashboard promotes associated live questions and keeps terminal Session history", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-dashboard-live-" });
    const projectRoot = `${dir}/project`;
    await Deno.mkdir(projectRoot);
    await savePlan(projectRoot, "active", "# Active\n", {
        planId: "active-plan",
        classification: "FEATURE",
        status: "in_progress",
    });
    await savePlan(projectRoot, "done", "# Done\n", {
        planId: "done-plan",
        classification: "FEATURE",
        status: "user_verified",
        userVerifiedAt: new Date().toISOString(),
    });
    const store = {
        listProjects: () => [{ projectId: "project-1", displayName: "Project", lifecycle: "enabled" }],
        getProjectHealth: () => ({ status: "available", evidence: [] }),
        requireEnabledProjectRoot: () => projectRoot,
        listSessionPlanAssociations: (sessionId: string) =>
            sessionId === "question-session"
                ? [{ planId: "active-plan", committedGeneration: 1 }]
                : sessionId === "done-session"
                ? [{ planId: "done-plan", committedGeneration: 1 }]
                : [],
        inspectSessionActivation: () => ({ activation: { state: "active", ownerProcessKind: "workspace" } }),
    };
    const sessionContinuation = {
        operations: new Map([["op-1", {
            projectId: "project-1",
            runwieldSessionId: "question-session",
            status: "running",
            liveInteraction: { interactionId: "ask-1", request: { prompt: "Choose.", type: "text" } },
        }]]),
        listSessions: () =>
            Promise.resolve({
                sessions: [
                    { runwieldSessionId: "question-session", displayName: "Question", state: "active" },
                    { runwieldSessionId: "done-session", displayName: "Done Session", state: "idle" },
                ],
                hasNext: false,
                diagnostics: [],
            }),
    };
    try {
        const payload = await loadOwnerDashboard(store, sessionContinuation);
        const needsYou = payload.dashboard.sections.find((section: { key: string }) =>
            section.key === "needs-you"
        ).items;
        assertEquals(needsYou.some((item: { planId: string }) => item.planId === "active-plan"), true);
        for (const type of ["plan_review", "code_review"]) {
            sessionContinuation.operations.set("op-1", {
                projectId: "project-1",
                runwieldSessionId: "question-session",
                status: "running",
                liveInteraction: { interactionId: "ask-1", request: { prompt: "Review", type } },
            });
            const waiting = await loadOwnerDashboard(store, sessionContinuation);
            const item = waiting.dashboard.sections.find((section) => section.key === "needs-you")?.items[0];
            assertEquals(item?.href, "/projects/project-1/sessions/question-session#interaction-ask-1");
            assertEquals(item?.actionLabel, type === "plan_review" ? "Review Plan" : "Review code");
            assertEquals(
                item?.statusLabel,
                type === "plan_review" ? "Plan ready for review" : "Code ready for review",
            );
        }
        sessionContinuation.operations.clear();
        const answered = await loadOwnerDashboard(store, sessionContinuation);
        assertEquals(answered.dashboard.sections.find((section) => section.key === "needs-you")?.items.length, 0);
        assertEquals(
            payload.projects[0].sessions.some((session: { runwieldSessionId: string }) =>
                session.runwieldSessionId === "done-session"
            ),
            true,
        );
        assertEquals(
            payload.projects[0].sessions.some((session: { runwieldSessionId: string }) =>
                session.runwieldSessionId === "question-session"
            ),
            false,
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("personal remote Workspace v2 Plan home keeps document rendering ahead of workflow reads", async () => {
    const route = await Deno.readTextFile(
        new URL("./pages/projects/[projectId]/plans/[planId].astro", import.meta.url),
    );
    assertEquals(route.includes("await loadOwnerPlanProgress"), false);
    assertEquals(route.includes("discoverProvenSessionId"), false);
    assertEquals(route.includes("listSessions(projectId"), false);
    assertStringIncludes(route, "progressApiUrl");
    assertStringIncludes(route, "expectedGeneration");
});

Deno.test("personal remote Workspace v2 Dashboard uses live evidence for active work and retained completion proof", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-dashboard-evidence-" });
    const projectRoot = `${dir}/project`;
    await Deno.mkdir(projectRoot);
    await savePlan(projectRoot, "inactive", "# Inactive\n", {
        planId: "inactive-plan",
        classification: "FEATURE",
        status: "in_progress",
    });
    await savePlan(projectRoot, "published", "# Published\n", {
        planId: "published-plan",
        classification: "FEATURE",
        status: "validated",
        verifiedAt: new Date().toISOString(),
    });
    const store = {
        listProjects: () => [{ projectId: "project-1", displayName: "Project", lifecycle: "enabled" }],
        getProjectHealth: () => ({ status: "available", evidence: [] }),
        requireEnabledProjectRoot: () => projectRoot,
        listSessionPlanAssociations: () => [],
        inspectSessionActivation: () => ({ activation: { state: "idle" } }),
    };
    const sessionContinuation = {
        operations: new Map(),
        listSessions: () => Promise.resolve({ sessions: [], hasNext: false, diagnostics: [] }),
    };
    try {
        const payload = await loadOwnerDashboard(store, sessionContinuation);
        const dashboardText = JSON.stringify(payload.dashboard);
        assertEquals(dashboardText.includes("inactive-plan"), false);
        const recentlyFinished = payload.dashboard.sections.find((section: { key: string }) =>
            section.key === "recently-finished"
        ).items;
        assertEquals(recentlyFinished.some((item: { planId: string }) => item.planId === "published-plan"), true);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("personal remote Workspace v2 Dashboard does not mark READY status ready when readiness evidence is broken", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-dashboard-readiness-" });
    const projectRoot = `${dir}/project`;
    await Deno.mkdir(`${projectRoot}/.wld`, { recursive: true });
    await savePlan(projectRoot, "ready", "# Ready\n", {
        planId: "ready-plan",
        classification: "FEATURE",
        status: "ready_for_work",
    });
    await Deno.writeTextFile(resolveProjectRuntimeLayout(projectRoot).primary.worktreeRegistryPath, "{ broken");
    const store = {
        listProjects: () => [{ projectId: "project-1", displayName: "Project", lifecycle: "enabled" }],
        getProjectHealth: () => ({ status: "available", evidence: [] }),
        requireEnabledProjectRoot: () => projectRoot,
        listSessionPlanAssociations: () => [],
        inspectSessionActivation: () => ({ activation: { state: "idle" } }),
    };
    const sessionContinuation = {
        operations: new Map(),
        listSessions: () => Promise.resolve({ sessions: [], hasNext: false, diagnostics: [] }),
    };
    try {
        const payload = await loadOwnerDashboard(store, sessionContinuation);
        const readyItems = payload.dashboard.sections.find((section: { key: string }) => section.key === "ready").items;
        assertEquals(readyItems.some((item: { planId: string }) => item.planId === "ready-plan"), false);
        const needsYou = payload.dashboard.sections.find((section: { key: string }) =>
            section.key === "needs-you"
        ).items;
        assertEquals(needsYou.length, 0);
        assertEquals(payload.projects[0].diagnostics.some((item) => item.source === "registry-reader"), true);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("personal remote Workspace v2 Session API filters committed Plan associations before pagination", async () => {
    const calls: number[] = [];
    const ctx = {
        params: { projectId: "project-1" },
        url: new URL("http://workspace.local/api/owner/projects/project-1/sessions?plan=target&page=0&pageSize=1"),
        state: {
            store: {
                requireEnabledProjectRoot: () => "/project",
                listSessionPlanAssociations: (sessionId: string) =>
                    sessionId === "late" ? [{ planId: "target", committedGeneration: 2 }] : [],
            },
            sessionContinuation: {
                listSessions: (_projectId: string, options: { page: number }) => {
                    calls.push(options.page);
                    return Promise.resolve({
                        sessions: options.page === 0
                            ? [{ runwieldSessionId: "first" }]
                            : [{ runwieldSessionId: "late" }],
                        hasNext: options.page === 0,
                        diagnostics: [],
                    });
                },
            },
        },
    };

    const response = await ownerProjectSessionsApi(ctx);
    const payload = await response.json();
    assertEquals(calls, [0, 1]);
    assertEquals(payload.total, 1);
    assertEquals(payload.sessions.map((session: { runwieldSessionId: string }) => session.runwieldSessionId), ["late"]);
});

Deno.test("personal remote Workspace v2 standalone Session expansion excludes only rendered Plan associations", async () => {
    const ctx = {
        params: { projectId: "project-1" },
        url: new URL(
            "http://workspace.local/api/owner/projects/project-1/sessions?excludeAssociated=true&nestedPlan=active-plan",
        ),
        state: {
            store: {
                requireEnabledProjectRoot: () => "/project",
                listSessionPlanAssociations: (sessionId: string) =>
                    sessionId === "nested"
                        ? [{ planId: "active-plan", committedGeneration: 1 }]
                        : sessionId === "terminal"
                        ? [{ planId: "terminal-plan", committedGeneration: 1 }]
                        : [],
            },
            sessionContinuation: {
                listSessions: () =>
                    Promise.resolve({
                        sessions: [{ runwieldSessionId: "nested" }, { runwieldSessionId: "terminal" }, {
                            runwieldSessionId: "free",
                        }],
                        hasNext: false,
                        diagnostics: [],
                    }),
            },
        },
    };

    const response = await ownerProjectSessionsApi(ctx);
    const payload = await response.json();
    assertEquals(
        payload.sessions.map((session: { runwieldSessionId: string }) => session.runwieldSessionId),
        ["terminal", "free"],
    );
});

Deno.test("personal remote Workspace v2 standalone Session expansion keeps terminal-only associations when no Plans render", async () => {
    const ctx = {
        params: { projectId: "project-1" },
        url: new URL("http://workspace.local/api/owner/projects/project-1/sessions?excludeAssociated=true"),
        state: {
            store: {
                requireEnabledProjectRoot: () => "/project",
                listSessionPlanAssociations: (sessionId: string) =>
                    sessionId === "terminal" ? [{ planId: "terminal-plan", committedGeneration: 1 }] : [],
            },
            sessionContinuation: {
                listSessions: () =>
                    Promise.resolve({
                        sessions: [{ runwieldSessionId: "terminal" }, { runwieldSessionId: "free" }],
                        hasNext: false,
                        diagnostics: [],
                    }),
            },
        },
    };

    const response = await ownerProjectSessionsApi(ctx);
    const payload = await response.json();
    assertEquals(
        payload.sessions.map((session: { runwieldSessionId: string }) => session.runwieldSessionId),
        ["terminal", "free"],
    );
});

Deno.test("personal remote Workspace v2 Plan workflow API dispatches checked resume and reports result errors", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-owner-workflow-action-" });
    const projectRoot = `${dir}/project`;
    await Deno.mkdir(projectRoot, { recursive: true });
    await savePlan(projectRoot, "validate", "# Validate\n\nBody\n", {
        planId: "validate-plan",
        classification: "FEATURE",
        status: "implemented",
    });
    let received: Record<string, unknown> | null = null;
    const ctx = {
        req: new Request("http://workspace.local", {
            method: "POST",
            body: JSON.stringify({
                action: "recover",
                planId: "validate-plan",
                expectedGeneration: 4,
            }),
        }),
        params: { projectId: "project-1", runwieldSessionId: "session-1" },
        state: {
            store: { requireEnabledProjectRoot: () => projectRoot },
            sessionContinuation: {
                startPlanWorkflowHandoff: (options: Record<string, unknown>) => {
                    received = options;
                    return Promise.resolve({ error: "validation needs attention" });
                },
            },
        },
    };

    try {
        const response = await ownerSessionPlanWorkflowApi(ctx);
        const payload = await response.json();
        assertEquals(response.status, 409);
        assertEquals(payload.error, "validation needs attention");
        assertEquals(received?.action, "recover");
        assertEquals(received?.planName, "validate");
        assertStringIncludes(String(received?.planContent || ""), "# Validate");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("personal remote Workspace v2 live workflow evidence ignores historical interactions", () => {
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
