import { serveHttp } from "../src/shared/http-server.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import { join } from "node:path";
import {
    assertExtractedBundledAgentReferenceFiles,
    parseReleaseCheckOptions,
    runReleaseCheck,
    smokeTestBundledAgentReferenceExtraction,
    smokeTestBinaryPlansUiSurface,
    smokeTestBinaryReviewSurface,
} from "./release-check.ts";
import { captureScriptProcess } from "./script-process.ts";
import { fileURLToPath } from "node:url";
import { runtimeSourceArgs } from "../src/testing/runtime-source-args.ts";

type VersionProjectCheck = (root: string) => Promise<void>;
const realSmokeChecks = {
    smokeTestBundledAgentReferenceExtraction,
    smokeTestBinaryPlansUiSurface,
    smokeTestBinaryReviewSurface,
};
async function withTemporaryVersionProject(fn: VersionProjectCheck) {
    const root = await fsMkdtemp(join(tmpdir(), "wld-release-check-project-"));
    try {
        await fsMkdir(join(root, "src", "shared"), { recursive: true });
        await fsWriteFile(join(root, "src", "shared", "version.js"), 'export const VERSION = "original";\n');
        await fsWriteFile(join(root, ".bun-version"), "1.4.3\n");
        await fn(root);
    } finally {
        await fsRm(root, { recursive: true });
    }
}

test("runReleaseCheck short-circuits after compile failure and restores generated version", async () => {
    await withTemporaryVersionProject(async (root) => {
        const stages: string[] = [];
        await assertRejects(
            () =>
                runReleaseCheck(
                    {
                        buildVersion: "v1.2.3",
                        rootDir: root,
                    },
                    {
                        makeTempDir: () => Promise.resolve(root),
                        remove: () => Promise.resolve(),
                        async run(command) {
                            stages.push(command === "bun" ? "compile" : "version");
                            await fsWriteFile(
                                join(root, "src", "shared", "version.js"),
                                'export const VERSION = "failed";\n',
                            );
                            return { success: false, code: 1, stdout: "", stderr: "compile failed" };
                        },
                        ...realSmokeChecks,
                    },
                ),
            Error,
            "Compile release binary failed",
        );

        assertEquals(stages, ["compile"]);
        assertEquals(
            await fsReadFile(join(root, "src", "shared", "version.js"), "utf8"),
            'export const VERSION = "original";\n',
        );
    });
});

test("release check rejects worker errors even when image fallback exits successfully", async () => {
    await withTemporaryVersionProject(async (root) => {
        await assertRejects(
            () =>
                runReleaseCheck(
                    { rootDir: root },
                    {
                        makeTempDir: () => Promise.resolve(root),
                        remove: () => Promise.resolve(),
                        run(_command, args) {
                            return Promise.resolve({
                                success: true,
                                code: 0,
                                stdout:
                                    args[0] === "--remote-preflight"
                                        ? JSON.stringify({ runtime: "bun", runtimeVersion: "1.4.3" })
                                        : "",
                                stderr:
                                    args[0] === "package-smoke"
                                        ? "error: Uncaught (in worker) Module not found: image-resize-worker.js"
                                        : "",
                            });
                        },
                        ...realSmokeChecks,
                    },
                ),
            Error,
            "Packaged image resize wrote unexpected terminal output",
        );
    });
});

test("runReleaseCheck restores generated version after binary version mismatch", async () => {
    await withTemporaryVersionProject(async (root) => {
        const stages: string[] = [];
        await assertRejects(
            () =>
                runReleaseCheck(
                    {
                        buildVersion: "v1.2.3-rc.1",
                        rootDir: root,
                    },
                    {
                        makeTempDir: () => Promise.resolve(root),
                        remove: () => Promise.resolve(),
                        async run(command, args) {
                            if (command === "bun" && args.includes("compile")) {
                                stages.push("compile");
                                await fsWriteFile(
                                    join(root, "src", "shared", "version.js"),
                                    'export const VERSION = "compiled";\n',
                                );
                                return { success: true, code: 0, stdout: "", stderr: "" };
                            }
                            if (command === "bun") {
                                stages.push("workspace-review-routes");
                                return { success: true, code: 0, stdout: "", stderr: "" };
                            }
                            stages.push("version");
                            return { success: true, code: 0, stdout: "runwield v1.2.3 (test-target)\n", stderr: "" };
                        },
                        ...realSmokeChecks,
                    },
                ),
            Error,
            "wrong version",
        );

        assertEquals(stages, ["compile", "workspace-review-routes", "version"]);
        assertEquals(
            await fsReadFile(join(root, "src", "shared", "version.js"), "utf8"),
            'export const VERSION = "original";\n',
        );
    });
});

