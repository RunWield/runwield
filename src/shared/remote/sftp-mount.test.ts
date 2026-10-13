import { Buffer } from "node:buffer";
import { connect, type Socket } from "node:net";
import { rmdir } from "node:fs/promises";
import { readStreamInto } from "../socket-listener.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { getCwd } from "../../constants.js";
import process from "node:process";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { installedLaptopPackageRoots, mountLaptopHome, startLaptopSftp, validateMountHeader } from "./sftp-mount.ts";

async function connectPeer(port: number): Promise<Socket> {
    const socket = connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
    return socket;
}
async function writePeer(socket: Socket, bytes: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => socket.write(bytes, (error) => (error ? reject(error) : resolve())));
}

async function syntheticHome(run: (home: string) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const home = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        const original = process.env["HOME"];
        const originalMarker = process.env["WLD_TEST_SANDBOX_HOME"];
        try {
            process.env["HOME"] = home;
            process.env["WLD_TEST_SANDBOX_HOME"] = home;
            await run(home);
        } finally {
            if (original === undefined) delete process.env["HOME"];
            else process.env["HOME"] = original;
            if (originalMarker === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = originalMarker;
            await fsRm(home, { recursive: true });
        }
    });
}

test("laptop transport fails before listening when personal files are absent", async () => {
    await syntheticHome(async () => {
        await assertRejects(startLaptopSftp, Error, "Laptop ~/.wld must exist");
    });
});

test("invalid package inventory rejects SFTP setup before opening a listener", async () => {
    await syntheticHome(async (home) => {
        await fsMkdir(join(home, ".wld"));
        await fsWriteFile(join(home, ".wld", "settings.json"), "{invalid");
        await assertRejects(startLaptopSftp);
        await fsWriteFile(join(home, ".wld", "settings.json"), "{}");
        const service = await startLaptopSftp();
        await service.close();
    });
});

test("laptop package inventory includes installed roots outside .wld but not absent packages", async () => {
    await syntheticHome(async (home) => {
        await fsMkdir(join(home, ".wld"));
        await fsMkdir(join(home, "package"));
        await fsMkdir(join(home, ".wld", "npm", "node_modules", "managed"), { recursive: true });
        await fsWriteFile(
            join(home, ".wld", "settings.json"),
            JSON.stringify({
                packages: ["../package", "npm:managed", "../absent"],
            }),
        );
        assertEquals(await installedLaptopPackageRoots(home), [
            { source: "../package", laptopPath: await fsRealpath(join(home, "package")) },
            {
                source: "npm:managed",
                laptopPath: await fsRealpath(join(home, ".wld", "npm", "node_modules", "managed")),
            },
        ]);
        const service = await startLaptopSftp();
        try {
            assertEquals(
                service.header.packages,
                (await installedLaptopPackageRoots(home)).map((entry) => ({
                    source: entry.source,
                    laptopPath:
                        process.platform === "win32" ? `/${entry.laptopPath.replaceAll("\\", "/")}` : entry.laptopPath,
                })),
            );
        } finally {
            await service.close();
        }
    });
});

test("SFTP transport serves laptop files only after connection authentication", async () => {
    await syntheticHome(async (home) => {
        await fsMkdir(join(home, ".wld"));
        await fsMkdir(join(home, ".agents"));
        const service = await startLaptopSftp();
        try {
            assertEquals(
                service.header.laptopHome,
                process.platform === "win32" ? `/${home.replaceAll("\\", "/")}` : home,
            );
            assertEquals(service.header.agents, true);
            const unauthorized = await connectPeer(service.header.sftpPort);
            await writePeer(unauthorized, new TextEncoder().encode("0".repeat(64) + "\n"));
            assertEquals(await readStreamInto(unauthorized, new Uint8Array(1)), null);
            unauthorized.destroy();
            const connected = await connectPeer(service.header.sftpPort);
            try {
                await writePeer(
                    connected,
                    new Uint8Array([
                        ...new TextEncoder().encode(service.header.sftpSecret + "\n"),
                        0,
                        0,
                        0,
                        5,
                        1,
                        0,
                        0,
                        0,
                        3,
                    ]),
                ); // SFTP INIT version 3.
                const response = new Uint8Array(9);
                let offset = 0;
                while (offset < response.length) {
                    const received = await readStreamInto(connected, response.subarray(offset));
                    if (received === null) throw new Error("SFTP server closed before version reply");
                    offset += received;
                }
                assertEquals(response[4], 2); // SFTP VERSION.
            } finally {
                connected.destroy();
            }
        } finally {
            await service.close();
        }
    });
});

