/** Pinned Bun executable builder for development and release qualification. */
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { argv, versions } from "node:process";
import { fileURLToPath } from "node:url";
import { requirePinnedBun } from "./check-bun-runtime.ts";
import { BUILD_METADATA_SCHEMA, computeBuildIdentity, REMOTE_PROTOCOL_VERSION, sha256File } from "./build-metadata.js";
import { resolveBuildVersion, writeBuildIdentityFile, writeVersionFile } from "./write-version.js";

interface LoadedSource {
    contents: string;
    loader: "js";
}
interface BuildPluginAPI {
    onLoad(filter: { filter: RegExp }, load: (input: { path: string }) => Promise<LoadedSource> | LoadedSource): void;
}
interface BuildPlugin {
    name: string;
    setup(api: BuildPluginAPI): void;
}
interface CompileOptions {
    outfile: string;
    target?: string;
    executablePath?: string;
    assets: string[];
    autoloadDotenv: false;
    autoloadBunfig: false;
    autoloadTsconfig: false;
    autoloadPackageJson: false;
}
interface BuildOptions {
    entrypoints: string[];
    root: string;
    target: "bun";
    format: "esm";
    outdir?: string;
    naming?: { entry: string };
    compile?: CompileOptions;
    plugins?: BuildPlugin[];
    loader?: Record<string, "file">;
}
interface BuildResult {
    success: boolean;
    logs: Array<{ toString(): string }>;
}
interface BunBuildRuntime {
    build(options: BuildOptions): Promise<BuildResult>;
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PASSIVE_PATHS = [
    "src/ui/workspace/static",
    "src/ui/design-system/tokens.css",
    "src/ui/design-system/components.css",
    "brand/logo.svg",
    "src/agent-definitions",
    "src/model-presets",
    "src/prompt-templates",
    "src/shared/session/SYSTEM_PROMPT_TEMPLATE.md",
    "src/cmd/sleep/prompt.md",
    "src/skills",
    "src/snip-filters",
    "src/ui/theme/catppuccin-mocha.json",
];

/** Stable content manifest covers every passive embedded byte, including generated CSS/JS/WASM. */
async function stagedPayloadIdentity(root: string): Promise<string> {
    const entries: string[] = [];
    async function visit(directory: string, prefix: string): Promise<void> {
        const children = await readdir(directory, { withFileTypes: true });
        children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        for (const child of children) {
            const name = prefix ? `${prefix}/${child.name}` : child.name;
            const path = join(directory, child.name);
            if (child.isDirectory()) await visit(path, name);
            else if (child.isFile()) entries.push(JSON.stringify([name, await sha256File(path)]));
            else throw new Error(`Unsupported packaged asset: ${name}`);
        }
    }
    await visit(root, "");
    return entries.join("\n");
}

const ARTIFACT_TARGETS: Record<string, string> = {
    "bun-darwin-arm64": "aarch64-apple-darwin",
    "bun-darwin-x64": "x86_64-apple-darwin",
    "bun-linux-arm64": "aarch64-unknown-linux-gnu",
    "bun-linux-x64": "x86_64-unknown-linux-gnu",
    "bun-windows-arm64": "aarch64-pc-windows-msvc",
    "bun-windows-x64": "x86_64-pc-windows-msvc",
};

export function bunArtifactTarget(target: string): string {
    const canonical = ARTIFACT_TARGETS[target];
    if (!canonical) throw new Error(`Unsupported Bun target: ${target}`);
    return canonical;
}

export async function compileBun(
    output: string,
    target?: string,
    runtime?: string,
    expectedBuildId?: string,
    entrypoint = "src/cli.ts",
): Promise<void> {
    requirePinnedBun();
    const entry = resolve(ROOT, entrypoint);
    const relativeEntry = relative(ROOT, entry);
    if (relativeEntry.startsWith("..") || !relativeEntry)
        throw new Error("Compile entrypoint must be inside the repository");
    await stat(entry);
    const compileTarget =
        target || `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    const artifactTarget = bunArtifactTarget(compileTarget);
    const bun: BunBuildRuntime = createRequire(import.meta.url)("bun");
    await mkdir(join(ROOT, ".ci-cache"), { recursive: true });
    const staging = await mkdtemp(join(ROOT, ".ci-cache", "bun-package-"));
    const outfile = resolve(output);
    const version = resolveBuildVersion({
        readEnv: (key) => process.env[key],
        runGit: (args) => {
            const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
            return result.status === 0 ? result.stdout.trim() || undefined : undefined;
        },
    });
    await writeVersionFile(join(ROOT, "src/shared/version.js"), version);
    try {
        await stat(join(ROOT, "src/shared/build-identity.js"));
    } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
        await writeBuildIdentityFile(join(ROOT, "src/shared/build-identity.js"), "0".repeat(64));
    }
    async function build(options: BuildOptions) {
        const result = await bun.build(options);
        if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    }
    let buildId = "";
    try {
        for (const path of PASSIVE_PATHS) {
            await mkdir(dirname(join(staging, path)), { recursive: true });
            await cp(join(ROOT, path), join(staging, path), { recursive: true, errorOnExist: true, force: false });
        }
        const plugins: BuildPlugin[] = [
            {
                name: "runwield-bun-runtime-assets",
                setup(api) {
                    api.onLoad({ filter: /[\\/]src[\\/]shared[\\/]photon-loader\.ts$/ }, () => ({
                        contents:
                            'import photon from "@silvia-odwyer/photon-node"; export function loadPhoton() { return photon; }',
                        loader: "js",
                    }));
                    api.onLoad({ filter: /[\\/]src[\\/]shared[\\/]version\.js$/ }, () => ({
                        contents: `export const VERSION = ${JSON.stringify(version)};`,
                        loader: "js",
                    }));
                    api.onLoad({ filter: /[\\/]src[\\/]shared[\\/]build-identity\.js$/ }, () => ({
                        contents: `export const BUILD_ID = ${JSON.stringify(
                            buildId,
                        )}; export const REMOTE_PROTOCOL_VERSION = ${REMOTE_PROTOCOL_VERSION};`,
                        loader: "js",
                    }));
                    api.onLoad({ filter: /photon_rs\.js$/ }, async ({ path }) => {
                        const source = await readFile(path, "utf8");
                        const original = "require('path').join(__dirname, 'photon_rs_bg.wasm')";
                        if (!source.includes(original))
                            throw new Error("Photon loader changed; revisit WASM embedding");
                        return { contents: source.replace(original, 'require("./photon_rs_bg.wasm")'), loader: "js" };
                    });
                },
            },
        ];
        const serverDir = join(staging, "dist/workspace-bun/server");
        await build({
            entrypoints: [join(ROOT, "dist/workspace-bun/server/entry.mjs")],
            root: ROOT,
            target: "bun",
            format: "esm",
            outdir: serverDir,
            naming: { entry: "[name].mjs" },
            plugins,
            loader: { ".wasm": "file" },
        });
        await cp(join(ROOT, "dist/workspace-bun/client"), join(staging, "dist/workspace-bun/client"), {
            recursive: true,
        });
        // Runtime/compiler and Bun lock contribute to identity; output path and
        // architecture do not. This cannot masquerade as the current Deno build.
        buildId = await computeBuildIdentity(
            ROOT,
            `bun:${versions.bun}`,
            [
                "bun-compile-v1",
                `entry:${relativeEntry.replaceAll("\\", "/")}`,
                `entry-sha256:${await sha256File(entry)}`,
                `lock:${await sha256File(join(ROOT, "bun.lock"))}`,
                `package:${await sha256File(join(ROOT, "package.json"))}`,
                `payload:${await stagedPayloadIdentity(staging)}`,
                ...PASSIVE_PATHS,
            ],
            false,
        );
        if (expectedBuildId && buildId !== expectedBuildId) {
            throw new Error(`Build identity mismatch: expected ${expectedBuildId}, got ${buildId}`);
        }
        // Bun directory assets retain their top directory name. Staging only
        // approved passive paths preserves src/ and dist/ without embedding tests.
        // https://bun.com/docs/bundler/executables#embed-directories
        await mkdir(dirname(outfile), { recursive: true });
        await build({
            entrypoints: [entry, join(ROOT, "src/utils/image-resize-worker.ts")],
            root: ROOT,
            target: "bun",
            format: "esm",
            loader: { ".wasm": "file" },
            plugins,
            compile: {
                outfile,
                ...(target ? { target } : {}),
                ...(runtime ? { executablePath: resolve(runtime) } : {}),
                assets: [join(staging, "src"), join(staging, "brand"), join(staging, "dist")],
                autoloadDotenv: false,
                autoloadBunfig: false,
                autoloadTsconfig: false,
                autoloadPackageJson: false,
            },
        });
        await writeFile(
            `${outfile}.build.json`,
            JSON.stringify(
                {
                    schema: BUILD_METADATA_SCHEMA,
                    protocol: REMOTE_PROTOCOL_VERSION,
                    buildId,
                    target: artifactTarget,
                    version,
                    sha256: await sha256File(outfile),
                },
                null,
                2,
            ) + "\n",
        );
        console.log(`Bun executable: ${outfile}`);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const [output = process.platform === "win32" ? "bin/wld.exe" : "bin/wld", target, runtime, ...extra] =
        argv.slice(2);
    if (extra.length) {
        throw new Error(
            "Usage: compile-bun.ts [output] [bun-darwin-arm64|bun-linux-arm64|bun-darwin-x64|bun-linux-x64|bun-windows-arm64|bun-windows-x64] [cached-runtime]",
        );
    }
    await compileBun(output, target, runtime);
}
