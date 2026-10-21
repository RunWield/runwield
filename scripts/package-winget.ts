import type { RunWieldPackageInstall } from "../src/shared/package-install.ts";
import { captureScriptProcess } from "./script-process.ts";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * Generate WinGet manifests for a published RunWield Windows ZIP.
 */

import { join } from "node:path";
import { parseReleaseTag } from "./release.js";
import { sha256 } from "./package-windows.ts";

export interface WingetPackageOptions {
    tag: string;
    output: string;
    baseUrl: string;
    testOnly: boolean;
}

interface PublishedPackageMetadata extends RunWieldPackageInstall {
    [field: string]: RunWieldPackageInstall[keyof RunWieldPackageInstall];
}

const RUNWIELD_REPO = "gandazgul/runwield";
const PACKAGE_ID = "Gandazgul.RunWield";
const PUBLISHER = "Gandazgul";
const PACKAGE_NAME = "RunWield";

function usage() {
    return "Usage: package-winget.js --tag <stable-tag> --output <dir> [--base-url <release-asset-base-url>] [--test-only]";
}

export function parsePackageWingetArgs(args: string[]): WingetPackageOptions {
    const options = { tag: "", output: "", baseUrl: "", testOnly: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--tag") options.tag = args[++index] || "";
        else if (arg === "--output") options.output = args[++index] || "";
        else if (arg === "--base-url") options.baseUrl = args[++index] || "";
        else if (arg === "--test-only") options.testOnly = true;
        else throw new Error(`Unknown package:winget option: ${arg}\n${usage()}`);
    }
    if (!options.tag || !options.output) throw new Error(usage());
    if (options.baseUrl && !options.testOnly) throw new Error("Base URL overrides require --test-only.");
    return options;
}

async function readUrlBytes(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
    return new Uint8Array(await response.arrayBuffer());
}

function assetBaseUrl(tag: string, baseUrl: string) {
    return baseUrl || `https://github.com/${RUNWIELD_REPO}/releases/download/${tag}`;
}

function renderVersionManifest(version: string) {
    return `# Created by bun run package:winget
# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.10.0.schema.json
PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.10.0
`;
}

function renderLocaleManifest(version: string) {
    return `# Created by bun run package:winget
# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.10.0.schema.json
PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${PUBLISHER}
PublisherUrl: https://github.com/gandazgul
PublisherSupportUrl: https://github.com/gandazgul/runwield/issues
PrivacyUrl: https://runwield.dev/privacy/
PackageName: ${PACKAGE_NAME}
PackageUrl: https://github.com/gandazgul/runwield
License: Free Use License
LicenseUrl: https://github.com/gandazgul/runwield/blob/v${version}/LICENSE
ShortDescription: Plan-first AI coding harness.
Description: RunWield is a local, plan-first AI coding harness for software projects.
Tags:
- ai
- cli
- coding-agent
- runwield
ManifestType: defaultLocale
ManifestVersion: 1.10.0
`;
}

function renderInstallerManifest(version: string, url: string, checksum: string) {
    return `# Created by bun run package:winget
# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.10.0.schema.json
PackageIdentifier: ${PACKAGE_ID}
PackageVersion: ${version}
InstallerLocale: en-US
InstallerType: zip
Commands:
- wld
Dependencies:
  PackageDependencies:
  - PackageIdentifier: Git.Git
Installers:
- Architecture: x64
  InstallerUrl: ${url}
  InstallerSha256: ${checksum.toUpperCase()}
  NestedInstallerType: portable
  ArchiveBinariesDependOnPath: true
  NestedInstallerFiles:
  - RelativeFilePath: wld.exe
    PortableCommandAlias: wld
ManifestType: installer
ManifestVersion: 1.10.0
`;
}

async function run(command: string, args: string[], cwd?: string) {
    const result = await captureScriptProcess(command, { args, cwd, stdout: "piped", stderr: "piped" });
    if (result.success) return;
    const decoder = new TextDecoder();
    throw new Error(
        `${command} ${args.join(" ")} failed:\n${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    );
}

async function readPublishedChecksum(url: string) {
    const bytes = await readUrlBytes(`${url}.sha256`);
    const text = new TextDecoder().decode(bytes).trim();
    const checksum = text.split(/\s+/)[0]?.toLowerCase() || "";
    if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error("Published Windows ZIP checksum file is invalid.");
    return checksum;
}

async function assertFile(root: string, path: string) {
    const stat = await fsStat(join(root, path)).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Published Windows ZIP is missing ${path}.`);
}

