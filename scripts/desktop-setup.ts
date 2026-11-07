import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { desktopElectron, electronPackage } from "./desktop-paths.ts";

const electron = await desktopElectron();
const artifact = `electron-v${electron.version}-${process.platform}-${process.arch}.zip`;
const checksums: Record<string, string> = JSON.parse(await readFile(join(electronPackage, "checksums.json"), "utf8"));
if (!/^[a-f0-9]{64}$/.test(checksums[artifact] || "")) throw new Error(`No upstream checksum for ${artifact}.`);
const upstream = await fetch(
    `https://github.com/electron/electron/releases/download/v${electron.version}/SHASUMS256.txt`,
);
if (!upstream.ok) throw new Error(`Electron checksum request failed: ${upstream.status}.`);
const line = (await upstream.text())
    .split("\n")
    .find((line) => line.trim().split(/\s+/)[1]?.replace(/^\*/, "") === artifact);
if (!line || line.trim().split(/\s+/)[0] !== checksums[artifact])
    throw new Error("Electron package and upstream checksums do not match.");
const env = { ...process.env };
for (const key of Object.keys(env)) {
    if (/^electron_/i.test(key) || /^npm_config_(arch|platform|electron_)/i.test(key) || key === "force_no_cache")
        delete env[key];
}
const installer = spawn(process.execPath, [join(electronPackage, "install.js")], { env, stdio: "inherit" });
await new Promise<void>((resolve, reject) => {
    installer.once("error", reject);
    installer.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Electron setup exited with ${code}.`)),
    );
});
const version = (await readFile(join(electronPackage, "dist", "version"), "utf8")).trim().replace(/^v/, "");
const executable = (await readFile(join(electronPackage, "path.txt"), "utf8")).trim();
if (version !== electron.version || executable !== electron.relative)
    throw new Error("Electron binary identity does not match the locked dependency.");
console.log(`Electron ${version} provisioned with the upstream SHA-256 archive checksum.`);
