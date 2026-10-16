import { captureScriptProcess } from "./script-process.ts";
import { tmpdir } from "node:os";
import { getCwd } from "../src/constants.js";
import {
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * Build the Windows x64 portable package ZIP from a compiled wld.exe and pinned helper assets.
 */

import { basename, join, resolve } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";
import { parseReleaseTag } from "./release.js";

const DEFAULT_INPUTS_PATH = "packaging/windows/tested-dependencies.json";
const PACKAGE_ID = "Gandazgul.RunWield";

/**
 * @typedef {Object} WindowsHelperInput
 * @property {string} name
 * @property {string} version
 * @property {string} url
 * @property {string} sha256
 * @property {string} license
 * @property {string} licenseUrl
 * @property {string[]} requiredFiles
 */

function usage() {
    return "Usage: package-windows.js --tag <tag> --binary <path-to-wld.exe> --output <dir> [--inputs <path>]";
}

/** @param {string[]} args */
export function parsePackageWindowsArgs(args) {
    const options = { tag: "", binary: "", output: "", inputsPath: DEFAULT_INPUTS_PATH };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--tag") options.tag = args[++index] || "";
        else if (arg === "--binary") options.binary = args[++index] || "";
        else if (arg === "--output") options.output = args[++index] || "";
        else if (arg === "--inputs") options.inputsPath = args[++index] || "";
        else throw new Error(`Unknown package:windows option: ${arg}\n${usage()}`);
    }
    if (!options.tag || !options.binary || !options.output || !options.inputsPath) throw new Error(usage());
    return options;
}

/** @param {Uint8Array} bytes */
export async function sha256(bytes) {
    const input = new Uint8Array(bytes.length);
    input.set(bytes);
    const hash = await crypto.subtle.digest("SHA-256", input.buffer);
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {string} url */
export function normalizeGitHubBlobUrl(url) {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return url;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 5 || parts[2] !== "blob") return url;
    const [owner, repo, , ref, ...pathParts] = parts;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${pathParts.join("/")}`;
}

/** @param {string} url */
async function readUrlBytes(url) {
    if (url.startsWith("file://")) return await fsReadFile(fromFileUrl(url));
    const response = await fetch(normalizeGitHubBlobUrl(url));
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`);
    return new Uint8Array(await response.arrayBuffer());
}

/** @param {string} name */
function sanitizeLicenseFileName(name) {
    return name.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** @param {string} binary @param {string} tag */
async function assertBinaryReleaseIdentity(binary, tag) {
    const bytes = await fsReadFile(binary);
    const text = new TextDecoder().decode(bytes);
    if (!text.includes(`"${tag}"`)) {
        throw new Error(`Compiled Windows binary does not contain the exact RunWield ${tag} release identity.`);
    }
}

/** @param {string} command @param {string[]} args @param {string} [cwd] */
async function run(command, args, cwd) {
    const result = await captureScriptProcess(command, {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
    });
    if (result.success) return;
    const decoder = new TextDecoder();
    throw new Error(
        `${command} ${args.join(" ")} failed:\n${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    );
}

/** @param {string} root @param {string} fileName @returns {Promise<string>} */
async function findFile(root, fileName) {
    for await (const entry of await fsReaddir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return path;
        if (entry.isDirectory()) {
            const found = await findFile(path, fileName);
            if (found) return found;
        }
    }
    return "";
}

/** @param {WindowsHelperInput} helper */
function renderNotice(helper) {
    return [
        `${helper.name} ${helper.version}`,
        `License: ${helper.license}`,
        `Source license: ${helper.licenseUrl}`,
        `Packaged asset: ${helper.url}`,
        `SHA-256: ${helper.sha256}`,
        "",
    ].join("\n");
}

/** @param {WindowsHelperInput} helper @param {string} helpersDir @param {string} licensesDir @param {string} downloadDir */
async function installHelper(helper, helpersDir, licensesDir, downloadDir) {
    const bytes = await readUrlBytes(helper.url);
    const actual = await sha256(bytes);
    if (actual !== String(helper.sha256).toLowerCase()) {
        throw new Error(`Checksum mismatch for ${helper.name}: expected ${helper.sha256}, got ${actual}`);
    }
    const assetPath = join(downloadDir, basename(new URL(helper.url).pathname));
    await fsWriteFile(assetPath, bytes);
    const extractDir = join(downloadDir, `${helper.name}-extract`);
    await fsMkdir(extractDir, { recursive: true });
    if (assetPath.toLowerCase().endsWith(".zip")) {
        await run("unzip", ["-q", assetPath, "-d", extractDir], getCwd());
    } else if (assetPath.toLowerCase().endsWith(".exe")) {
        await fsCopyFile(assetPath, join(extractDir, helper.requiredFiles[0]));
    } else {
        throw new Error(`Unsupported Windows helper asset: ${helper.url}`);
    }
    for (const required of helper.requiredFiles) {
        const found = await findFile(extractDir, required);
        if (!found) throw new Error(`Helper ${helper.name} asset is missing ${required}.`);
        await fsCopyFile(found, join(helpersDir, required));
    }
    const licenseBytes = await readUrlBytes(helper.licenseUrl);
    await fsWriteFile(join(licensesDir, `${sanitizeLicenseFileName(helper.name)}-LICENSE.txt`), licenseBytes);
    await fsWriteFile(join(licensesDir, `${helper.name}.NOTICE.txt`), renderNotice(helper));
}

/** @param {string} tag @param {string} [installDirectory] */
function packageMetadata(tag, installDirectory = ".") {
    return {
        schemaVersion: 1,
        packageManager: "winget",
        packageIdentifier: PACKAGE_ID,
        updateCommand: `winget upgrade --id ${PACKAGE_ID} --exact`,
        repairCommand: `winget repair --id ${PACKAGE_ID} --exact`,
        installDirectory,
        version: tag,
    };
}

/** @param {string} packageDir */
async function assertPackageComplete(packageDir) {
    for (
        const path of [
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
        ]
    ) {
        const stat = await fsStat(join(packageDir, path)).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Windows package is missing ${path}.`);
    }
}

