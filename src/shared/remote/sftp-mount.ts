import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { env, platform } from "node:process";
import { delimiter, posix } from "node:path";
import type { Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { listenSocket, readStreamInto } from "../socket-listener.ts";
import { type NativeProcess, spawnNativeProcess } from "../foreground-process.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import {
    chmod as fsChmod,
    lstat as fsLstat,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
/* Connection-owned laptop SFTP transport and remote SSHFS mounts. No HOME substitution. */
import { join } from "node:path";
import { parse as parseJsonc } from "../jsonc.ts";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getCwd, getHomeDir } from "../../constants.js";

export interface LaptopPackageRoot {
    source: string;
    laptopPath: string;
}

/** Enumerate installed global packages on the laptop, not the remote account. */
export async function installedLaptopPackageRoots(home: string): Promise<LaptopPackageRoot[]> {
    const settingsPath = join(home, ".wld", "settings.json");
    const text = await fsReadFile(settingsPath, "utf8").catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "{}";
        throw error;
    });
    const parsed = parseJsonc(text);
    if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !("packages" in parsed) ||
        !Array.isArray(parsed.packages)
    )
        return [];
    const manager = new DefaultPackageManager({
        cwd: getCwd(),
        agentDir: join(home, ".wld"),
        settingsManager: SettingsManager.inMemory(),
    });
    const roots: LaptopPackageRoot[] = [];
    for (const entry of parsed.packages) {
        const source =
            typeof entry === "string"
                ? entry
                : entry && typeof entry === "object" && !Array.isArray(entry) && "source" in entry
                  ? entry.source
                  : undefined;
        if (typeof source !== "string" || !source) continue;
        const installed = manager.getInstalledPath(source, "user");
        if (!installed) continue;
        const laptopPath = await fsRealpath(installed).catch(() => null);
        if (laptopPath && (await fsStat(laptopPath)).isDirectory()) roots.push({ source, laptopPath });
    }
    return roots;
}

function inside(path: string, root: string): boolean {
    const rest = posix.relative(root, path);
    return rest === "" || (rest !== ".." && !rest.startsWith("../") && !posix.isAbsolute(rest));
}

/** Win32 OpenSSH exposes absolute drive paths as /C:/Users/name over SFTP. */
function sftpWirePath(path: string): string {
    if (platform !== "win32") return path;
    const normalized = path.replaceAll("\\", "/");
    if (!/^[A-Za-z]:\//.test(normalized)) {
        throw new Error("Windows laptop SFTP requires an absolute local drive path");
    }
    return `/${normalized}`;
}

export interface MountHeader {
    /** Absolute SFTP server path, independent of the receiver operating system. */
    laptopHome: string;
    sftpPort: number;
    sftpSecret: string;
    agents: boolean;
    /** Installed global packages, resolved on the laptop before opening the remote view. */
    packages?: LaptopPackageRoot[];
}

export interface SftpService {
    header: MountHeader;
    close(): Promise<void>;
}

/** Clear the deadline when a child settles so completed cleanup cannot keep the runtime alive. */
async function settleWithin<T>(operation: Promise<T>, ms: number): Promise<T | undefined> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<undefined>((resolve) => {
                deadline = setTimeout(() => resolve(undefined), ms);
            }),
        ]);
    } finally {
        if (deadline !== undefined) clearTimeout(deadline);
    }
}

