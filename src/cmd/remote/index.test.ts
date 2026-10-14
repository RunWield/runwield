import { writeRuntimeExecutableFixture } from "../../testing/runtime-executable-fixture.ts";
import { basename, delimiter } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { test } from "node:test";
import {
    chmod as fsChmod,
    copyFile as fsCopyFile,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    symlink as fsSymlink,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl, pathToFileURL as toFileUrl } from "node:url";
import { join } from "node:path";
import { parseRemoteDestination } from "./index.ts";

const cli = fromFileUrl(new URL("../../cli.ts", import.meta.url));
const decoder = new TextDecoder();

interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface RemoteFixture {
    local: string;
    remote: string;
    sshLog: string;
    run: (args: string[], proof?: string) => Promise<CliResult>;
    runWithOpenStdin: () => Promise<CliResult>;
}

/** Real CLI with disposable homes: POSIX runs remote Python; Windows uses a native SSH protocol boundary. */
async function withRemoteFixture(test: (fixture: RemoteFixture) => Promise<void>, connected = false): Promise<void> {
    const root = await fsRealpath(await fsMkdtemp(join(tmpdir(), "runwield-fixture-")));
    try {
        const local = join(root, "local");
        const remote = join(root, "remote-home");
        const bin = join(root, "bin");
        const sshLog = join(root, "ssh-args");
        await Promise.all([fsMkdir(local), fsMkdir(remote), fsMkdir(bin)]);
        let executable = process.execPath;
        if (connected) {
            // The development artifact is discovered beside the running executable.
            // Keep that real build boundary entirely inside this disposable tree.
            executable = join(root, basename(process.execPath));
            await fsCopyFile(process.execPath, executable);
            await fsChmod(executable, 0o700);
            const bytes = new TextEncoder().encode("remote fixture artifact\n");
            const artifact = join(root, "wld-x86_64-unknown-linux-gnu");
            await fsWriteFile(artifact, bytes);
            await fsWriteFile(
                `${artifact}.build.json`,
                JSON.stringify({
                    schema: 1,
                    protocol: 1,
                    buildId: "a".repeat(64),
                    target: "x86_64-unknown-linux-gnu",
                    version: "development",
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                }),
            );
            await fsMkdir(join(local, ".wld"));
            const source = join(root, "ssh-connected.mjs");
            await fsWriteFile(
                source,
                `
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const readyFile = process.env.SSH_LOG + ".ready";
if (args[0] === "-tt") {
    if (!args.includes("ExitOnForwardFailure=yes") || !args.includes("remote-alias")) process.exit(42);
    process.stdout.write("REMOTE_SUPERVISOR_READY:/tmp/wld-remote-fixture/control.sock\\n");
    const deadline = Date.now() + 15000;
    while (!existsSync(readyFile)) {
        if (Date.now() > deadline) throw new Error("Private header never arrived");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    process.stdout.write("REMOTE_CONNECTED\\n");
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
        if (line !== "terminal-input") throw new Error("Unexpected terminal input");
        // Let the launcher start its next read, without delivering EOF to it.
        await new Promise(resolve => setTimeout(resolve, 100));
        process.stdout.write("REMOTE_EXIT_AFTER_INPUT\\n", () => process.exit(0));
        break;
    }
} else {
    if (args.length !== 4 || args[0] !== "-T" || args[1] !== "--" || args[2] !== "remote-alias") process.exit(42);
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
        const request = JSON.parse(line);
        if ("path" in request) {
            console.log(JSON.stringify({ ok: true, cwd: "/remote/home", home: "/remote/home", os: "Linux", arch: "x86_64", gitRoot: null, gitDir: null, gitCommonDir: null, primaryRoot: null, isWorktree: false }));
        } else if ("sha256" in request) {
            console.log(JSON.stringify({ ok: true, reused: true, path: "/remote/home/.cache/runwield/runtime/" + request.buildId + "/" + request.target + "/" + request.sha256 + "/wld" }));
        } else {
            if (request.socket !== "/tmp/wld-remote-fixture/control.sock") throw new Error("Wrong private socket");
            const header = request.header;
            for (const route of ["handshake", "readiness"]) {
                const response = await fetch("http://127.0.0.1:" + header.port + "/" + route, {
                    method: "POST", headers: { Authorization: "Bearer " + header.credential },
                    body: JSON.stringify({ buildId: header.buildId, protocol: header.protocol }),
                });
                if (!response.ok || (await response.json()).shutdown) throw new Error("Control handshake failed");
            }
            writeFileSync(readyFile, "authenticated");
        }
        process.exit(0);
    }
}
`,
            );
            await writeRuntimeExecutableFixture(join(bin, "ssh"), source);
        } else if (process.platform === "win32") {
            const source = join(root, "ssh.mjs");
            await fsWriteFile(
                source,
                `
import { writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
writeFileSync(process.env.SSH_LOG, args.join("\\n") + "\\n");
if (args.length !== 4 || args[0] !== "-T" || args[1] !== "--") process.exit(42);
let input = "";
for await (const chunk of process.stdin) input += chunk.toString();
writeFileSync(process.env.SSH_LOG + ".json", input);
const request = JSON.parse(input);
let exists = false;
try { exists = statSync(join(process.env.REMOTE_HOME, request.path || "")).isDirectory(); } catch {}
if (!exists) { console.log(JSON.stringify({ ok: false, error: "Remote target is not an existing directory" })); process.exit(1); }
console.log(JSON.stringify({ ok: true, cwd: "/remote/home/" + (request.path || ""), home: "/remote/home", os: "Linux", arch: "x86_64", gitRoot: null, gitDir: null, gitCommonDir: null, primaryRoot: null, isWorktree: false }));
`,
            );
            await writeRuntimeExecutableFixture(join(bin, "ssh"), source);
        } else {
            // Only this SSH subprocess sees a Linux host. The resolver itself still
            // runs unchanged through the actual shell and Python interpreter.
            await fsWriteFile(
                join(root, "sitecustomize.py"),
                'import platform\nplatform.system = lambda: "Linux"\nplatform.machine = lambda: "x86_64"\n',
            );
            await fsWriteFile(
                join(bin, "ssh"),
                `#!/bin/sh
printf '%s\\n' "$@" > "$SSH_LOG"
[ "$1" = -T ] && [ "$2" = -- ] && [ "$#" = 4 ] || exit 42
HOME="$REMOTE_HOME" PYTHONPATH="$REMOTE_PYTHONPATH" export HOME PYTHONPATH
tee "$SSH_LOG.json" | /bin/sh -c "$4"
`,
            );
            await fsChmod(join(bin, "ssh"), 0o700);
        }
        // The source checkout has no compiled launcher identity. Supply only that
        // build boundary to the CLI subprocess, without writing into the checkout.
        const identity = join(root, "build-identity.js");
        await fsWriteFile(
            identity,
            `export const BUILD_ID = "${"a".repeat(64)}";\nexport const REMOTE_PROTOCOL_VERSION = 1;\n`,
        );
        // A development launcher requires a local Linux artifact, regardless of the release build version.
        const version = join(root, "version.js");
        await fsWriteFile(version, 'export const VERSION = "development";\n');
        const preload = join(root, "build-boundary.ts");
        const replacements = {
            [fromFileUrl(new URL("../../shared/build-identity.js", import.meta.url))]: identity,
            [fromFileUrl(new URL("../../shared/version.js", import.meta.url))]: version,
        };
        await fsWriteFile(
            preload,
            `import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const replacements = ${JSON.stringify(replacements)};
plugin({ name: "fixture-build-boundary", setup(build) {
    build.onResolve({ filter: /(?:build-identity|version)\\.js$/ }, ({ path, importer }) => {
        const target = resolve(dirname(importer), path);
        const replacement = replacements[target];
        if (replacement) return { path: replacement };
    });
}});
`,
        );
        const cliArgs = (args: string[]) => [
            "run",
            "--preload",
            preload,
            ...runtimeSourceArgs(["run", "-A", cli, "remote", ...args]).slice(1),
        ];
        const cliEnv = (proof?: string) => ({
            ...process.env,
            HOME: local,
            WLD_TEST_SANDBOX_HOME: local,
            MNEMOTECA_DB_PATH: join(local, "mnemoteca.db"),
            PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
            SSH_LOG: sshLog,
            REMOTE_HOME: remote,
            REMOTE_PYTHONPATH: root,
            ...(proof === undefined ? {} : { WLD_REMOTE_MODEL_PROOF: proof }),
        });
        await test({
            local,
            remote,
            sshLog,
            run: async (args, proof) => {
                const output = await captureForegroundProcess(executable, {
                    args: cliArgs(args),
                    cwd: local,
                    env: cliEnv(proof),
                });
                return {
                    code: output.code,
                    stdout: decoder.decode(output.stdout),
                    stderr: decoder.decode(output.stderr),
                };
            },
            runWithOpenStdin: async () => {
                const child = spawn(executable, cliArgs(["remote-alias"]), {
                    cwd: local,
                    env: cliEnv(),
                    stdio: ["pipe", "pipe", "pipe"],
                });
                let stdout = "";
                let stderr = "";
                let sent = false;
                child.stdout.setEncoding("utf8");
                child.stderr.setEncoding("utf8");
                child.stdout.on("data", (chunk: string) => {
                    stdout += chunk;
                    if (!sent && stdout.includes("REMOTE_CONNECTED")) {
                        sent = true;
                        child.stdin.write("terminal-input\n");
                    }
                });
                child.stderr.on("data", (chunk: string) => {
                    stderr += chunk;
                });
                child.stdin.on("error", () => {});
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    const result = await Promise.race([
                        new Promise<CliResult>((resolve, reject) => {
                            child.once("error", reject);
                            child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
                        }),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(
                                () =>
                                    reject(
                                        new Error(`Remote CLI failed to exit with stdin open: ${stderr}\n${stdout}`),
                                    ),
                                30000,
                            );
                        }),
                    ]);
                    assertEquals(result.code, 0, result.stderr + "\n" + result.stdout);
                    assertEquals(sent, true, "the terminal input pump must run before SSH exits");
                    assertEquals(child.stdin.writableEnded, false, "parent must not supply stdin EOF");
                    return result;
                } finally {
                    clearTimeout(timer);
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill("SIGTERM");
                        await new Promise<void>((resolve) => {
                            const killTimer = setTimeout(() => child.kill("SIGKILL"), 6000);
                            child.once("close", () => {
                                clearTimeout(killTimer);
                                resolve();
                            });
                        });
                    }
                    child.stdin.destroy();
                }
            },
        });
    } finally {
        await fsRm(root, { recursive: true });
    }
}

