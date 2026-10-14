import { tmpdir } from "node:os";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/** Stage one checked, flat release asset set. Never change published bytes. */
import { join } from "node:path";
import { expectedReleaseAssetNames } from "./release.js";
import { verifyBuildArtifact } from "./build-metadata.js";
import { extractReleaseRuntime } from "../src/shared/remote/release-artifact.ts";

/**
 * Explicit development bundle. Never builds a missing runtime, and never
 * substitutes release assets for a development artifact.
 * @param {string} launcher
 * @param {string} linuxX64
 * @param {string} linuxArm64
 * @param {string} output
 */
export async function prepareDevelopmentArtifacts(launcher, linuxX64, linuxArm64, output) {
    const entries = [
        [launcher, "wld-launcher"],
        [linuxX64, "wld-x86_64-unknown-linux-gnu"],
        [linuxArm64, "wld-aarch64-unknown-linux-gnu"],
    ];
    const metadata = await Promise.all(entries.map(([path]) => verifyBuildArtifact(path)));
    if (
        metadata[1].target !== "x86_64-unknown-linux-gnu" ||
        metadata[2].target !== "aarch64-unknown-linux-gnu" ||
        metadata.some((item) =>
            item.buildId !== metadata[0].buildId || item.protocol !== metadata[0].protocol ||
            item.version !== metadata[0].version
        )
    ) {
        throw new Error("Development artifacts have mismatched build/protocol/VERSION or GNU targets");
    }
    await fsMkdir(output);
    for (const [path, name] of entries) {
        await fsCopyFile(path, join(output, name));
        await fsCopyFile(`${path}.build.json`, join(output, `${name}.build.json`));
    }
}

/**
 * @typedef {Object} PublishedAsset
 * @property {string} name
 * @property {string | null} digest
 * @typedef {Object} PublishedRelease
 * @property {PublishedAsset[]} assets
 */

/** @param {string} tag */
export function releaseAssetNames(tag) {
    return [
        ...expectedReleaseAssetNames(tag),
        `wld-${tag}-windows-x64.zip`,
        `wld-${tag}-windows-x64.zip.sha256`,
        "runwield-windows-package.json",
    ];
}

/** @param {string} directory @returns {Promise<string[]>} */
async function files(directory) {
    const result = [];
    for await (const entry of await fsReaddir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) result.push(...await files(path));
        else if (entry.isFile()) result.push(path);
        else throw new Error(`Unsupported release asset: ${path}`);
    }
    return result;
}

/** @param {string} path */
async function sha256(path) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await fsReadFile(path))))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} input
 * @param {string} output
 * @param {string} tag
 * @param {boolean} published
 * @param {string} publishedMetadata
 */
export async function prepareReleaseAssets(input, output, tag, published = false, publishedMetadata = "") {
    if (published && !publishedMetadata) throw new Error("Published recovery requires GitHub asset digests");
    const names = releaseAssetNames(tag);
    const paths = await files(input);
    const selected = new Map();
    for (const name of names) {
        if (name === "SHA256SUMS" && !published) continue;
        const matches = paths.filter((path) => path.split(/[\\/]/).pop() === name);
        if (matches.length !== 1) throw new Error(`Expected one ${name}; found ${matches.length}`);
        selected.set(name, matches[0]);
    }
    const sums = [];
    for (const name of names.filter((name) => name.endsWith(".sha256"))) {
        const asset = name.slice(0, -7);
        const expected = `${await sha256(selected.get(asset))}  ${asset}`;
        const actual = (await fsReadFile(selected.get(name), "utf8")).trim().replace(/\s+/, "  ");
        if (actual !== expected) throw new Error(`Release checksum mismatch: ${name}`);
        sums.push(expected);
    }
    if (published) {
        const actual = (await fsReadFile(selected.get("SHA256SUMS"), "utf8")).trim().split(/\r?\n/)
            .map((line) => line.replace(/\s+/, "  ")).sort();
        if (JSON.stringify(actual) !== JSON.stringify([...sums].sort())) {
            throw new Error("Published SHA256SUMS does not match the complete release set");
        }
    }
    // New publication validates the actual archive bytes against one launcher
    // identity. Published recovery must still accept immutable legacy assets
    // (which predate embedded metadata) after checking their GitHub digests.
    if (!published) {
        const stage = await fsMkdtemp(join(tmpdir(), "wld-release-verify-"));
        try {
            let launcher = null;
            for (const suffix of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) {
                const name = `wld-${tag}-${suffix}.tar.gz`;
                const directory = join(stage, suffix);
                await fsMkdir(directory);
                const { metadata } = await extractReleaseRuntime(selected.get(name), suffix, launcher, directory);
                if (!launcher) {
                    if (metadata.version !== tag) throw new Error("Release launcher VERSION does not match tag");
                    launcher = { buildId: metadata.buildId, protocol: metadata.protocol, version: metadata.version };
                }
            }
        } finally {
            await fsRm(stage, { recursive: true });
        }
    }
    if (publishedMetadata) {
        /** @type {PublishedRelease} */
        const metadata = JSON.parse(await fsReadFile(publishedMetadata, "utf8"));
        for (const [name, path] of selected) {
            const asset = metadata.assets.find((asset) => asset.name === name);
            if (asset?.digest !== `sha256:${await sha256(path)}`) {
                throw new Error(`Published asset digest missing or mismatched: ${name}`);
            }
        }
    }
    await fsMkdir(output);
    for (const [name, path] of selected) await fsCopyFile(path, join(output, name));
    if (!published) await fsWriteFile(join(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

if (import.meta.main) {
    if (process.argv.slice(2)[0] === "development") {
        if (process.argv.slice(2).length !== 5) {
            throw new Error(
                "Usage: release-assets.js development <launcher> <linux-x64> <linux-arm64> <output-directory>",
            );
        }
        await prepareDevelopmentArtifacts(
            process.argv.slice(2)[1],
            process.argv.slice(2)[2],
            process.argv.slice(2)[3],
            process.argv.slice(2)[4],
        );
        process.exit(0);
    }
    const [input, output, tag, mode, metadata] = process.argv.slice(2);
    if (!input || !output || !tag) throw new Error("Usage: release-assets.js <input> <output> <tag> [published]");
    if (mode === "published" && !metadata) throw new Error("Published recovery requires GitHub asset digests");
    await prepareReleaseAssets(input, output, tag, mode === "published", metadata);
}