// The release checker runs its real extraction and HTTP checks against the real
// source CLI. Only compilation and the separate CI process are controlled here;
// standalone compilation is qualified by the release lane itself.
function shellQuote(value: string): string {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function qualifySourceCli(root: string, includeGolden: boolean, brokenWorkspaceUrl?: string) {
    const temp = join(root, "qualification");
    const commands: string[] = [];
    const sourceCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const version = (await import("../src/shared/version.js")).VERSION;
    const options = parseReleaseCheckOptions([
        "--runtime",
        "bun",
        "--build-version",
        version,
        ...(includeGolden ? [] : ["--binary-only"]),
    ]);
    await runReleaseCheck(
        { ...options, rootDir: root },
        {
            ...realSmokeChecks,
            async makeTempDir() {
                await fsMkdir(temp);
                return temp;
            },
            remove: async () => {}, // retain evidence until the enclosing fixture cleanup
            async run(command, args, processOptions = {}) {
                commands.push(`${command} ${args.join(" ")}`);
                if (command === "bun") {
                    if (args.includes("compile")) {
                        assertEquals(processOptions.env?.WLD_BUILD_VERSION, version);
                        const output = args[args.indexOf("--output") + 1];
                        const invocation = [process.execPath, ...runtimeSourceArgs(["run", "-A", sourceCli])];
                        const brokenUi = brokenWorkspaceUrl
                            ? `if [ "$1 $2" = "plans ui" ]; then\n  printf '%s\\n' ${shellQuote("[RunWield] Workspace: " + brokenWorkspaceUrl)}\n  exec sleep 30\nfi\n`
                            : "";
                        await fsWriteFile(
                            output,
                            "#!/bin/sh\n" + brokenUi + "exec " + invocation.map(shellQuote).join(" ") + ' "$@"\n',
                        );
                        await fsChmod(output, 0o755);
                        await fsWriteFile(
                            join(root, "src", "shared", "version.js"),
                            'export const VERSION = "compiled";\n',
                        );
                    }
                    return { success: true, code: 0, stdout: "", stderr: "" };
                }
                const result = await captureScriptProcess(command, { ...processOptions, args });
                return {
                    ...result,
                    stdout: new TextDecoder().decode(result.stdout),
                    stderr: new TextDecoder().decode(result.stderr),
                };
            },
        },
    );
    return { commands, temp };
}

for (const includeGolden of [true, false]) {
    test(`release qualification checks real CLI extraction and HTTP surfaces with Golden=${includeGolden}`, async () => {
        await withTemporaryVersionProject(async (root) => {
            const { commands, temp } = await qualifySourceCli(root, includeGolden);
            assertEquals(
                commands.some((command) => command.includes("test:golden-tui:extensive")),
                includeGolden,
            );
            assertEquals(
                await fsReadFile(join(root, "src", "shared", "version.js"), "utf8"),
                'export const VERSION = "original";\n',
            );
            const home = join(temp, "reference-home");
            await assertExtractedBundledAgentReferenceFiles(home);
            if (includeGolden) {
                const skill = join(home, ".wld", "bundled-skills", "write-tests", "SKILL.md");
                const original = await fsReadFile(skill, "utf8");
                await fsWriteFile(skill, "stale release skill");
                await assertRejects(
                    () => assertExtractedBundledAgentReferenceFiles(home),
                    Error,
                    "stale bundled skill",
                );
                await fsWriteFile(skill, original);
                await fsRm(skill);
                await assertRejects(
                    () => assertExtractedBundledAgentReferenceFiles(home),
                    Error,
                    "did not extract bundled skill",
                );
            }
        });
    });
}

for (const identity of [
    { runtime: "deno", runtimeVersion: "2.9.7" },
    { runtime: "bun", runtimeVersion: "1.3.12" },
    { runtime: "bun" },
]) {
    test(`release qualification rejects unproven Bun identity ${JSON.stringify(identity)}`, async () => {
        await withTemporaryVersionProject(async (root) => {
            await assertRejects(
                () =>
                    runReleaseCheck(
                        { rootDir: root, includeGolden: false },
                        {
                            ...realSmokeChecks,
                            makeTempDir: () => Promise.resolve(root),
                            remove: async () => {},
                            run: (_command, args) =>
                                Promise.resolve({
                                    success: true,
                                    code: 0,
                                    stdout: args[0] === "--remote-preflight" ? JSON.stringify(identity) : "",
                                    stderr: "",
                                }),
                        },
                    ),
                Error,
                "Release binary must execute Bun 1.4.3.",
            );
        });
    });
}

for (const broken of ["fallback page", "missing nested chunk"]) {
    test(`release qualification refuses a packaged Workspace with ${broken}`, async () => {
        const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
            const path = new URL(request.url).pathname;
            if (path === "/")
                return new Response(
                    broken === "fallback page"
                        ? "Workspace Astro build unavailable"
                        : '<main data-astro-workspace-shell><astro-island component-url="/_astro/Workspace.js"></astro-island></main>',
                );
            if (path === "/_astro/Workspace.js")
                return new Response('export const load = () => import("./MissingChunk.js");', {
                    headers: { "content-type": "application/javascript" },
                });
            return new Response("not found", { status: 404 });
        });
        try {
            await withTemporaryVersionProject(async (root) => {
                await assertRejects(
                    () => qualifySourceCli(root, false, `http://127.0.0.1:${server.addr.port}/?token=fixture`),
                    Error,
                    broken === "fallback page" ? "Workspace build-unavailable" : "Review UI asset failed to load (404)",
                );
                assertEquals(
                    await fsReadFile(join(root, "src", "shared", "version.js"), "utf8"),
                    'export const VERSION = "original";\n',
                );
            });
        } finally {
            await server.shutdown();
        }
    });
}
