import { mkdtempSync, readdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { test } from "node:test";
import { assertEquals, assertThrows } from "../testing/assertions.ts";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { getHomeDir } from "../constants.js";
import {
    inspectMissingManagedProjectDirectory,
    inspectProjectDirectory,
    isExactSystemDirectory,
    systemDirectoryLocations,
} from "./project-directory.ts";

for (const platform of ["linux", "darwin", "windows"]) {
    test(`${platform} policy matches exact locations, not descendants or similar names`, () => {
        const home = platform === "windows" ? "C:\\Users\\Owner" : "/users/owner";
        const locations = systemDirectoryLocations({ platform, home });
        const posix = [
            "/bin",
            "/sbin",
            "/etc",
            "/usr",
            "/usr/bin",
            "/usr/sbin",
            "/usr/lib",
            "/usr/lib64",
            "/usr/local",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/local/lib",
            "/var",
            "/var/log",
            "/var/lib",
            "/var/cache",
            "/var/run",
            "/tmp",
            "/opt",
            "/home",
            "/root",
            "/lib",
            "/lib64",
            "/boot",
            "/dev",
            "/proc",
            "/sys",
            "/run",
            "/srv",
            "/mnt",
            "/media",
        ];
        const expected =
            platform === "windows"
                ? [home, "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData", "C:\\Users"]
                : [
                      home,
                      ...posix,
                      ...(platform === "darwin"
                          ? [
                                "/Applications",
                                "/Library",
                                "/System",
                                "/Users",
                                "/Volumes",
                                "/private",
                                "/private/etc",
                                "/private/tmp",
                                "/private/var",
                            ]
                          : []),
                  ];
        assertEquals(locations, expected);
        for (const location of expected) {
            assertEquals(isExactSystemDirectory(location, locations, platform), true, location);
            assertEquals(isExactSystemDirectory(`${location}/app`, locations, platform), false, location);
            assertEquals(isExactSystemDirectory(`${location}/./`, locations, platform), true);
            assertEquals(isExactSystemDirectory(`${location}/app/..`, locations, platform), true);
        }
        assertEquals(
            isExactSystemDirectory(platform === "windows" ? "C:\\binary" : "/binary", locations, platform),
            false,
        );
        assertEquals(isExactSystemDirectory(platform === "windows" ? "D:\\" : "/", locations, platform), true);
        if (platform === "windows") {
            assertEquals(
                systemDirectoryLocations({ platform, home, systemRoot: "D:\\Windows" }).includes("D:\\Users"),
                true,
            );
            assertEquals(isExactSystemDirectory("c:/users/OWNER/", locations, platform), true);
            assertEquals(isExactSystemDirectory("\\\\server\\share\\", locations, platform), true);
            assertEquals(isExactSystemDirectory("\\\\server\\share\\app", locations, platform), false);
        } else assertEquals(isExactSystemDirectory(home.toUpperCase(), locations, platform), false);
    });
}
test("real home and symlink aliases are classified without scanning or writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "directory-warning-"));
    try {
        const alias = join(dir, "home-alias");
        await symlink(getHomeDir(), alias);
        assertEquals(inspectProjectDirectory(alias).classified, true);
        assertEquals(inspectProjectDirectory(getHomeDir()).classified, true);
        assertEquals(inspectProjectDirectory(dir).classified, false);
        assertThrows(() => inspectProjectDirectory(join(dir, "missing")), Error, "ENOENT");
        assertEquals(
            [...readdirSync(dir, { withFileTypes: true })].map((entry) => entry.name),
            ["home-alias"],
        );
    } finally {
        await rm(dir, { recursive: true });
    }
});

test("missing managed target uses its canonical ancestor without weakening selected roots", () => {
    const dir = mkdtempSync(join(tmpdir(), "directory-warning-"));
    try {
        const alias = join(dir, "alias");
        symlinkSync(dir, alias);
        const target = join(alias, "missing", "execution");
        const inspection = inspectMissingManagedProjectDirectory(target);
        assertEquals(inspection.canonicalRoot, join(realpathSync(dir), "missing", "execution"));
        assertEquals(inspection.classified, false);
        assertThrows(() => inspectProjectDirectory(target), Error, "ENOENT");
        assertEquals(
            [...readdirSync(dir, { withFileTypes: true })].map((entry) => entry.name),
            ["alias"],
        );
        const file = join(dir, "file");
        writeText(file, "not a directory");
        assertThrows(() => inspectMissingManagedProjectDirectory(file), Error, "must be a directory");
        const dangling = join(dir, "dangling");
        symlinkSync(join(dir, "absent"), dangling);
        assertThrows(() => inspectMissingManagedProjectDirectory(dangling), Error, "ENOENT");
    } finally {
        rmSync(dir, { recursive: true });
    }
});

test("missing managed home is classified through a canonical ancestor alias", async () => {
    await withProcessGlobalTestLock(() => {
        const dir = mkdtempSync(join(tmpdir(), "directory-warning-"));
        const previousHome = getEnv("HOME");
        const previousSandbox = getEnv("WLD_TEST_SANDBOX_HOME");
        try {
            const alias = join(dir, "alias");
            symlinkSync(dir, alias);
            const home = join(dir, "absent-home");
            setEnv("HOME", home);
            setEnv("WLD_TEST_SANDBOX_HOME", home);
            assertEquals(inspectMissingManagedProjectDirectory(home).classified, true);
            assertEquals(inspectMissingManagedProjectDirectory(join(alias, "absent-home")).classified, true);
            assertThrows(() => inspectProjectDirectory(home), Error, "ENOENT");
            assertEquals(
                [...readdirSync(dir, { withFileTypes: true })].map((entry) => entry.name),
                ["alias"],
            );
        } finally {
            if (previousHome === undefined) deleteEnv("HOME");
            else setEnv("HOME", previousHome);
            if (previousSandbox === undefined) deleteEnv("WLD_TEST_SANDBOX_HOME");
            else setEnv("WLD_TEST_SANDBOX_HOME", previousSandbox);
            rmSync(dir, { recursive: true });
        }
        return Promise.resolve();
    });
});

const getEnv = (key: string) => process.env[key];
const setEnv = (key: string, value: string) => {
    process.env[key] = value;
};
const deleteEnv = (key: string) => {
    delete process.env[key];
};

function writeText(path: string, text: string): void {
    writeFileSync(path, text);
}
