import { spawn } from "node:child_process";
import { captureScriptProcess, waitForScriptExit } from "./script-process.ts";
import type { ScriptProcessOptions, ScriptProcessOutput } from "./script-process.ts";
import type { Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * Run the local release preflight: build the standalone binary with the same
 * script used by the release workflow, then smoke-test the native executable.
 */

import { join } from "node:path";
import { PASSIVE_PATHS } from "./compile-bun.ts";

const BUNDLED_AGENT_DEFS_SOURCE_DIR = join("src", "agent-definitions");
const BUNDLED_SKILLS_SOURCE_DIR = join("src", "skills");

const BUNDLED_EXTRACTED_MARKDOWN_TARGETS = Object.freeze([
    {
        label: "bundled agent definition",
        sourceDir: BUNDLED_AGENT_DEFS_SOURCE_DIR,
        cacheDir: join(".wld", "bundled-agent-definitions"),
    },
    {
        label: "bundled skill",
        sourceDir: BUNDLED_SKILLS_SOURCE_DIR,
        cacheDir: join(".wld", "bundled-skills"),
    },
]);

const REQUIRED_BUNDLED_BINARY_ASSET_INCLUDES = Object.freeze([
    "src/agent-definitions/",
    "src/prompt-templates/",
    "src/shared/session/SYSTEM_PROMPT_TEMPLATE.md",
    "src/skills/",
    "src/ui/theme/catppuccin-mocha.json",
]);

export interface RunResult extends Pick<ScriptProcessOutput, "success" | "code"> {
    stdout: string;
    stderr: string;
}

interface BundledMarkdownTarget {
    label: string;
    sourceDir: string;
    cacheDir: string;
}

export interface ExtractedBundledMarkdownFile extends BundledMarkdownTarget {
    relativePath: string;
}

export interface ParsedReleaseCheckOptions {
    buildVersion: string | undefined;
    includeGolden: boolean;
    runtime?: "bun";
}

interface BunRuntimeIdentity {
    runtime: string;
    runtimeVersion: string;
}

interface FileSnapshot {
    exists: boolean;
    content: string;
}

async function run(command: string, args: string[], options: ScriptProcessOptions = {}): Promise<RunResult> {
    const output = await captureScriptProcess(command, {
        ...options,
        args,
        stdin: options.stdin || "inherit",
        stdout: options.stdout || "inherit",
        stderr: options.stderr || "inherit",
    });
    const decoder = new TextDecoder();
    return {
        success: output.success,
        code: output.code,
        stdout: options.stdout === "piped" ? decoder.decode(output.stdout) : "",
        stderr: options.stderr === "piped" ? decoder.decode(output.stderr) : "",
    };
}

async function mustRun(
    label: string,
    command: string,
    args: string[],
    options: ScriptProcessOptions = {},
    runner: typeof run = run,
) {
    console.log(`\n==> ${label}`);
    const result = await runner(command, args, options);
    if (!result.success) {
        throw new Error(`${label} failed with exit code ${result.code}.`);
    }
    return result;
}

async function collectStream(stream: Readable | null, onText: (text: string) => void) {
    if (!stream) return;
    stream.setEncoding("utf8");
    // Node does not track the text chunk type established by setEncoding.
    for await (const text of stream as AsyncIterable<string>) onText(text);
}

export function readReviewUrl(output: string) {
    return output.match(/http:\/\/127\.0\.0\.1:\d+\/review\/plan\?token=[^\s]+/)?.[0] || "";
}

export function readWorkspaceUrl(output: string) {
    return output.match(/http:\/\/127\.0\.0\.1:\d+\/?\?token=[^\s]+/)?.[0] || "";
}

export function assertBinaryWorkspaceHtml(html: string) {
    if (html.includes("Workspace Astro build unavailable")) {
        throw new Error("Standalone binary rendered the Workspace build-unavailable error.");
    }
    if (!html.includes("data-astro-workspace-shell")) {
        throw new Error("Standalone binary Workspace shell did not render.");
    }
    if (!html.includes("astro-island")) throw new Error("Standalone binary Workspace page lacks Astro island markup.");
    if (!html.includes("/_astro/")) throw new Error("Standalone binary Workspace page lacks built Astro asset links.");
}

export function assertBinaryReviewHtml(html: string) {
    if (html.includes("Workspace review UI assets are unavailable")) {
        throw new Error("Standalone binary rendered the old unavailable-assets review page.");
    }
    if (html.includes("built-in review surface")) {
        throw new Error("Standalone binary rendered a review fallback instead of the real Astro UI.");
    }
    if (html.includes("Workspace Astro build unavailable")) {
        throw new Error("Standalone binary rendered the Workspace build-unavailable error.");
    }
    if (!html.includes("data-astro-review-shell")) throw new Error("Standalone binary review shell did not render.");
    if (!html.includes("astro-island")) throw new Error("Standalone binary review page lacks Astro island markup.");
    if (!html.includes("/_astro/")) throw new Error("Standalone binary review page lacks built Astro asset links.");
    if (!html.includes("Release binary review smoke")) {
        throw new Error("Standalone binary review page did not include the smoke-test Plan content.");
    }
}

export function collectReviewAssetUrls(html: string, baseUrl: string) {
    const urls = new Set<string>();
    const attributePattern = /(?:src|href|component-url|renderer-url)=(['"])(.*?)\1/g;
    let match: RegExpExecArray | null;
    while ((match = attributePattern.exec(html)) !== null) {
        addReviewAssetUrl(urls, match[2], baseUrl);
    }
    return [...urls];
}

function addReviewAssetUrl(urls: Set<string>, rawUrl: string, baseUrl: string) {
    if (!rawUrl || rawUrl.startsWith("data:") || rawUrl.startsWith("#")) return;
    const url = new URL(rawUrl, baseUrl);
    if (url.pathname.startsWith("/_astro/")) urls.add(url.href);
}

export function collectNestedReviewAssetUrls(source: string, assetUrl: string) {
    const urls = new Set<string>();
    const importPattern = /(?:import\s*\(\s*|from\s+)(['"])(.*?)\1/g;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(source)) !== null) {
        addReviewAssetUrl(urls, match[2], assetUrl);
    }
    const sideEffectImportPattern = /import\s+(['"])(.*?)\1/g;
    while ((match = sideEffectImportPattern.exec(source)) !== null) {
        addReviewAssetUrl(urls, match[2], assetUrl);
    }
    const cssUrlPattern = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    while ((match = cssUrlPattern.exec(source)) !== null) {
        addReviewAssetUrl(urls, match[2], assetUrl);
    }
    return [...urls];
}

export async function assertReviewAssetsLoad(pageUrl: string, html: string) {
    const pending = collectReviewAssetUrls(html, pageUrl);
    const seen = new Set<string>();

    while (pending.length) {
        const assetUrl = pending.shift();
        if (!assetUrl || seen.has(assetUrl)) continue;
        seen.add(assetUrl);

        const response = await fetch(assetUrl);
        const body = await response.text();
        if (response.status !== 200) {
            throw new Error(`Review UI asset failed to load (${response.status}): ${assetUrl}\n${body.slice(0, 200)}`);
        }

        if (assetUrl.endsWith(".js") || assetUrl.endsWith(".css")) {
            for (const nestedUrl of collectNestedReviewAssetUrls(body, assetUrl)) {
                if (!seen.has(nestedUrl)) pending.push(nestedUrl);
            }
        }
    }

    if (!seen.size) throw new Error("Review UI page did not reference any loadable Astro assets.");
}

async function collectMarkdownFiles(rootDir: string, relativeDir = ""): Promise<string[]> {
    const files: string[] = [];
    const currentDir = relativeDir ? join(rootDir, ...relativeDir.split("/")) : rootDir;
    for await (const entry of await fsReaddir(currentDir, { withFileTypes: true })) {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(rootDir, relativePath)));
        else if (entry.isFile() && entry.name.endsWith(".md")) files.push(relativePath);
    }
    return files.sort();
}

export function assertRequiredBundledAssetsConfigured() {
    const includePaths = new Set(PASSIVE_PATHS);

    for (const includePath of REQUIRED_BUNDLED_BINARY_ASSET_INCLUDES) {
        if (!includePaths.has(includePath.replace(/\/$/, ""))) {
            throw new Error(`Release compile is missing bundled asset include: ${includePath}`);
        }
    }
}

export async function collectBundledAgentReferenceFiles() {
    return await collectMarkdownFiles(BUNDLED_AGENT_DEFS_SOURCE_DIR);
}

export async function collectExtractedBundledMarkdownFiles(): Promise<ExtractedBundledMarkdownFile[]> {
    const files: ExtractedBundledMarkdownFile[] = [];
    for (const target of BUNDLED_EXTRACTED_MARKDOWN_TARGETS) {
        for (const relativePath of await collectMarkdownFiles(target.sourceDir)) {
            files.push({ ...target, relativePath });
        }
    }
    return files.sort((a, b) => `${a.cacheDir}/${a.relativePath}`.localeCompare(`${b.cacheDir}/${b.relativePath}`));
}

export async function assertExtractedBundledAgentReferenceFiles(homeDir: string) {
    for (const { label, sourceDir, cacheDir, relativePath } of await collectExtractedBundledMarkdownFiles()) {
        const sourcePath = join(sourceDir, relativePath);
        const extractedPath = join(homeDir, cacheDir, relativePath);
        let source: string;
        let extracted: string;
        try {
            source = await fsReadFile(sourcePath, "utf8");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Bundled ${label} source file is missing: ${sourcePath}. ${message}`);
        }
        try {
            extracted = await fsReadFile(extractedPath, "utf8");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Release binary did not extract ${label} markdown file: ${extractedPath}. ${message}`);
        }
        if (extracted !== source) {
            throw new Error(`Release binary extracted stale ${label} markdown file: ${extractedPath}`);
        }
    }
}

async function hasExtractedBundledAgentReferenceFiles(homeDir: string) {
    try {
        await assertExtractedBundledAgentReferenceFiles(homeDir);
        return true;
    } catch {
        return false;
    }
}

export async function smokeTestBundledAgentReferenceExtraction(binaryPath: string, root: string) {
    console.log("\n==> Smoke test bundled agent reference extraction");
    const homeDir = join(root, "reference-home");
    const projectDir = join(root, "reference-project");
    await fsMkdir(projectDir, { recursive: true });
    await fsMkdir(homeDir, { recursive: true });
    await fsWriteFile(join(projectDir, "README.md"), "# Release reference extraction smoke\n");

    const child = spawn(binaryPath, ["init"], {
        cwd: projectDir,
        env: { ...process.env, HOME: homeDir },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const childStatus = waitForScriptExit(child);

    let output = "";
    const append = (text: string) => {
        output += text;
    };
    const stdoutDone = collectStream(child.stdout, append);
    const stderrDone = collectStream(child.stderr, append);

    try {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            if (await hasExtractedBundledAgentReferenceFiles(homeDir)) return;

            const status = await Promise.race([
                childStatus,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
            ]);
            if (status) break;
        }

        await assertExtractedBundledAgentReferenceFiles(homeDir);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\nOutput:\n${output}`);
    } finally {
        try {
            child.kill("SIGTERM");
        } catch {
            // Process may have exited after initializing or failing before model invocation.
        }
        await Promise.allSettled([childStatus, stdoutDone, stderrDone]);
    }
}

export async function smokeTestBinaryPlansUiSurface(binaryPath: string, root: string) {
    console.log("\n==> Smoke test standalone Plans UI surface");
    const projectDir = join(root, "plans-ui-project");
    await fsMkdir(join(projectDir, "docs", "plans"), { recursive: true });
    await fsWriteFile(
        join(projectDir, "docs", "plans", "release-plans-ui-smoke.md"),
        `---\nplanId: release-plans-ui-smoke\nclassification: FEATURE\nstatus: draft\n---\n# Release binary Plans UI smoke\n`,
    );

    const child = spawn(binaryPath, ["plans", "ui", "--no-open"], {
        cwd: projectDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const childStatus = waitForScriptExit(child);

    let output = "";
    const append = (text: string) => {
        output += text;
    };
    const stdoutDone = collectStream(child.stdout, append);
    const stderrDone = collectStream(child.stderr, append);

    let url = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        url = readWorkspaceUrl(output);
        if (url) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!url) {
        try {
            child.kill("SIGTERM");
        } catch {
            // Process may have exited before printing a URL.
        }
        await Promise.allSettled([childStatus, stdoutDone, stderrDone]);
        throw new Error(`Standalone binary did not print a Workspace URL. Output:\n${output}`);
    }

    try {
        const response = await fetch(url);
        const html = await response.text();
        if (response.status !== 200) {
            throw new Error(`Plans UI URL returned ${response.status}: ${html.slice(0, 200)}\nOutput:\n${output}`);
        }
        assertBinaryWorkspaceHtml(html);
        await assertReviewAssetsLoad(url, html);
    } finally {
        try {
            child.kill("SIGTERM");
        } catch {
            // Process is expected to stay alive until terminated by release-check.
        }
        await Promise.allSettled([childStatus, stdoutDone, stderrDone]);
    }
}

export async function smokeTestBinaryReviewSurface(binaryPath: string, root: string) {
    console.log("\n==> Smoke test standalone Plan review surface");
    const projectDir = join(root, "plan-review-project");
    await fsMkdir(join(projectDir, "docs", "plans"), { recursive: true });
    await fsWriteFile(
        join(projectDir, "docs", "plans", "release-review-smoke.md"),
        `---\nplanId: release-review-smoke\nclassification: FEATURE\nstatus: draft\n---\n# Release binary review smoke\n`,
    );

    const child = spawn(binaryPath, ["plans", "read", "release-review-smoke", "--no-open"], {
        cwd: projectDir,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const childStatus = waitForScriptExit(child);

    let output = "";
    const append = (text: string) => {
        output += text;
    };
    const stdoutDone = collectStream(child.stdout, append);
    const stderrDone = collectStream(child.stderr, append);

    let url = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        url = readReviewUrl(output);
        if (url) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!url) {
        try {
            child.kill("SIGTERM");
        } catch {
            // Process may have exited before printing a URL.
        }
        await Promise.allSettled([childStatus, stdoutDone, stderrDone]);
        throw new Error(`Standalone binary did not print a review URL. Output:\n${output}`);
    }

    try {
        const response = await fetch(url);
        const html = await response.text();
        if (response.status !== 200) throw new Error(`Review URL returned ${response.status}: ${html.slice(0, 200)}`);
        assertBinaryReviewHtml(html);
        await assertReviewAssetsLoad(url, html);

        const token = new URL(url).searchParams.get("token") || "";
        const origin = new URL(url).origin;
        const exitResponse = await fetch(`${origin}/api/review/exit?token=${encodeURIComponent(token)}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-runwield-review-token": token },
            body: JSON.stringify({ reviewType: "plan" }),
        });
        const exitBody = await exitResponse.text();
        if (!exitResponse.ok) {
            throw new Error(`Standalone review exit returned ${exitResponse.status}: ${exitBody}`);
        }
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const status = await Promise.race([
            childStatus,
            new Promise<never>((_, reject) => {
                timeoutId = setTimeout(
                    () => reject(new Error("Standalone review command did not exit within 10 seconds.")),
                    10_000,
                );
            }),
        ]).finally(() => clearTimeout(timeoutId));
        if (!status.success) throw new Error(`Standalone review command exited ${status.code}. Output:\n${output}`);
    } finally {
        try {
            child.kill("SIGTERM");
        } catch {
            // Process already exited after the review close request.
        }
        await Promise.allSettled([childStatus, stdoutDone, stderrDone]);
    }
}

export function parseReleaseCheckOptions(args: string[] = []): ParsedReleaseCheckOptions {
    const options: ParsedReleaseCheckOptions = { buildVersion: undefined, includeGolden: true };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--build-version") options.buildVersion = args[++index];
        else if (arg === "--binary-only") options.includeGolden = false;
        else if (arg === "--runtime") {
            const runtime = args[++index];
            if (runtime !== "bun") throw new Error("--runtime requires bun.");
            options.runtime = runtime;
        } else throw new Error(`Unknown release check argument: ${arg}`);
    }
    if (options.buildVersion !== undefined && !options.buildVersion) {
        throw new Error("--build-version requires a value.");
    }
    return options;
}

export function assertBinaryVersionOutput(output: string, expectedVersion: string) {
    if (!output.includes(`runwield ${expectedVersion} (`)) {
        throw new Error(
            `Release binary reported the wrong version. Expected ${expectedVersion}; output was:\n${output}`,
        );
    }
}

export function assertBunRuntimeIdentity(output: string, expectedVersion: string) {
    const identity: BunRuntimeIdentity = JSON.parse(output);
    if (identity.runtime !== "bun" || identity.runtimeVersion !== expectedVersion) {
        throw new Error(`Release binary must execute Bun ${expectedVersion}.`);
    }
}

async function snapshotFile(path: string): Promise<FileSnapshot> {
    try {
        return { exists: true, content: await fsReadFile(path, "utf8") };
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return { exists: false, content: "" };
        }
        throw error;
    }
}

async function restoreFile(path: string, snapshot: FileSnapshot) {
    if (snapshot.exists) {
        await fsWriteFile(path, snapshot.content);
        return;
    }
    await fsRm(path).catch((error) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
}

export interface ReleaseCheckOptions {
    buildVersion?: string;
    rootDir?: string;
    includeGolden?: boolean;
    runtime?: "bun";
}

export interface ReleaseCheckTempDirOptions {
    prefix?: string;
}

export interface ReleaseCheckRemoveOptions {
    recursive?: boolean;
}

export interface ReleaseCheckExecutionPort {
    run: typeof run;
    makeTempDir: (options?: ReleaseCheckTempDirOptions) => Promise<string>;
    remove: (path: string, options?: ReleaseCheckRemoveOptions) => Promise<void>;
    smokeTestBundledAgentReferenceExtraction: typeof smokeTestBundledAgentReferenceExtraction;
    smokeTestBinaryPlansUiSurface: typeof smokeTestBinaryPlansUiSurface;
    smokeTestBinaryReviewSurface: typeof smokeTestBinaryReviewSurface;
}

const SYSTEM_RELEASE_CHECK_EXECUTION_PORT: ReleaseCheckExecutionPort = Object.freeze({
    run,
    makeTempDir: (options: ReleaseCheckTempDirOptions = {}) =>
        mkdtemp(join(tmpdir(), options.prefix ?? "wld-release-")),
    remove: fsRm,
    smokeTestBundledAgentReferenceExtraction,
    smokeTestBinaryPlansUiSurface,
    smokeTestBinaryReviewSurface,
});

export async function runReleaseCheck(options: ReleaseCheckOptions, port: ReleaseCheckExecutionPort) {
    const tempDir = await port.makeTempDir({ prefix: "wld-release-check-" });
    const rootDir = options.rootDir || ".";
    const versionPath = join(rootDir, "src", "shared", "version.js");
    const versionSnapshot = await snapshotFile(versionPath);
    const binaryName = process.platform === "win32" ? "wld.exe" : "wld";
    const output = join(tempDir, binaryName);
    const runner = port.run;

    try {
        assertRequiredBundledAssetsConfigured();
        const compileEnv = options.buildVersion ? { WLD_BUILD_VERSION: options.buildVersion } : undefined;
        await mustRun(
            "Compile release binary",
            "bun",
            ["run", "compile", "--output", output],
            {
                cwd: rootDir,
                env: compileEnv,
            },
            runner,
        );
        await mustRun(
            "Smoke test Workspace code and Plan review routes",
            "bun",
            ["run", "scripts/assert-workspace-review-runtime.ts", "--bun"],
            { cwd: rootDir },
            runner,
        );
        const smoke = await mustRun(
            "Smoke test release binary",
            output,
            ["--version"],
            {
                stdout: "piped",
                stderr: "piped",
            },
            runner,
        );
        if (options.buildVersion) assertBinaryVersionOutput(`${smoke.stdout}${smoke.stderr}`, options.buildVersion);
        {
            const identity = await mustRun(
                "Verify Bun runtime identity",
                output,
                ["--remote-preflight"],
                {
                    cwd: tempDir,
                    stdout: "piped",
                    stderr: "piped",
                    env: { HOME: tempDir, USERPROFILE: tempDir },
                },
                runner,
            );
            const expectedRuntime = (await fsReadFile(join(rootDir, ".bun-version"), "utf8")).trim();
            assertBunRuntimeIdentity(identity.stdout, expectedRuntime);
        }
        const imageSmoke = await mustRun(
            "Smoke test packaged image resize",
            output,
            ["package-smoke", "image-resize"],
            {
                cwd: tempDir,
                env: { WLD_INTERNAL_PACKAGE_CHECK: "1", HOME: tempDir, USERPROFILE: tempDir },
                stdout: "piped",
                stderr: "piped",
            },
            runner,
        );
        if (imageSmoke.stderr.trim()) {
            throw new Error(`Packaged image resize wrote unexpected terminal output: ${imageSmoke.stderr}`);
        }
        await port.smokeTestBundledAgentReferenceExtraction(output, tempDir);
        await port.smokeTestBinaryPlansUiSurface(output, tempDir);
        await port.smokeTestBinaryReviewSurface(output, tempDir);
        if (options.includeGolden !== false) {
            await mustRun(
                "Run Golden TUI release gate",
                "bun",
                ["run", "test:golden-tui:extensive"],
                { cwd: rootDir },
                runner,
            );
        }
    } finally {
        await restoreFile(versionPath, versionSnapshot);
        await port.remove(tempDir, { recursive: true }).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        });
    }
}

export async function main(args: string[] = process.argv.slice(2)) {
    await runReleaseCheck(parseReleaseCheckOptions(args), SYSTEM_RELEASE_CHECK_EXECUTION_PORT);
}

if (import.meta.main) await main();