function sftpString(value: string | Buffer): Buffer {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
}

async function readSftpPacket(peer: Socket): Promise<Buffer> {
    const readExactly = async (size: number) => {
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
            const count = await readStreamInto(peer, bytes.subarray(offset));
            if (count === null) throw new Error("SFTP server closed before completing a packet");
            offset += count;
        }
        return bytes;
    };
    const size = (await readExactly(4)).readUInt32BE();
    assert(size > 0 && size <= 1024 * 1024, "Invalid SFTP response length");
    return await readExactly(size);
}

async function sendSftpRequest(peer: Socket, type: number, id: number, payload: Buffer): Promise<Buffer> {
    const header = Buffer.alloc(9);
    header.writeUInt32BE(5 + payload.length);
    header[4] = type;
    header.writeUInt32BE(id, 5);
    await writePeer(peer, Buffer.concat([header, payload]));
    const response = await readSftpPacket(peer);
    assertEquals(response.readUInt32BE(1), id);
    return response;
}

test("authenticated SFTP reads a real Unicode file through its advertised laptop path", async () => {
    await syntheticHome(async (home) => {
        await fsMkdir(join(home, ".wld"));
        const filename = "transport \u00e9 sentinel.txt";
        const marker = "real laptop bytes through native SFTP";
        await fsWriteFile(join(home, ".wld", filename), marker);
        const service = await startLaptopSftp();
        const peer = await connectPeer(service.header.sftpPort);
        try {
            validateMountHeader(service.header);
            await writePeer(
                peer,
                Buffer.concat([
                    Buffer.from(service.header.sftpSecret + "\n"),
                    Buffer.from([0, 0, 0, 5, 1, 0, 0, 0, 3]),
                ]),
            );
            assertEquals((await readSftpPacket(peer))[0], 2);
            const flags = Buffer.alloc(8);
            flags.writeUInt32BE(1); // SSH_FXF_READ, no attributes.
            const opened = await sendSftpRequest(
                peer,
                3,
                1,
                Buffer.concat([sftpString(`${service.header.laptopHome}/.wld/${filename}`), flags]),
            );
            assertEquals(opened[0], 102, `SFTP OPEN failed: ${opened.toString("hex")}`);
            const handle = opened.subarray(5); // Encoded SFTP string, including its length.
            const offsetAndLength = Buffer.alloc(12);
            offsetAndLength.writeUInt32BE(4096, 8);
            const data = await sendSftpRequest(peer, 5, 2, Buffer.concat([handle, offsetAndLength]));
            assertEquals(data[0], 103);
            assertEquals(data.subarray(9, 9 + data.readUInt32BE(5)).toString("utf8"), marker);
            const closed = await sendSftpRequest(peer, 4, 3, handle);
            assertEquals(closed[0], 101);
            assertEquals(closed.readUInt32BE(5), 0);
        } finally {
            peer.destroy();
            await service.close();
        }
    });
});

test("remote mount rejects bad transport without modifying existing account files", async () => {
    await syntheticHome(async (home) => {
        for (const name of [".wld", ".agents"]) {
            await fsMkdir(join(home, name));
            await fsWriteFile(join(home, name, "sentinel"), name);
        }
        const config = {
            laptopHome: process.platform === "win32" ? `/${home.replaceAll("\\", "/")}` : home,
            sftpPort: 1234,
            sftpSecret: "a".repeat(64),
            agents: true,
        };
        await assertRejects(() => mountLaptopHome(home, { ...config, sftpSecret: "bad" }), Error, "Invalid SFTP");
        validateMountHeader(config);
        if (process.platform !== "linux") {
            await assertRejects(() => mountLaptopHome(home, config), Error, "requires Linux");
        }
        for (const name of [".wld", ".agents"]) {
            assertEquals(await fsReadFile(join(home, name, "sentinel"), "utf8"), name);
        }
    });
});

