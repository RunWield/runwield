import { assertEquals } from "../testing/assertions.ts";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { platform } from "node:process";
import { join } from "node:path";
import {
    bundledHelperDirectoryForInstall,
    packageMetadataPathForExecutablePath,
    prependToPathEnv,
    readRunWieldPackageInstallSync,
} from "./package-install.ts";

test("package metadata is read beside the real executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-package-install-"));
    try {
        const libexec = join(root, "Cellar", "wld", "libexec");
        const bin = join(root, "bin");
        await mkdir(libexec, { recursive: true });
        await mkdir(bin, { recursive: true });
        const exe = join(libexec, "wld");
        const link = join(bin, "wld");
        await writeFile(exe, "fixture");
        await symlink(exe, link);
        await writeFile(
            join(libexec, "runwield-install.json"),
            JSON.stringify({
                schemaVersion: 1,
                packageManager: "homebrew",
                packageIdentifier: "gandazgul/tap/wld",
                updateCommand: "brew upgrade gandazgul/tap/wld",
                repairCommand: "brew reinstall gandazgul/tap/wld",
                installDirectory: libexec,
                version: "v1.2.3",
            }),
        );

        assertEquals(
            packageMetadataPathForExecutablePath(link),
            join(await realpath(libexec), "runwield-install.json"),
        );
        assertEquals(readRunWieldPackageInstallSync(link)?.updateCommand, "brew upgrade gandazgul/tap/wld");
        await writeFile(
            join(libexec, "runwield-install.json"),
            JSON.stringify({
                schemaVersion: 1,
                packageManager: "winget",
                packageIdentifier: "Gandazgul.RunWield",
                updateCommand: "winget upgrade --id Gandazgul.RunWield --exact",
                repairCommand: "winget repair --id Gandazgul.RunWield --exact",
                installDirectory: ".",
                version: "v1.2.3",
            }),
        );
        assertEquals(readRunWieldPackageInstallSync(link)?.installDirectory, await realpath(libexec));
    } finally {
        await rm(root, { recursive: true });
    }
});

test("invalid or absent package metadata does not classify a standalone executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-package-install-"));
    try {
        const exe = join(root, "wld");
        await writeFile(exe, "fixture");
        assertEquals(readRunWieldPackageInstallSync(exe), null);
        await writeFile(join(root, "runwield-install.json"), JSON.stringify({ packageManager: "homebrew" }));
        assertEquals(readRunWieldPackageInstallSync(exe), null);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("WinGet helper lookup requires a complete sibling helper directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield package install spaces-"));
    try {
        const helpers = join(root, "runtime", "helpers");
        await mkdir(helpers, { recursive: true });
        const suffix = platform === "win32" ? ".exe" : "";
        const install = {
            schemaVersion: 1 as const,
            packageManager: "winget" as const,
            packageIdentifier: "Gandazgul.RunWield",
            updateCommand: "winget upgrade --id Gandazgul.RunWield --exact",
            repairCommand: "winget repair --id Gandazgul.RunWield --exact",
            installDirectory: root,
            version: "v1.2.3",
        };
        for (const name of ["mnemoteca", "cymbal", "ketch"]) {
            await writeFile(join(helpers, `${name}${suffix}`), name);
        }
        assertEquals(bundledHelperDirectoryForInstall(install), null);
        await writeFile(join(helpers, `agent-browser${suffix}`), "agent-browser");
        assertEquals(bundledHelperDirectoryForInstall(install), helpers);
    } finally {
        await rm(root, { recursive: true });
    }
});

test("PATH prepending preserves Windows Path key casing", () => {
    const key = platform === "win32" ? "Path" : "PATH";
    const env = prependToPathEnv({ [key]: "C:\\Windows" }, "C:\\Run Wield\\runtime\\helpers");
    assertEquals(env[key].startsWith("C:\\Run Wield\\runtime\\helpers"), true);
});