async function assertZipHasPackageMetadata(bytes: Uint8Array, versionTag: string) {
    const work = await fsMkdtemp(join(tmpdir(), "runwield-winget-zip-"));
    try {
        const zipPath = join(work, "package.zip");
        const extractDir = join(work, "extract");
        await fsWriteFile(zipPath, bytes);
        await fsMkdir(extractDir, { recursive: true });
        await run("unzip", ["-q", zipPath, "-d", extractDir]);
        for (const path of [
            "wld.exe",
            "runwield-install.json",
            "runtime/helpers/mnemoteca.exe",
            "runtime/helpers/cymbal.exe",
            "runtime/helpers/ketch.exe",
            "runtime/helpers/agent-browser.exe",
            "licenses/RUNWIELD-LICENSE.txt",
            "licenses/mnemoteca-LICENSE.txt",
            "licenses/cymbal-LICENSE.txt",
            "licenses/ketch-LICENSE.txt",
            "licenses/agent-browser-LICENSE.txt",
        ])
            await assertFile(extractDir, path);
        const metadata: PublishedPackageMetadata = JSON.parse(
            await fsReadFile(join(extractDir, "runwield-install.json"), "utf8"),
        );
        const expectedMetadata = {
            schemaVersion: 1,
            packageManager: "winget",
            packageIdentifier: PACKAGE_ID,
            updateCommand: `winget upgrade --id ${PACKAGE_ID} --exact`,
            repairCommand: `winget repair --id ${PACKAGE_ID} --exact`,
            installDirectory: ".",
            version: versionTag,
        };
        for (const [key, expected] of Object.entries(expectedMetadata)) {
            if (metadata[key] !== expected) {
                throw new Error(`Published Windows ZIP package metadata has invalid ${key}.`);
            }
        }
    } finally {
        await fsRm(work, { recursive: true }).catch(() => {});
    }
}

export async function packageWinget(options: WingetPackageOptions) {
    const parsed = parseReleaseTag(options.tag);
    if (parsed.kind !== "stable") throw new Error(`WinGet manifests require a Stable tag: ${options.tag}`);
    const version = parsed.tag.slice(1);
    const assetName = `wld-${parsed.tag}-windows-x64.zip`;
    const url = `${assetBaseUrl(parsed.tag, options.baseUrl).replace(/\/$/, "")}/${assetName}`;
    const bytes = await readUrlBytes(url);
    await assertZipHasPackageMetadata(bytes, parsed.tag);
    const checksum = await sha256(bytes);
    const publishedChecksum = await readPublishedChecksum(url);
    if (checksum !== publishedChecksum) {
        throw new Error(`Published Windows ZIP checksum mismatch: expected ${publishedChecksum}, got ${checksum}`);
    }

    const manifestDir = join(options.output, PACKAGE_ID, version);
    await fsRm(manifestDir, { recursive: true }).catch(() => {});
    await fsMkdir(manifestDir, { recursive: true });
    await fsWriteFile(join(manifestDir, `${PACKAGE_ID}.yaml`), renderVersionManifest(version));
    await fsWriteFile(join(manifestDir, `${PACKAGE_ID}.locale.en-US.yaml`), renderLocaleManifest(version));
    await fsWriteFile(
        join(manifestDir, `${PACKAGE_ID}.installer.yaml`),
        renderInstallerManifest(version, url, checksum),
    );
    await fsWriteFile(
        join(options.output, "runwield-winget-package.json"),
        `${JSON.stringify(
            { tag: parsed.tag, packageIdentifier: PACKAGE_ID, manifestDir, installerUrl: url, sha256: checksum },
            null,
            4,
        )}\n`,
    );
}

export async function main(args = process.argv.slice(2)) {
    await packageWinget(parsePackageWingetArgs(args));
}

if (import.meta.main) await main();