test("closing an authenticated SFTP child releases its process deadline timer", async () => {
    const source = `import { Buffer } from "node:buffer";
import { once } from "node:events";
import { connect } from "node:net";
import { startLaptopSftp } from ${JSON.stringify(new URL("./sftp-mount.ts", import.meta.url).href)};
const service = await startLaptopSftp();
const peer = connect({ host: "127.0.0.1", port: service.header.sftpPort });
try {
    await once(peer, "connect");
    const version = once(peer, "data");
    peer.write(Buffer.concat([Buffer.from(service.header.sftpSecret + "\\n"), Buffer.from([0,0,0,5,1,0,0,0,3])]));
    await version;
} finally {
    peer.destroy();
    await service.close();
}
console.log("SFTP child closed");`;
    const result = await captureForegroundProcess(process.execPath, {
        cwd: getCwd(),
        args: runtimeSourceArgs(["eval", source]),
        timeoutMs: 4_000,
    });
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(new TextDecoder().decode(result.stdout).trim(), "SFTP child closed");
});

// Opt in on a Linux host with working SSHFS and /dev/fuse. This exercises real kernel mounts.
test(
    "stalled laptop SFTP detaches its live mount before connection cleanup returns",
    {
        skip: process.platform !== "linux" || process.env["WLD_TEST_SSHFS_STALL"] !== "1" || process.getuid?.() === 0,
    },
    async () => {
        await syntheticHome(async (home) => {
            await fsMkdir(join(home, ".wld"));
            const remoteHome = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
            const service = await startLaptopSftp();
            let mount: Awaited<ReturnType<typeof mountLaptopHome>> | undefined;
            let stoppedPid: number | undefined;
            let closed = false;
            let mountedId: string | undefined;
            const mountLine = async (path: string) => {
                const field = path.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
                return (await fsReadFile("/proc/self/mountinfo", "utf8"))
                    .split("\n")
                    .filter((line) => line.split(" ")[4] === field)
                    .at(-1);
            };
            try {
                mount = await mountLaptopHome(remoteHome, service.header);
                mountedId = (await mountLine(mount.globalRoot))?.split(" ")[0];
                assert(mountedId);
                const children = (await fsReadFile(`/proc/self/task/${process.pid}/children`, "utf8"))
                    .trim()
                    .split(/\s+/);
                const sftp = [];
                for (const entry of children) {
                    if (!entry) continue;
                    const cmdline = await fsReadFile(`/proc/${entry}/cmdline`, "utf8").catch(() => "");
                    if (cmdline.split("\0")[0]?.endsWith("/sftp-server")) sftp.push(Number(entry));
                }
                assertEquals(sftp.length, 1, "Expected exactly one owned SFTP server child");
                stoppedPid = sftp[0];
                process.kill(stoppedPid, "SIGSTOP");
                // The health lookup must time out while SFTP is stopped. close() must
                // detach the mount even though ordinary unmount cannot finish.
                let deadline: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        mount.lost,
                        new Promise<never>((_, reject) => {
                            deadline = setTimeout(() => reject(new Error("Storage stall not detected")), 45_000);
                        }),
                    ]);
                } finally {
                    if (deadline !== undefined) clearTimeout(deadline);
                }
                closed = true;
                await assertRejects(() => mount!.close(), Error, "SSHFS cleanup uncertain");
                assertEquals(await mountLine(mount.globalRoot), undefined, "Live SSHFS mount remains");
                assertEquals((await fsStat(mount.globalRoot)).mode! & 0o777, 0o500);
            } finally {
                // Shutdown must terminate a stopped SFTP server without resuming it.
                try {
                    await Promise.race([
                        service.close(),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error("SFTP cleanup stalled")), 8_000),
                        ),
                    ]);
                } finally {
                    if (stoppedPid !== undefined) {
                        try {
                            process.kill(stoppedPid, "SIGCONT");
                        } catch {
                            /* Already exited. */
                        }
                    }
                }
                if (mount && !closed) await mount.close().catch(() => undefined);
                if (mount && mountedId && (await mountLine(mount.globalRoot))?.split(" ")[0] === mountedId) {
                    // Test-only recovery if the regression returns: do not leave our real mount behind.
                    await captureForegroundProcess("fusermount3", { args: ["-uz", mount.globalRoot], cwd: getCwd() });
                }
                await service.close();
                await rmdir(remoteHome);
            }
        });
    },
);

