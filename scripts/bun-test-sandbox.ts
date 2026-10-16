/** Loaded before Bun imports any test: direct unsandboxed `bun test` must fail closed. */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { env } from "node:process";
import { requirePinnedBun } from "./check-bun-runtime.ts";

requirePinnedBun();
const home = env.WLD_TEST_SANDBOX_HOME;
if (!home || env.HOME !== home || env.USERPROFILE !== home) {
    throw new Error("Refusing unsandboxed Bun tests. Use `bun run test` (scripts/run-tests.js).");
}
const root = realpathSync(home);
for (
    const name of [
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "TMPDIR",
        "TEMP",
        "TMP",
    ]
) {
    const value = env[name];
    if (!value) throw new Error(`Missing isolated test path: ${name}`);
    const child = relative(root, realpathSync(value));
    if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error(`Unsafe isolated test path: ${name}`);
}
for (const name of ["MNEMOTECA_DB_PATH", "SNIP_DB_PATH"]) {
    const value = env[name];
    if (!value) throw new Error(`Missing isolated test database: ${name}`);
    const child = relative(root, join(realpathSync(dirname(value)), basename(value)));
    if (!child || child.startsWith("..") || isAbsolute(child)) {
        throw new Error(`Unsafe isolated test database: ${name}`);
    }
}
