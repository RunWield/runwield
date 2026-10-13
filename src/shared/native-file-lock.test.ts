import { equal, match, ok, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { readLockFileSnapshot, removeLockFileIfSnapshotMatches } from "./lock-file-snapshot.ts";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { execPath, pid, platform, versions } from "node:process";
import { test } from "node:test";
import { openNativeFileLock } from "./native-file-lock.ts";

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "runwield-native-lock-"));
    return {
        directory,
        path: join(directory, "writer-λ守🔒.lock"),
        close: () => rmSync(directory, { recursive: true }),
    };
}

test("native locks exclude separate descriptors without truncating private lock contents", () => {
    const f = fixture();
    const first = openNativeFileLock(f.path);
    writeFileSync(f.path, "owner evidence");
    const second = openNativeFileLock(f.path, false);
    try {
        equal(first.tryLockSync(true), true);
        equal(second.tryLockSync(true), false);
        equal(second.tryLockSync(false), false);
        equal(first.readSnapshotSync().text, "owner evidence");
        if (platform === "win32") throws(() => readFileSync(f.path));
        else equal(readFileSync(f.path, "utf8"), "owner evidence");
        if (platform !== "win32") equal(statSync(f.path).mode & 0o777, 0o600);
        first.unlockSync();
        equal(readFileSync(f.path, "utf8"), "owner evidence");
        equal(second.tryLockSync(true), true);
        equal(first.tryLockSync(true), false);
        second.unlockSync();
        equal(first.tryLockSync(true), true);
    } finally {
        first.close();
        second.close();
        f.close();
    }
});

test("shared locks coexist and block an exclusive writer until every reader releases", () => {
    const f = fixture();
    const first = openNativeFileLock(f.path);
    const second = openNativeFileLock(f.path);
    const writer = openNativeFileLock(f.path);
    try {
        equal(first.tryLockSync(), true);
        equal(second.tryLockSync(false), true);
        equal(writer.tryLockSync(true), false);
        first.unlockSync();
        equal(writer.tryLockSync(true), false);
        second.unlockSync();
        equal(writer.tryLockSync(true), true);
    } finally {
        first.close();
        second.close();
        writer.close();
        f.close();
    }
});

test("closing releases ownership and a closed handle cannot affect a subsequently opened lock", () => {
    const f = fixture();
    const first = openNativeFileLock(f.path);
    equal(first.tryLockSync(true), true);
    first.close();
    const replacement = openNativeFileLock(f.path);
    const contender = openNativeFileLock(f.path);
    try {
        equal(replacement.tryLockSync(true), true);
        throws(() => first.tryLockSync(true));
        throws(() => first.unlockSync());
        throws(() => first.close());
        equal(contender.tryLockSync(true), false);
        replacement.close();
        equal(contender.tryLockSync(true), true);
    } finally {
        contender.close();
        f.close();
    }
});

test("missing and invalid lock paths fail instead of reporting contention", () => {
    const f = fixture();
    try {
        throws(() => openNativeFileLock(f.path, false), { code: "ENOENT" });
        throws(() => openNativeFileLock(join(f.directory, "missing", "lock")), { code: "ENOENT" });
        throws(() => openNativeFileLock(f.directory));
    } finally {
        f.close();
    }
});

for (const termination of ["close", "crash"]) {
    test(`native lock is released after child ${termination}`, async () => {
        const f = fixture();
        const source = `import { openNativeFileLock } from ${JSON.stringify(
            new URL("./native-file-lock.ts", import.meta.url).href,
        )};
const lock = openNativeFileLock(${JSON.stringify(f.path)});
if (!lock.tryLockSync(true)) throw new Error("Failed to own lock");
console.log("held");
${termination === "close" ? 'process.stdin.once("data", () => { lock.close(); console.log("released"); });' : ""}
setInterval(() => {}, 1000);`;
        const child = spawn(execPath, ["--eval", source], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        const closed = once(child, "close");
        const contender = openNativeFileLock(f.path);
        try {
            const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(10_000) });
            match(String(ready), /held/);
            equal(contender.tryLockSync(true), false);
            if (termination === "close") {
                const released = once(child.stdout, "data", { signal: AbortSignal.timeout(5_000) });
                child.stdin.write("release\n");
                match(String((await released)[0]), /released/);
                equal(child.exitCode, null);
            } else {
                ok(child.kill("SIGKILL"));
                await closed;
            }
            equal(contender.tryLockSync(true), true);
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await closed;
            contender.close();
            f.close();
        }
    });
}