/** Start one SFTP server per authenticated connection. The SSH reverse forward is the only intended client. */
export async function startLaptopSftp(): Promise<SftpService> {
    const home = getHomeDir();
    const source = join(home, ".wld");
    if (!(await fsStat(source).catch(() => null))?.isDirectory()) {
        throw new Error("Laptop ~/.wld must exist before a remote mount can start");
    }
    const paths =
        platform === "win32"
            ? [
                  ...(env.PATH || "")
                      .split(delimiter)
                      .filter(Boolean)
                      .map((directory) => join(directory, "sftp-server.exe")),
                  ...(env.ProgramFiles ? [join(env.ProgramFiles, "OpenSSH", "sftp-server.exe")] : []),
                  ...(env.SystemRoot ? [join(env.SystemRoot, "System32", "OpenSSH", "sftp-server.exe")] : []),
              ]
            : platform === "darwin"
              ? ["/usr/libexec/sftp-server"]
              : [
                    "/usr/lib/openssh/sftp-server",
                    "/usr/lib/ssh/sftp-server",
                    "/usr/libexec/sftp-server",
                    "/usr/libexec/openssh/sftp-server",
                ];
    let executable: string | undefined;
    for (const path of paths) {
        const file = await fsStat(path).catch(() => null);
        if (file?.isFile() && (platform === "win32" || (file.mode !== null && file.mode & 0o111))) {
            executable = path;
            break;
        }
    }
    if (!executable) throw new Error("OpenSSH sftp-server is required on the laptop");
    const agents = (await fsStat(join(home, ".agents")).catch(() => null))?.isDirectory() ?? false;
    const laptopHome = sftpWirePath(home);
    const packages = (await installedLaptopPackageRoots(home)).map((entry) => ({
        source: entry.source,
        laptopPath: sftpWirePath(entry.laptopPath),
    }));
    const listener = await listenSocket({ host: "127.0.0.1", port: 0 });
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, "0")).join(
        "",
    );
    const children = new Set<NativeProcess>();
    const connections = new Set<Socket>();
    const stopServingChild = async (child: NativeProcess) => {
        try {
            child.kill("SIGKILL");
        } catch {
            /* Already exited. */
        }
        if (!(await settleWithin(child.status, 5_000))) {
            throw new Error(`SFTP serving process termination unconfirmed: ${child.pid}`);
        }
    };
    let closed = false;
    const serve = async (conn: Socket) => {
        connections.add(conn);
        let child: NativeProcess | undefined;
        try {
            // The proxy sends a fixed-length credential before any SFTP bytes.
            const proof = new Uint8Array(65);
            let offset = 0;
            while (offset < proof.length) {
                const count = await readStreamInto(conn, proof.subarray(offset));
                if (count === null) return;
                offset += count;
            }
            const supplied = new TextDecoder().decode(proof);
            let difference = 0;
            const expected = `${secret}\n`;
            for (let i = 0; i < expected.length; i++) difference |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
            if (difference || closed) return;
            child = spawnNativeProcess(executable!, {
                cwd: getCwd(),
                args: [],
                stdin: "piped",
                stdout: "piped",
                stderr: "null",
            });
            children.add(child);
            await Promise.all([
                Readable.toWeb(conn)
                    .pipeTo(child.stdin)
                    .catch(() => undefined),
                child.stdout.pipeTo(Writable.toWeb(conn)).catch(() => undefined),
            ]);
        } catch {
            /* Connection closed. */
        } finally {
            try {
                conn.destroy();
            } catch {
                /* Already closed. */
            }
            connections.delete(conn);
            if (child) {
                const servingChild = child;
                await stopServingChild(servingChild)
                    .then(() => children.delete(servingChild))
                    .catch((error) => console.error("SFTP serving cleanup failed:", error));
            }
        }
    };
    const accept = (async () => {
        while (!closed) {
            try {
                void serve(await listener.accept());
            } catch {
                if (!closed) throw new Error("SFTP listener failed");
            }
        }
    })();
    return {
        header: {
            laptopHome,
            sftpPort: listener.port,
            sftpSecret: secret,
            agents,
            packages,
        },
        async close() {
            if (closed) return;
            closed = true;
            listener.close();
            for (const conn of connections) {
                try {
                    conn.destroy();
                } catch {
                    /* Already closed. */
                }
            }
            await accept;
            const results = await Promise.allSettled([...children].map(stopServingChild));
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
        },
    };
}

export function validateMountHeader(value: MountHeader): void {
    if (
        !value ||
        typeof value.laptopHome !== "string" ||
        !value.laptopHome.startsWith("/") ||
        value.laptopHome.includes("\0") ||
        !Number.isInteger(value.sftpPort) ||
        value.sftpPort < 1 ||
        value.sftpPort > 65535 ||
        !/^[a-f0-9]{64}$/.test(value.sftpSecret) ||
        typeof value.agents !== "boolean" ||
        (value.packages !== undefined &&
            (!Array.isArray(value.packages) ||
                value.packages.length > 128 ||
                value.packages.some(
                    (entry) =>
                        !entry ||
                        typeof entry.source !== "string" ||
                        !entry.source ||
                        typeof entry.laptopPath !== "string" ||
                        !posix.isAbsolute(entry.laptopPath) ||
                        entry.laptopPath.includes("\0") ||
                        entry.laptopPath === "/",
                )))
    ) {
        throw new Error("Invalid SFTP mount configuration");
    }
}