test(
    "remote mount denies fallback writes and leaves existing account files intact",
    {
        skip: process.platform !== "linux" || process.env["WLD_TEST_SSHFS"] !== "1" || process.getuid?.() === 0,
    },
    async () => {
        await syntheticHome(async (laptopHome) => {
            for (const name of [".wld", ".agents"]) {
                await fsMkdir(join(laptopHome, name));
                await fsWriteFile(join(laptopHome, name, "laptop"), `laptop ${name}`);
            }
            const packagePath = join(laptopHome, "installed-package");
            await fsMkdir(packagePath);
            await fsWriteFile(join(packagePath, "prompt.md"), "laptop package prompt");
            await fsWriteFile(
                join(laptopHome, ".wld", "settings.json"),
                JSON.stringify({
                    packages: ["../installed-package"],
                }),
            );
            const remoteHome = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
            try {
                for (const name of [".wld", ".agents"]) {
                    await fsMkdir(join(remoteHome, name));
                    await fsWriteFile(join(remoteHome, name, "remote"), `remote ${name}`);
                }
                const service = await startLaptopSftp();
                try {
                    let previousRoot = "";
                    for (let attempt = 0; attempt < 2; attempt++) {
                        const mount = await mountLaptopHome(remoteHome, service.header);
                        assert(mount.globalRoot.startsWith("/"));
                        assert(!mount.globalRoot.startsWith(remoteHome + "/"));
                        assert(mount.agentsRoot && !mount.agentsRoot.startsWith(remoteHome + "/"));
                        const mountedPackage = mount.packageRoots?.["../installed-package"];
                        assert(mountedPackage && !mountedPackage.startsWith(remoteHome + "/"));
                        const root = join(mount.globalRoot, "..");
                        try {
                            assert(root !== previousRoot);
                            assertEquals(await fsReadFile(join(mount.globalRoot, "laptop"), "utf8"), "laptop .wld");
                            assertEquals(await fsReadFile(join(mount.agentsRoot, "laptop"), "utf8"), "laptop .agents");
                            assertEquals(
                                await fsReadFile(join(mountedPackage, "prompt.md"), "utf8"),
                                "laptop package prompt",
                            );
                            for (const name of [".wld", ".agents"]) {
                                assertEquals(
                                    await fsReadFile(join(remoteHome, name, "remote"), "utf8"),
                                    `remote ${name}`,
                                );
                            }
                            assertEquals((await fsStat(root)).mode! & 0o777, 0o700);
                            // After an unexpected unmount, writes must not fall through to the host.
                            for (const path of [mount.globalRoot, mount.agentsRoot, mountedPackage]) {
                                const result = await captureForegroundProcess("fusermount3", {
                                    args: ["-u", path],
                                    cwd: getCwd(),
                                });
                                assert(result.code === 0, new TextDecoder().decode(result.stderr));
                                assertEquals((await fsStat(path)).mode! & 0o777, 0o500);
                                await assertRejects(
                                    () => fsWriteFile(join(path, "fallback"), "must not reach host"),
                                    Error,
                                    "EACCES",
                                );
                            }
                            // The process can remain alive after external unmount. Storage loss
                            // must still reach the supervisor through RemoteMount.lost.
                            let deadline: ReturnType<typeof setTimeout> | undefined;
                            try {
                                await Promise.race([
                                    mount.lost,
                                    new Promise<never>((_, reject) => {
                                        deadline = setTimeout(
                                            () => reject(new Error("Mount loss not detected")),
                                            12_000,
                                        );
                                    }),
                                ]);
                            } finally {
                                if (deadline !== undefined) clearTimeout(deadline);
                            }
                        } finally {
                            await mount.close();
                        }
                        assertEquals(
                            await fsStat(root).then(
                                () => true,
                                () => false,
                            ),
                            false,
                        );
                        previousRoot = root;
                    }
                } finally {
                    await service.close();
                }
                for (const name of [".wld", ".agents"]) {
                    assertEquals(await fsReadFile(join(remoteHome, name, "remote"), "utf8"), `remote ${name}`);
                }
            } finally {
                await fsRm(remoteHome, { recursive: true });
            }
        });
    },
);
