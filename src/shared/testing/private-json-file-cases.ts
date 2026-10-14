/** Shared real-filesystem assertions for Deno's isolated suite and Bun/Node qualification. */
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import {
    chmodSync,
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { ensurePrivateDir, writeJsonAtomically } from "../private-json-file.ts";

export const privateJsonFileCases = [
    {
        name: "private JSON creates nested directories and preserves Unicode and formatting",
        run(root: string) {
            const directory = join(root, "nested", "private");
            const path = join(directory, "manifest.json");
            const value = { title: "Session — 日本語 🐈", generation: 1, segments: ["α", "β"] };
            writeJsonAtomically(path, value);
            equal(readFileSync(path, "utf8"), `${JSON.stringify(value, null, 2)}\n`);
            deepStrictEqual(readdirSync(directory), ["manifest.json"]);
            if (platform !== "win32") {
                equal(statSync(directory).mode & 0o777, 0o700);
                equal(statSync(join(root, "nested")).mode & 0o777, 0o700);
                equal(statSync(path).mode & 0o777, 0o600);
            }
        },
    },
    {
        name: "private directories tighten an existing directory without removing its contents",
        run(root: string) {
            const directory = join(root, "existing");
            mkdirSync(directory);
            chmodSync(directory, 0o755);
            writeFileSync(join(directory, "keep"), "keep");
            ensurePrivateDir(directory);
            equal(readFileSync(join(directory, "keep"), "utf8"), "keep");
            if (platform !== "win32") equal(statSync(directory).mode & 0o777, 0o700);
        },
    },
    {
        name: "private JSON replaces the inode and preserves readers of the previous document",
        run(root: string) {
            const path = join(root, "manifest 日本語 🐈.json");
            writeJsonAtomically(path, { generation: 1 });
            chmodSync(path, 0o644);
            const previous = openSync(path, "r");
            try {
                const before = fstatSync(previous);
                const value = { generation: 2, payload: "é🦀".repeat(100_000) };
                writeJsonAtomically(path, value);
                deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), value);
                equal(readFileSync(previous, "utf8"), '{\n  "generation": 1\n}\n');
                if (platform !== "win32") {
                    ok(statSync(path).ino !== before.ino);
                    equal(statSync(path).mode & 0o777, 0o600);
                }
                deepStrictEqual(readdirSync(root), ["manifest 日本語 🐈.json"]);
            } finally {
                closeSync(previous);
            }
        },
    },
    {
        name: "private JSON leaves the existing document intact when serialization fails",
        run(root: string) {
            const path = join(root, "manifest.json");
            writeJsonAtomically(path, { generation: 1 });
            const before = readFileSync(path, "utf8");
            throws(() => writeJsonAtomically(path, { unsupported: 1n }), TypeError);
            equal(readFileSync(path, "utf8"), before);
            deepStrictEqual(readdirSync(root), ["manifest.json"]);
        },
    },
    {
        name: "private JSON propagates filesystem errors without replacing a directory",
        run(root: string) {
            const path = join(root, "manifest.json");
            mkdirSync(path);
            writeFileSync(join(path, "keep"), "keep");
            throws(() => writeJsonAtomically(path, { generation: 1 }));
            equal(readFileSync(join(path, "keep"), "utf8"), "keep");
            // Like the previous storage writer, a failed rename retains its private
            // temporary document. Do not claim failed-write cleanup was migrated.
            const temporary = readdirSync(root).filter((name) => name.startsWith("manifest.json.tmp-"));
            equal(temporary.length, 1);
            deepStrictEqual(JSON.parse(readFileSync(join(root, temporary[0]), "utf8")), { generation: 1 });
            if (platform !== "win32") equal(statSync(join(root, temporary[0])).mode & 0o777, 0o600);
        },
    },
    {
        name: "private directory creation rejects a file without damaging it",
        run(root: string) {
            const path = join(root, "occupied");
            writeFileSync(path, "keep");
            throws(() => ensurePrivateDir(path));
            equal(readFileSync(path, "utf8"), "keep");
            ok(existsSync(path));
        },
    },
];

export function runPrivateJsonFileCase(testCase: typeof privateJsonFileCases[number]): void {
    const root = mkdtempSync(join(tmpdir(), "runwield-private-json-"));
    try {
        testCase.run(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}
