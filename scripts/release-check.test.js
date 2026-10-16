import { serveHttp } from "../src/shared/http-server.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects, assertThrows } from "../src/testing/assertions.ts";
import { join } from "node:path";
import {
    assertBinaryVersionOutput,
    assertBunRuntimeIdentity,
    assertBinaryWorkspaceHtml,
    assertExtractedBundledAgentReferenceFiles,
    assertRequiredBundledAssetsConfigured,
    assertReviewAssetsLoad,
    collectBundledAgentReferenceFiles,
    collectExtractedBundledMarkdownFiles,
    collectNestedReviewAssetUrls,
    collectReviewAssetUrls,
    parseReleaseCheckOptions,
    readReviewUrl,
    readWorkspaceUrl,
    runReleaseCheck,
} from "./release-check.js";

/**
 * @param {string} rootDir
 * @param {string} [relativeDir]
 * @returns {Promise<string[]>}
 */
async function collectMarkdownFiles(rootDir, relativeDir = "") {
    /** @type {string[]} */
    const files = [];
    const currentDir = relativeDir ? join(rootDir, ...relativeDir.split("/")) : rootDir;
    for await (const entry of await fsReaddir(currentDir, { withFileTypes: true })) {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(rootDir, relativePath)));
        else if (entry.isFile() && entry.name.endsWith(".md")) files.push(relativePath);
    }
    return files.sort();
}

test("parseReleaseCheckOptions accepts build identity and binary-only CI mode", () => {
    assertEquals(parseReleaseCheckOptions(["--build-version", "v1.2.3-rc.1"]), {
        buildVersion: "v1.2.3-rc.1",
        includeGolden: true,
    });
    assertEquals(parseReleaseCheckOptions(["--binary-only"]), { buildVersion: undefined, includeGolden: false });
    assertEquals(parseReleaseCheckOptions([]), { buildVersion: undefined, includeGolden: true });
});

test("assertBinaryVersionOutput requires the requested release identity", () => {
    assertBinaryVersionOutput("runwield v1.2.3-rc.1 (x86_64-unknown-linux-gnu)\n", "v1.2.3-rc.1");
    assertThrows(
        () => assertBinaryVersionOutput("runwield v1.2.3 (x86_64-unknown-linux-gnu)\n", "v1.2.3-rc.1"),
        Error,
        "wrong version",
    );
});

/**
 * @param {(root: string) => Promise<void>} fn
 */