/** @param {{ tag: string, binary: string, output: string, inputsPath: string }} options */
export async function packageWindows(options) {
    const parsed = parseReleaseTag(options.tag);
    const binaryStat = await fsStat(options.binary).catch(() => null);
    if (!binaryStat?.isFile()) throw new Error(`Compiled Windows binary not found: ${options.binary}`);
    await assertBinaryReleaseIdentity(options.binary, parsed.tag);
    const inputs = /** @type {{ packageIdentifier?: string, helpers?: WindowsHelperInput[] }} */ (JSON.parse(
        await fsReadFile(options.inputsPath, "utf8"),
    ));
    if (inputs.packageIdentifier !== PACKAGE_ID) throw new Error(`Windows package identifier must be ${PACKAGE_ID}.`);
    if (!Array.isArray(inputs.helpers) || inputs.helpers.length === 0) {
        throw new Error("Windows helper inventory is empty.");
    }

    const output = resolve(options.output);
    await fsMkdir(output, { recursive: true });
    const work = await fsMkdtemp(join(tmpdir(), "runwield-windows-package-"));
    try {
        const packageDir = join(work, "package");
        const helpersDir = join(packageDir, "runtime", "helpers");
        const licensesDir = join(packageDir, "licenses");
        const downloadsDir = join(work, "downloads");
        await Promise.all([
            fsMkdir(helpersDir, { recursive: true }),
            fsMkdir(licensesDir, { recursive: true }),
            fsMkdir(downloadsDir, { recursive: true }),
        ]);
        await fsCopyFile(options.binary, join(packageDir, "wld.exe"));
        await fsWriteFile(
            join(packageDir, "runwield-install.json"),
            `${JSON.stringify(packageMetadata(parsed.tag), null, 4)}\n`,
        );
        await fsCopyFile("LICENSE", join(licensesDir, "RUNWIELD-LICENSE.txt"));
        for (const helper of inputs.helpers) await installHelper(helper, helpersDir, licensesDir, downloadsDir);
        await assertPackageComplete(packageDir);

        const zipName = `wld-${parsed.tag}-windows-x64.zip`;
        const zipPath = join(output, zipName);
        await fsRm(zipPath).catch(() => {});
        await run("zip", ["-qr", zipPath, "."], packageDir);
        const zipBytes = await fsReadFile(zipPath);
        const sum = await sha256(zipBytes);
        await fsWriteFile(join(output, `${zipName}.sha256`), `${sum}  ${zipName}\n`);
        await fsWriteFile(
            join(output, "runwield-windows-package.json"),
            `${
                JSON.stringify({ tag: parsed.tag, asset: zipName, sha256: sum, packageIdentifier: PACKAGE_ID }, null, 4)
            }\n`,
        );
    } finally {
        await fsRm(work, { recursive: true }).catch(() => {});
    }
}

export async function main(args = process.argv.slice(2)) {
    await packageWindows(parsePackageWindowsArgs(args));
}

if (import.meta.main) await main();
