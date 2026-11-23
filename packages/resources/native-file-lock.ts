/** OS-backed advisory locks shared with Deno and other POSIX flock writers. */
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, versions } from "node:process";
import { getSystemErrorName } from "node:util";
import { openWindowsFileLock } from "./native-file-lock-windows.ts";

export interface NativeFileLock {
    tryLockSync(exclusive?: boolean): boolean;
    lockSync(exclusive?: boolean): void;
    lock(exclusive?: boolean): Promise<void>;
    readSnapshotSync(): NativeLockSnapshot;
    replaceTextSync(text: string): void;
    unlockSync(): void;
    close(): void;
}

export interface NativeLockSnapshot {
    text: string;
    size: number;
    mtime: number;
}
interface NativeFunction {
    args: string[];
    returns: string;
}
interface LockSymbols {
    flock(fd: number, operation: number): number;
    __error?: () => number;
    __errno_location?: () => number;
}
interface LockLibrary {
    symbols: LockSymbols;
}
interface BunLockFFI {
    dlopen(path: string, functions: Record<string, NativeFunction>): LockLibrary;
    read: { i32(pointer: number): number };
}
interface PosixLockAPI {
    flock(fd: number, operation: number): number;
    errno(): number;
}

let posixAPI: PosixLockAPI | undefined;
function getPosixLockAPI(): PosixLockAPI {
    if (posixAPI) return posixAPI;
    if (!versions.bun || (platform !== "darwin" && platform !== "linux")) {
        throw new Error("Native file locks require Bun on macOS/Linux");
    }
    // Load the native Bun capability only when a POSIX lock is requested.
    const ffi: BunLockFFI = createRequire(import.meta.url)("bun:ffi");
    const errnoSymbol = platform === "darwin" ? "__error" : "__errno_location";
    const library = ffi.dlopen(platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
        flock: { args: ["i32", "i32"], returns: "i32" },
        [errnoSymbol]: { args: [], returns: "ptr" },
    });
    const errnoPointer = library.symbols[errnoSymbol];
    if (!errnoPointer) throw new Error(`Native lock library has no ${errnoSymbol}`);
    posixAPI = {
        flock: library.symbols.flock,
        errno: () => ffi.read.i32(errnoPointer()),
    };
    return posixAPI;
}

function lockError(errno: number): NodeJS.ErrnoException {
    const code = getSystemErrorName(-errno);
    return Object.assign(new Error(`flock: ${code}`), { code, errno: -errno, syscall: "flock" });
}

/** Opening does not acquire a lock or truncate an existing lock file. */
export function openNativeFileLock(path: string, create: boolean | "exclusive" = true): NativeFileLock {
    if (versions.bun && platform === "win32") return openWindowsFileLock(path, create);
    const api = getPosixLockAPI();
    let fd = openSync(
        path,
        constants.O_RDWR | (create ? constants.O_CREAT : 0) | (create === "exclusive" ? constants.O_EXCL : 0),
        0o600,
    );
    function flock(operation: number): boolean {
        if (fd < 0) throw lockError(9); // EBADF: never operate on a reused descriptor.
        for (;;) {
            if (api.flock(fd, operation) === 0) return true;
            const errno = api.errno();
            if (errno === 4) continue; // EINTR does not establish lock ownership.
            if ((operation & 4) !== 0 && errno === (platform === "darwin" ? 35 : 11)) return false;
            throw lockError(errno);
        }
    }
    return {
        tryLockSync(exclusive = false) {
            return flock((exclusive ? 2 : 1) | 4);
        },
        lockSync(exclusive = false) {
            flock(exclusive ? 2 : 1);
        },
        async lock(exclusive = false) {
            while (!flock((exclusive ? 2 : 1) | 4)) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        },
        readSnapshotSync() {
            if (fd < 0) throw lockError(9);
            const stat = fstatSync(fd);
            const bytes = new Uint8Array(stat.size);
            let offset = 0;
            while (offset < bytes.length) {
                const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
                if (count === 0) break;
                offset += count;
            }
            return {
                text: new TextDecoder().decode(bytes.subarray(0, offset)),
                size: stat.size,
                mtime: stat.mtime.getTime(),
            };
        },
        replaceTextSync(text) {
            if (fd < 0) throw lockError(9);
            ftruncateSync(fd, 0);
            const bytes = new TextEncoder().encode(text);
            let offset = 0;
            while (offset < bytes.length) {
                const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
                if (count === 0) throw new Error("Lock metadata write made no progress");
                offset += count;
            }
            fsyncSync(fd);
        },
        unlockSync() {
            flock(8);
        },
        close() {
            if (fd < 0) throw lockError(9);
            const closing = fd;
            fd = -1;
            closeSync(closing);
        },
    };
}
