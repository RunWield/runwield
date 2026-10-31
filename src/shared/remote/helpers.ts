import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import manifest from "../../../packaging/remote/tested-dependencies.json" with { type: "json" };
import { getCwd, getHomeDir } from "../../constants.js";
import { sha256Bytes } from "../../../scripts/build-metadata.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { openNativeFileLock } from "../native-file-lock.ts";
import { linuxTarget, prepareRemoteFiles } from "./runtime.js";

export interface RemoteHelperPin {
    name: string;
    version: string;
    target: string;
    url: string;
    sha256: string;
    binary: string;
    binarySha256: string;
    license: string;
    licenseUrl: string;
    licenseSha256: string;
}

export interface RemoteHelper {
    pin: RemoteHelperPin;
    binary: Uint8Array;
    notice: Uint8Array;
}

export interface RemoteHelperPlatform {
    os: string;
    arch: string;
}

/** Binary digests are derived from the verified upstream archives, not local metadata. */
export function remoteHelperPins(platform: RemoteHelperPlatform): RemoteHelperPin[] {
    const target = linuxTarget(platform);
    const pins = manifest.helpers.filter((pin) => pin.target === target);
    if (pins.length !== 2 || !["cymbal", "ketch"].every((name) => pins.some((pin) => pin.name === name))) {
        throw new Error(`Missing remote helper pins for ${target}`);
    }
    for (const pin of pins) {
        if (
            ![pin.sha256, pin.binarySha256, pin.licenseSha256].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
            pin.binary !== pin.name ||
            !/^v\d+\.\d+\.\d+$/.test(pin.version)
        )
            throw new Error("Invalid remote helper pin");
    }
    return pins;
}

/** Sole owner of both helper cache layouts. Remote locators always use POSIX separators. */
export function remoteHelperPaths(pin: RemoteHelperPin, remoteHome: string, laptopHome = getHomeDir()) {
    const parts = [pin.name, pin.version, pin.target, pin.sha256];
    return {
        laptop: join(laptopHome, ".cache", "runwield", "remote", "helpers", ...parts),
        remote: `${remoteHome}/.cache/runwield/helpers/${parts.join("/")}`,
        cacheParts: ["helpers", ...parts],
    };
}

async function checked(bytes: Uint8Array, checksum: string, label: string): Promise<Uint8Array> {
    if ((await sha256Bytes(bytes)) !== checksum) throw new Error(`Remote helper ${label} checksum mismatch`);
    return bytes;
}

async function tar(args: string[]): Promise<Uint8Array> {
    const result = await captureForegroundProcess("tar", { args, cwd: getCwd() });
    if (result.code !== 0) throw new Error(`Invalid helper archive: ${new TextDecoder().decode(result.stderr)}`);
    return result.stdout;
}

async function verifyCache(pin: RemoteHelperPin, directory: string): Promise<RemoteHelper> {
    await checked(await readFile(join(directory, "archive.tar.gz")), pin.sha256, "archive");
    // Never extract paths to disk. Select only the exact root member from a verified archive.
    const binary = await checked(
        await tar(["-xOzf", join(directory, "archive.tar.gz"), "--", pin.binary]),
        pin.binarySha256,
        "binary",
    );
    const notice = await checked(await readFile(join(directory, "LICENSE")), pin.licenseSha256, "license");
    return { pin, binary, notice };
}

async function download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Cannot download remote helper ${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

/** A complete cache entry includes the notice, so a warm laptop can repair an offline server. */
export async function obtainRemoteHelpers(
    platform: RemoteHelperPlatform,
    signal?: AbortSignal,
): Promise<RemoteHelper[]> {
    const helpers: RemoteHelper[] = [];
    for (const pin of remoteHelperPins(platform)) {
        const cache = remoteHelperPaths(pin, "").laptop;
        const parent = dirname(cache);
        await mkdir(parent, { recursive: true });
        const lock = openNativeFileLock(join(parent, `.${pin.sha256}.lock`));
        try {
            while (!lock.tryLockSync(true)) {
                signal?.throwIfAborted();
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            signal?.throwIfAborted();
            try {
                helpers.push(await verifyCache(pin, cache));
                continue;
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
                await rm(cache, { recursive: true, force: true });
            }
            const stage = await mkdtemp(join(parent, ".stage-"));
            try {
                const archive = await checked(await download(pin.url, signal), pin.sha256, "archive");
                const notice = await checked(await download(pin.licenseUrl, signal), pin.licenseSha256, "license");
                await writeFile(join(stage, "archive.tar.gz"), archive);
                await writeFile(join(stage, "LICENSE"), notice);
                helpers.push(await verifyCache(pin, stage));
                await rename(stage, cache);
            } finally {
                await rm(stage, { recursive: true, force: true });
            }
        } finally {
            lock.close();
        }
    }
    return helpers;
}

export async function prepareRemoteHelpers(
    host: string,
    remoteHome: string,
    helpers: RemoteHelper[],
    signal?: AbortSignal,
): Promise<void> {
    for (const { pin, binary, notice } of helpers) {
        const paths = remoteHelperPaths(pin, remoteHome);
        const result = await prepareRemoteFiles(
            host,
            {
                kind: "helper",
                cacheParts: paths.cacheParts,
                files: [
                    { name: pin.binary, sha256: pin.binarySha256, size: binary.length, executable: true },
                    { name: "LICENSE", sha256: pin.licenseSha256, size: notice.length, executable: false },
                ],
            },
            [binary, notice],
            "ssh",
            signal,
        );
        if (result.path !== `${paths.remote}/${pin.binary}`)
            throw new Error("Remote helper returned an unexpected cache path");
    }
}

/** Run before the supervisor starts any view or model proof process. No PATH fallback is permitted. */
export async function verifiedRemoteHelperPath(platform: RemoteHelperPlatform, inheritedPath: string): Promise<string> {
    const directories: string[] = [];
    try {
        for (const pin of remoteHelperPins(platform)) {
            const directory = remoteHelperPaths(pin, getHomeDir()).remote;
            // Refuse symlinks in the complete private path, not just the leaf.
            let current = getHomeDir();
            for (const part of directory.slice(current.length + 1).split("/")) {
                current += `/${part}`;
                const info = await lstat(current);
                if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
                    throw new Error("Unsafe helper directory");
                }
            }
            for (const [name, checksum, executable] of [
                [pin.binary, pin.binarySha256, true],
                ["LICENSE", pin.licenseSha256, false],
            ] as const) {
                const path = `${directory}/${name}`;
                const info = await lstat(path);
                if (
                    !info.isFile() ||
                    info.uid !== process.getuid?.() ||
                    (info.mode & 0o077) !== 0 ||
                    (executable && !(info.mode & 0o100))
                ) {
                    throw new Error("Unsafe helper file");
                }
                await checked(await readFile(path), checksum, name);
            }
            directories.push(directory);
        }
    } catch (error) {
        throw new Error(
            `Private remote helper is missing or damaged. Reconnect to repair it. ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return [...directories, inheritedPath].join(":");
}
