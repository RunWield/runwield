import { projects } from "@runwield/projects";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { test } from "node:test";
import { assertEquals, assertThrows } from "../testing/assertions.ts";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { getHomeDir } from "../constants.ts";

for (const platform of ["linux", "darwin", "windows"]) {
    test(`${platform} policy matches exact locations, not descendants or similar names`, () => {
        const home = platform === "windows" ? "C:\\Users\\Owner" : "/users/owner";
        const locations = projects.directory.systemLocations({ platform, home });
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
            assertEquals(projects.directory.isExactSystem(location, locations, platform), true, location);
            assertEquals(projects.directory.isExactSystem(`${location}/app`, locations, platform), false, location);
            assertEquals(projects.directory.isExactSystem(`${location}/./`, locations, platform), true);
            assertEquals(projects.directory.isExactSystem(`${location}/app/..`, locations, platform), true);
        }
        assertEquals(
            projects.directory.isExactSystem(platform === "windows" ? "C:\\binary" : "/binary", locations, platform),
            false,
        );
        assertEquals(
            projects.directory.isExactSystem(platform === "windows" ? "D:\\" : "/", locations, platform),
            true,
        );
        if (platform === "windows") {
            assertEquals(
                projects.directory.systemLocations({ platform, home, systemRoot: "D:\\Windows" }).includes("D:\\Users"),
                true,
            );
            assertEquals(projects.directory.isExactSystem("c:/users/OWNER/", locations, platform), true);
            assertEquals(projects.directory.isExactSystem("\\\\server\\share\\", locations, platform), true);
            assertEquals(projects.directory.isExactSystem("\\\\server\\share\\app", locations, platform), false);
        } else assertEquals(projects.directory.isExactSystem(home.toUpperCase(), locations, platform), false);
    });
}
test("real home and symlink aliases are classified without scanning or writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "directory-warning-"));
    try {
        const alias = join(dir, "home-alias");
        await symlink(getHomeDir(), alias);
        assertEquals(projects.directory.inspect(alias).classified, true);
        assertEquals(projects.directory.inspect(getHomeDir()).classified, true);
        assertEquals(projects.directory.inspect(dir).classified, false);
        assertThrows(() => projects.directory.inspect(join(dir, "missing")), Error, "ENOENT");
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
        const inspection = projects.directory.inspectMissingManaged(target);
        assertEquals(inspection.canonicalRoot, join(realpathSync.native(dir), "missing", "execution"));
        assertEquals(inspection.classified, false);
        assertThrows(() => projects.directory.inspect(target), Error, "ENOENT");
        assertEquals(
            [...readdirSync(dir, { withFileTypes: true })].map((entry) => entry.name),
            ["alias"],
        );
        const file = join(dir, "file");
        writeText(file, "not a directory");
        assertThrows(() => projects.directory.inspectMissingManaged(file), Error, "must be a directory");
        const dangling = join(dir, "dangling");
        symlinkSync(join(dir, "absent"), dangling);
        assertThrows(() => projects.directory.inspectMissingManaged(dangling), Error, "ENOENT");
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
            assertEquals(projects.directory.inspectMissingManaged(home).classified, true);
            assertEquals(projects.directory.inspectMissingManaged(join(alias, "absent-home")).classified, true);
            assertThrows(() => projects.directory.inspect(home), Error, "ENOENT");
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
