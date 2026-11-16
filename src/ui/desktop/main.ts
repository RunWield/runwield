import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AcpWorkspaceSessionClient } from "../../acp/client/workspace-session-client.ts";
import type { SessionClientView } from "../workspace/client/session-client.ts";
import { DESKTOP_URL, SESSION_CHANNEL, validateDesktopRequest } from "./bridge.ts";
import { PROJECT_CHANNEL, validateProjectRequest, type DesktopProjectRequest } from "./bridge.ts";
import type { DesktopRequest } from "./bridge.ts";
import { DARK_BROWSER_THEME } from "../design-system/themes/dark.ts";

function argument(name: string): string {
    const index = process.argv.indexOf(name);
    return index < 0 ? "" : process.argv[index + 1] || "";
}
const projectArgument = argument("--project");
const bun = argument("--bun");
const cli = argument("--cli");
if (![bun, cli].every((path) => isAbsolute(path)) || (projectArgument && !isAbsolute(projectArgument)))
    throw new Error("Use desktop:dev with the source runtime launcher and an optional absolute Project candidate.");
const inspector = argument("--cdp-port");
if (inspector) {
    if (!/^\d+$/.test(inspector) || Number(inspector) < 1024 || Number(inspector) > 65535)
        throw new Error("Use a development inspection port between 1024 and 65535.");
    app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
    app.commandLine.appendSwitch("remote-debugging-port", inspector);
}
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
    { scheme: "runwield", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
async function startDesktop(): Promise<void> {
    const project = "";
    await access(bun);
    await access(cli);
    await app.whenReady();
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
    const window = new BrowserWindow({
        title: "RunWield",
        show: !process.argv.includes("--hidden"),
        width: 1440,
        height: 900,
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
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());

    const runtime = spawn(bun, [cli, "acp"], {
        cwd: resolve(cli, "../.."),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    console.info(`[desktop] runtime PID ${runtime.pid}; Project ${project}`);
    let stderr = "";
    runtime.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-16000);
        process.stderr.write(chunk);
    });
    runtime.on("error", (error) => console.error(`Runtime launch failed: ${error.message}`));
    let exitError = "";
    const exited = new Promise<void>((resolveExit) =>
        runtime.once("close", (code, signal) => {
            if (code !== 0) {
                exitError = `Runtime exited with ${signal || code}. ${stderr}`;
                console.error(exitError);
            }
            resolveExit();
        }),
    );
    const client = new AcpWorkspaceSessionClient({
        connectionId: randomUUID(),
        project,
        workspaceAdmission: true,
        input: Readable.toWeb(runtime.stdout),
        output: Writable.toWeb(runtime.stdin),
    });
    let view: SessionClientView;
    const publish = () => {
        if (!window.isDestroyed() && window.webContents.getURL() === DESKTOP_URL)
            window.webContents.send(`${SESSION_CHANNEL}view`, view);
    };
    client.observe((next) => {
        view = next;
        publish();
    });
    function trusted(event: IpcMainInvokeEvent): void {
        if (
            window.isDestroyed() ||
            event.sender !== window.webContents ||
            !event.senderFrame ||
            event.senderFrame.detached ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame.url !== DESKTOP_URL
        )
            throw new Error("Untrusted desktop sender.");
    }
    ipcMain.handle(`${SESSION_CHANNEL}observe`, (event, payload?: DesktopRequest) => {
        trusted(event);
        if (payload !== undefined) throw new Error("Invalid observation request.");
        publish();
    });
    for (const operation of ["create", "load", "send", "answer", "cancel", "close"] as const) {
        ipcMain.handle(`${SESSION_CHANNEL}${operation}`, (event, payload: DesktopRequest) => {
            trusted(event);
            validateDesktopRequest(operation, payload, view);
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
                case "remove":
                    return client.removeProject(projectRequest);
                case "rescan":
                    return client.rescanProject(projectRequest);
                case "candidate":
                    return projectArgument;
                case "pick": {
                    const result = await dialog.showOpenDialog(window, {
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

    let settled = false;
    let shutdown: Promise<void> | null = null;
    function closeApplication(): void {
        if (shutdown) return;
        shutdown = (async () => {
            const wasConnected = view.connection === "ready";
            let timer: ReturnType<typeof setTimeout>;
            try {
                await Promise.race([
                    (async () => {
                        await client.dispose();
                        runtime.stdin.end();
                        await exited;
                        if (wasConnected && exitError) throw new Error(exitError);
                    })(),
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        "The runtime did not settle and exit. Keep this window open and retry closing.",
                                    ),
                                ),
                            10000,
                        );
                    }),
                ]);
            } finally {
                clearTimeout(timer!);
            }
            settled = true;
            window.destroy();
            app.quit();
        })().catch((error: Error) => {
            shutdown = null;
            console.error(error.message);
            dialog.showErrorBox("Could not close the Session", error.message);
        });
    }
    window.on("close", (event) => {
        if (!settled) {
            event.preventDefault();
            closeApplication();
        }
    });
    app.on("before-quit", (event) => {
        if (!settled) {
            event.preventDefault();
            closeApplication();
        }
    });
    process.on("SIGINT", closeApplication);
    process.on("SIGTERM", closeApplication);
    await window.loadURL(DESKTOP_URL);
}
// Do not top-level await startup: Electron waits for ESM evaluation before emitting ready.
void startDesktop().catch((error: Error) => {
    console.error(error);
    app.exit(1);
});
