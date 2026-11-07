import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const desktopBuild = join(desktopRoot, "dist", "desktop");
export const electronPackage = join(desktopRoot, "node_modules", "electron");
interface RootManifest {
    devDependencies: { electron: string; "playwright-core": string };
}
interface ElectronManifest {
    name: string;
    version: string;
}
export async function desktopElectron() {
    const root: RootManifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
    const installed: ElectronManifest = JSON.parse(await readFile(join(electronPackage, "package.json"), "utf8"));
    if (
        installed.name !== "electron" ||
        installed.version !== root.devDependencies.electron ||
        !/^\d+\.\d+\.\d+$/.test(installed.version)
    )
        throw new Error("Install the exact locked Electron dependency with bun run install:locked.");
    const relative =
        process.platform === "darwin"
            ? "Electron.app/Contents/MacOS/Electron"
            : process.platform === "win32"
              ? "electron.exe"
              : "electron";
    return { version: installed.version, relative, executable: join(electronPackage, "dist", relative) };
}
export async function requireDesktopArtifacts(): Promise<void> {
    const electron = await desktopElectron();
    try {
        await access(electron.executable);
        const version = (await readFile(join(electronPackage, "dist", "version"), "utf8")).trim().replace(/^v/, "");
        if (version !== electron.version) throw new Error("Electron binary version does not match the locked package.");
    } catch (error) {
        throw new Error("Run bun run desktop:setup to provision the locked Electron binary.", { cause: error });
    }
    try {
        for (const file of ["main.mjs", "preload.cjs", "renderer/index.html"]) await access(join(desktopBuild, file));
    } catch (error) {
        throw new Error("Run bun run desktop:build before focused desktop tests.", { cause: error });
    }
    if (process.platform === "linux" && !process.env.DISPLAY)
        throw new Error("A graphical display is required. Use xvfb-run -a bun run desktop:test.");
}
