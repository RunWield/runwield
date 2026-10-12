import { captureScriptProcess } from "./script-process.ts";
import { copyFile as fsCopyFile, mkdir as fsMkdir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import process from "node:process";
/**
 * Run local Homebrew checks for a rendered tap.
 */

import { resolve } from "node:path";

const TAP_NAME = "gandazgul/tap";

function usage() {
    return "Usage: package-homebrew-check.js --tap <directory>";
}

/** @param {string[]} args */
function parseArgs(args) {
    let tap = "";
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--tap") tap = args[++index] || "";
        else throw new Error(`Unknown package:homebrew:check option: ${arg}\n${usage()}`);
    }
    if (!tap) throw new Error(usage());
    return { tap };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {boolean} allowFailure
 * @param {boolean} capture
 */
async function run(command, args, cwd, allowFailure = false, capture = false) {
    console.error(`$ ${command} ${args.join(" ")}`);
    const output = await captureScriptProcess(command, {
        args,
        cwd,
        stdout: capture ? "piped" : "inherit",
        stderr: capture ? "piped" : "inherit",
    });
    if (!capture) {
        if (!output.success && !allowFailure) {
            throw new Error(`${command} ${args.join(" ")} failed with exit code ${output.code}`);
        }
        return { success: output.success, stdout: "", stderr: "" };
    }
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success && !allowFailure) {
        throw new Error(`${command} ${args.join(" ")} failed with exit code ${output.code}:\n${stdout}${stderr}`);
    }
    return { success: output.success, stdout, stderr };
}

/** @param {string} tap */
async function ensureGitTap(tap) {
    const gitDir = await fsStat(`${tap}/.git`).then((stat) => stat.isDirectory()).catch(() => false);
    if (!gitDir) await run("git", ["init"], tap);
    await run("git", ["add", "."], tap);
    const status = await run("git", ["status", "--porcelain"], tap, false, true);
    if (!status.stdout.trim()) return;
    await run("git", [
        "-c",
        "user.name=RunWield",
        "-c",
        "user.email=runwield@example.invalid",
        "commit",
        "-m",
        "Prepare tap",
    ], tap);
}

/**
 * @param {string} existingPath
 * @param {string} tap
 */
