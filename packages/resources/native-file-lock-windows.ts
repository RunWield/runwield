/** Win32 byte-range locks, sharing the same kernel ownership as Deno's file locks. */
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { toNamespacedPath } from "node:path";
import type { NativeFileLock } from "./native-file-lock.ts";

interface NativeFunction {
    args: string[];
    returns: string;
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
    LockFileEx(
        handle: bigint,
        flags: number,
        reserved: number,
        low: number,
        high: number,
        overlapped: Uint8Array,
    ): number;
    UnlockFileEx(handle: bigint, reserved: number, low: number, high: number, overlapped: Uint8Array): number;
    CloseHandle(handle: bigint): number;
    GetLastError(): number;
    GetFileSizeEx(handle: bigint, size: Uint8Array): number;
    GetFileTime(handle: bigint, creation: number, access: number, modified: Uint8Array): number;
    SetFilePointerEx(handle: bigint, distance: bigint, position: number, method: number): number;
    SetEndOfFile(handle: bigint): number;
    FlushFileBuffers(handle: bigint): number;
    ReadFile(handle: bigint, bytes: Uint8Array, length: number, count: Uint8Array, overlapped: number): number;
    WriteFile(handle: bigint, bytes: Uint8Array, length: number, count: Uint8Array, overlapped: number): number;
}
interface WindowsFFI {
    dlopen(path: string, functions: Record<string, NativeFunction>): { symbols: WindowsSymbols };
}
let symbols: WindowsSymbols | undefined;
function windowsAPI(): WindowsSymbols {
    if (symbols) return symbols;
    const ffi: WindowsFFI = createRequire(import.meta.url)("bun:ffi");
    symbols = ffi.dlopen("kernel32.dll", {
        CreateFileW: { args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
        LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "buffer"], returns: "i32" },
        UnlockFileEx: { args: ["u64", "u32", "u32", "u32", "buffer"], returns: "i32" },
        CloseHandle: { args: ["u64"], returns: "i32" },
        GetLastError: { args: [], returns: "u32" },
        GetFileSizeEx: { args: ["u64", "buffer"], returns: "i32" },
        GetFileTime: { args: ["u64", "ptr", "ptr", "buffer"], returns: "i32" },
        SetFilePointerEx: { args: ["u64", "i64", "ptr", "u32"], returns: "i32" },
        SetEndOfFile: { args: ["u64"], returns: "i32" },
        FlushFileBuffers: { args: ["u64"], returns: "i32" },
        ReadFile: { args: ["u64", "buffer", "u32", "buffer", "ptr"], returns: "i32" },
        WriteFile: { args: ["u64", "buffer", "u32", "buffer", "ptr"], returns: "i32" },
    }).symbols;
    return symbols;
}
function windowsError(errno: number, syscall: string, path: string): NodeJS.ErrnoException {
    const codes: Record<number, string> = {
        2: "ENOENT",
        3: "ENOENT",
        5: "EACCES",
        6: "EBADF",
        32: "EBUSY",
        33: "EAGAIN",
        80: "EEXIST",
        87: "EINVAL",
        112: "ENOSPC",
        123: "EINVAL",
        158: "EINVAL",
        183: "EEXIST",
        267: "ENOTDIR",
    };
    const code = codes[errno] || "EIO";
    return Object.assign(new Error(`${syscall}: ${code} (Windows error ${errno}), ${path}`), {
        code,
        errno,
        syscall,
        path,
    });
}

