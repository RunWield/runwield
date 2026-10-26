import { test } from "node:test";
import process from "node:process";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertEquals } from "../../testing/assertions.ts";
import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { getCwd } from "../../constants.js";

for (const host of [
    {
        os: "Darwin",
        arch: "x86_64",
        expected: "Remote SSH supports Linux x86-64 and ARM64 servers; the target runs macOS.",
    },
    {
        os: "Linux",
        arch: "armv7l",
        expected: "Remote SSH supports Linux x86-64 and ARM64 servers; the target CPU is armv7l.",
    },
    {
        os: "Linux",
        arch: "x86_64",
        expected:
            "Remote SSH server is missing: sshfs, fusermount3, /dev/fuse (character device). Run sudo dnf install sshfs fuse3 on the server. Make /dev/fuse available as a character device (load the fuse module or enable FUSE on the host). Reconnect after the prerequisites are ready.",
    },
]) {
    test(`remote command refuses an unready ${host.os}/${host.arch} host before cache or download access`, async () => {
        const root = await mkdtemp(join(tmpdir(), "remote-host-readiness-"));
        try {
            const home = join(root, "home");
            const bin = join(root, "bin");
            await mkdir(home);
            await mkdir(bin);
            const sshSource = join(root, "ssh.mjs");
            await writeFile(
                sshSource,
                `
const args = process.argv.slice(2);
if (args[0] === "-G") {
    console.log("hostname example\\nuser tester\\nport 22");
} else {
    if (args[0] !== "-v") throw new Error("Runtime transfer started");
    for await (const chunk of process.stdin) {}
    console.error("debug1: Server host key: ssh-ed25519 SHA256:fixture");
    console.log(JSON.stringify({ ok: true, cwd: "/remote/home", home: "/remote/home", os: ${JSON.stringify(host.os)}, arch: ${JSON.stringify(host.arch)}, osReleaseId: "fedora", osReleaseIdLike: "", sshfs: false, fusermount3: false, fuseDevice: false, gitRoot: null, gitDir: null, gitCommonDir: null, primaryRoot: null, isWorktree: false }));
}
`,
            );
            await writeRuntimeExecutableFixture(join(bin, "ssh"), sshSource);
            // Only generated release identity is supplied. All command and cache machinery stays real.
            const identity = join(root, "build-identity.js");
            const version = join(root, "version.js");
            await writeFile(
                identity,
                `export const BUILD_ID = "${"a".repeat(64)}"; export const REMOTE_PROTOCOL_VERSION = 1;`,
            );
            await writeFile(version, 'export const VERSION = "v1.2.3";');
            const replacements = {
                [fileURLToPath(new URL("../../shared/build-identity.js", import.meta.url))]: identity,
                [fileURLToPath(new URL("../../shared/version.js", import.meta.url))]: version,
            };
            const preload = join(root, "release-boundary.ts");
            await writeFile(
                preload,
                `
import { plugin } from "bun";
import { resolve, dirname } from "node:path";
const replacements = ${JSON.stringify(replacements)};
plugin({ name: "release-identity", setup(build) {
    build.onResolve({ filter: /(?:build-identity|version)\\.js$/ }, ({ path, importer }) => {
        const replacement = replacements[resolve(dirname(importer), path)];
        if (replacement) return { path: replacement };
    });
}});
`,
            );
            const entry = join(root, "entry.ts");
            await writeFile(
                entry,
                `
import { writeFileSync } from "node:fs";
import { runRemoteCommand } from ${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))};
globalThis.fetch = async () => {
    writeFileSync(${JSON.stringify(join(root, "download-started"))}, "unexpected network access");
    throw new Error("Download started before host readiness");
};
try {
    await runRemoteCommand(["example"]);
    console.error("Unready host accepted");
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
`,
            );
            const result = await captureForegroundProcess(process.execPath, {
                cwd: getCwd(),
                args: ["run", "--preload", preload, entry],
                env: {
                    ...process.env,
                    HOME: home,
                    WLD_TEST_SANDBOX_HOME: home,
                    MNEMOTECA_DB_PATH: join(home, "memory.db"),
                    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
                },
            });
            assertEquals(result.code, 1);
            assertEquals(new TextDecoder().decode(result.stderr).trim(), host.expected);
            assertEquals(
                await stat(join(root, "download-started")).then(
                    () => true,
                    () => false,
                ),
                false,
            );
            assertEquals(
                await stat(join(home, ".cache")).then(
                    () => true,
                    () => false,
                ),
                false,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}
