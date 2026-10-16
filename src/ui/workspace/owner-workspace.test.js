import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { getPlanRevisionForText, injectFrontMatter, loadPlan, savePlan } from "../../plan-store.js";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { createOwnerWorkspaceApp, startWorkspaceServer } from "./server.js";

/** @param {string} credential @param {string} [csrf] */
function cookiePair(credential, csrf = "csrf-secret") {
    return `rw_owner_device=${encodeURIComponent(credential)}; rw_owner_csrf=${encodeURIComponent(csrf)}`;
}

test("startWorkspaceServer enforces owner non-loopback TLS policy at the exported entry point", () => {
    assertThrows(
        () =>
            startWorkspaceServer({
                mode: "owner",
                host: "0.0.0.0",
                port: 8787,
                publicOrigin: "http://runwield.example.test",
                trustTlsTerminator: true,
            }),
        Error,
        "https:// publicOrigin",
    );
    assertThrows(
        () =>
            startWorkspaceServer({
                mode: "owner",
                host: "0.0.0.0",
                port: 8787,
                publicOrigin: "https://runwield.example.test",
                trustTlsTerminator: false,
            }),
        Error,
        "trustTlsTerminator",
    );
});

test("owner Workspace redirects unpaired browsers and serves pairing code bootstrap", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-ui-"));
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const ownerApp = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    try {
        const app = ownerApp.handler();
        const redirect = await app(new Request("http://127.0.0.1:8787/"));
        assertEquals(redirect.status, 302);
        assertEquals(redirect.headers.get("location"), "/pair");
        const css = await app(new Request("http://127.0.0.1:8787/workspace.css"));
        assertEquals(css.status, 200);
        assertStringIncludes(css.headers.get("content-type") || "", "text/css");

        const wrongHost = await app(new Request("http://127.0.0.1:8788/workspace.css"));
        assertEquals(wrongHost.status, 403);

        const request = await app(
            new Request("http://127.0.0.1:8787/api/owner/pairing/request", {
                method: "POST",
                headers: { origin: "http://127.0.0.1:8787", "content-type": "application/json" },
                body: JSON.stringify({ deviceLabel: "Phone" }),
            }),
        );
        assertEquals(request.status, 201);
        assertStringIncludes(request.headers.get("set-cookie") || "", "rw_pairing_proof=");
        const body = await request.json();
        assertEquals(body.state, "pending");
        assertEquals(/^[A-Z2-9]{6}$/.test(body.code), true);

        let rateLimited = request;
        for (let index = 0; index < 4; index += 1) {
            rateLimited = await app(
                new Request("http://127.0.0.1:8787/api/owner/pairing/request", {
                    method: "POST",
                    headers: {
                        origin: "http://127.0.0.1:8787",
                        "content-type": "application/json",
                        "x-forwarded-for": `198.51.100.${index}`,
                    },
                    body: JSON.stringify({ deviceLabel: `Phone ${index}` }),
                }),
            );
        }
        assertEquals(rateLimited.status, 429);
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("owner Workspace requires CSRF for Project mutation and resolves Project Plan Board by registered Project", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-project-"));
    const projectRoot = `${dir}/project`;
    const otherProjectRoot = `${dir}/other-project`;
    await fsMkdir(projectRoot);
    await fsMkdir(otherProjectRoot);
    await fsMkdir(`${projectRoot}/src`);
    await fsWriteFile(`${projectRoot}/src/referenced.ts`, "export const referenced = true;\n");
    await savePlan(projectRoot, "owner-plan", "# Owner Plan\n\n## Context\n\nVisible owner plan", {
        planId: "owner-plan-id",
        classification: "FEATURE",
        complexity: "LOW",
        summary: "Visible owner plan",
        status: "draft",
    });
    await savePlan(projectRoot, "held-plan", "# Held Plan\n\n## Context\n\nVisible held plan", {
        planId: "held-plan-id",
        classification: "FEATURE",
        complexity: "LOW",
        summary: "Visible held plan",
        status: "on_hold",
    });
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    let appObject;
    try {
        const pairing = store.createPairingRequest({
            codeFactory: () => "OWN123",
            proofFactory: () => "proof",
        });
        store.approvePairingRequest(pairing.code);
        const claimed = store.claimPairingRequest(pairing.proof, {
            credentialFactory: () => "credential-secret",
            csrfFactory: () => "csrf-secret",
        });
        const project = store.registerProject({ root: projectRoot, displayName: "Owner Project" });
        const otherProject = store.registerProject({ root: otherProjectRoot, displayName: "Other Project" });
        let closedConnections = 0;
        appObject = /** @type {any} */ (
            createOwnerWorkspaceApp({
                mode: "owner",
                publicOrigin: "http://127.0.0.1:8787",
                store,
            })
        );
        appObject.ownerConnections.register(claimed.deviceId, { close: () => (closedConnections += 1) });
        const app = appObject.handler();

        const rejected = await app(
            new Request("http://127.0.0.1:8787/api/owner/projects", {
                method: "POST",
                headers: { origin: "http://127.0.0.1:8787", cookie: cookiePair(claimed.credential) },
                body: JSON.stringify({ root: projectRoot }),
            }),
        );
        assertEquals(rejected.status, 403);

        const page = await app(
            new Request(`http://127.0.0.1:8787/projects/${project.projectId}/plans`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        const html = await page.text();
        if (page.status === 503) {
            assertStringIncludes(html, "Workspace Astro build unavailable");
        } else {
            assertEquals(page.status, 200, html);
            assertStringIncludes(html, "Owner Project Plan Board");
            assertStringIncludes(html, "Visible owner plan");
            assertStringIncludes(html, "Project Plan views");
            assertStringIncludes(html, `/projects/${project.projectId}/plans/closed`);
            assertStringIncludes(html, `/projects/${project.projectId}/plans/on-hold`);

            const tokenizedPage = await app(
                new Request(`http://127.0.0.1:8787/projects/${project.projectId}/plans?token=ephemeral&q=owner`, {
                    headers: { cookie: cookiePair(claimed.credential) },
                }),
            );
            assertEquals(tokenizedPage.status, 200);
            const tokenizedHtml = await tokenizedPage.text();
            assertStringIncludes(tokenizedHtml, "q=owner");
            assertStringIncludes(tokenizedHtml, `/projects/${project.projectId}/plans/closed?q=owner`);
            assertEquals(/href=\"[^\"]*token=ephemeral/.test(tokenizedHtml), false);

            const onHoldPage = await app(
                new Request(`http://127.0.0.1:8787/projects/${project.projectId}/plans/on-hold`, {
                    headers: { cookie: cookiePair(claimed.credential) },
                }),
            );
            assertEquals(onHoldPage.status, 200);
            assertStringIncludes(await onHoldPage.text(), "Visible held plan");

            const missingPlanPage = await app(
                new Request(`http://127.0.0.1:8787/projects/${project.projectId}/plans/missing-plan`, {
                    headers: { cookie: cookiePair(claimed.credential) },
                }),
            );
            assertEquals(missingPlanPage.status, 404);
        }

        const boardApi = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/plans`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(boardApi.status, 200);
        const boardJson = await boardApi.json();
        assertEquals(boardJson.readOnly, true);
        const boardText = JSON.stringify(boardJson);
        assertStringIncludes(boardText, "Visible owner plan");
        assertEquals(boardText.includes("allowedManualTargetStatuses"), false);
        assertEquals(boardText.includes("allowedTargetStatuses"), false);

        const ownerPlanCard = boardJson.board.columns[0].cards[0];
        assertEquals(ownerPlanCard.actions, {});

        const mutationNotFound = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/plans/owner-plan-id/body`, {
                method: "PUT",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    cookie: cookiePair(claimed.credential),
                    "x-runwield-csrf": "csrf-secret",
                    "content-type": "application/json",
                },
                body: "{}",
            }),
        );
        assertEquals(mutationNotFound.status, 404);
        assertStringIncludes(mutationNotFound.headers.get("content-type") || "", "application/json");
        assertEquals((await mutationNotFound.json()).error, "Owner API route not found.");

        const onHoldBoardApi = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/plans/view/on-hold`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(onHoldBoardApi.status, 200);
        assertStringIncludes(JSON.stringify(await onHoldBoardApi.json()), "Visible held plan");

        const detailApi = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/plans/owner-plan-id`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(detailApi.status, 200);
        const detailJson = await detailApi.json();
        assertEquals(detailJson.plan.capabilities.bodyEditing, false);
        assertEquals(detailJson.plan.actions, {});
        const detailText = JSON.stringify(detailJson);
        assertStringIncludes(detailText, "Owner Plan");
        assertEquals(detailText.includes(projectRoot), false);

        const referencedFile = await app(
            new Request(
                `http://127.0.0.1:8787/api/owner/projects/${project.projectId}/files/content?path=src%2Freferenced.ts`,
                { headers: { cookie: cookiePair(claimed.credential) } },
            ),
        );
        assertEquals(referencedFile.status, 200);
        const referencedFileJson = await referencedFile.json();
        assertEquals(referencedFileJson.filepath, "src/referenced.ts");
        assertEquals(referencedFileJson.contents, "export const referenced = true;\n");

        const registeredApi = await app(
            new Request("http://127.0.0.1:8787/api/owner/projects", {
                method: "POST",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    cookie: cookiePair(claimed.credential),
                    "x-runwield-csrf": "csrf-secret",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ root: projectRoot, displayName: "Owner Project" }),
            }),
        );
        assertEquals(registeredApi.status, 201);
        const registeredText = JSON.stringify(await registeredApi.json());
        assertStringIncludes(registeredText, "rootLabel");
        assertEquals(registeredText.includes(projectRoot), false);

        const projectsPage = await app(
            new Request("http://127.0.0.1:8787/projects", { headers: { cookie: cookiePair(claimed.credential) } }),
        );
        const projectsHtml = await projectsPage.text();
        if (projectsPage.status === 503) {
            assertStringIncludes(projectsHtml, "Workspace Astro build unavailable");
        } else {
            assertEquals(projectsPage.status, 200);
            assertStringIncludes(projectsHtml, "Link a Project");
            assertStringIncludes(projectsHtml, "Project root");
            assertStringIncludes(projectsHtml, "Owner Project");
        }

        const home = await app(
            new Request("http://127.0.0.1:8787/", { headers: { cookie: cookiePair(claimed.credential) } }),
        );
        const homeHtml = await home.text();
        assertStringIncludes(homeHtml, "Attention Dashboard");
        assertStringIncludes(homeHtml, "rw-thinking-dots");
        assertStringIncludes(homeHtml, "rw-thinking-glyph");
        assertEquals(homeHtml.includes("Restoring the latest available Project Session"), false);
        assertStringIncludes(homeHtml, "/workspace-shell.js");
        assertEquals(homeHtml.includes("Relink Project root"), false);

        const transcriptPath = `${projectRoot}/phone-session.jsonl`;
        await fsWriteFile(
            transcriptPath,
            [
                { type: "session", id: "phone-session", cwd: projectRoot },
                { type: "session_info", name: "Phone Ideation" },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n",
        );
        /** @type {any} */ (store).listProjectSessions = () =>
            Promise.resolve({
                sessions: [
                    {
                        runwieldSessionId: "session-owned",
                        projectId: project.projectId,
                        displayName: "Phone Ideation",
                        transcriptPath,
                    },
                ],
                diagnostics: [
                    {
                        code: "path_leak_regression",
                        sessionPath: `${projectRoot}/.runwield/sessions/session.json`,
                        message: `Transcript cwd ${projectRoot}/worktree does not match registered Project root`,
                    },
                ],
            });
        /** @type {any} */ (store).inspectSessionActivation = () => ({
            activation: { state: "idle", ownerProcessKind: null },
            generation: { generation: 1 },
        });
        const sessionsApi = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/sessions`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(sessionsApi.status, 200);
        const sessionsText = JSON.stringify(await sessionsApi.json());
        assertStringIncludes(sessionsText, "Phone Ideation");
        assertStringIncludes(sessionsText, "[local path]");
        assertEquals(sessionsText.includes(projectRoot), false);
        assertEquals(sessionsText.includes("sessionPath"), false);

        const sidebarApi = await app(
            new Request("http://127.0.0.1:8787/api/owner/sidebar", {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(sidebarApi.status, 200);
        const sidebarText = JSON.stringify(await sidebarApi.json());
        assertStringIncludes(sidebarText, "Owner Project");
        assertStringIncludes(sidebarText, "Phone Ideation");
        assertEquals(sidebarText.includes(projectRoot), false);

        const optionsApi = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/session-options`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(optionsApi.status, 200);
        const optionsText = JSON.stringify(await optionsApi.json());
        assertStringIncludes(optionsText, "Router");
        assertStringIncludes(optionsText, "thinkingLevels");
        assertEquals(optionsText.includes(projectRoot), false);
        assertEquals(optionsText.includes("apiKey"), false);

        let configurePayload = null;
        appObject.sessionContinuation.configureSession = (payload) => {
            configurePayload = payload;
            return Promise.resolve({ ok: true, generation: payload.expectedGeneration + 1 });
        };
        const configureApi = await app(
            new Request(
                `http://127.0.0.1:8787/api/owner/projects/${project.projectId}/sessions/session-owned/configure`,
                {
                    method: "POST",
                    headers: {
                        origin: "http://127.0.0.1:8787",
                        cookie: cookiePair(claimed.credential),
                        "x-runwield-csrf": "csrf-secret",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        expectedGeneration: 3,
                        agentName: "engineer",
                        model: "model-a",
                        provider: "provider-a",
                        thinkingLevel: "medium",
                    }),
                },
            ),
        );
        assertEquals(configureApi.status, 202);
        assertEquals(configurePayload, {
            projectId: project.projectId,
            runwieldSessionId: "session-owned",
            expectedGeneration: 3,
            agentName: "engineer",
            model: "model-a",
            provider: "provider-a",
            thinkingLevel: "medium",
        });

        let cancelledOperationId = "";
        appObject.sessionContinuation.cancelOperation = ({ operationId }) => {
            cancelledOperationId = operationId;
            return { ok: true, aborted: true };
        };
        const cancelApi = await app(
            new Request("http://127.0.0.1:8787/api/owner/session-operations/operation-owned/cancel", {
                method: "POST",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    cookie: cookiePair(claimed.credential),
                    "x-runwield-csrf": "csrf-secret",
                    "content-type": "application/json",
                },
                body: JSON.stringify({}),
            }),
        );
        assertEquals(cancelApi.status, 202);
        assertEquals(cancelledOperationId, "operation-owned");

        appObject.sessionContinuation.timeline = () =>
            Promise.resolve({
                ok: true,
                generation: 1,
                events: [],
                complete: true,
                segments: [{ byteLength: 123, terminalEntryId: "entry-secret" }],
            });
        const timelineApi = await app(
            new Request(
                `http://127.0.0.1:8787/api/owner/projects/${project.projectId}/sessions/session-owned/timeline`,
                {
                    headers: { cookie: cookiePair(claimed.credential) },
                },
            ),
        );
        assertEquals(timelineApi.status, 200);
        const timelineText = JSON.stringify(await timelineApi.json());
        assertEquals(timelineText.includes("segments"), false);
        assertEquals(timelineText.includes("byteLength"), false);
        assertEquals(timelineText.includes("terminalEntryId"), false);

        let answered = false;
        appObject.sessionContinuation.operations.set("operation-owned", {
            status: "running",
            projectId: project.projectId,
            runwieldSessionId: "session-owned",
            events: [],
            liveInteraction: { interactionId: "interaction-owned", request: { prompt: "Pick" } },
            answer: { resolve: () => (answered = true), reject: () => {} },
        });
        const wrongProjectAnswer = await app(
            new Request(
                `http://127.0.0.1:8787/api/owner/projects/${otherProject.projectId}/session-operations/operation-owned/interactions/interaction-owned/answer`,
                {
                    method: "POST",
                    headers: {
                        origin: "http://127.0.0.1:8787",
                        cookie: cookiePair(claimed.credential),
                        "x-runwield-csrf": "csrf-secret",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ requestId: "answer-wrong-project", response: "yes" }),
                },
            ),
        );
        assertEquals(wrongProjectAnswer.status, 409);
        assertEquals(answered, false);
        const answerApi = await app(
            new Request(
                `http://127.0.0.1:8787/api/owner/projects/${project.projectId}/session-operations/operation-owned/interactions/interaction-owned/answer`,
                {
                    method: "POST",
                    headers: {
                        origin: "http://127.0.0.1:8787",
                        cookie: cookiePair(claimed.credential),
                        "x-runwield-csrf": "csrf-secret",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({
                        requestId: "answer-owned",
                        runwieldSessionId: "session-owned",
                        response: "yes",
                    }),
                },
            ),
        );
        assertEquals(answerApi.status, 202);
        assertEquals(answered, true);

        const sessionsPage = await app(
            new Request(`http://127.0.0.1:8787/projects/${project.projectId}/sessions`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals([200, 503].includes(sessionsPage.status), true);
        assertStringIncludes(await sessionsPage.text(), "Project Sessions");

        const newSessionPage = await app(
            new Request(`http://127.0.0.1:8787/projects/${project.projectId}/sessions/new`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(newSessionPage.status === 404, false);
        assertStringIncludes(await newSessionPage.text(), "New Project Session");

        const settingsPage = await app(
            new Request(`http://127.0.0.1:8787/projects/${project.projectId}/settings`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(settingsPage.status === 404, false);
        const settingsHtml = await settingsPage.text();
        if (settingsPage.status === 503) {
            assertStringIncludes(settingsHtml, "Workspace Astro build unavailable");
        } else {
            assertStringIncludes(settingsHtml, "Owner Project settings");
            assertStringIncludes(settingsHtml, "Relink Project root");
        }

        /** @type {any} */ (store).getSessionById = (runwieldSessionId) =>
            runwieldSessionId === "session-owned"
                ? {
                      runwieldSessionId,
                      projectId: "file-project-identity",
                      transcriptCwd: projectRoot,
                  }
                : null;
        const sessionDetailPage = await app(
            new Request(`http://127.0.0.1:8787/projects/${project.projectId}/sessions/session-owned`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(sessionDetailPage.status === 404, false);

        store.catalogProjectSessions = () =>
            Promise.resolve({
                cataloged: [],
                diagnostics: [
                    {
                        code: "path_leak_regression",
                        sessionPath: `${projectRoot}/.runwield/sessions/session.json`,
                        message: `Transcript cwd ${projectRoot}/worktree does not match registered Project root`,
                        nested: { cwd: `${projectRoot}/nested` },
                    },
                ],
            });
        const rescan = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/action`, {
                method: "POST",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    cookie: cookiePair(claimed.credential),
                    "x-runwield-csrf": "csrf-secret",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ action: "rescan" }),
            }),
        );
        assertEquals(rescan.status, 200);
        const rescanText = JSON.stringify(await rescan.json());
        assertStringIncludes(rescanText, "[local path]");
        assertEquals(rescanText.includes(projectRoot), false);
        assertEquals(rescanText.includes("sessionPath"), false);
        assertEquals(rescanText.includes('"cwd"'), false);

        store.setProjectEnabled(project.projectId, false);
        let disabledCatalogCalled = false;
        store.catalogProjectSessions = () => {
            disabledCatalogCalled = true;
            return Promise.resolve({ cataloged: [], diagnostics: [] });
        };
        const disabledRescan = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/action`, {
                method: "POST",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    cookie: cookiePair(claimed.credential),
                    "x-runwield-csrf": "csrf-secret",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ action: "rescan" }),
            }),
        );
        assertEquals(disabledRescan.status, 400);
        assertEquals(disabledCatalogCalled, false);
        store.setProjectEnabled(project.projectId, true);
        store.removeProject(project.projectId);
        let removedCatalogCalled = false;
        store.catalogProjectSessions = () => {
            removedCatalogCalled = true;
            return Promise.resolve({ cataloged: [], diagnostics: [] });
        };
        const removedRescan = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/action`, {
                method: "POST",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    cookie: cookiePair(claimed.credential),
                    "x-runwield-csrf": "csrf-secret",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ action: "rescan" }),
            }),
        );
        assertEquals(removedRescan.status, 400);
        assertEquals(removedCatalogCalled, false);
        assertEquals(store.getProjectById(project.projectId), null);

        const badUpgradeOrigin = await app(
            new Request("http://127.0.0.1:8787/api/owner/future-socket", {
                headers: {
                    origin: "http://127.0.0.1:8788",
                    upgrade: "websocket",
                    cookie: cookiePair(claimed.credential),
                },
            }),
        );
        assertEquals(badUpgradeOrigin.status, 403);

        const allowedUpgrade = await app(
            new Request("http://127.0.0.1:8787/api/owner/future-socket", {
                headers: {
                    origin: "http://127.0.0.1:8787",
                    upgrade: "websocket",
                    cookie: cookiePair(claimed.credential),
                },
            }),
        );
        assertEquals(allowedUpgrade.status, 404);

        const revoked = await app(
            new Request(`http://127.0.0.1:8787/api/owner/devices/${claimed.deviceId}/revoke`, {
                method: "POST",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    cookie: cookiePair(claimed.credential),
                    "x-runwield-csrf": "csrf-secret",
                },
                body: "{}",
            }),
        );
        assertEquals(revoked.status, 200);
        assertEquals(closedConnections, 1);
    } finally {
        await appObject?.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("owner Workspace rejects stale live Plan review before answering Runtime", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-plan-review-stale-"));
    const projectRoot = `${dir}/project`;
    await fsMkdir(projectRoot);
    await savePlan(projectRoot, "owner-plan", "# Owner Plan\n\nBody", {
        planId: "owner-plan-id",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Visible owner plan",
        status: "draft",
    });
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    let appObject;
    try {
        const project = store.registerProject({ root: projectRoot, displayName: "Owner Project" });
        appObject = /** @type {any} */ (
            createOwnerWorkspaceApp({
                mode: "owner",
                publicOrigin: "http://127.0.0.1:8787",
                store,
            })
        );
        const plan = await loadPlan(projectRoot, "owner-plan");
        const openedRevision = await getPlanRevisionForText(plan.markdown);
        await fsWriteFile(plan.path, injectFrontMatter(plan.markdown, { status: "feedback" }));

        let resolved = false;
        let rejectedMessage = "";
        appObject.sessionContinuation.operations.set("operation-stale", {
            status: "running",
            projectId: project.projectId,
            runwieldSessionId: "session-owned",
            events: [],
            liveInteraction: {
                interactionId: "interaction-stale",
                request: {
                    type: "plan_review",
                    prompt: "Review Plan",
                    planReview: {
                        planId: "owner-plan-id",
                        classification: "PLANNED_CHANGE",
                        expectedRevision: openedRevision,
                        reviewedSource: {
                            markdown: plan.markdown,
                            path: plan.path,
                            planName: "owner-plan",
                            attrs: plan.attrs,
                            revision: openedRevision,
                        },
                        expectedStatus: "draft",
                        expectedWorktree: { kind: "none" },
                    },
                },
            },
            answer: {
                resolve: () => (resolved = true),
                reject: (error) => (rejectedMessage = error instanceof Error ? error.message : String(error)),
            },
        });

        await assertRejects(
            () =>
                appObject.sessionContinuation.answerInteraction({
                    deviceId: "device-owned",
                    projectId: project.projectId,
                    operationId: "operation-stale",
                    interactionId: "interaction-stale",
                    runwieldSessionId: "session-owned",
                    requestId: "answer-stale-plan-review",
                    response: {
                        approved: true,
                        approvalAction: "run",
                        executionAgent: "engineer",
                        collaborationRecommendation: "autonomous",
                    },
                }),
            Error,
            "Plan Status changed after review opened",
        );
        assertEquals(resolved, false);
        assertStringIncludes(rejectedMessage, "Plan Status changed after review opened");
        assertEquals((await loadPlan(projectRoot, "owner-plan"))?.attrs.status, "feedback");
    } finally {
        await appObject?.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("owner Workspace rejects Shared Space bearer capabilities on owner APIs", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-isolation-"));
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const ownerApp = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    try {
        const app = ownerApp.handler();
        const response = await app(
            new Request("http://127.0.0.1:8787/api/owner/projects", {
                headers: { authorization: "Bearer shared-space-capability" },
            }),
        );
        assertEquals(response.status, 401);
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("owner Workspace keeps read-only Project Plan progress API and removes progress page", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-progress-"));
    const projectRoot = `${dir}/project`;
    await fsMkdir(projectRoot);
    await savePlan(projectRoot, "progress-plan", "# Progress Plan\n\nBody", {
        planId: "progress-plan-id",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Progress plan",
        status: "ready_for_work",
    });
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const ownerApp = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    try {
        const pairing = store.createPairingRequest({
            codeFactory: () => "PRG123",
            proofFactory: () => "proof",
        });
        store.approvePairingRequest(pairing.code);
        const claimed = store.claimPairingRequest(pairing.proof, {
            credentialFactory: () => "credential-secret",
            csrfFactory: () => "csrf-secret",
        });
        const project = store.registerProject({ root: projectRoot, displayName: "Owner Project" });
        const app = ownerApp.handler();
        const api = await app(
            new Request(
                `http://127.0.0.1:8787/api/owner/projects/${project.projectId}/plans/progress-plan-id/progress`,
                {
                    headers: { cookie: cookiePair(claimed.credential) },
                },
            ),
        );
        assertEquals(api.status, 200);
        const json = await api.json();
        assertEquals(json.readOnly, true);
        assertEquals(json.plan.planId, "progress-plan-id");
        assertEquals(JSON.stringify(json).includes(projectRoot), false);

        const page = await app(
            new Request(`http://127.0.0.1:8787/projects/${project.projectId}/plans/progress-plan-id/progress`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(page.status, 404);
    } finally {
        await ownerApp.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});

test("owner Workspace reviews a complete Sequence and rejects stale sibling evidence", async () => {
    const { prepareSequenceReview } = await import("../../shared/workflow/sequence-review.ts");
    const { WorkspaceSessionContinuationService } = await import("./server/session-continuation.js");
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-owner-sequence-review-"));
    const root = `${dir}/project`;
    await fsMkdir(root);
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    try {
        await savePlan(root, "sequence", "# Sequence", {
            classification: "PROJECT",
            type: "sequence",
            status: "draft",
        });
        for (const [index, name] of ["first", "second"].entries()) {
            await savePlan(root, `sequence/${name}`, `# ${name}`, {
                classification: "PLANNED_CHANGE",
                status: "draft",
                parentPlan: "sequence",
                order: index + 1,
            });
        }
        const project = store.registerProject({ root, displayName: "Sequence project" });
        const service = new WorkspaceSessionContinuationService({ store });
        const documents = await prepareSequenceReview(root, "sequence");
        const answers = [];
        service.operations.set("sequence-review", {
            status: "running",
            projectId: project.projectId,
            runwieldSessionId: "sequence-session",
            events: [],
            liveInteraction: {
                interactionId: "sequence-interaction",
                request: {
                    type: "plan_review",
                    prompt: "Review Sequence",
                    planReview: { planId: documents[0].planId, sequenceDocuments: documents },
                },
            },
            answer: { resolve: (answer) => answers.push(answer), reject: () => {} },
        });
        const second = documents[2];
        await fsWriteFile(second.planPath, `${second.plan}\nNew requirements.`);
        const decision = {
            approved: true,
            approvalAction: "run",
            documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
        };
        const request = {
            deviceId: "sequence-device",
            projectId: project.projectId,
            operationId: "sequence-review",
            interactionId: "sequence-interaction",
            runwieldSessionId: "sequence-session",
            requestId: "stale-sequence",
            response: decision,
        };
        await assertRejects(() => service.answerInteraction(request), Error, "changed while review was open");
        assertEquals(answers.length, 0);
        assertEquals((await loadPlan(root, "sequence/first"))?.attrs.status, "draft");
        await fsWriteFile(second.planPath, second.plan);
        await service.answerInteraction({ ...request, requestId: "current-sequence" });
        assertEquals(answers.length, 1);
        assertEquals(
            answers[0]._meta.sequenceDecision.documents.map((doc) => doc.planId),
            documents.map((doc) => doc.planId),
        );
        assertEquals((await loadPlan(root, "sequence"))?.attrs.status, "draft", "the workflow owns the grouped commit");
        service.operations.set("sequence-review", {
            ...service.operations.get("sequence-review"),
            liveInteraction: {
                interactionId: "sequence-chat",
                request: {
                    type: "plan_review",
                    planReview: { planName: "sequence", sequenceDocuments: documents },
                },
            },
            answer: {
                resolve: (answer) => {
                    answers.push(answer);
                },
                reject: () => {},
            },
        });
        await service.answerInteraction({
            ...request,
            interactionId: "sequence-chat",
            requestId: "sequence-chat",
            response: {
                approved: false,
                feedback: "Clarify the group.",
                conversationTurn: true,
                documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
            },
        });
        assertEquals(answers[1]._meta.conversationTurn, true);
        assertEquals(answers[1]._meta.sequenceDecision.feedback, "Clarify the group.");
    } finally {
        store.close();
        await fsRm(dir, { recursive: true });
    }
});
