/** Read only through the file object whose OS-resolved path passed containment. */
import {
    closeSync,
    constants,
    readFileSync,
    readlinkSync,
    fstatSync,
    lstatSync,
    fsyncSync,
    type BigIntStats,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from "node:path";
import { writeJsonAtomically } from "./private-json-file.ts";
import { platform, pid } from "node:process";

interface NativeFunction {
    args: string[];
    returns: string;
}
interface PathSymbols {
    proc_pidfdinfo(pid: number, fd: number, flavor: number, buffer: Uint8Array, size: number): number;
}
interface ObjectPathSymbols {
    fsgetpath(buffer: Uint8Array, size: bigint, fsid: Uint8Array, inode: bigint): bigint;
}
interface ObjectPathFFI {
    dlopen(path: string, functions: Record<string, NativeFunction>): { symbols: ObjectPathSymbols };
}
interface WindowsSymbols {
    SetFileInformationByHandle(handle: bigint, kind: number, buffer: Uint8Array, size: number): number;
    CreateFileW(
        path: Uint8Array,
        access: number,
        share: number,
        security: number,
        disposition: number,
        flags: number,
        template: bigint,
    ): bigint;
    GetFinalPathNameByHandleW(handle: bigint, path: Uint8Array, length: number, flags: number): number;
    GetFileType(handle: bigint): number;
    ReadFile(handle: bigint, buffer: Uint8Array, length: number, count: Uint8Array, overlapped: number): number;
    CloseHandle(handle: bigint): number;
}
interface PathFFI {
    dlopen(path: string, functions: Record<string, NativeFunction>): { symbols: PathSymbols };
}
interface WindowsFFI {
    dlopen(path: string, functions: Record<string, NativeFunction>): { symbols: WindowsSymbols };
}
let macPaths: PathSymbols | undefined;
let macObjectPaths: ObjectPathSymbols | undefined;
let windowsFiles: WindowsSymbols | undefined;

export function isPathInside(path: string, root: string): boolean {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    // Keep case significant, including on Windows case-sensitive directories.
    const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(prefix);
}

function denied(): Error {
    return Object.assign(new Error("Cannot verify opened file containment."), { code: "EACCES" });
}

function descriptorPath(fd: number): string {
    if (platform === "linux") {
        // readlink reports the opened object, without resolving the requested path again.
        const path = readlinkSync(`/proc/self/fd/${fd}`);
        if (!isAbsolute(path) || path.endsWith(" (deleted)")) throw denied();
        return path;
    }
    if (platform === "darwin") {
        if (!macPaths) {
            const ffi: PathFFI = createRequire(import.meta.url)("bun:ffi");
            macPaths = ffi.dlopen("/usr/lib/libproc.dylib", {
                proc_pidfdinfo: { args: ["i32", "i32", "i32", "buffer", "i32"], returns: "i32" },
            }).symbols;
        }
        if (!macObjectPaths) {
            const ffi: ObjectPathFFI = createRequire(import.meta.url)("bun:ffi");
            macObjectPaths = ffi.dlopen("/usr/lib/libSystem.B.dylib", {
                fsgetpath: { args: ["buffer", "u64", "buffer", "u64"], returns: "i64" },
            }).symbols;
        }
        // Darwin sys/proc_info.h (64-bit): PROC_PIDFDVNODEPATHINFO = 2;
        // vnode_fdinfowithpath is 1200 bytes; inode is at 32, fsid_t at 168.
        const information = Buffer.alloc(1200);
        if (macPaths.proc_pidfdinfo(pid, fd, 2, information, information.length) !== information.length) throw denied();
        // Do NOT use libproc's path field: it hides vn_getpath errors and can
        // contain a truncated suffix. fsgetpath reports reconstruction failures.
        const buffer = Buffer.alloc(8192);
        const length = Number(
            macObjectPaths.fsgetpath(
                buffer,
                BigInt(buffer.length),
                information.subarray(168, 176),
                information.readBigUInt64LE(32),
            ),
        );
        if (length <= 1 || length > buffer.length || buffer[length - 1] !== 0) throw denied();
        const path = buffer.toString("utf8", 0, length - 1);
        if (!isAbsolute(path)) throw denied();
        return path;
    }
    throw denied();
}

function windowsAPI(): WindowsSymbols {
    if (windowsFiles) return windowsFiles;
    const ffi: WindowsFFI = createRequire(import.meta.url)("bun:ffi");
    windowsFiles = ffi.dlopen("kernel32.dll", {
        SetFileInformationByHandle: { args: ["u64", "u32", "buffer", "u32"], returns: "i32" },
        CreateFileW: { args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
        GetFinalPathNameByHandleW: { args: ["u64", "buffer", "u32", "u32"], returns: "u32" },
        GetFileType: { args: ["u64"], returns: "u32" },
        ReadFile: { args: ["u64", "buffer", "u32", "buffer", "ptr"], returns: "i32" },
        CloseHandle: { args: ["u64"], returns: "i32" },
    }).symbols;
    return windowsFiles;
}

function readWindowsText(root: string, path: string, pruneDigest?: string): string {
    const api = windowsAPI();
    const handle = api.CreateFileW(
        Buffer.from(toNamespacedPath(path) + "\0", "utf16le"),
        pruneDigest ? 0x80010000 : 0x80000000, // Pruning also requires DELETE access.
        pruneDigest ? 1 : 7, // Prevent replacement and writes during the digest check.
        0,
        3, // OPEN_EXISTING.
        pruneDigest ? 0x00200000 : 0, // OPEN_REPARSE_POINT for deletion.
        0n,
    );
    if (handle === 0n || handle === 0xffffffffffffffffn) throw denied();
    try {
        if (api.GetFileType(handle) !== 1) throw denied(); // FILE_TYPE_DISK.
        const buffer = Buffer.alloc(32768 * 2);
        const length = api.GetFinalPathNameByHandleW(handle, buffer, buffer.length / 2, 0);
        if (length === 0 || length >= buffer.length / 2) throw denied();
        const finalPath = buffer.toString("utf16le", 0, length * 2);
        const normalized = finalPath.startsWith("\\\\?\\UNC\\")
            ? "\\\\" + finalPath.slice(8)
            : finalPath.startsWith("\\\\?\\")
              ? finalPath.slice(4)
              : finalPath;
        if (!isPathInside(normalized, root)) throw denied();
        if (pruneDigest && normalized !== path) throw denied();
        const chunks: Buffer[] = [];
        const count = Buffer.alloc(4);
        for (;;) {
            if (!api.ReadFile(handle, buffer, buffer.length, count, 0)) throw denied();
            const size = count.readUInt32LE(0);
            if (size === 0) break;
            chunks.push(Buffer.from(buffer.subarray(0, size)));
        }
        const bytes = Buffer.concat(chunks);
        if (pruneDigest && createHash("sha256").update(bytes).digest("hex") === pruneDigest) {
            if (!api.SetFileInformationByHandle(handle, 4, Buffer.from([1]), 1)) throw denied();
        }
        return bytes.toString("utf8");
    } finally {
        api.CloseHandle(handle);
    }
}

type RenameExclusive = (from: number, source: Uint8Array, to: number, target: Uint8Array, flags: number) => number;
interface UnlinkFFI {
    dlopen(
        path: string,
        functions: Record<string, NativeFunction>,
    ): {
        symbols: {
            renameat2: RenameExclusive;
            renameatx_np: RenameExclusive;
            openat(parent: number, name: Uint8Array, flags: number): number;
            unlinkat(parent: number, name: Uint8Array, flags: number): number;
        };
    };
}
let unlinkLibrary: ReturnType<UnlinkFFI["dlopen"]> | undefined;

interface CopyCleanupJournal {
    path: string;
    digest: string;
    stageId: string;
    parent: string;
    original: string;
    settled: boolean;
}
function fileIdentity(stat: BigIntStats): string {
    return [stat.dev, stat.ino, stat.birthtimeNs].join("/");
}
function copyJournal(location: string, path: string, digest: string): CopyCleanupJournal | undefined {
    let text: string;
    try {
        text = readFileSync(location, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
    }
    const entry: CopyCleanupJournal = JSON.parse(text);
    if (
        entry.path !== path ||
        entry.digest !== digest ||
        !/^[a-f0-9-]{36}$/.test(entry.stageId) ||
        !entry.original ||
        !entry.parent ||
        typeof entry.settled !== "boolean"
    )
        throw denied();
    return entry;
}
/** Keep the validated parent open so removal never resolves its ancestors again. */
export async function removeContainedCopy(
    root: string,
    path: string,
    digest: string,
    journalPath: string,
    signal?: AbortSignal,
): Promise<void> {
    signal?.throwIfAborted();
    if (!isPathInside(path, root) || path.includes("\0") || !/^[a-f0-9]{64}$/.test(digest)) throw denied();
    if (platform === "win32") {
        readWindowsText(root, path, digest);
        return;
    }
    if (platform !== "linux" && platform !== "darwin") throw denied();
    if (!unlinkLibrary) {
        const ffi: UnlinkFFI = createRequire(import.meta.url)("bun:ffi");
        unlinkLibrary = ffi.dlopen(platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
            [platform === "darwin" ? "renameatx_np" : "renameat2"]: {
                args: ["i32", "buffer", "i32", "buffer", "u32"],
                returns: "i32",
            },
            openat: { args: ["i32", "buffer", "i32"], returns: "i32" },
            unlinkat: { args: ["i32", "buffer", "i32"], returns: "i32" },
        });
    }
    const api = unlinkLibrary.symbols;
    let journal = copyJournal(journalPath, path, digest);
    if (journal?.settled) return;
    const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(
        (error: NodeJS.ErrnoException) => {
            if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code || "")) return;
            throw error;
        },
    );
    function preserveMovedDirectory() {
        if (journal) {
            console.warn(
                `Copy directory moved. Preserved any detached save as RunWield recovered copy ${journal.stageId}.md in that directory.`,
            );
            writeJsonAtomically(journalPath, { ...journal, settled: true });
        }
    }
    if (!parent) {
        signal?.throwIfAborted();
        return preserveMovedDirectory();
    }
    try {
        signal?.throwIfAborted();
        const parentId = fileIdentity(fstatSync(parent.fd, { bigint: true }));
        if (descriptorPath(parent.fd) !== dirname(path) || (journal && journal.parent !== parentId))
            return preserveMovedDirectory();
        const name = Buffer.from(basename(path) + "\0");
        const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
        const identityIfApproved = (leaf: Buffer, expectedPath: string) => {
            const fd = api.openat(parent.fd, leaf, flags);
            if (fd < 0) return;
            try {
                const info = fstatSync(fd, { bigint: true });
                if (
                    info.isFile() &&
                    descriptorPath(fd) === expectedPath &&
                    createHash("sha256").update(readFileSync(fd)).digest("hex") === digest
                )
                    return fileIdentity(info);
            } finally {
                closeSync(fd);
            }
        };
        if (!journal) {
            const original = identityIfApproved(name, path);
            if (!original) return;
            journal = { path, digest, original, parent: parentId, stageId: randomUUID(), settled: false };
            writeJsonAtomically(journalPath, journal);
        }
        const rename = platform === "darwin" ? api.renameatx_np : api.renameat2;
        const exclusive = platform === "darwin" ? 4 : 1; // RENAME_EXCL or RENAME_NOREPLACE.
        const stageName = "RunWield recovered copy " + journal.stageId + ".md";
        const staged = Buffer.from(stageName + "\0");
        const stagePath = join(dirname(path), stageName);
        let detached = !!lstatSync(stagePath, { throwIfNoEntry: false });
        if (!detached && identityIfApproved(name, path) === journal.original) {
            if (
                descriptorPath(parent.fd) !== dirname(path) ||
                rename(parent.fd, name, parent.fd, staged, exclusive) !== 0
            ) {
                // The copy is still in place. Only a detached file needs recovery.
                writeJsonAtomically(journalPath, { ...journal, settled: true });
                return;
            }
            fsyncSync(parent.fd);
            detached = true;
        }
        if (detached) {
            if (descriptorPath(parent.fd) !== dirname(path)) throw denied();
            if (identityIfApproved(staged, stagePath) === journal.original) {
                if (api.unlinkat(parent.fd, staged, 0) !== 0) throw denied();
            } else if (rename(parent.fd, staged, parent.fd, name, exclusive) !== 0) {
                if (!lstatSync(path, { throwIfNoEntry: false }))
                    throw new Error("Could not restore an edited copy. Retry cleanup.");
                console.warn(`Preserved both editor saves at ${path} and ${stagePath}`);
            }
        }
        fsyncSync(parent.fd);
        writeJsonAtomically(journalPath, { ...journal, settled: true });
    } finally {
        await parent.close();
    }
}

/** Unknown descriptor paths fail closed; no pathname-read fallback is permitted. */
export async function readContainedTextFile(root: string, path: string): Promise<string | null> {
    if (platform === "win32") return readWindowsText(root, path);
    // Nonblocking prevents a raced replacement with a FIFO from hanging the reader.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        if (!(await file.stat()).isFile()) return null;
        if (!isPathInside(descriptorPath(file.fd), root)) throw denied();
        return await file.readFile("utf8");
    } finally {
        await file.close();
    }
}
