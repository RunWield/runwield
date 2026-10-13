import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals } from "../src/testing/assertions.ts";
import { buildWorkspaceRuntime } from "./build-workspace-runtime.js";
import { buildPlanServerRuntime } from "./build-plan-server-runtime.js";
import { captureScriptProcess } from "./script-process.ts";

async function run(command: string, args: string[]): Promise<void> {
    const result = await captureScriptProcess(command, { args, signal: AbortSignal.timeout(30_000) });
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
}

test("Bun remote runtime bundles execute after their source tree is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "wld-bun-remote-runtime-"));
    const source = join(root, "source");
    const clientDir = join(source, "client");
    const serverEntry = join(source, "workspace.mjs");
    const remoteEntry = join(source, "remote.ts");
    const workspaceRuntimeDir = join(root, "workspace-runtime");
    const runtimeDir = join(root, "relocated");
    try {
        await mkdir(clientDir, { recursive: true });
        await writeFile(join(source, "label.ts"), 'export const label: string = "bundled";\n');
        await writeFile(
            serverEntry,
            'import { label } from "./label.ts"; import { Database } from "bun:sqlite"; const db = new Database(":memory:"); console.log(db.query("SELECT ? AS value").get(label).value + ":workspace"); db.close();\n',
        );
        await writeFile(
            remoteEntry,
            'import { label } from "./label.ts"; import { Database } from "bun:sqlite"; const db = new Database(":memory:"); console.log(db.query("SELECT ? AS value").get(label).value + ":remote"); db.close();\n',
        );
        await writeFile(join(clientDir, "client.js"), 'console.log("browser");\n');
        await buildWorkspaceRuntime({ serverEntry, clientDir, runtimeDir: workspaceRuntimeDir }, { run });
        await buildPlanServerRuntime({ remoteEntry, workspaceRuntimeDir, runtimeDir, assetCopies: [] }, { run });
        await rm(source, { recursive: true });
        await rm(workspaceRuntimeDir, { recursive: true });

        for (const [entry, expected] of [
            ["remote-server.js", "bundled:remote\n"],
            ["dist/workspace-runtime/server.mjs", "bundled:workspace\n"],
        ]) {
            const result = await captureScriptProcess(process.execPath, {
                args: [join(runtimeDir, entry)],
                cwd: runtimeDir,
                signal: AbortSignal.timeout(10_000),
            });
            assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
            assertEquals(new TextDecoder().decode(result.stdout), expected);
        }
        assertEquals(
            await readFile(join(runtimeDir, "dist/workspace-runtime/client/client.js.asset"), "utf8"),
            'console.log("browser");\n',
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
