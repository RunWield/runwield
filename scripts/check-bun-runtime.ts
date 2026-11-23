import { readFileSync } from "node:fs";
import { versions } from "node:process";

interface RuntimeManifest {
    engines: { bun: string };
}

/** Exact repository toolchain identity (separate from the supported local range). */
export function readPinnedBunVersion(path = new URL("../.bun-version", import.meta.url)): string {
    const pin = readFileSync(path, "utf8").replace(/\n+$/, "");
    if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pin)) {
        throw new Error("Expected one stable Bun version (major.minor.patch) in .bun-version.");
    }
    return pin;
}

const { engines }: RuntimeManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const supportedBunRange = engines.bun;

export function requireSupportedBun(): void {
    const selected = readPinnedBunVersion();
    if (versions.bun === selected) return;
    if (!versions.bun || !Bun.semver.satisfies(versions.bun, supportedBunRange)) {
        throw new Error(
            `RunWield uses Bun ${selected} from .bun-version and also supports ${supportedBunRange}; found ${versions.bun || "another runtime"}.`,
        );
    }
}

if (import.meta.main) requireSupportedBun();