// Keep a descriptor to the underlying directory: chmod(path) after mount would change laptop files.
// The helper opens the descriptor before SSHFS starts and seals it even if its stdin closes early.
const SEAL_MOUNTPOINT = `import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.write(1, b'R')
    os.read(0, 1)
finally:
    os.fchmod(fd, 0o500)
    os.close(fd)
os.write(1, b'S')
`;

const PROXY = `#!/usr/bin/env python3
import os, socket, sys, threading
# The script is stored in a private connection directory; SSHFS supplies extra SSH arguments.
port = int(os.environ['WLD_SFTP_PORT'])
secret = os.environ['WLD_SFTP_SECRET']
sock = socket.create_connection(('127.0.0.1', port), timeout=10)
# The connect timeout must not become an idle I/O timeout for healthy mounts.
sock.settimeout(None)
sock.sendall(secret.encode() + b'\\n')
def incoming():
    try:
        while True:
            data = os.read(0, 65536)
            if not data: break
            sock.sendall(data)
    finally: sock.shutdown(socket.SHUT_WR)
threading.Thread(target=incoming, daemon=True).start()
while True:
    data = sock.recv(65536)
    if not data: break
    os.write(1, data)
`;

// Read the kernel mount table rather than trusting an SSHFS process or an empty mountpoint.
interface MountRecord {
    id: string;
    type: string;
}

async function mountAt(path: string): Promise<MountRecord | undefined> {
    const text = await fsReadFile("/proc/self/mountinfo", "utf8");
    const field = path.replaceAll("\\", "\\134").replaceAll(" ", "\\040").replaceAll("\t", "\\011");
    // The last matching entry is the visible (top) mount if another mount was stacked here.
    const line = text
        .split("\n")
        .filter((entry) => entry.split(" ")[4] === field)
        .at(-1);
    return line ? { id: line.split(" ")[0], type: line.split(" - ")[1]?.split(" ")[0] ?? "" } : undefined;
}

interface MountProcess {
    path: string;
    child: NativeProcess;
    mountId?: string;
}

export interface RemoteMount {
    /** Private connection-owned mount paths; never paths inside the remote account home. */
    globalRoot: string;
    agentsRoot?: string;
    /** Original package source to private mount path (or mounted .wld path). */
    packageRoots?: Record<string, string>;
    /** Resolves when a mount process exits or mounted storage fails a bounded health check. */
    lost: Promise<void>;
    close(): Promise<void>;
}

