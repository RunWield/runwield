/**
 * Build the standalone RunWield binary. Development builds are explicit; a
 * remote connection must never compile on demand. From the same unchanged
 * checkout and compiler, run:
 *
 * export ASTRO_KEY="$(openssl rand -base64 32)" # reuse for this artifact set; keep private
 * deno run -A scripts/compile.js --output bin/wld
 * BUILD_ID=$(deno eval 'console.log(JSON.parse(await Deno.readTextFile("bin/wld.build.json")).buildId)')
 * deno run -A scripts/compile.js --target x86_64-unknown-linux-gnu --output bin/wld-linux-x64 --expect-build-id "$BUILD_ID"
 * deno run -A scripts/compile.js --target aarch64-unknown-linux-gnu --output bin/wld-linux-arm64 --expect-build-id "$BUILD_ID"
 * deno run -A scripts/release-assets.js development bin/wld bin/wld-linux-x64 bin/wld-linux-arm64 bin/remote-build
 *
 * Each binary has an adjacent .build.json (schema, protocol, buildId, target,
 * sha256). The bundle has wld-launcher and two GNU target filenames with
 * adjacent metadata. Do not use VERSION or a Git hash as a compatibility check.
 */

import { dirname, resolve } from "@std/path";
import {
    BUILD_IDENTITY_PATH,
    BUILD_METADATA_SCHEMA,
    computeBuildIdentity,
    REMOTE_PROTOCOL_VERSION,
    sha256File,
} from "./build-metadata.js";
import { writeBuildIdentityFile } from "./write-version.js";

export const DENO_COMPILE_MINIMUM_VERSION = "2.9.3";

const STATIC_INCLUDE_PATHS = [
    "src/shared/build-identity.js",
    "src/ui/workspace/static/",
    "src/ui/design-system/tokens.css",
    "src/ui/design-system/components.css",
    "brand/logo.svg",
    "dist/workspace-runtime/server.mjs",
    "dist/workspace-runtime/client/",
    "src/ui/workspace/server/plan-adapter.js",
    "src/agent-definitions/",
    "src/model-presets/",
    "src/prompt-templates/",
    "src/shared/session/SYSTEM_PROMPT_TEMPLATE.md",
    "src/cmd/sleep/prompt.md",
    "src/skills/",
    "src/snip-filters",
    "src/ui/theme/catppuccin-mocha.json",
    // Pi resolves this worker beside the compiled bundle. Keep its source
    // directory intact so Photon can load its module-relative WASM asset.
    "image-resize-worker.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/utils/",
    "node_modules/@silvia-odwyer/photon-node/",
];

/**
 * @typedef {Object} CommandResult
 * @property {boolean} success
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {Object} CompileOptions
 * @property {string} [output]
 * @property {string} [target]
 * @property {boolean} [reload]
 * @property {string} [expectBuildId]
 */

/**
 * Run a command and return success + stdout.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<CommandResult>}
 */
async function runCmd(cmd, args, extraEnv = {}) {
    // Vite embeds the environment object's insertion order into server.mjs.
    // Preserve the build environment in a stable order and exclude `_`,
    // which shells change to the previous command path between builds.
    const env = Object.fromEntries(
        Object.entries({ ...Deno.env.toObject(), ...extraEnv }).filter(([key]) => key !== "_")
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    );
    const command = new Deno.Command(cmd, { args, env, clearEnv: true, stdout: "piped", stderr: "piped" });
    const { success, stdout, stderr } = await command.output();
    return {
        success,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
    };
}

/**
 * @param {CompileOptions} [options]
 * @returns {string[]}
 */
export function buildCompileArgs(options = {}) {
    const output = options.output || "./bin/wld";
    const args = [
        "compile",
        "--output",
        output,
        "-A",
        "--no-check",
        "--unstable-no-legacy-abort",
        "--exclude-unused-npm",
        "--bundle",
        "--minify",
        "--app-name",
        "wld",
    ];

    if (options.reload) args.push("--reload");
    if (options.target) args.push("--target", options.target);

    for (const path of STATIC_INCLUDE_PATHS) {
        args.push("--include", path);
    }

    args.push("src/cli.ts");

    return args;
}

/**
 * @param {string[]} args
 * @returns {CompileOptions}
 */
export function parseCompileOptions(args) {
    /** @type {CompileOptions} */
    const options = {};
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--reload") {
            options.reload = true;
            continue;
        }
        if (arg === "--output" || arg === "--target" || arg === "--expect-build-id") {
            const value = args[index + 1];
            if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
            if (arg === "--output") options.output = value;
            else if (arg === "--target") options.target = value;
            else options.expectBuildId = value;
            index += 1;
            continue;
        }
        if (arg.startsWith("--output=")) {
            options.output = arg.slice("--output=".length);
            continue;
        }
        if (arg.startsWith("--target=")) {
            options.target = arg.slice("--target=".length);
            continue;
        }
        if (arg.startsWith("--expect-build-id=")) {
            options.expectBuildId = arg.slice("--expect-build-id=".length);
            continue;
        }
        throw new Error(`Unknown compile option: ${arg}`);
    }
    return options;
}

/**
 * @param {string} version
 * @returns {number[]}
 */
function parseDenoVersion(version) {
    return version.split(".").map((part) => Number.parseInt(part, 10));
}

/**
 * @param {string} version
 * @param {string} minimumVersion
 * @returns {boolean}
 */
function isDenoVersionAtLeast(version, minimumVersion) {
    const currentParts = parseDenoVersion(version);
    const minimumParts = parseDenoVersion(minimumVersion);
    const partCount = Math.max(currentParts.length, minimumParts.length);

    for (let index = 0; index < partCount; index += 1) {
        const currentPart = currentParts[index] || 0;
        const minimumPart = minimumParts[index] || 0;
        if (currentPart > minimumPart) return true;
        if (currentPart < minimumPart) return false;
    }

    return true;
}

