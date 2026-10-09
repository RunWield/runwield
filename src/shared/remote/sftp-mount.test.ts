import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { installedLaptopPackageRoots, mountLaptopHome, startLaptopSftp, validateMountHeader } from "./sftp-mount.ts";

async function syntheticHome(run: (home: string) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const home = await Deno.makeTempDir();
        const original = Deno.env.get("HOME");
        const originalMarker = Deno.env.get("WLD_TEST_SANDBOX_HOME");
        try {
            Deno.env.set("HOME", home);
            Deno.env.set("WLD_TEST_SANDBOX_HOME", home);
            await run(home);
        } finally {
            if (original === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", original);
            if (originalMarker === undefined) Deno.env.delete("WLD_TEST_SANDBOX_HOME");
            else Deno.env.set("WLD_TEST_SANDBOX_HOME", originalMarker);
            await Deno.remove(home, { recursive: true });
        }
    });
}

Deno.test("laptop transport fails before listening when personal files are absent", async () => {
    await syntheticHome(async () => {
        await assertRejects(startLaptopSftp, Error, "Laptop ~/.wld must exist");
    });
});

Deno.test("invalid package inventory rejects SFTP setup before opening a listener", async () => {
    await syntheticHome(async (home) => {
        await Deno.mkdir(join(home, ".wld"));
        await Deno.writeTextFile(join(home, ".wld", "settings.json"), "{invalid");
        await assertRejects(startLaptopSftp);
        await Deno.writeTextFile(join(home, ".wld", "settings.json"), "{}");
        const service = await startLaptopSftp();
        await service.close();
    });
});

Deno.test("laptop package inventory includes installed roots outside .wld but not absent packages", async () => {
    await syntheticHome(async (home) => {
        await Deno.mkdir(join(home, ".wld"));
        await Deno.mkdir(join(home, "package"));
        await Deno.mkdir(join(home, ".wld", "npm", "node_modules", "managed"), { recursive: true });
        await Deno.writeTextFile(
            join(home, ".wld", "settings.json"),
            JSON.stringify({
                packages: ["../package", "npm:managed", "../absent"],
            }),
        );
        assertEquals(await installedLaptopPackageRoots(home), [
            { source: "../package", laptopPath: await Deno.realPath(join(home, "package")) },
            {
                source: "npm:managed",
                laptopPath: await Deno.realPath(join(home, ".wld", "npm", "node_modules", "managed")),
            },
        ]);
        const service = await startLaptopSftp();
        try {
            assertEquals(service.header.packages, await installedLaptopPackageRoots(home));
        } finally {
            await service.close();
        }
    });
});

Deno.test("SFTP transport serves laptop files only after connection authentication", async () => {
    await syntheticHome(async (home) => {
        await Deno.mkdir(join(home, ".wld"));
        await Deno.mkdir(join(home, ".agents"));
        const service = await startLaptopSftp();
        try {
            assertEquals(service.header.laptopHome, home);
            assertEquals(service.header.agents, true);
            const unauthorized = await Deno.connect({ hostname: "127.0.0.1", port: service.header.sftpPort });
            await unauthorized.write(new TextEncoder().encode("0".repeat(64) + "\n"));
            assertEquals(await unauthorized.read(new Uint8Array(1)), null);
            unauthorized.close();
            const connected = await Deno.connect({ hostname: "127.0.0.1", port: service.header.sftpPort });
            try {
                await connected.write(new TextEncoder().encode(service.header.sftpSecret + "\n"));
                await connected.write(new Uint8Array([0, 0, 0, 5, 1, 0, 0, 0, 3])); // SFTP INIT version 3.
                const response = new Uint8Array(9);
                let offset = 0;
                while (offset < response.length) {
                    const received = await connected.read(response.subarray(offset));
                    if (received === null) throw new Error("SFTP server closed before version reply");
                    offset += received;
                }
                assertEquals(response[4], 2); // SFTP VERSION.
            } finally {
                connected.close();
            }
        } finally {
            await service.close();
        }
    });
});

Deno.test("remote mount rejects bad transport without modifying existing account files", async () => {
    await syntheticHome(async (home) => {
        for (const name of [".wld", ".agents"]) {
            await Deno.mkdir(join(home, name));
            await Deno.writeTextFile(join(home, name, "sentinel"), name);
        }
        const config = { laptopHome: home, sftpPort: 1234, sftpSecret: "a".repeat(64), agents: true };
        await assertRejects(() => mountLaptopHome(home, { ...config, sftpSecret: "bad" }), Error, "Invalid SFTP");
        validateMountHeader(config);
        if (Deno.build.os !== "linux") {
            await assertRejects(() => mountLaptopHome(home, config), Error, "requires Linux");
        }
        for (const name of [".wld", ".agents"]) {
            assertEquals(await Deno.readTextFile(join(home, name, "sentinel")), name);
        }
    });
});

