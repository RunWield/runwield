import { assertEquals } from "../src/testing/assertions.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import {
    buildWorkspaceRuntime,
    getOpaqueWorkspaceAssetName,
    getServerEntryImportPaths,
    normalizeCompiledNodeChildProcessImports,
    unrefBundledMessageChannels,
    waitForStableWorkspaceClientAssets,
} from "./build-workspace-runtime.js";

test("getOpaqueWorkspaceAssetName hides executable browser modules from compile graph tracing", () => {
    assertEquals(getOpaqueWorkspaceAssetName("client.js"), "client.js.asset");
    assertEquals(getOpaqueWorkspaceAssetName("worker.mjs"), "worker.mjs.asset");
    assertEquals(getOpaqueWorkspaceAssetName("styles.css"), "styles.css");
    assertEquals(getOpaqueWorkspaceAssetName("sprite.png"), "sprite.png");
});

test("getServerEntryImportPaths ignores JSDoc type imports", () => {
    const source = `
import { route } from "./chunks/route.mjs";
import "./chunks/setup.mjs";
const page = () => import("./chunks/page.mjs");
/** @type {import("./types.js").GeneratedType} */
const typed = route;
`;

    assertEquals(getServerEntryImportPaths(source, "dist/workspace/server"), [
        join("dist", "workspace", "server", "chunks", "route.mjs"),
        join("dist", "workspace", "server", "chunks", "setup.mjs"),
        join("dist", "workspace", "server", "chunks", "page.mjs"),
    ]);
});

test("waitForStableWorkspaceClientAssets waits for delayed generated files", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-workspace-client-assets-"));
    try {
        await fsWriteFile(join(root, "first.css"), "a{}");
        const delayedWrite = new Promise((resolve, reject) => {
            setTimeout(() => fsWriteFile(join(root, "second.css"), "b{}").then(resolve, reject), 120);
        });
        await waitForStableWorkspaceClientAssets(root, { intervalMs: 50, timeoutMs: 1000 });
        await delayedWrite;

        assertEquals(await fsReadFile(join(root, "second.css"), "utf8"), "b{}");
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("waitForStableWorkspaceClientAssets waits for delayed client directory creation", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-workspace-client-parent-"));
    const clientDir = join(root, "client");
    try {
        const delayedCreate = new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    await fsMkdir(clientDir);
                    await fsWriteFile(join(clientDir, "entry.css"), "a{}");
                    resolve(undefined);
                } catch (error) {
                    reject(error);
                }
            }, 20);
        });
        await waitForStableWorkspaceClientAssets(clientDir, { intervalMs: 50, timeoutMs: 1000 });
        await delayedCreate;

        assertEquals(await fsReadFile(join(clientDir, "entry.css"), "utf8"), "a{}");
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("normalizeCompiledNodeChildProcessImports replaces dynamic child_process requires", () => {
    const source =
        'var a=Ut("node:child_process");import{spawn as sp,spawnSync as ss}from"node:child_process";var b=Ut("node:child_process");';

    assertEquals(
        normalizeCompiledNodeChildProcessImports(source),
        'var a=({exec:__rwNodeChildProcessExec,spawn:sp,spawnSync:ss});import{exec as __rwNodeChildProcessExec,spawn as sp,spawnSync as ss}from"node:child_process";var b=({exec:__rwNodeChildProcessExec,spawn:sp,spawnSync:ss});',
    );
});

