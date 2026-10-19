import { bashFixturePath } from "./bash-fixture.ts";
import { test } from "node:test";
import { readFile as fsReadFile, rm as fsRm, stat as fsStat } from "node:fs/promises";
import { assertEquals, assertRejects, assertStringIncludes } from "../src/testing/assertions.ts";
import { join } from "node:path";

import { createFixture, readCurlLog, runInstaller, runInstallerInPseudoTty } from "./install-test-helpers.js";

test("install.sh delegates missing Mnemoteca installs to the official installer", async (t) => {
    await t.test("sandbox database variable present", async () => {
        const fixture = await createFixture();
        try {
            const result = await runInstaller(fixture, {
                extraEnv: { MNEMOTECA_DB_PATH: join(fixture.root, "memory.db") },
            });
            assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
            const curlLog = await readCurlLog(fixture.curlLog);
            assertEquals(curlLog.split("raw.githubusercontent.com/gandazgul/mnemoteca/main/install.sh").length - 1, 1);
            const installerLog = await fsReadFile(fixture.mnemotecaInstallerLog, "utf8");
            assertStringIncludes(installerLog, "repo=gandazgul/mnemoteca");
            assertStringIncludes(installerLog, `install_dir=${bashFixturePath(fixture.installDir)}`);
            assertStringIncludes(installerLog, `db_path=${join(fixture.root, "memory.db")}`);
            const stat = await fsStat(join(fixture.installDir, "mnemoteca"));
            assertEquals(stat.isFile(), true);
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });

    await t.test("sandbox database variable absent", async () => {
        const fixture = await createFixture();
        try {
            const result = await runInstaller(fixture, { unsetEnv: ["MNEMOTECA_DB_PATH"] });
            assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
            const curlLog = await readCurlLog(fixture.curlLog);
            assertEquals(curlLog.split("raw.githubusercontent.com/gandazgul/mnemoteca/main/install.sh").length - 1, 1);
            const installerLog = await fsReadFile(fixture.mnemotecaInstallerLog, "utf8");
            assertStringIncludes(installerLog, "db_path=unset");
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });
});

test("install.sh rejects Mnemoteca installer failure and false success", async (t) => {
    await t.test("installer exits with failure", async () => {
        const fixture = await createFixture({ mnemotecaInstallerFails: true });
        try {
            const result = await runInstaller(fixture);
            assertEquals(result.code, 1);
            assertStringIncludes(result.stderr, "Mnemoteca installer failed");
            assertStringIncludes(result.stderr, "Required helper Mnemoteca could not be installed");
            assertEquals(
                Reflect.get(await assertRejects(() => fsStat(join(fixture.installDir, "mnemoteca")), Error), "code"),
                "ENOENT",
            );
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });

    await t.test("installer exits without producing executable", async () => {
        const fixture = await createFixture({ mnemotecaInstallerSkipsExecutable: true });
        try {
            const result = await runInstaller(fixture);
            assertEquals(result.code, 1);
            assertStringIncludes(result.stderr, "did not produce executable");
            assertStringIncludes(result.stderr, "Required helper Mnemoteca could not be installed");
            assertEquals(
                Reflect.get(await assertRejects(() => fsStat(join(fixture.installDir, "mnemoteca")), Error), "code"),
                "ENOENT",
            );
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });
});

test("install.sh forwards pseudo-terminal input to the delegated Mnemoteca installer", async () => {
    const fixture = await createFixture({ mnemotecaInstallerPrompts: true });
    try {
        const result = await runInstallerInPseudoTty(fixture, "\ny\n\nn\n");
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        const installerLog = await fsReadFile(fixture.mnemotecaInstallerLog, "utf8");
        assertStringIncludes(installerLog, "answer=y");
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh rejects missing or corrupt checksum coverage for archive helpers", async (t) => {
    await t.test("missing manifest entry and missing release asset digest", async () => {
        const fixture = await createFixture({ omitChecksumFor: "cymbal", omitDigestFor: "cymbal" });
        try {
            const result = await runInstaller(fixture);
            assertEquals(result.code, 1);
            assertStringIncludes(result.stderr, "Checksum manifest lacks an entry for cymbal");
            assertStringIncludes(result.stderr, "Could not find a SHA-256 release asset digest for cymbal");
            assertStringIncludes(result.stderr, "Checksum verification failed for cymbal");
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });

    await t.test("corrupt checksum", async () => {
        const fixture = await createFixture({ badChecksumFor: "cymbal" });
        try {
            const result = await runInstaller(fixture);
            assertEquals(result.code, 1);
            assertStringIncludes(result.stderr, "Checksum verification failed for cymbal");
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });

    await t.test("corrupt release asset digest", async () => {
        const fixture = await createFixture({ omitChecksumFor: "cymbal", badDigestFor: "cymbal" });
        try {
            const result = await runInstaller(fixture);
            assertEquals(result.code, 1);
            assertStringIncludes(result.stderr, "Checksum manifest lacks an entry for cymbal");
            assertStringIncludes(result.stderr, "Checksum verification failed for cymbal");
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });
});

test("install.sh accepts a RunWield archive when GitHub's asset digest repairs a stale manifest", async () => {
    const fixture = await createFixture({ badChecksumFor: "wld" });
    try {
        const result = await runInstaller(fixture);
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assertStringIncludes(result.stdout, "Using GitHub release asset digest for wld-");
        const stat = await fsStat(join(fixture.installDir, "wld"));
        assertEquals(stat.isFile(), true);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh rejects a RunWield archive when the manifest and GitHub digest both mismatch", async () => {
    const fixture = await createFixture({ badChecksumFor: "wld", badDigestFor: "wld" });
    try {
        const result = await runInstaller(fixture);
        assertEquals(result.code, 1);
        assertStringIncludes(result.stderr, "Checksum verification failed for wld-");
        assertEquals(
            Reflect.get(await assertRejects(() => fsStat(join(fixture.installDir, "wld")), Error), "code"),
            "ENOENT",
        );
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh rejects missing executables in required archive helper archives", async () => {
    const fixture = await createFixture({ missingExecutableFor: "cymbal" });
    try {
        const result = await runInstaller(fixture);
        assertEquals(result.code, 1);
        assertStringIncludes(result.stderr, "does not contain executable 'cymbal'");
        assertStringIncludes(result.stderr, "Required helper Cymbal could not be installed");
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh aborts on required helper download failure but not optional Snip failure", async (t) => {
    await t.test("required Cymbal failure", async () => {
        const fixture = await createFixture({ missingAssetFor: "cymbal" });
        try {
            const result = await runInstaller(fixture);
            assertEquals(result.code, 1);
            assertStringIncludes(result.stderr, "Failed to download cymbal archive");
            assertStringIncludes(result.stderr, "Required helper Cymbal could not be installed");
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });

    await t.test("optional Snip failure", async () => {
        const fixture = await createFixture({ missingAssetFor: "snip" });
        try {
            const result = await runInstaller(fixture);
            assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
            assertStringIncludes(result.stderr, "Warning: optional helper Snip could not be installed");
            for (const name of ["wld", "mnemoteca", "cymbal", "agent-browser"]) {
                const stat = await fsStat(join(fixture.installDir, name));
                assertEquals(stat.isFile(), true);
            }
            assertEquals(
                Reflect.get(await assertRejects(() => fsStat(join(fixture.installDir, "snip")), Error), "code"),
                "ENOENT",
            );
        } finally {
            await fsRm(fixture.root, { recursive: true });
        }
    });
});
