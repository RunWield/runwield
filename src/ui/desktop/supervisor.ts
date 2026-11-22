import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, screen, session, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AcpWorkspaceSessionClient } from "../../acp/client/workspace-session-client.ts";
import type { SessionClientView } from "../workspace/client/session-client.ts";
import { DESKTOP_URL, SESSION_CHANNEL, validateDesktopRequest } from "./bridge.ts";
import { PROJECT_CHANNEL, validateProjectRequest, type DesktopProjectRequest } from "./bridge.ts";
import type { DesktopRequest } from "./bridge.ts";
import {
    SAVED_CHANNEL,
    SAVED_OPERATIONS,
    validateSavedRequest,
    type SavedDesktopRequest,
} from "./saved-session-bridge.ts";
import type {
    WorkspaceProjectContext,
    WorkspaceHistoryRequest,
    WorkspaceSnapshotRequest,
    WorkspaceConfigureRequest,
    WorkspaceSessionRequest,
} from "../../acp/workspace-contract.ts";
import { DesktopDraftStore, type DesktopDraftLocator } from "./draft-store.ts";
import { DRAFT_CHANNEL, validateDraftRequest, type DesktopDraftRequest } from "./draft-bridge.ts";
import { DesktopPreferences, validateNavigation, type DesktopRecoveryNotice } from "./preferences.ts";
import type { DesktopNavigation } from "../workspace/client/desktop-workbench.ts";
import { DARK_BROWSER_THEME } from "../design-system/themes/dark.ts";

export interface DesktopSupervisorOptions {
    bun: string;
    cli: string;
    projectArgument: string;
    hidden: boolean;
}

/** The updater uses the same acknowledged stop boundary as native Quit. */
export let stopDesktopForUpdate: (() => Promise<boolean>) | null = null;