test("standalone Workspace bundle omits runner environment without changing build flags", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-workspace-build-env-"));
    const serverEntry = join(root, "entry.mjs");
    const clientDir = join(root, "client");
    const runtimeDir = join(root, "runtime");
    const serverOutput = join(runtimeDir, "server.mjs");
    const flags = '{ASSETS_PREFIX:void 0,BASE_URL:"/",DEV:!1,MODE:"production",PROD:!0,SITE:void 0,SSR:!0}';
    const snapshot = `Object.assign(${flags},{PATH:\"/runner/bin\",TOKEN:\"private-{build}-value\"})`;
    try {
        await fsWriteFile(serverEntry, "export default true;\n");
        await fsMkdir(clientDir);
        await fsWriteFile(join(clientDir, "client.css"), "body{}\n");
        await buildWorkspaceRuntime(
            { serverEntry, clientDir, runtimeDir },
            {
                run: () => fsWriteFile(serverOutput, `const mode=${snapshot}?.PROD;\n`),
            },
        );
        assertEquals(await fsReadFile(serverOutput, "utf8"), `const mode=Object.assign(${flags},{})?.PROD;\n`);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("standalone Workspace bundle waits for Astro to replace its manifest placeholder", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-workspace-manifest-"));
    const serverEntry = join(root, "entry.mjs");
    const clientDir = join(root, "client");
    const runtimeDir = join(root, "runtime");
    const finalized = 'export const manifest = { key: "ready" };\n';
    let delayedWrite;
    try {
        await fsWriteFile(serverEntry, 'export const manifest = "@@ASTRO_MANIFEST_REPLACE@@";\n');
        await fsMkdir(clientDir);
        delayedWrite = new Promise((resolve, reject) => {
            setTimeout(() => fsWriteFile(serverEntry, finalized).then(resolve, reject), 120);
        });
        await buildWorkspaceRuntime(
            { serverEntry, clientDir, runtimeDir },
            {
                run: async () => fsWriteFile(join(runtimeDir, "server.mjs"), await fsReadFile(serverEntry, "utf8")),
            },
        );
        assertEquals(await fsReadFile(join(runtimeDir, "server.mjs"), "utf8"), finalized);
    } finally {
        await delayedWrite;
        await fsRm(root, { recursive: true });
    }
});

test("standalone Workspace runtime is identical across manifest asset discovery orders", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "wld-workspace-asset-order-"));
    const serverEntry = join(root, "entry.mjs");
    const clientDir = join(root, "client");
    const runtimeDir = join(root, "runtime");
    const serverOutput = join(runtimeDir, "server.mjs");
    const sources = [
        'const manifest={inlinedScripts:["second","first"],assets:["/workspace.css","/_astro/client.js","/pwa/icon.png"],buildFormat:"directory"};',
        'const manifest={inlinedScripts:["second","first"],assets:["/pwa/icon.png","/workspace.css","/_astro/client.js"],buildFormat:"directory"};',
    ];
    const expected =
        'const manifest={inlinedScripts:["second","first"],assets:["/_astro/client.js","/pwa/icon.png","/workspace.css"],buildFormat:"directory"};';
    try {
        await fsWriteFile(serverEntry, "export default true;\n");
        await fsMkdir(clientDir);
        await fsWriteFile(join(clientDir, "client.js"), "export default true;\n");
        for (const source of sources) {
            await buildWorkspaceRuntime(
                { serverEntry, clientDir, runtimeDir },
                {
                    run: () => fsWriteFile(serverOutput, source),
                },
            );
            assertEquals(await fsReadFile(serverOutput, "utf8"), expected);
            assertEquals(
                await fsReadFile(join(runtimeDir, "client/client.js.asset"), "utf8"),
                "export default true;\n",
            );
        }
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("unrefBundledMessageChannels prevents renderer ports from keeping the executable alive", () => {
    assertEquals(
        unrefBundledMessageChannels("const scheduler = new MessageChannel;"),
        "class __RunWieldUnrefedMessageChannel extends MessageChannel{constructor(){super();this.port1.unref();this.port2.unref();queueMicrotask(()=>{this.port1.unref();this.port2.unref()})}}\n" +
            "const scheduler = new __RunWieldUnrefedMessageChannel;",
    );
    assertEquals(
        unrefBundledMessageChannels("const scheduler=new MessageChannel;scheduler.port1.onmessage=run;"),
        "class __RunWieldUnrefedMessageChannel extends MessageChannel{constructor(){super();this.port1.unref();this.port2.unref();queueMicrotask(()=>{this.port1.unref();this.port2.unref()})}}\n" +
            "const scheduler=new __RunWieldUnrefedMessageChannel;scheduler.port1.onmessage=run;",
    );
    assertEquals(unrefBundledMessageChannels("const scheduler = null;"), "const scheduler = null;");
});
