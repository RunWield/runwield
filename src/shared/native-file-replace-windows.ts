/** Preserve open readers when replacing a file on Bun/Windows. */
import { platform, versions } from "node:process";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { toNamespacedPath } from "node:path";

interface NativeFunction {
    args: string[];
    returns: string;
}
interface ReplaceSymbols {
    CreateFileW(
        path: Uint8Array,
        access: number,
        share: number,
        security: number,
        disposition: number,
        flags: number,
        template: bigint,
    ): bigint;
    SetFileInformationByHandle(handle: bigint, informationClass: number, information: Uint8Array, size: number): number;
    CloseHandle(handle: bigint): number;
}
interface ReplaceFFI {
    dlopen(path: string, functions: Record<string, NativeFunction>): { symbols: ReplaceSymbols };
}
let symbols: ReplaceSymbols | undefined;
function windowsAPI(): ReplaceSymbols {
    if (symbols) return symbols;
    const ffi: ReplaceFFI = createRequire(import.meta.url)("bun:ffi");
    symbols = ffi.dlopen("kernel32.dll", {
        CreateFileW: { args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
        SetFileInformationByHandle: { args: ["u64", "u32", "buffer", "u32"], returns: "i32" },
        CloseHandle: { args: ["u64"], returns: "i32" },
    }).symbols;
    return symbols;
}

/**
 * Used only after ordinary rename reports access denied. Match Rust/Deno's
 * FileRenameInfoEx fallback: replace the directory entry atomically while open
 * handles continue reading the previous file. Never unlink or copy the target.
 * https://github.com/rust-lang/rust/blob/1.92.0/library/std/src/sys/fs/windows.rs#L1200
 */
export function tryReplaceWindowsFileSync(source: string, destination: string): boolean {
    if (source.includes("\0") || destination.includes("\0")) return false;
    const api = windowsAPI();
    const handle = api.CreateFileW(
        Buffer.from(toNamespacedPath(source) + "\0", "utf16le"),
        0x10000, // DELETE access is required for rename.
        7, // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE.
        0,
        3, // OPEN_EXISTING: never create or truncate the source.
        0x02200000, // OPEN_REPARSE_POINT | BACKUP_SEMANTICS.
        0n,
    );
    if (handle === 0xffffffffffffffffn || handle === 0n) return false;
    try {
        const name = Buffer.from(toNamespacedPath(destination) + "\0", "utf16le");
        // Both supported Windows targets use the 64-bit FILE_RENAME_INFO layout:
        // flags at 0, null RootDirectory at 8, byte length at 16, UTF-16 name at 20.
        const information = Buffer.alloc(20 + name.byteLength);
        information.writeUInt32LE(3, 0); // REPLACE_IF_EXISTS | POSIX_SEMANTICS.
        information.writeUInt32LE(name.byteLength - 2, 16);
        name.copy(information, 20);
        return api.SetFileInformationByHandle(handle, 22, information, information.byteLength) !== 0;
    } finally {
        api.CloseHandle(handle);
    }
}

/** Recover only Bun/Windows access-denied rename failures without changing other errors. */
export function recoverWindowsRename(error: Error, source: string, destination: string): boolean {
    return Boolean(
        platform === "win32" &&
        versions.bun &&
        "code" in error &&
        error.code === "EPERM" &&
        tryReplaceWindowsFileSync(source, destination),
    );
}