async function withTemporaryVersionProject(fn) {
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

test("runReleaseCheck propagates build identity to compile and preserves stage order", async () => {
    await withTemporaryVersionProject(async (root) => {
        /** @type {string[]} */
        const stages = [];
        /** @type {Array<{ command: string, args: string[], env?: NodeJS.ProcessEnv }>} */
        const calls = [];
        await runReleaseCheck(
            {
                buildVersion: "v1.2.3-rc.1",
                rootDir: root,
            },
            {
                makeTempDir: () => Promise.resolve("release-temp"),
                remove: () => Promise.resolve(),
                async run(command, args, options = {}) {
                    calls.push({ command, args, env: options.env });
                    if (command === "bun" && args.includes("compile")) {
                        stages.push("compile");
                        await fsWriteFile(
                            join(root, "src", "shared", "version.js"),
                            'export const VERSION = "compiled";\n',
                        );
                        return { success: true, code: 0, stdout: "", stderr: "" };
                    }
                    if (command === "bun" && args.includes("test:golden-tui:extensive")) {
                        stages.push("golden-tui");
                        return { success: true, code: 0, stdout: "", stderr: "" };
                    }
                    if (command === "bun") {
                        stages.push("workspace-review-routes");
                        return { success: true, code: 0, stdout: "", stderr: "" };
                    }
                    if (args[0] === "--remote-preflight") {
                        stages.push("runtime-identity");
                        return {
                            success: true,
                            code: 0,
                            stdout: JSON.stringify({ runtime: "bun", runtimeVersion: "1.4.3" }),
                            stderr: "",
                        };
                    }
                    if (args[0] === "package-smoke") {
                        assertEquals(args, ["package-smoke", "image-resize"]);
                        assertEquals(options.cwd, "release-temp");
                        assertEquals(options.env?.WLD_INTERNAL_PACKAGE_CHECK, "1");
                        stages.push("image-resize");
                        return { success: true, code: 0, stdout: "", stderr: "" };
                    }
                    stages.push("version");
                    return {
                        success: true,
                        code: 0,
                        stdout: "runwield v1.2.3-rc.1 (test-target)\n",
                        stderr: "",
                    };
                },
                smokeTestBundledAgentReferenceExtraction() {
                    stages.push("references");
                    return Promise.resolve();
                },
                smokeTestBinaryPlansUiSurface() {
                    stages.push("plans-ui");
                    return Promise.resolve();
                },
                smokeTestBinaryReviewSurface() {
                    stages.push("review");
                    return Promise.resolve();
                },
            },
        );

        assertEquals(stages, [
            "compile",
            "workspace-review-routes",
            "version",
            "runtime-identity",
            "image-resize",
            "references",
            "plans-ui",
            "review",
            "golden-tui",
        ]);
        assertEquals(calls[0].env, { WLD_BUILD_VERSION: "v1.2.3-rc.1" });
        assertEquals(
            await fsReadFile(join(root, "src", "shared", "version.js"), "utf8"),
            'export const VERSION = "original";\n',
        );
    });
});

test("runReleaseCheck can leave Golden qualification to a parallel CI job", async () => {
    await withTemporaryVersionProject(async (root) => {
        /** @type {string[]} */
        const commands = [];
        await runReleaseCheck(
            { rootDir: root, includeGolden: false },
            {
                makeTempDir: () => Promise.resolve("release-temp"),
                remove: () => Promise.resolve(),
                run(command, args) {
                    commands.push(`${command} ${args.join(" ")}`);
                    return Promise.resolve({
                        success: true,
                        code: 0,
                        stdout:
                            args[0] === "--remote-preflight"
                                ? JSON.stringify({ runtime: "bun", runtimeVersion: "1.4.3" })
                                : command === "bun"
                                  ? ""
                                  : "runwield test-version (test-target)\n",
                        stderr: "",
                    });
                },
                smokeTestBundledAgentReferenceExtraction: () => Promise.resolve(),
                smokeTestBinaryPlansUiSurface: () => Promise.resolve(),
                smokeTestBinaryReviewSurface: () => Promise.resolve(),
            },
        );

        assertEquals(
            commands.some((command) => command.includes("test:golden-tui")),
            false,
        );
    });
});

test("runReleaseCheck short-circuits after compile failure and restores generated version", async () => {
    await withTemporaryVersionProject(async (root) => {
        /** @type {string[]} */
        const stages = [];
        await assertRejects(
            () =>
                runReleaseCheck(
                    {
                        buildVersion: "v1.2.3",
                        rootDir: root,
                    },
                    {
                        makeTempDir: () => Promise.resolve("release-temp"),
                        remove: () => Promise.resolve(),
                        async run(command) {
                            stages.push(command === "bun" ? "compile" : "version");
                            await fsWriteFile(
                                join(root, "src", "shared", "version.js"),
                                'export const VERSION = "failed";\n',
                            );
                            return { success: false, code: 1, stdout: "", stderr: "compile failed" };
                        },
                        smokeTestBundledAgentReferenceExtraction() {
                            stages.push("references");
                            return Promise.resolve();
                        },
                        smokeTestBinaryPlansUiSurface() {
                            stages.push("plans-ui");
                            return Promise.resolve();
                        },
                        smokeTestBinaryReviewSurface() {
                            stages.push("review");
                            return Promise.resolve();
                        },
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
        let laterChecks = 0;
        const laterCheck = () => {
            laterChecks++;
            return Promise.resolve();
        };
        await assertRejects(
            () =>
                runReleaseCheck(
                    { rootDir: root },
                    {
                        makeTempDir: () => Promise.resolve("release-temp"),
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
                        smokeTestBundledAgentReferenceExtraction: laterCheck,
                        smokeTestBinaryPlansUiSurface: laterCheck,
                        smokeTestBinaryReviewSurface: laterCheck,
                    },
                ),
            Error,
            "Packaged image resize wrote unexpected terminal output",
        );
        assertEquals(laterChecks, 0);
    });
});

test("runReleaseCheck restores generated version after binary version mismatch", async () => {
    await withTemporaryVersionProject(async (root) => {
        /** @type {string[]} */
        const stages = [];
        await assertRejects(
            () =>
                runReleaseCheck(
                    {
                        buildVersion: "v1.2.3-rc.1",
                        rootDir: root,
                    },
                    {
                        makeTempDir: () => Promise.resolve("release-temp"),
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
                        smokeTestBundledAgentReferenceExtraction() {
                            stages.push("references");
                            return Promise.resolve();
                        },
                        smokeTestBinaryPlansUiSurface() {
                            stages.push("plans-ui");
                            return Promise.resolve();
                        },
                        smokeTestBinaryReviewSurface() {
                            stages.push("review");
                            return Promise.resolve();
                        },
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

test("release compile includes required bundled markdown and theme assets", () => {
    assertRequiredBundledAssetsConfigured();
});

test("readReviewUrl extracts Plan review URL from command output", () => {
    assertEquals(
        readReviewUrl("[RunWield] Plan read-only view: http://127.0.0.1:1234/review/plan?token=abc-123\n"),
        "http://127.0.0.1:1234/review/plan?token=abc-123",
    );
});

test("readWorkspaceUrl extracts Plans UI URL from command output", () => {
    assertEquals(
        readWorkspaceUrl("[RunWield] Workspace: http://127.0.0.1:1234/?token=abc-123\n"),
        "http://127.0.0.1:1234/?token=abc-123",
    );
});

test("assertBinaryWorkspaceHtml requires the real built Workspace shell", () => {
    assertBinaryWorkspaceHtml(
        '<main data-astro-workspace-shell><astro-island component-url="/_astro/Workspace.js"></astro-island></main>',
    );
    assertThrows(
        () => assertBinaryWorkspaceHtml("Workspace Astro build unavailable"),
        Error,
        "Workspace build-unavailable",
    );
});

test("collectReviewAssetUrls finds Astro assets needed by review HTML", () => {
    const html =
        '<link rel="stylesheet" href="/_astro/app.css"><astro-island component-url="/_astro/Review.js"></astro-island>';

    assertEquals(collectReviewAssetUrls(html, "http://127.0.0.1:1234/review/plan?token=test"), [
        "http://127.0.0.1:1234/_astro/app.css",
        "http://127.0.0.1:1234/_astro/Review.js",
    ]);
});

test("collectNestedReviewAssetUrls finds dynamic import chunks", () => {
    const source =
        'const chunk = () => import("./ArtifactReadSurface.js"); import { x } from "./client.js"; import "./side-effect.js";';

    assertEquals(collectNestedReviewAssetUrls(source, "http://127.0.0.1:1234/_astro/Review.js"), [
        "http://127.0.0.1:1234/_astro/ArtifactReadSurface.js",
        "http://127.0.0.1:1234/_astro/client.js",
        "http://127.0.0.1:1234/_astro/side-effect.js",
    ]);
});

test("collectBundledAgentReferenceFiles covers all agent definitions, prompts, and plan formats", async () => {
    assertEquals(
        await collectBundledAgentReferenceFiles(),
        await collectMarkdownFiles(join("src", "agent-definitions")),
    );
});

test("collectExtractedBundledMarkdownFiles covers agent definitions and bundled skills", async () => {
    const extracted = await collectExtractedBundledMarkdownFiles();
    assertEquals(
        extracted.map((file) => join(file.cacheDir, file.relativePath)),
        [
            ...(await collectMarkdownFiles(join("src", "agent-definitions"))).map((path) =>
                join(".wld", "bundled-agent-definitions", path),
            ),
            ...(await collectMarkdownFiles(join("src", "skills"))).map((path) => join(".wld", "bundled-skills", path)),
        ].sort((a, b) => a.localeCompare(b)),
    );
});

test("assertExtractedBundledAgentReferenceFiles accepts copied bundled markdown", async () => {
    const homeDir = await fsMkdtemp(join(tmpdir(), "runwield-reference-home-"));
    try {
        for (const { sourceDir, cacheDir, relativePath } of await collectExtractedBundledMarkdownFiles()) {
            const relativeParts = relativePath.split("/");
            const targetDir = join(homeDir, cacheDir, ...relativeParts.slice(0, -1));
            const targetPath = join(targetDir, relativeParts.at(-1) || "");
            const source = await fsReadFile(join(sourceDir, relativePath), "utf8");
            await fsMkdir(targetDir, { recursive: true });
            await fsWriteFile(targetPath, source);
        }

        await assertExtractedBundledAgentReferenceFiles(homeDir);
    } finally {
        await fsRm(homeDir, { recursive: true });
    }
});

test("assertExtractedBundledAgentReferenceFiles rejects missing bundled markdown", async () => {
    const homeDir = await fsMkdtemp(join(tmpdir(), "runwield-reference-home-missing-"));
    try {
        await assertRejects(
            () => assertExtractedBundledAgentReferenceFiles(homeDir),
            Error,
            "Release binary did not extract bundled agent definition markdown file",
        );
    } finally {
        await fsRm(homeDir, { recursive: true });
    }
});

test("assertReviewAssetsLoad fails when a dynamic review chunk is missing", async () => {
    const server = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/_astro/Review.js") {
            return new Response('export const load = () => import("./MissingChunk.js");', {
                headers: { "content-type": "application/javascript" },
            });
        }
        return new Response("Not found", { status: 404 });
    });
    const pageUrl = `http://127.0.0.1:${server.addr.port}/review/plan?token=test`;
    const html = '<astro-island component-url="/_astro/Review.js"></astro-island>';

    try {
        await assertRejects(() => assertReviewAssetsLoad(pageUrl, html), Error, "Review UI asset failed to load (404)");
    } finally {
        await server.shutdown();
    }
});

test("Bun release identity rejects Deno and an unexpected compiler version", () => {
    assertBunRuntimeIdentity(JSON.stringify({ runtime: "bun", runtimeVersion: "1.4.3" }), "1.4.3");
    for (const identity of [
        { runtime: "deno", runtimeVersion: "2.9.7" },
        { runtime: "bun", runtimeVersion: "1.3.12" },
        { runtime: "bun" },
    ])
        assertThrows(() => assertBunRuntimeIdentity(JSON.stringify(identity), "1.4.3"));
    assertThrows(() => parseReleaseCheckOptions(["--runtime", "node"]));
    assertThrows(() => parseReleaseCheckOptions(["--runtime"]));
    assertEquals(parseReleaseCheckOptions(["--runtime", "bun", "--binary-only"]), {
        buildVersion: undefined,
        includeGolden: false,
        runtime: "bun",
    });
});

test("Bun release gate compiles and checks the Bun runtime without invoking the Deno compiler", async () => {
    await withTemporaryVersionProject(async (root) => {
        await fsWriteFile(join(root, ".bun-version"), "1.4.3\n");
        /** @type {Array<{ command: string, args: string[] }>} */
        const calls = [];
        /** @type {string[]} */
        const surfaces = [];
        await runReleaseCheck(
            { rootDir: root, runtime: "bun", includeGolden: false, buildVersion: "v1.2.3-rc.1" },
            {
                makeTempDir: () => Promise.resolve("release-temp"),
                remove: () => Promise.resolve(),
                run(command, args) {
                    calls.push({ command, args });
                    const stdout =
                        args[0] === "--remote-preflight"
                            ? JSON.stringify({ runtime: "bun", runtimeVersion: "1.4.3" })
                            : args[0] === "--version"
                              ? "runwield v1.2.3-rc.1 (arm64-darwin)\n"
                              : "";
                    return Promise.resolve({ success: true, code: 0, stdout, stderr: "" });
                },
                smokeTestBundledAgentReferenceExtraction: () => {
                    surfaces.push("references");
                    return Promise.resolve();
                },
                smokeTestBinaryPlansUiSurface: () => {
                    surfaces.push("plans");
                    return Promise.resolve();
                },
                smokeTestBinaryReviewSurface: () => {
                    surfaces.push("review");
                    return Promise.resolve();
                },
            },
        );
        assertEquals(calls[0].command, "bun");
        assertEquals(calls[0].args, [
            "run",
            "compile",
            "--output",
            join("release-temp", process.platform === "win32" ? "wld.exe" : "wld"),
        ]);
        assertEquals(calls[1], {
            command: "bun",
            args: ["run", "scripts/assert-workspace-review-runtime.js", "--bun"],
        });
        assertEquals(
            calls.some((call) => call.command === "deno"),
            false,
        );
        assertEquals(
            calls.some((call) => call.args[0] === "--remote-preflight"),
            true,
        );
        assertEquals(
            calls.some((call) => call.args[0] === "package-smoke"),
            true,
        );
        assertEquals(surfaces, ["references", "plans", "review"]);
        for (const identity of [
            { runtime: "deno", runtimeVersion: "2.9.7" },
            { runtime: "bun", runtimeVersion: "1.3.12" },
        ]) {
            await assertRejects(
                () =>
                    runReleaseCheck(
                        { rootDir: root, runtime: "bun", includeGolden: false },
                        {
                            makeTempDir: () => Promise.resolve("release-temp"),
                            remove: () => Promise.resolve(),
                            run(_command, args) {
                                return Promise.resolve({
                                    success: true,
                                    code: 0,
                                    stdout: args[0] === "--remote-preflight" ? JSON.stringify(identity) : "",
                                    stderr: "",
                                });
                            },
                            smokeTestBundledAgentReferenceExtraction: () => Promise.resolve(),
                            smokeTestBinaryPlansUiSurface: () => Promise.resolve(),
                            smokeTestBinaryReviewSurface: () => Promise.resolve(),
                        },
                    ),
                Error,
                "Release binary must execute Bun 1.4.3.",
            );
        }
    });
});
