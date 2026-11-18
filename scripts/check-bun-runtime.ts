import { readFileSync } from "node:fs";
import { versions } from "node:process";

interface RuntimeManifest {
    engines: { bun: string };
}

const { engines }: RuntimeManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const supportedBunRange = engines.bun;

export function requireSupportedBun(): void {
    if (!versions.bun || !Bun.semver.satisfies(versions.bun, supportedBunRange)) {
        throw new Error(`RunWield requires Bun ${supportedBunRange}; found ${versions.bun || "another runtime"}.`);
    }
}

if (import.meta.main) requireSupportedBun();
