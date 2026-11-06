import process from "node:process";
import { captureScriptProcess } from "./script-process.ts";
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
import { buildWorkspaceRuntime } from "./build-workspace-runtime.ts";

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
    let delayedWrite: Promise<void> | undefined;
    try {
        await fsWriteFile(serverEntry, 'export const manifest = "@@ASTRO_MANIFEST_REPLACE@@";\n');
        await fsMkdir(clientDir);
        delayedWrite = new Promise<void>((resolve, reject) => {
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

for (const initialClientState of ["existing", "absent"]) {
    test(`runtime packages late client assets when the client directory is ${initialClientState}`, async () => {
        const root = await fsMkdtemp(join(tmpdir(), "wld-runtime-late-assets-"));
        const serverEntry = join(root, "entry.mjs");
        const clientDir = join(root, "client");
        const runtimeDir = join(root, "runtime");
        let producer: Promise<void> | undefined;
        try {
            await fsWriteFile(serverEntry, "export default true;");
            if (initialClientState === "existing") await fsMkdir(clientDir);
            await buildWorkspaceRuntime(
                { serverEntry, clientDir, runtimeDir },
                {
                    run: async () => {
                        await fsWriteFile(join(runtimeDir, "server.mjs"), "export default true;");
                        producer = new Promise<void>((resolve, reject) => {
                            setTimeout(() => {
                                fsMkdir(clientDir, { recursive: true })
                                    .then(() => fsWriteFile(join(clientDir, "late.css"), ".late{display:block}"))
                                    .then(resolve, reject);
                            }, 120);
                        });
                    },
                },
            );
            assertEquals(await fsReadFile(join(runtimeDir, "client/late.css"), "utf8"), ".late{display:block}");
        } finally {
            await producer;
            await fsRm(root, { recursive: true, force: true });
        }
    });
}

async function withCompiledOutput(source: string, check: (path: string) => Promise<void>) {
    const root = await fsMkdtemp(join(tmpdir(), "workspace-compiled-contract-"));
    const serverEntry = join(root, "entry.mjs");
    const clientDir = join(root, "client");
    const runtimeDir = join(root, "runtime");
    try {
        await fsWriteFile(serverEntry, "export default true;");
        await fsMkdir(clientDir);
        await buildWorkspaceRuntime(
            { serverEntry, clientDir, runtimeDir },
            {
                run: () => fsWriteFile(join(runtimeDir, "server.mjs"), source),
            },
        );
        await check(join(runtimeDir, "server.mjs"));
    } finally {
        await fsRm(root, { recursive: true, force: true });
    }
}

test("packaged compiler shims execute real child processes without dynamic require support", async () => {
    await withCompiledOutput(
        `
        function Ut() { throw new Error("Dynamic require is unavailable in compiled executables"); }
        var childProcess=Ut("node:child_process");import{spawn as sp,spawnSync as ss}from"node:child_process";
        const child = childProcess.spawnSync(process.execPath, ["-e", "process.stdout.write('child ran')"]);
        if (child.status !== 0) throw new Error(String(child.stderr));
        process.stdout.write(child.stdout);
    `,
        async (path) => {
            const result = await captureScriptProcess(process.execPath, { args: [path] });
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
            assertEquals(new TextDecoder().decode(result.stdout), "child ran");
        },
    );
});

test("packaged renderer channels allow the standalone process to exit after rendering", async () => {
    await withCompiledOutput(
        `
        const scheduler = new MessageChannel;
        scheduler.port1.onmessage = () => {};
        // Model a renderer/runtime that references its scheduling ports on setup.
        scheduler.port1.ref();
        scheduler.port2.ref();
        console.log("rendered");
    `,
        async (path) => {
            const result = await captureScriptProcess(process.execPath, {
                args: [path],
                signal: AbortSignal.timeout(3000),
            });
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
            assertEquals(new TextDecoder().decode(result.stdout).trim(), "rendered");
        },
    );
});

test("runtime build waits for real executable chunks while ignoring type-only imports", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "workspace-chunk-contract-"));
    const serverEntry = join(root, "entry.mjs");
    const clientDir = join(root, "client");
    const runtimeDir = join(root, "runtime");
    let producer: Promise<void> | undefined;
    try {
        await fsWriteFile(
            serverEntry,
            `
import { route } from "./route.mjs";
import "./setup.mjs";
const page = await import("./page.mjs");
/** @type {import("./absent-types.js").GeneratedType} */
const typed = route;
console.log(typed + page.title);
`,
        );
        await fsMkdir(clientDir);
        for (const name of ["client.js", "worker.mjs", "styles.css", "sprite.png"]) {
            await fsWriteFile(join(clientDir, name), `asset:${name}`);
        }
        producer = new Promise((resolve, reject) => {
            setTimeout(
                () =>
                    Promise.all([
                        fsWriteFile(join(root, "route.mjs"), 'export const route = "ready:";'),
                        fsWriteFile(join(root, "setup.mjs"), "export const ready = true;"),
                        fsWriteFile(join(root, "page.mjs"), 'export const title = "page";'),
                    ]).then(() => resolve(), reject),
                120,
            );
        });
        await buildWorkspaceRuntime(
            { serverEntry, clientDir, runtimeDir },
            {
                run: async (command, args) => {
                    const built = await captureScriptProcess(command, { args });
                    assertEquals(built.code, 0, new TextDecoder().decode(built.stderr));
                },
            },
        );
        const result = await captureScriptProcess(process.execPath, { args: [join(runtimeDir, "server.mjs")] });
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        assertEquals(new TextDecoder().decode(result.stdout).trim(), "ready:page");
        for (const [original, stored] of [
            ["client.js", "client.js.asset"],
            ["worker.mjs", "worker.mjs.asset"],
            ["styles.css", "styles.css"],
            ["sprite.png", "sprite.png"],
        ]) {
            assertEquals(await fsReadFile(join(runtimeDir, "client", stored), "utf8"), `asset:${original}`);
        }
    } finally {
        await producer;
        await fsRm(root, { recursive: true, force: true });
    }
});