async function isCloneOfTap(existingPath, tap) {
    const origin = await run("git", ["-C", existingPath, "config", "--get", "remote.origin.url"], tap, true, true);
    if (!origin.success) return false;
    const expected = `file://${resolve(tap)}`;
    return origin.stdout.trim() === expected ||
        resolve(origin.stdout.trim().replace(/^file:\/\//, "")) === resolve(tap);
}

/** @param {string} path */
async function fileSha256(path) {
    const hash = await crypto.subtle.digest("SHA-256", await fsReadFile(path));
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {string} fromTap
 * @param {string} toTap
 */
async function copyRenderedTapFiles(fromTap, toTap) {
    await fsMkdir(`${toTap}/Formula`, { recursive: true });
    for (const path of ["Formula/wld.rb", "Formula/mnemoteca.rb", "README.md", "runwield-homebrew-package.json"]) {
        await fsCopyFile(`${fromTap}/${path}`, `${toTap}/${path}`);
    }
}

/** @param {string} tap */
async function registeredTapPath(tap) {
    const existing = await run("brew", ["--repo", TAP_NAME], tap, true, true);
    if (!existing.success) return "";
    const existingPath = resolve(existing.stdout.trim());
    const exists = await fsStat(existingPath).then((stat) => stat.isDirectory()).catch((error) => {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
        throw error;
    });
    if (!exists) return "";
    if (existingPath !== resolve(tap) && !(await isCloneOfTap(existingPath, tap))) {
        throw new Error(`Homebrew tap ${TAP_NAME} already points at ${existingPath}. Untap it or pass that path.`);
    }
    if (existingPath !== resolve(tap)) await copyRenderedTapFiles(tap, existingPath);
    return existingPath;
}

/** @param {string} tap */
async function readManifest(tap) {
    const text = await fsReadFile(`${tap}/runwield-homebrew-package.json`, "utf8");
    return JSON.parse(text);
}

/**
 * @param {string} tap
 * @param {string} wldTag
 */
async function assertInstalledRunWieldPackage(tap, wldTag) {
    const prefix = (await run("brew", ["--prefix", "gandazgul/tap/wld"], tap, false, true)).stdout.trim();
    const metadata = JSON.parse(await fsReadFile(`${prefix}/libexec/runwield-install.json`, "utf8"));
    if (metadata.packageManager !== "homebrew" || metadata.packageIdentifier !== "gandazgul/tap/wld") {
        throw new Error("Installed RunWield artifact is missing Homebrew ownership metadata.");
    }
    if (metadata.version !== wldTag || metadata.updateCommand !== "brew upgrade gandazgul/tap/wld") {
        throw new Error(`Installed RunWield metadata does not match ${wldTag}.`);
    }
    const executable = `${prefix}/bin/wld`;
    const version = (await run(executable, ["--version"], tap, false, true)).stdout;
    if (!version.includes(wldTag)) throw new Error(`Installed wld does not report ${wldTag}: ${version}`);
    return executable;
}

/**
 * @param {string} tap
 * @param {string} executable
 */
async function assertPackageUpdateAliases(tap, executable) {
    for (const alias of ["update", "upgrade"]) {
        const output = await run(executable, [alias], tap, false, true);
        if (!output.stdout.includes("brew upgrade gandazgul/tap/wld")) {
            throw new Error(`wld ${alias} did not report the Homebrew upgrade command.`);
        }
    }
}

export async function main(args = process.argv.slice(2)) {
    const { tap } = parseArgs(args);
    if (process.platform !== "darwin") throw new Error("Homebrew package checks must run on macOS.");
    await fsStat(`${tap}/Formula/wld.rb`);
    await fsStat(`${tap}/Formula/mnemoteca.rb`);
    const manifest = await readManifest(tap);
    if (!manifest.wldTag || !manifest.mnemotecaTag) {
        throw new Error("Package manifest must name wldTag and mnemotecaTag.");
    }
    await ensureGitTap(tap);
    const registeredTap = await registeredTapPath(tap);
    if (!registeredTap) {
        const tapUrl = `file://${resolve(tap)}`;
        await run("brew", ["trust", tapUrl], tap);
        await run("brew", ["tap", TAP_NAME, tapUrl], tap);
    }
    await run("brew", ["audit", "--strict", "--formula", "gandazgul/tap/wld", "gandazgul/tap/mnemoteca"], tap);
    await run("brew", ["install", "gandazgul/tap/mnemoteca"], tap);
    await run("brew", ["install", "gandazgul/tap/wld"], tap);
    const executable = await assertInstalledRunWieldPackage(tap, manifest.wldTag);
    const installedHash = await fileSha256(executable);
    await assertPackageUpdateAliases(tap, executable);
    if (await fileSha256(executable) !== installedHash) {
        throw new Error("wld update aliases changed the installed package bytes.");
    }
    await run("brew", ["test", "gandazgul/tap/mnemoteca"], tap);
    await run("brew", ["test", "gandazgul/tap/wld"], tap);
    await run("brew", ["upgrade", "gandazgul/tap/mnemoteca", "gandazgul/tap/wld"], tap);
    const upgradedExecutable = await assertInstalledRunWieldPackage(tap, manifest.wldTag);
    if (await fileSha256(upgradedExecutable) !== installedHash) {
        throw new Error("brew upgrade changed the installed package bytes.");
    }
    await run("brew", ["uninstall", "gandazgul/tap/wld"], tap);
    const removed = await fsStat(upgradedExecutable).then(() => false).catch((error) => {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return true;
        throw error;
    });
    if (!removed) throw new Error("brew uninstall left the verified wld executable installed.");
    await run("brew", ["uninstall", "gandazgul/tap/mnemoteca"], tap);
    await run("brew", ["install", "gandazgul/tap/wld"], tap);
    const reinstalledExecutable = await assertInstalledRunWieldPackage(tap, manifest.wldTag);
    if (await fileSha256(reinstalledExecutable) !== installedHash) {
        throw new Error("brew reinstall did not restore the same package bytes.");
    }
    console.log("Homebrew formulas audited, installed, tested, upgraded, uninstalled, and ownership-checked.");
}

if (import.meta.main) await main();
