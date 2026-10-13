import { spawn } from "node:child_process";
import { watch } from "node:fs/promises";
import process from "node:process";
import { waitForScriptExit } from "./script-process.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { stagePublicDocs } from "./public-docs.ts";

const projectRoot = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const output = join(projectRoot, "docs-site", "src", "content", "docs");

await stagePublicDocs(projectRoot, output);

const server = spawn(
    process.execPath,
    [
        join(projectRoot, "docs-site", "node_modules", "astro", "bin", "astro.mjs"),
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "4322",
    ],
    {
        cwd: join(projectRoot, "docs-site"),
        stdio: "inherit",
    },
);
const status = waitForScriptExit(server);

type Timer = ReturnType<typeof setTimeout>;
let timer: Timer | undefined;
const controller = new AbortController();

async function watchSources(path: string): Promise<void> {
    for await (const event of watch(path, { recursive: true, signal: controller.signal })) {
        if (event.filename && !event.filename.endsWith(".md") && !event.filename.endsWith("release.json")) continue;
        clearTimeout(timer);
        timer = setTimeout(async () => {
            try {
                await stagePublicDocs(projectRoot, output);
                console.log("Restaged public documentation source");
            } catch (error) {
                console.error(error);
            }
        }, 75);
    }
}

const stop = () => {
    clearTimeout(timer);
    controller.abort();
    server.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
    await Promise.race([
        status,
        ...[join(projectRoot, "docs"), join(projectRoot, "docs-site", "release.json")].map(async (path) => {
            try {
                await watchSources(path);
            } catch (error) {
                if (!controller.signal.aborted) throw error;
            }
        }),
    ]);
} finally {
    stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await status;
}
