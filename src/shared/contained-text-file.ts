/** Read only through the file object whose OS-resolved path passed containment. */
import { constants, readlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { isAbsolute, resolve, sep, toNamespacedPath } from "node:path";
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
        CreateFileW: { args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
        GetFinalPathNameByHandleW: { args: ["u64", "buffer", "u32", "u32"], returns: "u32" },
        GetFileType: { args: ["u64"], returns: "u32" },
        ReadFile: { args: ["u64", "buffer", "u32", "buffer", "ptr"], returns: "i32" },
        CloseHandle: { args: ["u64"], returns: "i32" },
    }).symbols;
    return windowsFiles;
}

function readWindowsText(root: string, path: string): string {
    const api = windowsAPI();
    const handle = api.CreateFileW(
        Buffer.from(toNamespacedPath(path) + "\0", "utf16le"),
        0x80000000, // GENERIC_READ: never create, truncate, or write.
        7, // Share read, write, and delete; do not change other actors' access.
        0,
        3, // OPEN_EXISTING.
        0,
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
        const chunks: Buffer[] = [];
        const count = Buffer.alloc(4);
        for (;;) {
            if (!api.ReadFile(handle, buffer, buffer.length, count, 0)) throw denied();
            const size = count.readUInt32LE(0);
            if (size === 0) break;
            chunks.push(Buffer.from(buffer.subarray(0, size)));
        }
        return Buffer.concat(chunks).toString("utf8");
    } finally {
        api.CloseHandle(handle);
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