export function openWindowsFileLock(path: string, create: boolean | "exclusive"): NativeFileLock {
    if (path.includes("\0")) throw windowsError(123, "CreateFileW", path);
    const api = windowsAPI();
    // Own the HANDLE directly: a Bun/Node descriptor is not a portable Win32 HANDLE.
    // Share deletion for snapshot-safe stale-file retirement; locking still excludes writers.
    const handle = api.CreateFileW(
        Buffer.from(toNamespacedPath(path) + "\0", "utf16le"),
        0xc0000000,
        7,
        0,
        create === "exclusive" ? 1 : create ? 4 : 3,
        0x80,
        0n,
    );
    if (handle === 0xffffffffffffffffn || handle === 0n) {
        throw windowsError(api.GetLastError(), "CreateFileW", path);
    }
    let closed = false;
    let held: boolean | undefined;
    // Both supported Windows targets are 64-bit: OVERLAPPED is 32 bytes; offset zero.
    const overlapped = new Uint8Array(32);
    function ensureOpen(): void {
        if (closed) throw windowsError(6, "file lock", path);
    }
    function checked(result: number, syscall: string): void {
        if (!result) throw windowsError(api.GetLastError(), syscall, path);
    }
    function unlock(): void {
        ensureOpen();
        if (held === undefined) return;
        checked(api.UnlockFileEx(handle, 0, 0xffffffff, 0xffffffff, overlapped), "UnlockFileEx");
        held = undefined;
    }
    function acquire(exclusive: boolean, immediate: boolean): boolean {
        ensureOpen();
        if (held === exclusive) return true;
        if (held !== undefined) unlock(); // Like flock, mode conversion is not atomic.
        if (api.LockFileEx(handle, (exclusive ? 2 : 0) | (immediate ? 1 : 0), 0, 0xffffffff, 0xffffffff, overlapped)) {
            held = exclusive;
            return true;
        }
        const error = api.GetLastError();
        if (immediate && error === 33) return false; // ERROR_LOCK_VIOLATION only denotes contention.
        throw windowsError(error, "LockFileEx", path);
    }
    function rewind(): void {
        ensureOpen();
        checked(api.SetFilePointerEx(handle, 0n, 0, 0), "SetFilePointerEx");
    }
    return {
        tryLockSync: (exclusive = false) => acquire(exclusive, true),
        lockSync(exclusive = false) {
            acquire(exclusive, false);
        },
        async lock(exclusive = false) {
            while (!acquire(exclusive, true)) await new Promise((resolve) => setTimeout(resolve, 10));
        },
        unlockSync: unlock,
        close() {
            ensureOpen();
            closed = true;
            checked(api.CloseHandle(handle), "CloseHandle");
        },
        readSnapshotSync() {
            rewind();
            const sizeBytes = new Uint8Array(8);
            const timeBytes = new Uint8Array(8);
            checked(api.GetFileSizeEx(handle, sizeBytes), "GetFileSizeEx");
            checked(api.GetFileTime(handle, 0, 0, timeBytes), "GetFileTime");
            const size = Number(new DataView(sizeBytes.buffer).getBigUint64(0, true));
            if (!Number.isSafeInteger(size)) throw new Error("Lock metadata exceeds the safe size range");
            const bytes = new Uint8Array(size);
            const count = new Uint8Array(4);
            let offset = 0;
            while (offset < size) {
                const chunk = bytes.subarray(offset, Math.min(size, offset + 0x7fffffff));
                checked(api.ReadFile(handle, chunk, chunk.length, count, 0), "ReadFile");
                const read = new DataView(count.buffer).getUint32(0, true);
                if (!read) break;
                offset += read;
            }
            return {
                text: new TextDecoder().decode(bytes.subarray(0, offset)),
                size,
                mtime: Number(new DataView(timeBytes.buffer).getBigUint64(0, true) / 10000n - 11644473600000n),
            };
        },
        replaceTextSync(text) {
            rewind();
            checked(api.SetEndOfFile(handle), "SetEndOfFile");
            const bytes = new TextEncoder().encode(text);
            const count = new Uint8Array(4);
            let offset = 0;
            while (offset < bytes.length) {
                const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 0x7fffffff));
                checked(api.WriteFile(handle, chunk, chunk.length, count, 0), "WriteFile");
                const written = new DataView(count.buffer).getUint32(0, true);
                if (!written) throw new Error("Lock metadata write made no progress");
                offset += written;
            }
            checked(api.FlushFileBuffers(handle), "FlushFileBuffers");
        },
    };
}
