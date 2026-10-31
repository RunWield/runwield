import { mkdir, mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import { getCwd, getHomeDir } from "../../constants.js";
import { captureForegroundProcess } from "../captured-process.ts";
import { chmod as fsChmod, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openNativeFileLock } from "../native-file-lock.ts";
import type { ArtifactMetadata } from "../../../scripts/build-metadata.ts";
import { sha256Bytes, verifyBuildArtifact } from "../../../scripts/build-metadata.ts";

export interface LauncherIdentity {
    buildId: string;
    protocol: number;
    version: string;
}

export interface ExtractedReleaseRuntime {
    artifact: string;
    metadata: ArtifactMetadata;
}

export interface ObtainedReleaseRuntime extends ExtractedReleaseRuntime {
    directory: string;
}

const TARGETS: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
};
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;

export function releaseRuntimeName(tag: string, suffix: string): string {
    if (!RELEASE_TAG.test(tag) || (tag.includes("-rc.") && Number(tag.split("-rc.")[1]) < 1)) {
        throw new Error(`Invalid launcher release tag: ${tag}`);
    }
    if (!TARGETS[suffix]) throw new Error(`Unsupported release runtime: ${suffix}`);
    return `wld-${tag}-${suffix}.tar.gz`;
}

async function tar(args: string[]): Promise<Uint8Array> {
    const result = await captureForegroundProcess("tar", { args, cwd: getCwd() });
    if (result.code !== 0) {
        throw new Error(`Invalid release archive: ${new TextDecoder().decode(result.stderr).trim()}`);
    }
    return result.stdout;
}

/**
 * Verify archive contents, binary checksum and the matching launcher identity.
 * Never extract arbitrary archive paths to disk.
 */
export async function extractReleaseRuntime(
    archive: string,
    suffix: string,
    launcher: LauncherIdentity | null,
    directory: string,
): Promise<ExtractedReleaseRuntime> {
    const target = TARGETS[suffix];
    if (!target) throw new Error(`Unsupported release runtime: ${suffix}`);
    const entries = new TextDecoder()
        .decode(await tar(["-tzf", archive]))
        .trim()
        .split(/\r?\n/);
    const hasLicense = entries.length === 3 && entries[2] === "LICENSE";
    if ((entries.length !== 2 && !hasLicense) || entries[0] !== "wld" || entries[1] !== "wld.build.json") {
        throw new Error(`Release archive must contain only wld, wld.build.json and optional LICENSE: ${archive}`);
    }
    if (hasLicense) await fsWriteFile(join(directory, "LICENSE"), await tar(["-xOzf", archive, "LICENSE"]));
    const artifact = join(directory, "wld");
    await fsWriteFile(artifact, await tar(["-xOzf", archive, "wld"]));
    await fsWriteFile(`${artifact}.build.json`, await tar(["-xOzf", archive, "wld.build.json"]));
    const metadata = await verifyBuildArtifact(artifact);
    if (
        metadata.target !== target ||
        (launcher &&
            (metadata.buildId !== launcher.buildId ||
                metadata.protocol !== launcher.protocol ||
                metadata.version !== launcher.version))
    ) {
        throw new Error(`Release runtime does not match launcher build, protocol, VERSION or ${target} target`);
    }
    if (platform !== "win32") await fsChmod(artifact, 0o700);
    return { artifact, metadata };
}

/** Deterministic location shared by the launcher and release qualification gate. */
export function releaseRuntimeCacheDirectory(tag: string, suffix: string): string {
    releaseRuntimeName(tag, suffix);
    return join(getHomeDir(), ".cache", "runwield", "remote", "runtime", tag, suffix);
}

async function download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    let response;
    try {
        response = await fetch(url, {
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
        });
    } catch (error) {
        throw new Error(`Cannot download ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

/** Downloads and cache hits use exactly the same checksum, extraction and identity checks. */
async function verifyReleaseRuntime(
    cache: string,
    name: string,
    suffix: string,
    launcher: LauncherIdentity,
): Promise<ObtainedReleaseRuntime> {
    const archive = join(cache, name);
    const [archiveBytes, checksum] = await Promise.all([readFile(archive), readFile(`${archive}.sha256`, "utf8")]);
    const line = `${await sha256Bytes(archiveBytes)}  ${name}`;
    if (checksum !== line && checksum !== `${line}\n`) {
        throw new Error(`Release archive checksum mismatch: ${name}`);
    }
    const directory = await mkdtemp(join(tmpdir(), "wld-remote-release-"));
    try {
        const result = await extractReleaseRuntime(archive, suffix, launcher, directory);
        return { ...result, directory };
    } catch (error) {
        await fsRm(directory, { recursive: true, force: true });
        throw error;
    }
}

/**
 * Obtain the exact VERSION-tagged asset, without network access on a verified hit.
 * The caller owns only the temporary extraction directory, never the cached pair.
 */
export async function obtainReleaseRuntime(
    tag: string,
    suffix: string,
    launcher: LauncherIdentity,
    signal?: AbortSignal,
): Promise<ObtainedReleaseRuntime> {
    const name = releaseRuntimeName(tag, suffix);
    if (launcher.version !== tag) throw new Error("Release VERSION does not match launcher VERSION");
    const cache = releaseRuntimeCacheDirectory(tag, suffix);
    const versionDirectory = dirname(cache);
    const root = dirname(versionDirectory);
    await mkdir(root, { recursive: true });
    // Keep the lock outside pruned VERSION directories. Serializing pruning with
    // readers/writers also prevents one VERSION from deleting another's stage.
    // The OS releases this lock if a launcher exits during a download.
    const lock = openNativeFileLock(join(root, ".lock"));
    let runtime: ObtainedReleaseRuntime | undefined;
    try {
        while (!lock.tryLockSync(true)) {
            signal?.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        signal?.throwIfAborted();
        try {
            runtime = await verifyReleaseRuntime(cache, name, suffix, launcher);
        } catch (error) {
            // A failed filesystem/tool check is not evidence that cached bytes are corrupt.
            if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
            // Missing, partial and corrupt entries all get one fresh download.
            await fsRm(cache, { recursive: true, force: true });
        }
        if (!runtime) {
            await mkdir(versionDirectory, { recursive: true });
            const stage = await mkdtemp(join(versionDirectory, `.${suffix}-`));
            try {
                const base = `https://github.com/gandazgul/runwield/releases/download/${tag}/${name}`;
                const [archive, checksum] = await Promise.all([
                    download(base, signal),
                    download(`${base}.sha256`, signal),
                ]);
                await Promise.all([
                    fsWriteFile(join(stage, name), archive),
                    fsWriteFile(join(stage, `${name}.sha256`), checksum),
                ]);
                runtime = await verifyReleaseRuntime(stage, name, suffix, launcher);
                // Promote the complete, verified pair in a single operation.
                await rename(stage, cache);
            } finally {
                await fsRm(stage, { recursive: true, force: true });
            }
        }
        // Never evict an older working release until this extraction and build
        // identity have passed, including on cache hits.
        for (const entry of await readdir(root, { withFileTypes: true })) {
            if (entry.isDirectory() && RELEASE_TAG.test(entry.name) && entry.name !== tag) {
                await fsRm(join(root, entry.name), { recursive: true, force: true });
            }
        }
        return runtime;
    } catch (error) {
        if (runtime) await fsRm(runtime.directory, { recursive: true, force: true });
        throw error;
    } finally {
        lock.close();
    }
}