test("exclusive lock creation and descriptor writes preserve complete metadata", () => {
    const f = fixture();
    const owner = openNativeFileLock(f.path, "exclusive");
    try {
        owner.lockSync(true);
        const text = "λ守🔒".repeat(8192);
        owner.replaceTextSync(text);
        equal(owner.readSnapshotSync().text, text);
        if (platform === "win32") throws(() => readFileSync(f.path));
        else equal(readFileSync(f.path, "utf8"), text);
        equal(owner.readSnapshotSync().size, new TextEncoder().encode(text).length);
        equal(owner.readSnapshotSync().mtime, statSync(f.path).mtime.getTime());
        throws(() => openNativeFileLock(f.path, "exclusive"), { code: "EEXIST" });
        if (platform === "win32") throws(() => readFileSync(f.path));
        else equal(readFileSync(f.path, "utf8"), text);
        owner.replaceTextSync("short");
        equal(owner.readSnapshotSync().text, "short");
        equal(owner.readSnapshotSync().size, 5);
        if (platform !== "win32") {
            unlinkSync(f.path);
            writeFileSync(f.path, "replacement inode");
            equal(owner.readSnapshotSync().text, "short");
            owner.replaceTextSync("original inode");
            equal(readFileSync(f.path, "utf8"), "replacement inode");
        }
    } finally {
        owner.close();
        f.close();
    }
    throws(() => owner.replaceTextSync("closed"));
    throws(() => owner.readSnapshotSync());
});

test("closed native and Node lock writers retire matching snapshots across timestamp boundaries", async () => {
    const f = fixture();
    try {
        for (const writer of ["native", "node"]) {
            for (let iteration = 0; iteration < 64; iteration++) {
                const text = JSON.stringify({ token: `${writer}-${iteration}`, pid: process.pid });
                if (writer === "native") {
                    const owner = openNativeFileLock(f.path, "exclusive");
                    try {
                        owner.lockSync(true);
                        owner.replaceTextSync(text);
                    } finally {
                        owner.close();
                    }
                } else {
                    const owner = await open(f.path, "wx");
                    try {
                        await owner.writeFile(text);
                        await owner.sync();
                    } finally {
                        await owner.close();
                    }
                }
                if (iteration >= 32) {
                    const seconds = 1_700_000_000 + (iteration - 32) / 10_000;
                    utimesSync(f.path, seconds, seconds);
                }
                const snapshot = await readLockFileSnapshot(f.path);
                ok(snapshot);
                const reader = openNativeFileLock(f.path, false);
                const nativeSnapshot = reader.readSnapshotSync();
                reader.close();
                const stat = statSync(f.path);
                const mtimeNs = statSync(f.path, { bigint: true }).mtimeNs.toString();
                const removed = await removeLockFileIfSnapshotMatches(f.path, snapshot);
                equal(
                    removed,
                    true,
                    JSON.stringify({ writer, iteration, snapshot, nativeSnapshot, mtimeMs: stat.mtimeMs, mtimeNs }),
                );
                equal(existsSync(f.path), false);
            }
        }
    } finally {
        f.close();
    }
});

