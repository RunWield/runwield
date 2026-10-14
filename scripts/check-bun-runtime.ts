import { readFileSync } from "node:fs";
import { versions } from "node:process";

export function requirePinnedBun(): void {
    const expected = readFileSync(new URL("../.bun-version", import.meta.url), "utf8").trim();
    if (versions.bun !== expected) {
        throw new Error(
            `RunWield's Bun migration requires Bun ${expected}; found ${versions.bun || "another runtime"}.`,
        );
    }
}

if (import.meta.main) requirePinnedBun();