/**
 * Keep local and release artifacts on a supported Deno compiler/runtime.
 *
 * @param {string} [version]
 */
export function assertCompileDenoVersion(version = Deno.version.deno) {
    if (!isDenoVersionAtLeast(version, DENO_COMPILE_MINIMUM_VERSION)) {
        throw new Error(
            `RunWield binaries must be compiled with Deno ${DENO_COMPILE_MINIMUM_VERSION} or newer; current Deno is ${version}.`,
        );
    }
}

/**
 * A cross-compiled binary cannot run on the build host.
 *
 * @param {string | undefined} target
 * @returns {boolean}
 */
export function canSmokeTestCompiledBinary(target) {
    if (!target) return true;
    const osTarget = Deno.build.os === "darwin"
        ? "apple-darwin"
        : Deno.build.os === "windows"
        ? "pc-windows-msvc"
        : "unknown-linux-gnu";
    return target === `${Deno.build.arch}-${osTarget}`;
}

/**
 * @param {string[]} [args]
 * @returns {Promise<void>}
 */
export async function main(args = Deno.args) {
    assertCompileDenoVersion();
    const options = parseCompileOptions(args);
    const output = options.output || "./bin/wld";
    const root = resolve(".");
    const commonOptions = buildCompileArgs().filter((arg, index, args) =>
        index !== 1 && index !== 2 && arg !== "--reload" &&
        // Build identity is generated; the include flag itself is stable.
        !(arg === "--target" || args[index - 1] === "--target")
    );
    const beforePreparation = await computeBuildIdentity(root, Deno.version.deno, commonOptions, false);

    const versionBuild = await runCmd("deno", ["run", "-A", "scripts/write-version.js"]);
    if (!versionBuild.success) throw new Error(versionBuild.stderr || "Version generation failed.");
    const { VERSION } = await import("../src/shared/version.js");

    // Invoke the task's command directly. `deno task` adds npm bins to PATH
    // in a different environment insertion order across runs; Vite embeds
    // that order in the generated server bundle.
    const workspaceBuild = await runCmd("deno", [
        "run",
        "-A",
        "--env",
        "npm:astro",
        "build",
        "--config",
        "src/ui/workspace/astro.config.mjs",
    ]);
    console.log(workspaceBuild.stdout);
    if (!workspaceBuild.success) {
        throw new Error(workspaceBuild.stderr || "Workspace build failed.");
    }

    const workspaceRuntimeBuild = await runCmd("deno", ["run", "-A", "scripts/build-workspace-runtime.js"]);
    console.log(workspaceRuntimeBuild.stdout);
    if (!workspaceRuntimeBuild.success) {
        throw new Error(workspaceRuntimeBuild.stderr || "Workspace runtime build failed.");
    }

    const workspaceReviewRuntimeCheck = await runCmd("deno", [
        "run",
        "-A",
        "scripts/assert-workspace-review-runtime.js",
    ]);
    console.log(workspaceReviewRuntimeCheck.stdout);
    if (!workspaceReviewRuntimeCheck.success) {
        throw new Error(workspaceReviewRuntimeCheck.stderr || "Workspace review runtime quality gate failed.");
    }

    if (beforePreparation !== await computeBuildIdentity(root, Deno.version.deno, commonOptions, false)) {
        throw new Error("Build source drift during preparation; rebuild both artifacts from unchanged inputs.");
    }
    const buildId = await computeBuildIdentity(root, Deno.version.deno, commonOptions);
    if (options.expectBuildId && options.expectBuildId !== buildId) {
        throw new Error(`Build source drift: expected ${options.expectBuildId}, got ${buildId}.`);
    }
    await writeBuildIdentityFile(BUILD_IDENTITY_PATH, buildId);
    await Deno.mkdir(dirname(output), { recursive: true });
    await Deno.remove(`${output}.build.json`).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    const compile = await runCmd("deno", buildCompileArgs(options));

    console.log(compile.stdout);

    if (!compile.success) {
        throw new Error(compile.stderr || "Deno compile failed.");
    }

    if (buildId !== await computeBuildIdentity(root, Deno.version.deno, commonOptions)) {
        await Deno.remove(output).catch(() => {});
        throw new Error("Build source drift during compilation; discard the artifact.");
    }

    if (canSmokeTestCompiledBinary(options.target)) {
        const smokeTest = await runCmd(resolve(output), ["--version"]);
        if (!smokeTest.success) {
            throw new Error(smokeTest.stderr || "Compiled RunWield binary failed its startup smoke test.");
        }
        const imageSmokeTest = await runCmd(resolve(output), ["package-smoke", "image-resize"], {
            WLD_INTERNAL_PACKAGE_CHECK: "1",
        });
        if (!imageSmokeTest.success) {
            throw new Error(imageSmokeTest.stderr || "Compiled RunWield binary failed its image runtime smoke test.");
        }
    }
    const target = options.target ||
        `${Deno.build.arch}-${
            Deno.build.os === "darwin"
                ? "apple-darwin"
                : Deno.build.os === "windows"
                ? "pc-windows-msvc"
                : "unknown-linux-gnu"
        }`;
    await Deno.writeTextFile(
        `${output}.build.json`,
        JSON.stringify(
            {
                schema: BUILD_METADATA_SCHEMA,
                protocol: REMOTE_PROTOCOL_VERSION,
                buildId,
                target,
                version: VERSION,
                sha256: await sha256File(output),
            },
            null,
            2,
        ) + "\n",
    );
    console.log(`[wld] build metadata: ${output}.build.json (buildId ${buildId})`);
}

if (import.meta.main) {
    await main();
}