test("async native lock waits without blocking the owner from releasing", async () => {
    const f = fixture();
    const owner = openNativeFileLock(f.path);
    const waiter = openNativeFileLock(f.path);
    let acquired = false;
    try {
        owner.lockSync(true);
        const waiting = waiter.lock(true).then(() => (acquired = true));
        await new Promise((resolve) => setTimeout(resolve, 30));
        equal(acquired, false);
        owner.unlockSync();
        await waiting;
        equal(acquired, true);
        equal(owner.tryLockSync(true), false);
        waiter.unlockSync();
        equal(owner.tryLockSync(true), true);
    } finally {
        owner.close();
        waiter.close();
        f.close();
    }
});

interface NativeFunction {
    args: string[];
    returns: string;
}
interface FileTimeSymbols {
    CreateFileW(
        path: Uint8Array,
        access: number,
        share: number,
        security: number,
        disposition: number,
        flags: number,
        template: bigint,
    ): bigint;
    SetFileTime(handle: bigint, creation: number, access: number, modified: Uint8Array): number;
    GetFileTime(handle: bigint, creation: number, access: number, modified: Uint8Array): number;
    CloseHandle(handle: bigint): number;
    GetLastError(): number;
}
interface FileTimeLibrary {
    symbols: FileTimeSymbols;
    close(): void;
}
interface FileTimeFFI {
    dlopen(path: string, functions: Record<string, NativeFunction>): FileTimeLibrary;
}

function fileTimeAPI(): FileTimeLibrary {
    const ffi: FileTimeFFI = createRequire(import.meta.url)("bun:ffi");
    return ffi.dlopen("kernel32.dll", {
        CreateFileW: {
            args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "u64"],
            returns: "u64",
        },
        SetFileTime: { args: ["u64", "ptr", "ptr", "buffer"], returns: "i32" },
        GetFileTime: { args: ["u64", "ptr", "ptr", "buffer"], returns: "i32" },
        CloseHandle: { args: ["u64"], returns: "i32" },
        GetLastError: { args: [], returns: "u32" },
    });
}

// Avoid utimes' floating seconds input. Set and verify the actual 100ns FILETIME bits.
function setExactFileTime(api: FileTimeSymbols, path: string, ticks: bigint): void {
    const handle = api.CreateFileW(Buffer.from(toNamespacedPath(path) + "\0", "utf16le"), 0x180, 7, 0, 3, 0x80, 0n); // FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES; OPEN_EXISTING.
    ok(handle !== 0n && handle !== 0xffffffffffffffffn, `CreateFileW: ${api.GetLastError()}`);
    try {
        const requested = new Uint8Array(8);
        new DataView(requested.buffer).setBigUint64(0, ticks, true);
        ok(api.SetFileTime(handle, 0, 0, requested), `SetFileTime: ${api.GetLastError()}`);
        const observed = new Uint8Array(8);
        ok(api.GetFileTime(handle, 0, 0, observed), `GetFileTime: ${api.GetLastError()}`);
        equal(
            new DataView(observed.buffer).getBigUint64(0, true),
            ticks,
            "Filesystem must preserve exact 100ns fixture time",
        );
    } finally {
        ok(api.CloseHandle(handle), `CloseHandle: ${api.GetLastError()}`);
    }
}

const windowsBunOnly = { skip: platform !== "win32" || !versions.bun };
const epochTicks = 116444736000000000n;