test("remote destination separates a directory from an SSH host without changing the host", () => {
    assertEquals(parseRemoteDestination("alias"), { host: "alias", path: null });
    assertEquals(parseRemoteDestination("user@alias:~/repo:branch"), { host: "user@alias", path: "~/repo:branch" });
    assertEquals(parseRemoteDestination("[2001:db8::1]:/srv/repo"), { host: "[2001:db8::1]", path: "/srv/repo" });
    assertEquals(parseRemoteDestination("alias:"), { host: "alias", path: null });
});

test("remote destination rejects option-like and malformed hosts", () => {
    for (const destination of ["", "-oProxyCommand=bad", "-oBad:/repo", ":/repo", "alias name", "[unfinished"]) {
        assertThrows(() => parseRemoteDestination(destination), Error, "Invalid SSH destination");
    }
});

test("remote CLI help and invalid arity do not contact SSH", async () => {
    await withRemoteFixture(async ({ run, sshLog }) => {
        const help = await run(["--help"]);
        assertEquals(help.code, 0);
        assertStringIncludes(help.stdout, "Usage: wld remote <ssh-host>");
        const missing = await run([]);
        assertEquals(missing.code, 1);
        assertStringIncludes(missing.stderr, "Usage: wld remote <ssh-host>");
        const excess = await run(["alias", "other"]);
        assertEquals(excess.code, 1);
        assertEquals(await exists(sshLog), false);
    });
});

