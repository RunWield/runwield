import { assertEquals } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { test } from "node:test";
import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { makeValidationProjectRoot } from "../../shared/workflow/validation-test-helpers.js";

test("Astro dev serves local and owner Plan Boards with canonical Plan data", async () => {
    const projectRoot = await makeValidationProjectRoot("dev-import-regression", {
        status: "draft",
        summary: "Canonical development import fixture",
    });
    const scratch = await fsMkdtemp(join(tmpdir(), "workspace-astro-dev-test-"));
    const repoRoot = new URL("../../../", import.meta.url);
    const script = `
        import { dev } from ${JSON.stringify(new URL("node_modules/astro/dist/core/index.js", repoRoot).href)};
        import { assertEquals, assertStringIncludes } from ${JSON.stringify(import.meta.resolve("../../testing/assertions.ts"))};
        const server = await dev({
            root: ${JSON.stringify(fileURLToPath(new URL("src/ui/workspace/", repoRoot)))},
            configFile: "astro.config.mjs",
            cacheDir: ${JSON.stringify(`${scratch}/astro`)},
            server: { host: "127.0.0.1", port: 0, open: false },
            vite: { cacheDir: ${JSON.stringify(`${scratch}/vite`)} },
            logLevel: "error",
        });
        try {
            for (const route of ["/", "/projects/dev-project/plans"]) {
                const response = await fetch(\`http://127.0.0.1:\${server.address.port}\${route}\`);
                const html = await response.text();
                assertEquals(response.status, 200, route + "\\n" + html.slice(0, 3000));
                assertStringIncludes(html, "dev-import-regression", route);
            }
        } finally {
            await server.stop();
        }
    `;
    try {
        const output = await captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs(["eval", "--config", fileURLToPath(new URL("deno.json", repoRoot)), script]),
            cwd: projectRoot,
            env: { ASTRO_TELEMETRY_DISABLED: "1" },
            signal: AbortSignal.timeout(120_000),
        });
        const decoder = new TextDecoder();
        assertEquals(output.success, true, decoder.decode(output.stdout) + decoder.decode(output.stderr));
    } finally {
        await fsRm(projectRoot, { recursive: true });
        await fsRm(scratch, { recursive: true });
    }
});

test("Astro dev reads remote mode from Bun's environment for Shared Space pages", async () => {
    const scratch = await fsMkdtemp(join(tmpdir(), "workspace-remote-dev-test-"));
    const repoRoot = new URL("../../../", import.meta.url);
    const script = `
        import process from "node:process";
        import { dev } from ${JSON.stringify(new URL("node_modules/astro/dist/core/index.js", repoRoot).href)};
        import { assertEquals, assertStringIncludes } from ${JSON.stringify(import.meta.resolve("../../testing/assertions.ts"))};
        const server = await dev({
            root: ${JSON.stringify(fileURLToPath(new URL("src/ui/workspace/", repoRoot)))},
            configFile: "astro.config.mjs",
            cacheDir: ${JSON.stringify(`${scratch}/astro`)},
            server: { host: "127.0.0.1", port: 0, open: false },
            vite: { cacheDir: ${JSON.stringify(`${scratch}/vite`)} },
            logLevel: "error",
        });
        try {
            const url = \`http://127.0.0.1:\${server.address.port}/p/audit-space\`;
            const remote = await fetch(url);
            const html = await remote.text();
            assertEquals(remote.status, 200, html.slice(0, 3000));
            assertStringIncludes(html, "Remote Plan Review");
            process.env.RUNWIELD_WORKSPACE_MODE = "local";
            const local = await fetch(url);
            await local.text();
            assertEquals(local.status, 404);
            delete process.env.RUNWIELD_WORKSPACE_MODE;
            const unset = await fetch(url);
            await unset.text();
            assertEquals(unset.status, 404);
        } finally {
            await server.stop();
        }
    `;
    try {
        const output = await captureForegroundProcess(process.execPath, {
            args: ["--no-install", "--eval", script],
            cwd: fileURLToPath(repoRoot),
            env: { ASTRO_TELEMETRY_DISABLED: "1", RUNWIELD_WORKSPACE_MODE: "remote" },
            signal: AbortSignal.timeout(120_000),
        });
        const decoder = new TextDecoder();
        assertEquals(output.success, true, decoder.decode(output.stdout) + decoder.decode(output.stderr));
    } finally {
        await fsRm(scratch, { recursive: true });
    }
});
