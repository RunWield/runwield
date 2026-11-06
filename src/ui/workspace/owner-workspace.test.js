import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    writeFile as fsWriteFile,
    symlink as fsSymlink,
} from "node:fs/promises";
import { getRunWieldSessionDir } from "../../shared/session/root-session.js";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { savePlan } from "../../plan-store.js";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.ts";
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
        store.registerProject({ root: otherProjectRoot, displayName: "Other Project" });
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

        const sessionDir = getRunWieldSessionDir(projectRoot);
        await fsMkdir(sessionDir, { recursive: true });
        const transcriptPath = `${sessionDir}/2026-11-01T00-00-00-000Z_phone-session.jsonl`;
        await fsWriteFile(
            transcriptPath,
            [
                { type: "session", id: "phone-session", cwd: projectRoot },
                { type: "session_info", name: "Phone Ideation" },
            ]
                .map((entry) => JSON.stringify(entry))
                .join("\n") + "\n",
        );
        const phone = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "phone-session",
            transcriptPath,
            transcriptCwd: projectRoot,
            source: "catalog",
        });
        const sessionsApi = await app(
            new Request(`http://127.0.0.1:8787/api/owner/projects/${project.projectId}/sessions`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(sessionsApi.status, 200);
        const sessionsText = JSON.stringify(await sessionsApi.json());
        assertStringIncludes(sessionsText, "Phone Ideation");
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

        const sessionDetailPage = await app(
            new Request(`http://127.0.0.1:8787/projects/${project.projectId}/sessions/${phone.runwieldSessionId}`, {
                headers: { cookie: cookiePair(claimed.credential) },
            }),
        );
        assertEquals(sessionDetailPage.status === 404, false);

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
        assertEquals(rescanText.includes(projectRoot), false);
        assertEquals(rescanText.includes("sessionPath"), false);
        assertEquals(rescanText.includes('"cwd"'), false);

        store.setProjectEnabled(project.projectId, false);
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
        store.setProjectEnabled(project.projectId, true);
        store.removeProject(project.projectId);
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

test("owner add and relink expose redacted confirmation before writes and keep auth", async () => {
    const { getHomeDir } = await import("../../constants.js");
    const dir = await fsMkdtemp(join(tmpdir(), "owner-consent-"));
    const store = openOwnerCoordinationStore({ dbPath: `${dir}/owner.sqlite3` });
    const pairing = store.createPairingRequest({ codeFactory: () => "HOME12", proofFactory: () => "home-proof" });
    store.approvePairingRequest(pairing.code);
    const claimed = store.claimPairingRequest(pairing.proof, {
        credentialFactory: () => "home-credential",
        csrfFactory: () => "csrf-secret",
    });
    const owner = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: "http://127.0.0.1:8787", store });
    const app = owner.handler();
    const request = (path, body, authenticated = true) =>
        app(
            new Request(`http://127.0.0.1:8787${path}`, {
                method: "POST",
                headers: {
                    origin: "http://127.0.0.1:8787",
                    "content-type": "application/json",
                    ...(authenticated
                        ? { cookie: cookiePair(claimed.credential), "x-runwield-csrf": "csrf-secret" }
                        : {}),
                },
                body: JSON.stringify(body),
            }),
        );
    try {
        const root = getHomeDir();
        const unauthenticated = await request("/api/owner/projects", { root }, false);
        assertEquals(unauthenticated.status, 401);
        const refusal = await request("/api/owner/projects", { root });
        assertEquals(refusal.status, 409);
        const warning = await refusal.json();
        assertEquals(warning.code, "directory_confirmation_required");
        assertEquals(JSON.stringify(warning).includes(root), false);
        assertEquals(store.listProjects(), []);
        const alias = `${dir}/root-alias`;
        await fsSymlink(root, alias);
        assertEquals(
            (await request("/api/owner/projects", { root: alias, directoryConfirmation: warning.confirmation })).status,
            409,
        );
        const aliasWarning = await (await request("/api/owner/projects", { root: alias })).json();
        await fsRm(alias);
        await fsSymlink("/", alias);
        assertEquals(
            (await request("/api/owner/projects", { root: alias, directoryConfirmation: aliasWarning.confirmation }))
                .status,
            409,
        );
        assertEquals(store.listProjects(), []);
        const ordinary = await request("/api/owner/projects", { root: dir });
        assertEquals(ordinary.status, 201);
        const projectId = (await ordinary.json()).project.projectId;
        const evidence = store.listProjectRootEvidence(projectId);
        const relinkPath = `/api/owner/projects/${projectId}/action`;
        assertEquals((await request(relinkPath, { action: "relink", newRoot: root })).status, 409);
        assertEquals(store.listProjectRootEvidence(projectId), evidence);
        assertEquals(
            (
                await request(relinkPath, {
                    action: "relink",
                    newRoot: root,
                    directoryConfirmation: warning.confirmation,
                })
            ).status,
            200,
        );
        assertEquals((await request("/api/owner/projects", { root })).status, 409);
        assertEquals(
            (await request("/api/owner/projects", { root, directoryConfirmation: warning.confirmation })).status,
            201,
        );
    } finally {
        await owner.close();
        store.close();
        await fsRm(dir, { recursive: true });
    }
});