export async function startDesktopSupervisor({
    bun,
    cli,
    projectArgument,
    hidden,
}: DesktopSupervisorOptions): Promise<void> {
    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
    }
    let window: BrowserWindow | null = null;
    let ready = false;
    let settled = false;
    let shutdown: Promise<void> | null = null;
    let flushingView: { requestId: string; resolve: () => void; reject: (error: Error) => void } | null = null;
    const attachWindow = () => {
        if (!ready || settled || shutdown) return;
        if (!window || window.isDestroyed()) window = createWindow();
        else {
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
        }
    };
    app.on("second-instance", attachWindow);
    app.on("activate", attachWindow);
    // Window lifetime must not control runtime lifetime, including on Windows and Linux.
    app.on("window-all-closed", () => {});
    const project = "";
    await access(bun);
    await access(cli);
    await app.whenReady();
    const preferences = await DesktopPreferences.open(app.getPath("userData"));
    const rendererRoot = await realpath(fileURLToPath(new URL("./renderer/", import.meta.url)));
    const csp =
        "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
    protocol.handle("runwield", async (request) => {
        try {
            const url = new URL(request.url);
            if (request.method !== "GET" || url.hostname !== "app" || url.username || url.password || url.port)
                return new Response("Refused", { status: 403 });
            const pathname = decodeURIComponent(url.pathname);
            if (pathname.includes("\\") || pathname.split("/").some((part) => part === ".." || part === "."))
                return new Response("Refused", { status: 403 });
            const asset = await realpath(resolve(rendererRoot, `.${pathname === "/" ? "/index.html" : pathname}`));
            if (!asset.startsWith(rendererRoot + sep)) return new Response("Refused", { status: 403 });
            const response = await net.fetch(pathToFileURL(asset).href);
            const headers = new Headers(response.headers);
            headers.set("Content-Security-Policy", csp);
            headers.set("X-Content-Type-Options", "nosniff");
            return new Response(response.body, { status: response.status, headers });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on("will-download", (event) => event.preventDefault());
    function createWindow(): BrowserWindow {
        const savedBounds = preferences.read().bounds;
        const visible = screen
            .getAllDisplays()
            .some(
                ({ workArea }) =>
                    (savedBounds.x ?? workArea.x) < workArea.x + workArea.width &&
                    (savedBounds.y ?? workArea.y) < workArea.y + workArea.height &&
                    (savedBounds.x ?? workArea.x) + savedBounds.width > workArea.x &&
                    (savedBounds.y ?? workArea.y) + savedBounds.height > workArea.y,
            );
        const next = new BrowserWindow({
            title: "RunWield",
            show: !hidden,
            ...(visible ? savedBounds : { width: savedBounds.width, height: savedBounds.height }),
            minWidth: 700,
            minHeight: 550,
            backgroundColor: DARK_BROWSER_THEME.colors["--rw-page-bg"],
            webPreferences: {
                preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: true,
                webviewTag: false,
                navigateOnDragDrop: false,
            },
        });
        next.setMenuBarVisibility(false);
        next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        next.webContents.on("will-navigate", (event) => event.preventDefault());
        next.webContents.on("will-frame-navigate", (event) => event.preventDefault());
        next.webContents.on("will-redirect", (event) => event.preventDefault());
        next.webContents.on("will-attach-webview", (event) => event.preventDefault());
        next.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
            if (mainFrame) {
                detachRenderer(next.webContents);
            }
        });
        next.webContents.on("render-process-gone", () => {
            flushingView?.resolve();
            flushingView = null;
            detachRenderer(next.webContents);
            if (!settled && !next.isDestroyed() && window === next) {
                window = createWindow();
                next.destroy();
            }
        });
        const saveBounds = () => {
            if (!next.isDestroyed() && !next.isMinimized() && !next.isMaximized())
                void preferences.update({ bounds: next.getBounds() }).catch(console.error);
        };
        next.on("resize", saveBounds);
        next.on("move", saveBounds);
        next.on("close", () => {
            detachRenderer(next.webContents);
            saveBounds();
        });

        next.on("closed", () => {
            flushingView?.resolve();
            flushingView = null;
            if (window === next) window = null;
        });
        void next.loadURL(DESKTOP_URL).catch((error: Error) => console.error(error));
        return next;
    }
    function startRuntime() {
        const runtime = spawn(bun, [cli, "acp"], {
            cwd: resolve(cli, "../.."),
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        console.info(`[desktop] runtime PID ${runtime.pid}`);
        runtime.stderr.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(chunk));
        runtime.on("error", (error) => console.error(`Runtime launch failed: ${error.message}`));
        const exited = new Promise<void>((resolveExit) => runtime.once("close", () => resolveExit()));
        const client = new AcpWorkspaceSessionClient({
            connectionId: randomUUID(),
            project,
            workspaceAdmission: true,
            input: Readable.toWeb(runtime.stdout),
            output: Writable.toWeb(runtime.stdin),
        });
        client.setRendererAttached(false);
        if (shutdown) client.setSubmissionDispatchPaused(true);
        return { runtime, exited, client };
    }
    let { runtime, exited, client } = startRuntime();
    const drafts = await DesktopDraftStore.open(app.getPath("userData"));
    // These public store methods are the restart boundary: list(), bind(), read(), flush().
    function locator(sessionId: string): DesktopDraftLocator {
        const bound = client.getBindingView(sessionId);
        const summary = view.bindings?.find((item) => item.sessionId === sessionId);
        if (!bound || !summary?.projectId) throw new Error("Unknown desktop draft binding.");
        return { projectId: summary.projectId, durableSessionId: bound.durableSessionId, composerKey: sessionId };
    }
    let view: SessionClientView;
    const uncertainties = new Map<string, string>();
    const inFlight = new Set<string>();
    const submissionKey = (wire: string, request: string) => JSON.stringify([wire, request]);
    let recovering = true;
    let restart: Promise<void> | null = null;
    let observingRenderer: Electron.WebContents | null = null;
    function renderer(): Electron.WebContents | null {
        return window &&
            !window.isDestroyed() &&
            observingRenderer === window.webContents &&
            observingRenderer.getURL() === DESKTOP_URL
            ? observingRenderer
            : null;
    }
    const publish = () => renderer()?.send(`${SESSION_CHANNEL}view`, view);
    async function acceptDraft(location: DesktopDraftLocator, requestId: string) {
        const owner = client;
        const bound = owner.getBindingView(location.composerKey);
        await drafts.accepted(location, requestId);
        if (owner !== client) return;
        inFlight.delete(submissionKey(location.composerKey, requestId));
        if (!bound) return;
        const { connectionId, project, sessionId } = bound;
        renderer()?.send(`${DRAFT_CHANNEL}accepted`, { connectionId, project, sessionId }, requestId);
    }
    function connectObservers() {
        const owner = client;
        owner.onSubmission(async ({ phase, submission }) => {
            if (owner !== client) throw new Error("Runtime was replaced.");
            if (phase === "withdrawn") {
                // Keep the prepared record for deliberate receipt lookup; no request reached Core.
                inFlight.delete(submissionKey(submission.wireSessionId, submission.requestId));
                return;
            }
            if (shutdown && phase === "prepared") throw new Error("RunWield is stopping. Input was not sent.");
            const location = locator(submission.wireSessionId);
            if (submission.sessionId) location.durableSessionId = submission.sessionId;
            await drafts.bind(location);
            if (phase === "prepared") {
                await drafts.submit(location, {
                    text: submission.text,
                    images: submission.images,
                    requestId: submission.requestId,
                    expectedGeneration: submission.expectedGeneration,
                    kind: submission.kind,
                });
                inFlight.add(submissionKey(submission.wireSessionId, submission.requestId));
            } else {
                await acceptDraft(location, submission.requestId);
            }
        });
        owner.observe((next) => {
            if (owner !== client) return;
            const notice = uncertainties.get(next.sessionId);
            view = {
                ...next,
                draftNotice: drafts.notice,
                bindings: next.bindings?.map((binding) =>
                    uncertainties.has(binding.sessionId) && binding.phase === "idle"
                        ? { ...binding, phase: "interrupted" }
                        : binding,
                ),
                ...(notice
                    ? { recoveryNotice: notice, phase: next.phase === "idle" ? "interrupted" : next.phase }
                    : {}),
            };
            if (!recovering && view.connection === "ready") {
                const bindings = owner.getBindingViews().map((bound) => locator(bound.sessionId));
                const recoveryNotices: DesktopRecoveryNotice[] = bindings.flatMap((location) => {
                    const message = uncertainties.get(location.composerKey);
                    return message ? [{ ...location, message }] : [];
                });
                void preferences.update({ bindings, recoveryNotices }).catch(console.error);
                for (const location of bindings)
                    if (location.durableSessionId) void drafts.bind(location).catch(console.error);
            }
            publish();
        });
    }
    connectObservers();
    async function restoreBindings() {
        const saved = preferences.read();
        const entries = await drafts.list();
        const locations = new Map(
            [...saved.bindings, ...entries].map((entry) => [
                JSON.stringify([entry.projectId, entry.durableSessionId || entry.composerKey]),
                entry,
            ]),
        );
        const projects = (await client.listProjects()).projects;
        let selectedWire = "";
        for (const previous of locations.values()) {
            if (!projects.some((row) => row.projectId === previous.projectId && row.enabled)) continue;
            try {
                const admitted = await client.openProject({ projectId: previous.projectId });
                let durableId = previous.durableSessionId;
                const savedNotice = saved.recoveryNotices.find(
                    (notice) =>
                        notice.projectId === previous.projectId &&
                        (notice.durableSessionId
                            ? notice.durableSessionId === previous.durableSessionId
                            : notice.composerKey === previous.composerKey),
                );
                let uncertain = Boolean(savedNotice);
                const entry = await drafts.read(previous);
                // Bootstrap receipt discovery precedes create/load. Lookup never creates a Session.
                for (const submitted of entry?.submitted || []) {
                    const resolution = await client.resolveSubmission({
                        context: admitted.context,
                        ...(durableId ? { sessionId: durableId } : {}),
                        requestId: submitted.requestId,
                        kind: submitted.kind,
                        expectedGeneration: submitted.expectedGeneration,
                    });
                    durableId ||= resolution.sessionId || "";
                    if (resolution.status === "accepted") {
                        await drafts.accepted(previous, submitted.requestId);
                        if (!resolution.result || resolution.outcome === "unknown") uncertain = true;
                    } else if (resolution.status === "unknown") uncertain = true;
                }
                if (durableId) await client.load(durableId);
                else await client.create();
                const next = locator(view.sessionId);
                await drafts.restoreBinding(previous, next);
                if (uncertain)
                    uncertainties.set(
                        next.composerKey,
                        "The previous input outcome is uncertain. It was not sent again. Inspect saved history, then use new input for a deliberate continuation.",
                    );
                if (
                    previous.projectId === saved.navigation.selectedProjectId &&
                    [previous.durableSessionId, previous.composerKey].includes(saved.navigation.selectedSessionId)
                )
                    selectedWire = next.composerKey;
                const restored = await drafts.read(next);
                for (const queued of restored?.queued || []) client.queue(view, { ...queued, restored: true });
            } catch (error) {
                console.error(`Desktop recovery: ${error instanceof Error ? error.message : error}`);
            }
        }
        if (selectedWire) {
            const bound = client.getBindingView(selectedWire)!;
            const location = locator(selectedWire);
            await client.openProject({ projectId: location.projectId });
            await client.load(bound.durableSessionId || bound.sessionId);
            await preferences.update({
                navigation: { ...saved.navigation, selectedSessionId: bound.durableSessionId || bound.sessionId },
            });
        } else if (
            !saved.navigation.selectedSessionId &&
            saved.navigation.selectedProjectId &&
            saved.navigation.showSession &&
            projects.some((row) => row.projectId === saved.navigation.selectedProjectId && row.enabled)
        ) {
            try {
                await client.openProject({ projectId: saved.navigation.selectedProjectId });
            } catch {
                await preferences.update({
                    navigation: { ...saved.navigation, selectedProjectId: "", showSession: false },
                });
            }
        } else {
            await preferences.update({
                navigation: { ...saved.navigation, selectedProjectId: "", selectedSessionId: "", showSession: false },
            });
        }
        recovering = false;
        const bindings = client.getBindingViews().map((bound) => locator(bound.sessionId));
        const recoveryNotices: DesktopRecoveryNotice[] = bindings.flatMap((location) => {
            const message = uncertainties.get(location.composerKey);
            return message ? [{ ...location, message }] : [];
        });
        await preferences.update({ bindings, recoveryNotices });
    }
    const restored = restoreBindings().catch((error: Error) => {
        recovering = false;
        console.error(error.message);
    });
    function trusted(event: IpcMainInvokeEvent): void {
        if (
            !window ||
            window.isDestroyed() ||
            event.sender !== window.webContents ||
            !event.senderFrame ||
            event.senderFrame.detached ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame.url !== DESKTOP_URL
        )
            throw new Error("Untrusted desktop sender.");
    }
    let rendererEpoch = 0;
    const attachments = new WeakMap<Electron.WebContents, Promise<void>>();
    function detachRenderer(contents: Electron.WebContents): void {
        attachments.delete(contents);
        if (!window || window.isDestroyed() || window.webContents !== contents) return;
        rendererEpoch++;
        observingRenderer = null;
        client.setRendererAttached(false);
    }
    ipcMain.handle(`${SESSION_CHANNEL}observe`, async (event, payload?: DesktopRequest) => {
        trusted(event);
        if (payload !== undefined) throw new Error("Invalid observation request.");
        const epoch = rendererEpoch;
        let attachment = attachments.get(event.sender);
        if (!attachment) {
            attachment = (async () => {
                await restored;
                if (restart) await restart.catch(console.error);
                await client.reattachViews();
                trusted(event);
                if (rendererEpoch !== epoch) throw new Error("Renderer was detached.");
                observingRenderer = event.sender;
                client.setRendererAttached(true);
            })();
            attachments.set(event.sender, attachment);
        }
        await attachment;
        trusted(event);
        publish();
    });
    function namedBinding(sessionId: string): SessionClientView {
        const bound = client.getBindingView(sessionId);
        if (!bound) throw new Error("Unknown Session binding.");
        return bound;
    }
    for (const operation of ["read", "write", "discard", "editQueued"] as const) {
        ipcMain.handle(`${DRAFT_CHANNEL}${operation}`, async (event, payload: DesktopDraftRequest) => {
            trusted(event);
            validateDraftRequest(operation, payload, namedBinding(payload?.sessionId));
            const location = locator(payload.sessionId);
            await drafts.bind(location);
            if (operation === "write") return drafts.write(location, payload.composer!);
            if (operation === "discard") return drafts.discard(location);
            if (operation === "editQueued") {
                const composer = await drafts.editQueued(location, payload.requestId!);
                client.removeQueued(payload, payload.requestId!);
                return composer;
            }
            const entry = await drafts.read(location);
            // Restore unsent queue intent into its existing owner, never dispatch from the store.
            const restored = [
                ...(entry?.queued || []),
                ...(entry?.submitted || []).filter(
                    (item) =>
                        !inFlight.has(submissionKey(payload.sessionId, item.requestId)) &&
                        item.requestId !== entry?.composer?.requestId &&
                        !entry?.queued.some((draft) => draft.requestId === item.requestId),
                ),
            ];
            for (const draft of restored) {
                client.queue(payload, { ...draft, restored: true });
            }
            return {
                composer: entry?.composer || null,
                submittedRequestIds: entry?.submitted.map((item) => item.requestId) || [],
            };
        });
    }
    for (const operation of ["create", "load", "send", "answer", "cancel", "close"] as const) {
        ipcMain.handle(`${SESSION_CHANNEL}${operation}`, (event, payload: DesktopRequest) => {
            trusted(event);
            validateDesktopRequest(
                operation,
                payload,
                operation === "create" ||
                    operation === "load" ||
                    !payload ||
                    typeof payload !== "object" ||
                    Array.isArray(payload)
                    ? view
                    : namedBinding(payload.sessionId),
            );
            if (shutdown || recovering || restart)
                throw new Error("RunWield is stopping or recovering. Try again after it settles.");
            switch (operation) {
                case "create":
                    return client.create();
                case "load":
                    return client.load(payload.knownId!);
                case "send":
                    return client.send(payload, payload.text!);
                case "answer":
                    return client.answer(payload, payload.answer!);
                case "cancel":
                    return client.cancel(payload);
                case "close":
                    return client.close(payload);
            }
        });
    }
    const readContexts = new Map<string, WorkspaceProjectContext>();
    for (const operation of SAVED_OPERATIONS) {
        ipcMain.handle(`${SAVED_CHANNEL}${operation}`, async (event, payload: SavedDesktopRequest) => {
            trusted(event);
            validateSavedRequest(
                operation,
                payload,
                ["stageConfiguration", "sendImages", "queue", "removeQueued", "command"].includes(operation)
                    ? namedBinding(payload?.sessionId)
                    : view,
                readContexts,
            );
            if (view.connection !== "ready") throw new Error("Wait for the runtime connection.");
            if (
                (shutdown || recovering || restart) &&
                [
                    "command",
                    "sendImages",
                    "queue",
                    "configure",
                    "answer",
                    "stageConfiguration",
                    "archive",
                    "unarchive",
                ].includes(operation)
            )
                throw new Error("RunWield is stopping or recovering. Input was not sent.");
            switch (operation) {
                case "readProject": {
                    const result = await client.readProject({ projectId: payload.projectId! });
                    readContexts.set(result.context.projectId, result.context);
                    return result;
                }
                case "listSessions":
                    return client.listSessions(payload.request!);
                case "history":
                    return client.history(payload.request as WorkspaceHistoryRequest);
                case "snapshot":
                    return client.snapshot(payload.request as WorkspaceSnapshotRequest);
                case "sessionOptions":
                    return client.sessionOptions(payload.context!);
                case "configure":
                    return client.configure(payload.request as WorkspaceConfigureRequest);
                case "archive":
                    return client.archive(payload.request as WorkspaceSessionRequest, payload.confirmed);
                case "unarchive":
                    return client.unarchive(payload.request as WorkspaceSessionRequest);
                case "stageConfiguration":
                    return client.stageConfiguration(payload, payload.selection!);
                case "command":
                    return client.command(payload, payload.text!);
                case "sendImages": {
                    const requestId = payload.requestId || randomUUID();
                    const location = locator(payload.sessionId);
                    await drafts.bind(location);
                    const entry = await drafts.read(location);
                    if (!entry?.composer && !entry?.queued.some((draft) => draft.requestId === requestId))
                        await drafts.write(location, {
                            text: payload.text!,
                            requestId,
                            images: payload.images!.map((image) => ({
                                ...image,
                                id: randomUUID(),
                                name: "Attached image",
                            })),
                        });
                    const priorSubmission = entry?.submitted.find((item) => item.requestId === requestId);
                    if (priorSubmission) {
                        const admitted = await client.readProject({ projectId: location.projectId });
                        const resolution = await client.resolveSubmission({
                            context: admitted.context,
                            ...(location.durableSessionId ? { sessionId: location.durableSessionId } : {}),
                            requestId,
                            kind: priorSubmission.kind,
                            expectedGeneration: priorSubmission.expectedGeneration,
                        });
                        if (resolution.status === "accepted") {
                            await acceptDraft(location, requestId);
                            if (!resolution.result?.ok) {
                                uncertainties.set(
                                    payload.sessionId,
                                    "Core recorded the previous input, but did not confirm a successful outcome. It was not sent again. Inspect saved history before continuing with new input.",
                                );
                                await client.reattachViews();
                            }
                            return;
                        }
                        if (resolution.status !== "no_receipt")
                            throw new Error(
                                "The original input outcome is uncertain. It was not sent again. Use new input for a deliberate continuation.",
                            );
                        return client.submitPrepared({
                            ...priorSubmission,
                            context: admitted.context,
                            wireSessionId: payload.sessionId,
                            sessionId: location.durableSessionId,
                        });
                    }
                    uncertainties.delete(payload.sessionId);
                    const prepared = await client.prepareSubmission(
                        payload,
                        payload.text!,
                        payload.images!,
                        requestId,
                        payload.expectedGeneration,
                    );
                    await client.submitPrepared(prepared);
                    return;
                }
                case "queue": {
                    const epoch = rendererEpoch;
                    const owner = client;
                    const location = locator(payload.sessionId);
                    await drafts.bind(location);
                    await drafts.queue(location, payload.draft!);
                    return owner.queue(payload, {
                        ...payload.draft!,
                        ...(epoch !== rendererEpoch ? { restored: true } : {}),
                    });
                }
                case "removeQueued": {
                    await drafts.accepted(locator(payload.sessionId), payload.requestId!);
                    return client.removeQueued(payload, payload.requestId!);
                }
            }
        });
    }
    for (const operation of [
        "list",
        "open",
        "register",
        "relink",
        "setEnabled",
        "remove",
        "rescan",
        "pick",
        "candidate",
    ] as const) {
        ipcMain.handle(`${PROJECT_CHANNEL}${operation}`, async (event, payload: DesktopProjectRequest) => {
            trusted(event);
            validateProjectRequest(operation, payload, view.connectionId);
            if (view.connection !== "ready") throw new Error("Wait for the runtime connection.");
            const projectRequest = { projectId: payload.projectId! };
            switch (operation) {
                case "list":
                    return client.listProjects();
                case "open":
                    return client.openProject(projectRequest);
                case "register":
                    return client.registerProject({
                        root: payload.root!,
                        ...(payload.displayName ? { displayName: payload.displayName } : {}),
                        ...(payload.directoryConfirmation
                            ? { directoryConfirmation: payload.directoryConfirmation }
                            : {}),
                    });
                case "relink":
                    return client.relinkProject({
                        ...projectRequest,
                        newRoot: payload.newRoot!,
                        ...(payload.displayName ? { displayName: payload.displayName } : {}),
                        ...(payload.directoryConfirmation
                            ? { directoryConfirmation: payload.directoryConfirmation }
                            : {}),
                    });
                case "setEnabled":
                    return client.setProjectEnabled({ ...projectRequest, enabled: payload.enabled! });
                case "remove": {
                    const result = await client.removeProject(projectRequest);
                    await drafts.removeProject(payload.projectId!);
                    return result;
                }
                case "rescan":
                    return client.rescanProject(projectRequest);
                case "candidate":
                    return projectArgument;
                case "pick": {
                    const result = await dialog.showOpenDialog(window!, {
                        title: "Open Project",
                        properties: ["openDirectory"],
                    });
                    return result.canceled ? null : result.filePaths[0] || null;
                }
            }
        });
    }
    ipcMain.handle("desktop:open-link", async (event, href: string) => {
        trusted(event);
        if (typeof href !== "string" || href.length > 2048) throw new Error("Invalid external link.");
        const url = new URL(href);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            throw new Error("Only HTTP and HTTPS links can open in the browser.");
        await shell.openExternal(url.href);
    });

    ipcMain.handle("desktop:flushed-drafts", (event, payload: { requestId: string; error?: string }) => {
        trusted(event);
        if (
            !payload ||
            typeof payload.requestId !== "string" ||
            Object.keys(payload).some((key) => !["requestId", "error"].includes(key)) ||
            (payload.error !== undefined && typeof payload.error !== "string") ||
            payload.requestId !== flushingView?.requestId
        )
            throw new Error("Invalid draft flush acknowledgement.");
        if (payload.error) flushingView.reject(new Error(payload.error));
        else flushingView.resolve();
        flushingView = null;
    });
    async function flushRendererDrafts() {
        if (!window || window.isDestroyed() || !observingRenderer) return;
        await new Promise<void>((resolve, reject) => {
            const requestId = randomUUID();
            flushingView = { requestId, resolve, reject };
            window!.webContents.send("desktop:flush-drafts", requestId);
        });
    }
    ipcMain.handle("desktop:preferences:read", async (event, payload) => {
        trusted(event);
        if (payload !== undefined) throw new Error("Invalid preferences request.");
        await restored;
        if (restart) await restart.catch(console.error);
        trusted(event);
        const { navigation } = preferences.read();
        if (!navigation.selectedProjectId || view.connection !== "ready" || observingRenderer) return navigation;
        const owner = client;
        const projects = await owner.listProjects().catch((error: Error) => {
            console.error("Could not verify the saved Project destination:", error.message);
            return null;
        });
        trusted(event);
        if (
            !projects ||
            owner !== client ||
            projects.projects.some((row) => row.projectId === navigation.selectedProjectId && row.enabled)
        )
            return navigation;
        owner.clearSelection();
        const fallback = { ...navigation, selectedProjectId: "", selectedSessionId: "", showSession: false };
        await preferences.update({ navigation: fallback }).catch(console.error);
        return fallback;
    });
    ipcMain.handle("desktop:preferences:write", async (event, navigation: DesktopNavigation) => {
        trusted(event);
        validateNavigation(navigation);
        if (recovering || restart) return;
        const projects = (await client.listProjects()).projects;
        if (
            navigation.selectedProjectId &&
            !projects.some((row) => row.projectId === navigation.selectedProjectId && row.enabled)
        )
            throw new Error("Unknown or disabled Project preference.");
        if (
            navigation.showSession &&
            navigation.selectedSessionId &&
            !client
                .getBindingViews()
                .some(
                    (bound) =>
                        locator(bound.sessionId).projectId === navigation.selectedProjectId &&
                        [bound.sessionId, bound.durableSessionId].includes(navigation.selectedSessionId),
                )
        )
            throw new Error("Unknown Session preference.");
        await preferences.update({ navigation });
    });
    ipcMain.handle("desktop:restart-runtime", (event, payload) => {
        trusted(event);
        if (payload !== undefined) throw new Error("Invalid runtime restart request.");
        if (shutdown) throw new Error("RunWield is stopping.");
        if (restart) return restart;
        if (view.connection !== "disconnected") throw new Error("The runtime is still connected.");
        restart = (async () => {
            await exited;
            await preferences.flush();
            recovering = true;
            uncertainties.clear();
            inFlight.clear();
            ({ runtime, exited, client } = startRuntime());
            readContexts.clear();
            connectObservers();
            await restoreBindings();
            await client.reattachViews();
            client.setRendererAttached(Boolean(observingRenderer));
        })().finally(() => {
            recovering = false;
            restart = null;
            publish();
        });
        return restart;
    });

    async function ownedWorkMayBeRunning(): Promise<boolean> {
        if (view.connection !== "ready") return true;
        for (const bound of client.getBindingViews()) {
            const location = locator(bound.sessionId);
            const admitted = await client.readProject({ projectId: location.projectId });
            const snapshot = await client.snapshot({
                context: admitted.context,
                sessionId: bound.durableSessionId,
                wireSessionId: bound.sessionId,
            });
            // Retained Background Tasks can outlive an idle turn. Read Core, not the view phase.
            if (!["idle", "uninitialized"].includes(snapshot.state)) return true;
        }
        return false;
    }
    async function stopAndQuit(): Promise<boolean> {
        if (shutdown) {
            await shutdown;
            return settled;
        }
        client.setSubmissionDispatchPaused(true);
        shutdown = (async () => {
            await restored;
            if (restart) await restart;
            await flushRendererDrafts();
            await drafts.flush();
            await preferences.flush();
            const result = await client.drain();
            if (result.status !== "settled")
                throw new Error("Owned work has not settled. RunWield will stay open. Try Stop and quit again.");
            await client.dispose();
            runtime.stdin.end();
            await exited;
            settled = true;
            window?.destroy();
            app.quit();
        })();
        try {
            await shutdown;
            return true;
        } catch (error) {
            console.error(error instanceof Error ? error.message : error);
            dialog.showErrorBox(
                "RunWield is still open",
                error instanceof Error ? error.message : "Settlement could not be confirmed. Try again.",
            );
            return false;
        } finally {
            if (!settled) {
                shutdown = null;
                client.setSubmissionDispatchPaused(false);
            }
        }
    }
    stopDesktopForUpdate = stopAndQuit;
    let quitChoice: Promise<void> | null = null;
    function requestQuit(): void {
        if (quitChoice || shutdown) return;
        quitChoice = (async () => {
            let work = true;
            try {
                work = await ownedWorkMayBeRunning();
            } catch {
                /* Unknown is live. */
            }
            if (work) {
                attachWindow();
                const options: Electron.MessageBoxOptions = {
                    type: "question",
                    title: "Stop work and quit RunWield?",
                    message: "RunWield may still own running work.",
                    detail: "Stay open leaves work unchanged. Stop and quit waits for Core to confirm that owned work has settled.",
                    buttons: ["Stay open", "Stop and quit"],
                    defaultId: 0,
                    cancelId: 0,
                    noLink: true,
                };
                const choice = window
                    ? await dialog.showMessageBox(window, options)
                    : await dialog.showMessageBox(options);
                if (choice.response !== 1) return;
            }
            await stopAndQuit();
        })().finally(() => {
            quitChoice = null;
        });
    }
    const newSession = () => {
        attachWindow();
        const contents = window?.webContents;
        if (!contents) return;
        if (contents.isLoadingMainFrame() || contents.getURL() !== DESKTOP_URL)
            contents.once("did-finish-load", () => contents.send("desktop:new-session"));
        else contents.send("desktop:new-session");
    };
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            ...(process.platform === "darwin"
                ? [
                      {
                          label: "RunWield",
                          submenu: [
                              { role: "about" as const },
                              { type: "separator" as const },
                              { role: "hide" as const },
                              { role: "hideOthers" as const },
                              { role: "unhide" as const },
                              { type: "separator" as const },
                              { label: "Quit RunWield", accelerator: "CmdOrCtrl+Q", click: requestQuit },
                          ],
                      },
                  ]
                : []),
            {
                label: "File",
                submenu: [
                    { label: "New Session", accelerator: "CmdOrCtrl+N", click: newSession },
                    { role: "close" },
                    ...(process.platform === "darwin"
                        ? []
                        : [{ label: "Quit", accelerator: "CmdOrCtrl+Q", click: requestQuit }]),
                ],
            },
            { role: "editMenu" },
            { role: "windowMenu" },
        ]),
    );
    app.on("before-quit", (event) => {
        if (!settled) {
            event.preventDefault();
            requestQuit();
        }
    });
    process.on("SIGINT", requestQuit);
    process.on("SIGTERM", requestQuit);
    ready = true;
    attachWindow();
}