test("source remote help works without a generated identity and connection explains the build step", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    try {
        for (const path of ["src/cmd/remote", "src/shared/remote", "scripts"]) {
            await fsMkdir(join(root, path), { recursive: true });
        }
        for (const path of [
            "src/cmd/remote/index.ts",
            "src/shared/foreground-process.ts",
            "src/shared/linux-process-group.ts",
            "src/shared/captured-process.ts",
            "src/shared/socket-listener.ts",
            "src/shared/stdin-stream.ts",
            "src/shared/jsonc.ts",
            "src/shared/remote/runtime.js",
            "src/shared/remote/target.ts",
            "src/shared/remote/control.ts",
            "src/shared/remote/release-artifact.ts",
            "src/shared/remote/sftp-mount.ts",
            "src/shared/remote/model-proof-config.ts",
            "src/constants.js",
            "runtime-root.js",
            "scripts/build-metadata.js",
            "src/shared/version.js",
        ])
            await fsCopyFile(path, join(root, path));

        await fsSymlink(
            fromFileUrl(new URL("../../../node_modules", import.meta.url)),
            join(root, "node_modules"),
            "dir",
        );

        const module = await import(toFileUrl(join(root, "src/cmd/remote/index.ts")).href);
        const originalLog = console.log;
        let help = "";
        try {
            console.log = (message: string) => {
                help = message;
            };
            await module.runRemoteCommand(["--help"]);
        } finally {
            console.log = originalLog;
        }
        assertStringIncludes(help, "Usage: wld remote");
        await assertRejects(() => module.runRemoteCommand(["example"]), Error, "bun run compile --output bin/wld");
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("remote CLI refuses malformed LIVE proof before contacting SSH", async () => {
    await withRemoteFixture(async ({ run, sshLog }) => {
        for (const proof of [
            "",
            "{}",
            "not-json",
            '{"provider":"p","modelId":"m","sentinelFile":"../secret"}',
            '{"provider":"p","modelId":"m","sentinelFile":"/tmp/secret"}',
        ]) {
            const result = await run(["alias"], proof);
            assertEquals(result.code, 1);
            assertStringIncludes(result.stderr, "Invalid WLD_REMOTE_MODEL_PROOF");
            assertEquals(await exists(sshLog), false);
        }
    });
});

test("remote CLI rejects an option-like host before invoking SSH", async () => {
    await withRemoteFixture(async ({ run, sshLog }) => {
        const result = await run(["-oProxyCommand=bad"]);
        assertEquals(result.code, 1);
        assertStringIncludes(result.stderr, "Invalid SSH destination");
        assertEquals(await exists(sshLog), false);
    });
});

test("remote CLI resolves a host home without initializing a local project and requires a built artifact", async () => {
    await withRemoteFixture(async ({ run, local, remote, sshLog }) => {
        const result = await run(["remote-alias"]);
        assertEquals(result.code, 1);
        assertStringIncludes(result.stderr, "Missing x86_64-unknown-linux-gnu artifact");
        assertStringIncludes(result.stderr, "bun run compile --target x86_64-unknown-linux-gnu");
        assertEquals((await fsReadFile(sshLog, "utf8")).split("\n").slice(0, 3), ["-T", "--", "remote-alias"]);
        assertEquals(await exists(join(local, ".wld")), false);
        assertEquals(await exists(join(local, ".git")), false);
        assertEquals(await exists(join(remote, ".cache")), false);
    });
});

test("remote CLI keeps shell metacharacters in the target path literal", async () => {
    await withRemoteFixture(async ({ run, remote, sshLog }) => {
        const name = "space ' $(touch BAD); folder";
        await fsMkdir(join(remote, name));
        const result = await run([`remote-alias:${name}`]);
        // POSIX executes the real resolver; Windows checks the laptop dispatch/protocol boundary.
        assertStringIncludes(result.stderr, "Missing x86_64-unknown-linux-gnu artifact");
        assertEquals(await exists(join(remote, "BAD")), false);
        const sshArgs = await fsReadFile(sshLog, "utf8");
        assertEquals(sshArgs.includes(name), false);
        assertEquals(JSON.parse(await fsReadFile(sshLog + ".json", "utf8")), { path: name });
    });
});

test("remote CLI reports an absent remote directory before artifact setup", async () => {
    await withRemoteFixture(async ({ run, remote }) => {
        const result = await run(["remote-alias:missing"]);
        assertEquals(result.code, 1);
        assertStringIncludes(result.stderr, "Remote target is not an existing directory");
        assertEquals(await exists(join(remote, ".cache")), false);
    });
});

async function exists(path: string): Promise<boolean> {
    return await fsStat(path).then(
        () => true,
        () => false,
    );
}

test("remote CLI exits after authenticated SSH closes while terminal stdin remains open", async () => {
    await withRemoteFixture(async ({ runWithOpenStdin, sshLog }) => {
        const result = await runWithOpenStdin();
        assertEquals(result.code, 0, result.stderr);
        assertStringIncludes(result.stdout, "REMOTE_EXIT_AFTER_INPUT");
        assertEquals(await fsReadFile(sshLog + ".ready", "utf8"), "authenticated");
    }, true);
});
