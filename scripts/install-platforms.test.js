import { test } from "node:test";
import {
    mkdir as fsMkdir,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { join } from "node:path";

import {
    BINARY_NAMES,
    createFixture,
    readCurlLog,
    RELEASE_BINARY_NAMES,
    repoPath,
    runInstaller,
    VERSIONS,
    writeExecutable,
} from "./install-test-helpers.js";

test("install.sh maps Darwin/Linux amd64/arm64 assets and preserves positional wld version", async (t) => {
    /** @type {Array<{ os: import("./install-test-helpers.js").TestOs, arch: import("./install-test-helpers.js").TestArch }>} */
    const platforms = [
        { os: "Darwin", arch: "x86_64" },
        { os: "Darwin", arch: "arm64" },
        { os: "Linux", arch: "x86_64" },
        { os: "Linux", arch: "arm64" },
    ];

    for (const platform of platforms) {
        await t.test(`${platform.os} ${platform.arch}`, async () => {
            const fixture = await createFixture(platform);
            try {
                const result = await runInstaller(fixture, { requestedVersion: VERSIONS.runwield });
                assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
                const curlLog = await readCurlLog(fixture.curlLog);
                for (const name of RELEASE_BINARY_NAMES) {
                    assertStringIncludes(curlLog, fixture.assets[name]);
                }
                for (const name of BINARY_NAMES) {
                    const stat = await fsStat(join(fixture.installDir, name));
                    assertEquals(stat.isFile(), true);
                }
                assertStringIncludes(curlLog, `/download/${VERSIONS.runwield}/${fixture.assets.wld}`);
            } finally {
                await fsRm(fixture.root, { recursive: true });
            }
        });
    }
});

test("install.sh falls back to GitHub web redirect when latest release API is unavailable", async () => {
    const fixture = await createFixture({ latestApiFailsFor: ["runwield"] });
    try {
        const result = await runInstaller(fixture, { requestedVersion: null });
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        const curlLog = await readCurlLog(fixture.curlLog);
        assertStringIncludes(curlLog, "https://api.github.com/repos/gandazgul/runwield/releases/latest");
        assertStringIncludes(curlLog, "https://github.com/gandazgul/runwield/releases/latest");
        assertStringIncludes(curlLog, `/download/${VERSIONS.runwield}/${fixture.assets.wld}`);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh preserves Mnemoteca on PATH without invoking its installer", async () => {
    const fixture = await createFixture();
    const externalBin = join(fixture.root, "external-bin");
    await fsMkdir(externalBin);
    await writeExecutable(join(externalBin, "mnemoteca"), "#!/usr/bin/env bash\necho external mnemoteca\n");
    try {
        const result = await runInstaller(fixture, { extraPathDir: externalBin });
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assertStringIncludes(result.stdout, "Preserving existing mnemoteca");
        const curlLog = await readCurlLog(fixture.curlLog);
        assertEquals(curlLog.includes("raw.githubusercontent.com/gandazgul/mnemoteca/main/install.sh"), false);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh preserves Mnemoteca in the install directory without invoking its installer", async () => {
    const fixture = await createFixture();
    await writeExecutable(join(fixture.installDir, "mnemoteca"), "#!/usr/bin/env bash\necho install-dir mnemoteca\n");
    try {
        const result = await runInstaller(fixture);
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assertStringIncludes(result.stdout, "Preserving existing mnemoteca");
        const curlLog = await readCurlLog(fixture.curlLog);
        assertEquals(curlLog.includes("raw.githubusercontent.com/gandazgul/mnemoteca/main/install.sh"), false);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh ignores a pre-rename compatibility executable when Mnemoteca is missing", async () => {
    const fixture = await createFixture();
    const externalBin = join(fixture.root, "external-bin");
    const oldName = "mnemo" + "syne";
    await fsMkdir(externalBin);
    await writeExecutable(join(externalBin, oldName), `#!/usr/bin/env bash\necho ${oldName}\n`);
    try {
        const result = await runInstaller(fixture, { extraPathDir: externalBin });
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        const curlLog = await readCurlLog(fixture.curlLog);
        assertEquals(curlLog.split("raw.githubusercontent.com/gandazgul/mnemoteca/main/install.sh").length - 1, 1);
        const stat = await fsStat(join(fixture.installDir, "mnemoteca"));
        assertEquals(stat.isFile(), true);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh preserves archive helpers on PATH and in install dir, and reruns skip archive downloads", async () => {
    const fixture = await createFixture();
    const externalBin = join(fixture.root, "external-bin");
    await fsMkdir(externalBin);
    await writeExecutable(join(externalBin, "mnemoteca"), "#!/usr/bin/env bash\necho external mnemoteca\n");
    await writeExecutable(join(fixture.installDir, "cymbal"), "#!/usr/bin/env bash\necho existing cymbal\n");
    await writeExecutable(join(fixture.installDir, "ketch"), "#!/usr/bin/env bash\necho existing ketch\n");
    try {
        const first = await runInstaller(fixture, { extraPathDir: externalBin });
        assertEquals(first.code, 0, `${first.stdout}\n${first.stderr}`);
        assertStringIncludes(first.stdout, "Preserving existing mnemoteca");
        assertStringIncludes(first.stdout, "Preserving existing cymbal");
        assertStringIncludes(first.stdout, "Preserving existing ketch");
        assertStringIncludes(first.stdout, "agent-browser");
        assertStringIncludes(first.stdout, "snip");

        await fsWriteFile(fixture.curlLog, "");
        const second = await runInstaller(fixture, { extraPathDir: externalBin });
        assertEquals(second.code, 0, `${second.stdout}\n${second.stderr}`);
        assertStringIncludes(second.stdout, "Preserving existing mnemoteca");
        assertStringIncludes(second.stdout, "Preserving existing cymbal");
        assertStringIncludes(second.stdout, "Preserving existing ketch");
        assertStringIncludes(second.stdout, "Preserving existing snip");
        const curlLog = await readCurlLog(fixture.curlLog);
        assertEquals(curlLog.includes("raw.githubusercontent.com/gandazgul/mnemoteca/main/install.sh"), false);
        assertEquals(curlLog.includes("cymbal_"), false);
        assertEquals(curlLog.includes("ketch_"), false);
        assertEquals(curlLog.includes("snip_"), false);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("ux:new-user image provisions Node 24 for required agent-browser helper", async () => {
    const containerfile = await fsReadFile(repoPath("Containerfile.wld-ux"), "utf8");
    assertStringIncludes(containerfile, "https://deb.nodesource.com/node_24.x");
    assertStringIncludes(containerfile, "node --version");
    assertStringIncludes(containerfile, "command -v wld mnemoteca cymbal ketch agent-browser snip");
});

test("ux:new-user tasks build latest and current targets from one containerfile", async () => {
    const packageJson = JSON.parse(await fsReadFile(repoPath("package.json"), "utf8"));
    assertStringIncludes(packageJson.scripts["ux:new-user"], "--target wld-ux-latest");
    assertStringIncludes(packageJson.scripts["ux:new-user"], "-f Containerfile.wld-ux");

    const currentTask = packageJson.scripts["ux:new-user:current"];
    assertStringIncludes(currentTask, "bun run compile --target");
    assertStringIncludes(currentTask, "--target wld-ux-current");
    assertStringIncludes(currentTask, "-f Containerfile.wld-ux");
    assertStringIncludes(currentTask, "runwield-wld-ux-current:local");

    const containerfile = await fsReadFile(repoPath("Containerfile.wld-ux"), "utf8");
    assertStringIncludes(containerfile, "FROM wld-ux-base AS wld-ux-latest");
    assertStringIncludes(containerfile, "FROM wld-ux-base AS wld-ux-current");
    assertStringIncludes(containerfile, "COPY --chown=deno:deno bin/wld /tmp/wld-current");
    assertStringIncludes(containerfile, 'install -m 755 /tmp/wld-current "$WLD_INSTALL_DIR/wld"');

    const containerignore = await fsReadFile(repoPath(".containerignore"), "utf8");
    assertStringIncludes(containerignore, "!bin/wld");
});
