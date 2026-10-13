import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    rm as fsRm,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
// A disposable module layout tests the real Workspace server with both entry paths.
// The synthetic entries count module evaluations; no loader or importer is injected.
import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl, pathToFileURL as toFileUrl } from "node:url";

const sourceRoot = dirname(dirname(fromFileUrl(import.meta.url)));
const root = await fsMkdtemp(join(tmpdir(), "workspace-renderer-probe-"));
const marker = '"key":';

async function mirror(relative: string, excluded: string[]): Promise<void> {
    const source = join(sourceRoot, relative);
    const target = join(root, relative);
    await fsMkdir(target, { recursive: true });
    for await (const entry of await fsReaddir(source, { withFileTypes: true })) {
        if (excluded.includes(entry.name)) continue;
        await fsSymlink(join(source, entry.name), join(target, entry.name));
    }
}

async function entry(path: string, name: string): Promise<void> {
    await fsMkdir(dirname(path), { recursive: true });
    await fsWriteFile(
        path,
        `// ${marker}\nglobalThis.__rendererProbe ??= {};\nglobalThis.__rendererProbe.${name} = (globalThis.__rendererProbe.${name} || 0) + 1;\nexport const handle = async (request) => new Response('<h1>${name} ' + new URL(request.url).searchParams.get('page') + '</h1>', { headers: { 'content-type': 'text/html' } });\n`,
    );
}

try {
    await mirror("", ["runtime-root.js", "src", "dist"]);
    await fsCopyFile(join(sourceRoot, "runtime-root.js"), join(root, "runtime-root.js"));
    await mirror("src", ["ui"]);
    await mirror("src/ui", ["workspace"]);
    await mirror("src/ui/workspace", ["server.js"]);
    await fsCopyFile(join(sourceRoot, "src/ui/workspace/server.js"), join(root, "src/ui/workspace/server.js"));
    const source = join(
        root,
        process.versions.bun ? "dist/workspace-bun/server/entry.mjs" : "dist/workspace/server/entry.mjs",
    );
    const runtime = join(root, "dist/workspace-runtime/server.mjs");
    if (process.argv.slice(2)[0] !== "missing") await entry(source, "source");
    await entry(runtime, "runtime");
    const { createWorkspaceApp } = await import(toFileUrl(join(root, "src/ui/workspace/server.js")).href);
    const handler = createWorkspaceApp({ cwd: root, token: "secret" }).handler();
    const page = async (value: string): Promise<string> => {
        const response = await handler(new Request(`http://localhost/?token=secret&page=${value}`));
        return `${response.status}:${await response.text()}`;
    };
    if (process.argv.slice(2)[0] === "missing") {
        // No valid entry on the first attempt; the next request may retry.
        await fsRm(runtime);
        if (!(await page("before")).startsWith("503:")) throw new Error("Missing entry did not fail");
        await entry(source, "source");
    }
    if (process.argv.slice(2)[0] === "fallback") {
        await fsWriteFile(source, "// no importable marker");
    }
    if (process.argv.slice(2)[0] === "evaluation-failure") {
        for (const path of [source, runtime]) {
            await fsWriteFile(path, `// ${marker}\nthrow new Error('Renderer evaluation failed');`);
        }
        const response = await page("broken");
        if (!response.startsWith("503:") || !response.includes("restart")) {
            throw new Error(`Evaluation failure did not require restart: ${response}`);
        }
        console.log(JSON.stringify({ mode: process.argv.slice(2)[0], response }));
    } else {
        if (process.argv.slice(2)[0] === "disabled") {
            process.env["WLD_WORKSPACE_DISABLE_BUILT_SERVER"] = "1";
            if (!(await page("disabled")).startsWith("503:")) throw new Error("Disabled renderer did not fail");
            delete process.env["WLD_WORKSPACE_DISABLE_BUILT_SERVER"];
        }
        const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => page(String(index))));
        const expected = process.argv.slice(2)[0] === "fallback" ? "runtime" : "source";
        for (const [index, response] of responses.entries()) {
            if (!response.includes(`<h1>${expected} ${index}</h1>`)) throw new Error(`Wrong response: ${response}`);
        }
        const count = Reflect.get(globalThis, "__rendererProbe") as Record<string, number>;
        if (count?.[expected] !== 1 || count[expected === "source" ? "runtime" : "source"]) {
            throw new Error(`Entry initialized more than once or wrong entry selected: ${JSON.stringify(count)}`);
        }
        console.log(JSON.stringify({ mode: process.argv.slice(2)[0], count, responses: responses.length }));
    }
} finally {
    await fsRm(root, { recursive: true });
}
