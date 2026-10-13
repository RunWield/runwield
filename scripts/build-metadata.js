/* Common, content-based identity for explicit local and GNU/Linux builds.
 * This is build tooling, not a Git-commit or VERSION comparison.
 */
import { join } from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";

export const REMOTE_PROTOCOL_VERSION = 1;
export const BUILD_IDENTITY_PATH = "src/shared/build-identity.js";
export const BUILD_METADATA_SCHEMA = 1;

// Capture first-party sources, generated workspace resources, config/lock and
// the one npm resource directory explicitly embedded by the executable compiler. The lock
// identifies resolved dependencies; their locally installed bytes are not a
// portable identity across npm installations/platforms.
const INPUTS = [
    "src",
    "scripts",
    "third_party/plannotator/packages",
    "brand",
    "dist/workspace-runtime",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "tsconfig.bun.json",
    "config.schema.json",
    "image-resize-worker.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/utils",
];
const EXCLUDED = new Set([BUILD_IDENTITY_PATH, "src/shared/version.js"]);
const encoder = new TextEncoder();

/** @param {Uint8Array} bytes */
export async function sha256Bytes(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/** @param {string} path */
export async function sha256File(path) {
    return sha256Bytes(await readFile(path));
}

/**
 * @param {string} root
 * @param {boolean} includeRuntime
 * @returns {Promise<string[]>}
 */
async function inputFiles(root, includeRuntime) {
    /** @type {string[]} */
    const found = [];
    /** @param {string} name */
    async function visit(name) {
        if (
            EXCLUDED.has(name) ||
            name.endsWith(".test.js") ||
            name.endsWith(".test.ts") ||
            name.endsWith(".test.tsx") ||
            name.endsWith(".spec.ts")
        )
            return;
        const path = join(root, name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
            // Documentation links in the vendored tree are not compiled.
            if (name.startsWith("third_party/") && name.endsWith(".md")) return;
            throw new Error(`Build input is a symlink: ${name}`);
        }
        if (info.isDirectory()) {
            const entries = [];
            entries.push(...(await readdir(path)));
            for (const entry of entries.sort()) {
                if (["node_modules", ".git", ".astro", ".vite", "dist", "coverage"].includes(entry)) continue;
                await visit(`${name}/${entry}`);
            }
        } else if (info.isFile()) found.push(name);
        else throw new Error(`Unsupported build input: ${name}`);
    }
    for (const name of INPUTS) {
        if (!includeRuntime && name === "dist/workspace-runtime") continue;
        await visit(name);
    }
    return found.sort();
}

/**
 * @param {string} root
 * @param {string} runtimeVersion
 * @param {string[]} compileOptions Common flags/includes, without output, target or reload.
 * @param {boolean} [includeRuntime]
 * @returns {Promise<string>}
 */
export async function computeBuildIdentity(root, runtimeVersion, compileOptions, includeRuntime = true) {
    const parts = [
        JSON.stringify({
            schema: BUILD_METADATA_SCHEMA,
            protocol: REMOTE_PROTOCOL_VERSION,
            runtimeVersion,
            compileOptions,
        }),
    ];
    for (const name of await inputFiles(root, includeRuntime)) {
        parts.push(JSON.stringify([name, await sha256File(join(root, name))]));
    }
    return sha256Bytes(encoder.encode(parts.join("\n")));
}

/**
 * @typedef {Object} ArtifactMetadata
 * @property {number} schema
 * @property {number} protocol
 * @property {string} buildId
 * @property {string} target
 * @property {string} version
 * @property {string} sha256
 */

/** @param {string} artifact @param {string} metadataPath @returns {Promise<ArtifactMetadata>} */
export async function verifyBuildArtifact(artifact, metadataPath = `${artifact}.build.json`) {
    /** @type {ArtifactMetadata} */
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
        metadata.schema !== BUILD_METADATA_SCHEMA ||
        metadata.protocol !== REMOTE_PROTOCOL_VERSION ||
        !/^[a-f0-9]{64}$/.test(metadata.buildId) ||
        !/^[a-z0-9_-]+$/.test(metadata.target) ||
        typeof metadata.version !== "string" ||
        !metadata.version ||
        metadata.version.length > 100 ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256)
    ) {
        throw new Error(`Invalid build metadata: ${metadataPath}`);
    }
    if ((await sha256File(artifact)) !== metadata.sha256) {
        throw new Error(`Build artifact checksum mismatch: ${artifact}`);
    }
    return metadata;
}