test(
    "Windows lock retirement preserves exact identity at dense 100ns timestamp boundaries",
    windowsBunOnly,
    async () => {
        const directory = mkdtempSync(join(tmpdir(), "rw-lock-time-"));
        const path = join(directory, "owner-λ.lock");
        const library = fileTimeAPI();
        let checked = 0;
        const failures: string[] = [];
        try {
            // Exercise 100ns increments around zero, half-ms, and integer-ms boundaries.
            // The final ticks below an integer ms are absent from the coarser utimes probe.
            const offsets = [
                ...Array.from({ length: 41 }, (_, index) => index),
                ...Array.from({ length: 81 }, (_, index) => 4960 + index),
                ...Array.from({ length: 81 }, (_, index) => 9960 + index),
            ];
            for (const writer of ["native", "node"]) {
                for (const baseMs of [1700000000000n, 1791676800123n, 2200000000999n]) {
                    for (const offset of offsets) {
                        const text = JSON.stringify({
                            token: `${writer}-${baseMs}-${offset}`,
                            pid,
                        });
                        if (writer === "native") {
                            const owner = openNativeFileLock(path, "exclusive");
                            try {
                                owner.lockSync(true);
                                owner.replaceTextSync(text);
                            } finally {
                                owner.close();
                            }
                        } else {
                            const owner = await open(path, "wx");
                            try {
                                await owner.writeFile(text);
                                await owner.sync();
                            } finally {
                                await owner.close();
                            }
                        }
                        try {
                            const ticks = epochTicks + baseMs * 10000n + BigInt(offset);
                            setExactFileTime(library.symbols, path, ticks);
                            const snapshot = await readLockFileSnapshot(path);
                            ok(snapshot);
                            const reader = openNativeFileLock(path, false);
                            const nativeSnapshot = (() => {
                                try {
                                    return reader.readSnapshotSync();
                                } finally {
                                    reader.close();
                                }
                            })();
                            const stat = statSync(path);
                            const mtimeNs = statSync(path, {
                                bigint: true,
                            }).mtimeNs.toString();
                            const removed = await removeLockFileIfSnapshotMatches(path, snapshot);
                            const expectedFloorMs = Number((ticks - epochTicks) / 10000n);
                            const diagnostic = JSON.stringify({
                                writer,
                                baseMs: String(baseMs),
                                offset,
                                fileTime: String(ticks),
                                expectedFloorMs,
                                snapshot,
                                nativeSnapshot,
                                mtimeMs: stat.mtimeMs,
                                mtimeNs,
                                removed,
                            });
                            checked++;
                            if (
                                !removed ||
                                existsSync(path) ||
                                nativeSnapshot.mtime !== expectedFloorMs ||
                                snapshot.mtime !== expectedFloorMs
                            )
                                failures.push(diagnostic);
                        } finally {
                            // Only our disposable fixture path, after all owned descriptors have closed.
                            rmSync(path, { force: true });
                        }
                    }
                }
            }
            equal(checked, 1218);
            equal(failures.length, 0, `Timestamp failures (${failures.length}/${checked}):\n${failures.join("\n")}`);
        } finally {
            library.close();
            rmSync(directory, { recursive: true, force: true });
        }
    },
);

test("Windows retirement still refuses changed timestamp and changed owner evidence", windowsBunOnly, async () => {
    const directory = mkdtempSync(join(tmpdir(), "rw-lock-stale-"));
    const path = join(directory, "owner.lock");
    const library = fileTimeAPI();
    const original = JSON.stringify({ token: "original", pid });
    const replacement = JSON.stringify({ token: "replaced", pid });
    const ticks = epochTicks + 1791676800123n * 10000n;
    try {
        writeFileSync(path, original, { flag: "wx" });
        setExactFileTime(library.symbols, path, ticks);
        const snapshot = await readLockFileSnapshot(path);
        ok(snapshot);
        setExactFileTime(library.symbols, path, ticks + 20000n);
        equal(await removeLockFileIfSnapshotMatches(path, snapshot), false);
        equal(readFileSync(path, "utf8"), original);
        // Same length and timestamp, different token/text; the live PID is unchanged.
        equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
        writeFileSync(path, replacement);
        setExactFileTime(library.symbols, path, ticks);
        equal(await removeLockFileIfSnapshotMatches(path, snapshot), false);
        equal(readFileSync(path, "utf8"), replacement);
        const fresh = await readLockFileSnapshot(path);
        ok(fresh);
        equal(await removeLockFileIfSnapshotMatches(path, fresh), true);
        equal(existsSync(path), false);
    } finally {
        library.close();
        rmSync(directory, { recursive: true, force: true });
    }
});