/** Mount only empty, newly created private entries. If unmount cannot be confirmed, retain the denied directory. */
export async function mountLaptopHome(home: string, config: MountHeader): Promise<RemoteMount> {
    validateMountHeader(config);
    if (platform !== "linux") throw new Error("Remote SSHFS mount requires Linux");
    if (!home.startsWith("/") || home.includes("\0") || (await fsRealpath(home)) !== home) {
        throw new Error("Invalid remote home for SSHFS mount");
    }
    const homeStat = await fsLstat(home);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw new Error("Remote home must be a real directory");
    for (const command of ["sshfs", "fusermount3", "python3"]) {
        const result = await captureForegroundProcess("sh", {
            cwd: getCwd(),
            args: ["-c", 'command -v "$1" >/dev/null', "--", command],
        });
        if (result.code !== 0) throw new Error(`Remote mount requires ${command}`);
    }
    if (!(await fsStat("/dev/fuse").catch(() => null))?.isCharacterDevice()) {
        throw new Error("Remote mount requires an accessible /dev/fuse");
    }
    await fsReadFile("/proc/self/mountinfo", "utf8").catch(() => {
        throw new Error("Remote mount requires /proc/self/mountinfo for safe cleanup");
    });
    const globalLaptop = posix.join(config.laptopHome, ".wld");
    const agentsLaptop = posix.join(config.laptopHome, ".agents");
    const mounts = [
        { name: "global", laptop: globalLaptop },
        ...(config.agents ? [{ name: "agents", laptop: agentsLaptop }] : []),
    ];
    const packageRoots: Record<string, string> = Object.create(null);
    for (const entry of config.packages ?? []) {
        if (Object.hasOwn(packageRoots, entry.source)) throw new Error("Duplicate laptop package source");
        if (inside(entry.laptopPath, globalLaptop)) {
            packageRoots[entry.source] = join("global", posix.relative(globalLaptop, entry.laptopPath));
        } else if (config.agents && inside(entry.laptopPath, agentsLaptop)) {
            packageRoots[entry.source] = join("agents", posix.relative(agentsLaptop, entry.laptopPath));
        } else {
            const name = `package-${mounts.length}`;
            mounts.push({ name, laptop: entry.laptopPath });
            packageRoots[entry.source] = name;
        }
    }
    // makeTempDir creates a unique directory; never reuse a previous mount root.
    const privateDir = await mkdtemp(join(tmpdir(), "wld-sftp-"));
    const proxy = join(privateDir, "sftp-proxy");
    const active: MountProcess[] = [];
    const created: string[] = [];
    let uncertain = false;
    let probePending = false;
    let monitorStopped = false;
    let monitorTimer: ReturnType<typeof setInterval> | undefined;
    let storageLost: (() => void) | undefined;
    const storageFailure = new Promise<void>((resolve) => {
        storageLost = resolve;
    });
    const boundedStorage = async <T>(operation: Promise<T>, label: string): Promise<T> => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<T>((_, reject) => {
                    deadline = setTimeout(() => {
                        uncertain = true;
                        reject(new Error(`SSHFS storage request timed out: ${label}`));
                    }, 30_000);
                }),
            ]);
        } finally {
            if (deadline !== undefined) clearTimeout(deadline);
        }
    };
    const close = async () => {
        monitorStopped = true;
        if (monitorTimer !== undefined) clearInterval(monitorTimer);
        // A timed-out or still-running kernel lookup cannot be cancelled by Promise.race.
        // Keep the sealed mountpoint and report uncertainty even if mountinfo changes.
        if (probePending) uncertain = true;
        let failure: Error | undefined;
        // A failed ordinary unmount can leave a live FUSE mount after the connection exits.
        // Each command is bounded. Check the visible mount identity again before every attempt;
        // never try to detach a mount that we did not observe during creation.
        const detach = async (path: string, mountId: string | undefined, lazy: boolean): Promise<boolean> => {
            const current = await mountAt(path);
            if (!current) return true;
            if (!mountId || current.id !== mountId || current.type !== "fuse.sshfs") {
                throw new Error(`Unexpected filesystem at mountpoint: ${path}`);
            }
            const unmount = spawnNativeProcess("fusermount3", {
                cwd: getCwd(),
                stdin: "null",
                args: lazy ? ["-uz", path] : ["-u", path],
                stdout: "null",
                stderr: "null",
            });
            const result = await settleWithin(unmount.status, 5_000);
            if (!result) {
                uncertain = true;
                try {
                    unmount.kill("SIGKILL");
                } catch {
                    /* Already exited. */
                }
                // A stuck helper can remain in the kernel even after SIGKILL.
                if (!(await settleWithin(unmount.status, 1_000))) {
                    throw new Error(`SSHFS unmount helper termination unconfirmed: ${path}`);
                }
            }
            // A different visible mount is not a successful detach of ours. Do not touch it.
            const after = await mountAt(path);
            if (after && (after.id !== mountId || after.type !== "fuse.sshfs")) {
                throw new Error(`Unexpected filesystem at mountpoint: ${path}`);
            }
            return !after;
        };
        for (const { path, child, mountId } of [...active].reverse()) {
            let stopped = false;
            const stopChild = async () => {
                if (stopped) return;
                stopped = true;
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* Already exited. */
                }
                if (!(await settleWithin(child.status, 5_000))) {
                    uncertain = true;
                    throw new Error(`SSHFS process termination unconfirmed: ${path}`);
                }
            };
            // A failed helper is not proof that the mount remains. Recheck mountinfo;
            // an unexpected identity is fatal and must never be used for a retry.
            const attempt = async (lazy: boolean): Promise<boolean> => {
                try {
                    return await detach(path, mountId, lazy);
                } catch (error) {
                    if (error instanceof Error && error.message.startsWith("Unexpected filesystem")) throw error;
                    uncertain = true;
                    return false;
                }
            };
            try {
                if (!(await attempt(false))) {
                    // Lazy detach removes the mount from this namespace, but cannot cancel
                    // pending kernel FUSE requests. Retain the sealed private directory.
                    uncertain = true;
                    if (!(await attempt(true))) {
                        await stopChild();
                        if (!(await attempt(true))) throw new Error(`SSHFS detach not confirmed: ${path}`);
                    }
                }
            } catch (error) {
                failure = error instanceof Error ? error : new Error(String(error));
            } finally {
                try {
                    await stopChild();
                } catch (error) {
                    failure = error instanceof Error ? error : new Error(String(error));
                }
            }
        }
        if (failure) uncertain = true;
        if (uncertain) {
            throw new Error(
                `SSHFS cleanup uncertain; sealed mount directory retained: ${privateDir}${
                    failure ? ` (${failure.message})` : ""
                }`,
            );
        }
        for (const path of [...created].reverse()) {
            try {
                if (await mountAt(path)) throw new Error(`SSHFS unmount not confirmed: ${path}`);
                // All SSHFS children have stopped. Seal even if the descriptor helper failed;
                // never chmod a path while a filesystem is mounted there.
                await fsChmod(path, 0o500);
                // Non-recursive removal refuses mounted paths and any unexpected contents.
                await rmdir(path);
            } catch (error) {
                failure = error instanceof Error ? error : new Error(String(error));
            }
        }
        // Never recursively delete a root that might still contain a live mount.
        await fsRm(proxy).catch((error) => {
            failure = error instanceof Error ? error : new Error(String(error));
        });
        await rmdir(privateDir).catch((error) => {
            failure = error instanceof Error ? error : new Error(String(error));
        });
        if (failure) throw failure;
    };
    try {
        await fsChmod(privateDir, 0o700);
        await fsWriteFile(proxy, PROXY, { mode: 0o700 });
        await fsChmod(proxy, 0o700);
        for (const entry of mounts) {
            const path = join(privateDir, entry.name);
            await fsMkdir(path, { mode: 0o700 });
            created.push(path);
            await fsChmod(path, 0o700);
            const sealer = spawnNativeProcess("python3", {
                cwd: getCwd(),
                args: ["-c", SEAL_MOUNTPOINT, path],
                stdin: "piped",
                stdout: "piped",
                stderr: "null",
            });
            const reader = sealer.stdout.getReader();
            const writer = sealer.stdin.getWriter();
            let owned: MountProcess | undefined;
            let sealFailed = false;
            try {
                const ready = await reader.read();
                if (ready.done || ready.value[0] !== 82) {
                    throw new Error(`Mountpoint descriptor not opened: ${entry.name}`);
                }
                const child = spawnNativeProcess("sshfs", {
                    cwd: getCwd(),
                    stdin: "null",
                    args: [
                        "-f",
                        `${"127.0.0.1"}:${entry.laptop}`,
                        path,
                        "-o",
                        `ssh_command=${proxy}`,
                        "-o",
                        "sshfs_sync,direct_io,no_readahead,cache=no,dir_cache=no,attr_timeout=0,entry_timeout=0,negative_timeout=0",
                    ],
                    env: { WLD_SFTP_PORT: String(config.sftpPort), WLD_SFTP_SECRET: config.sftpSecret },
                    stdout: "null",
                    stderr: "piped",
                });
                owned = { path, child };
                active.push(owned);
                const deadline = Date.now() + 12_000;
                while (Date.now() < deadline) {
                    const current = await mountAt(path);
                    if (current?.type === "fuse.sshfs") {
                        owned.mountId = current.id;
                        break;
                    }
                    if (current) throw new Error(`Unexpected filesystem at mountpoint: ${path}`);
                    if (await settleWithin(child.status, 100)) {
                        const detail = (await new Response(child.stderr).text())
                            .trim()
                            .replaceAll(config.sftpSecret, "[redacted]");
                        throw new Error(`SSHFS stopped before mounting ${entry.name}: ${detail}`);
                    }
                }
                if (!owned.mountId) throw new Error(`SSHFS did not mount ${entry.name}`);
            } finally {
                // Seal by descriptor before any probe or readiness, including failed starts.
                // Closing stdin also triggers sealing if the mount attempt threw.
                await writer.close().catch(() => undefined);
                const sealed = await reader.read();
                const result = await sealer.status;
                reader.releaseLock();
                writer.releaseLock();
                sealFailed = !result.success || sealed.done || sealed.value[0] !== 83;
            }
            if (sealFailed) throw new Error(`Underlying mountpoint was not sealed: ${entry.name}`);
            if (!owned?.mountId) throw new Error(`SSHFS did not mount ${entry.name}`);
            // A fresh name cannot be returned from the cache. Verify both directions before readiness.
            const probe = join(path, `.wld-mount-probe-${crypto.randomUUID()}`);
            try {
                await boundedStorage(fsWriteFile(probe, "laptop-backed", { flag: "wx" }), entry.name);
                if ((await boundedStorage(fsReadFile(probe, "utf8"), entry.name)) !== "laptop-backed") {
                    throw new Error("SSHFS readback differs");
                }
            } finally {
                // Do not issue more FUSE operations after a request timed out.
                if (!uncertain) await boundedStorage(fsRm(probe), entry.name).catch(() => undefined);
            }
            if ((await mountAt(path))?.id !== owned.mountId) throw new Error(`SSHFS mount lost: ${entry.name}`);
        }
        const checkStorage = async () => {
            if (monitorStopped || probePending) return;
            probePending = true;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
                // A fresh, unpredictable missing name forces a lookup through SSHFS rather
                // than accepting a cached stat of the mount root. NotFound is expected.
                const lookup = async () => {
                    for (const { path, mountId } of active) {
                        if (monitorStopped) return;
                        const before = await mountAt(path);
                        if (before?.id !== mountId || before?.type !== "fuse.sshfs") {
                            throw new Error(`SSHFS mount identity changed: ${path}`);
                        }
                        try {
                            await fsStat(join(path, `.wld-health-${crypto.randomUUID()}`));
                            throw new Error(`Unexpected SSHFS health entry: ${path}`);
                        } catch (error) {
                            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
                        }
                        const after = await mountAt(path);
                        if (after?.id !== mountId || after?.type !== "fuse.sshfs") {
                            throw new Error(`SSHFS mount identity changed: ${path}`);
                        }
                    }
                };
                const result = await Promise.race([
                    lookup().then(
                        () => "healthy" as const,
                        () => "failed" as const,
                    ),
                    new Promise<"timed out">((resolve) => {
                        deadline = setTimeout(() => resolve("timed out"), 30_000);
                    }),
                ]);
                if (result === "timed out") uncertain = true; // The kernel lookup remains in flight.
                if (result !== "healthy" && !monitorStopped) {
                    monitorStopped = true;
                    if (monitorTimer !== undefined) clearInterval(monitorTimer);
                    storageLost?.();
                }
            } finally {
                if (deadline !== undefined) clearTimeout(deadline);
                probePending = false;
            }
        };
        monitorTimer = setInterval(() => {
            void checkStorage();
        }, 5_000);
        return {
            globalRoot: join(privateDir, "global"),
            ...(config.agents ? { agentsRoot: join(privateDir, "agents") } : {}),
            packageRoots: Object.fromEntries(
                Object.entries(packageRoots).map(([source, path]) => [source, join(privateDir, path)]),
            ),
            lost: Promise.race([storageFailure, ...active.map(({ child }) => child.status.then(() => undefined))]),
            close,
        };
    } catch (error) {
        await close().catch((cleanup) => console.error("Remote mount cleanup failed:", cleanup));
        throw error;
    }
}