// Opt in on a Linux host with working SSHFS and /dev/fuse. This exercises real kernel mounts.
Deno.test({
    name: "stalled laptop SFTP detaches its live mount before connection cleanup returns",
    ignore: Deno.build.os !== "linux",
    fn: async () => {
        if (Deno.env.get("WLD_TEST_SSHFS_STALL") !== "1" || Deno.uid() === 0) return;
        await syntheticHome(async (home) => {
            await Deno.mkdir(join(home, ".wld"));
            const remoteHome = await Deno.makeTempDir();
            const service = await startLaptopSftp();
            let mount: Awaited<ReturnType<typeof mountLaptopHome>> | undefined;
            let stoppedPid: number | undefined;
            let closed = false;
            let mountedId: string | undefined;
            const mountLine = async (path: string) => {
                const field = path.replaceAll("\\", "\\134").replaceAll(" ", "\\040");
                return (await Deno.readTextFile("/proc/self/mountinfo")).split("\n")
                    .filter((line) => line.split(" ")[4] === field).at(-1);
            };
            try {
                mount = await mountLaptopHome(remoteHome, service.header);
                mountedId = (await mountLine(mount.globalRoot))?.split(" ")[0];
                assert(mountedId);
                const children = (await Deno.readTextFile(`/proc/self/task/${Deno.pid}/children`)).trim().split(/\s+/);
                const sftp = [];
                for (const entry of children) {
                    if (!entry) continue;
                    const cmdline = await Deno.readTextFile(`/proc/${entry}/cmdline`).catch(() => "");
                    if (cmdline.split("\0")[0]?.endsWith("/sftp-server")) sftp.push(Number(entry));
                }
                assertEquals(sftp.length, 1, "Expected exactly one owned SFTP server child");
                stoppedPid = sftp[0];
                Deno.kill(stoppedPid, "SIGSTOP");
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
                assertEquals((await Deno.stat(mount.globalRoot)).mode! & 0o777, 0o500);
            } finally {
                // Shutdown must terminate a stopped SFTP server without resuming it.
                try {
                    await Promise.race([
                        service.close(),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error("SFTP cleanup stalled")), 8_000)
                        ),
                    ]);
                } finally {
                    if (stoppedPid !== undefined) {
                        try {
                            Deno.kill(stoppedPid, "SIGCONT");
                        } catch { /* Already exited. */ }
                    }
                }
                if (mount && !closed) await mount.close().catch(() => undefined);
                if (mount && mountedId && (await mountLine(mount.globalRoot))?.split(" ")[0] === mountedId) {
                    // Test-only recovery if the regression returns: do not leave our real mount behind.
                    await new Deno.Command("fusermount3", {
                        args: ["-uz", mount.globalRoot],
                        stdout: "null",
                        stderr: "null",
                    }).output();
                }
                await service.close();
                await Deno.remove(remoteHome);
            }
        });
    },
});

Deno.test({
    name: "remote mount denies fallback writes and leaves existing account files intact",
    ignore: Deno.build.os !== "linux",
    fn: async () => {
        if (Deno.env.get("WLD_TEST_SSHFS") !== "1" || Deno.uid() === 0) return;
        await syntheticHome(async (laptopHome) => {
            for (const name of [".wld", ".agents"]) {
                await Deno.mkdir(join(laptopHome, name));
                await Deno.writeTextFile(join(laptopHome, name, "laptop"), `laptop ${name}`);
            }
            const packagePath = join(laptopHome, "installed-package");
            await Deno.mkdir(packagePath);
            await Deno.writeTextFile(join(packagePath, "prompt.md"), "laptop package prompt");
            await Deno.writeTextFile(
                join(laptopHome, ".wld", "settings.json"),
                JSON.stringify({
                    packages: ["../installed-package"],
                }),
            );
            const remoteHome = await Deno.makeTempDir();
            try {
                for (const name of [".wld", ".agents"]) {
                    await Deno.mkdir(join(remoteHome, name));
                    await Deno.writeTextFile(join(remoteHome, name, "remote"), `remote ${name}`);
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
                            assertEquals(await Deno.readTextFile(join(mount.globalRoot, "laptop")), "laptop .wld");
                            assertEquals(await Deno.readTextFile(join(mount.agentsRoot, "laptop")), "laptop .agents");
                            assertEquals(
                                await Deno.readTextFile(join(mountedPackage, "prompt.md")),
                                "laptop package prompt",
                            );
                            for (const name of [".wld", ".agents"]) {
                                assertEquals(
                                    await Deno.readTextFile(join(remoteHome, name, "remote")),
                                    `remote ${name}`,
                                );
                            }
                            assertEquals((await Deno.stat(root)).mode! & 0o777, 0o700);
                            // After an unexpected unmount, writes must not fall through to the host.
                            for (const path of [mount.globalRoot, mount.agentsRoot, mountedPackage]) {
                                const result = await new Deno.Command("fusermount3", {
                                    args: ["-u", path],
                                    stdout: "null",
                                    stderr: "piped",
                                }).output();
                                assert(result.success, new TextDecoder().decode(result.stderr));
                                assertEquals((await Deno.stat(path)).mode! & 0o777, 0o500);
                                await assertRejects(
                                    () => Deno.writeTextFile(join(path, "fallback"), "must not reach host"),
                                    Deno.errors.PermissionDenied,
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
                        assertEquals(await Deno.stat(root).then(() => true, () => false), false);
                        previousRoot = root;
                    }
                } finally {
                    await service.close();
                }
                for (const name of [".wld", ".agents"]) {
                    assertEquals(await Deno.readTextFile(join(remoteHome, name, "remote")), `remote ${name}`);
                }
            } finally {
                await Deno.remove(remoteHome, { recursive: true });
            }
        });
    },
});
