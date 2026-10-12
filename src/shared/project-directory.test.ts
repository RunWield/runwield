import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { getHomeDir } from "../constants.js";
import {
    inspectMissingManagedProjectDirectory,
    inspectProjectDirectory,
    isExactSystemDirectory,
    systemDirectoryLocations,
} from "./project-directory.ts";

for (const platform of ["linux", "darwin", "windows"]) {
    Deno.test(`${platform} policy matches exact locations, not descendants or similar names`, () => {
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
        const expected = platform === "windows"
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
Deno.test("real home and symlink aliases are classified without scanning or writing", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const alias = join(dir, "home-alias");
        await Deno.symlink(getHomeDir(), alias);
        assertEquals(inspectProjectDirectory(alias).classified, true);
        assertEquals(inspectProjectDirectory(getHomeDir()).classified, true);
        assertEquals(inspectProjectDirectory(dir).classified, false);
        assertThrows(() => inspectProjectDirectory(join(dir, "missing")), Deno.errors.NotFound);
        assertEquals([...Deno.readDirSync(dir)].map((entry) => entry.name), ["home-alias"]);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("missing managed target uses its canonical ancestor without weakening selected roots", () => {
    const dir = Deno.makeTempDirSync();
    try {
        const alias = join(dir, "alias");
        Deno.symlinkSync(dir, alias);
        const target = join(alias, "missing", "execution");
        const inspection = inspectMissingManagedProjectDirectory(target);
        assertEquals(inspection.canonicalRoot, join(Deno.realPathSync(dir), "missing", "execution"));
        assertEquals(inspection.classified, false);
        assertThrows(() => inspectProjectDirectory(target), Deno.errors.NotFound);
        assertEquals([...Deno.readDirSync(dir)].map((entry) => entry.name), ["alias"]);
        const file = join(dir, "file");
        Deno.writeTextFileSync(file, "not a directory");
        assertThrows(() => inspectMissingManagedProjectDirectory(file), Error, "must be a directory");
        const dangling = join(dir, "dangling");
        Deno.symlinkSync(join(dir, "absent"), dangling);
        assertThrows(() => inspectMissingManagedProjectDirectory(dangling), Deno.errors.NotFound);
    } finally {
        Deno.removeSync(dir, { recursive: true });
    }
});

Deno.test("missing managed home is classified through a canonical ancestor alias", async () => {
    await withProcessGlobalTestLock(() => {
        const dir = Deno.makeTempDirSync();
        const previousHome = Deno.env.get("HOME");
        const previousSandbox = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        try {
            const alias = join(dir, "alias");
            Deno.symlinkSync(dir, alias);
            const home = join(dir, "absent-home");
            Deno.env.set("HOME", home);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", home);
            assertEquals(inspectMissingManagedProjectDirectory(home).classified, true);
            assertEquals(inspectMissingManagedProjectDirectory(join(alias, "absent-home")).classified, true);
            assertThrows(() => inspectProjectDirectory(home), Deno.errors.NotFound);
            assertEquals([...Deno.readDirSync(dir)].map((entry) => entry.name), ["alias"]);
        } finally {
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            if (previousSandbox === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", previousSandbox);
            Deno.removeSync(dir, { recursive: true });
        }
        return Promise.resolve();
    });
});
