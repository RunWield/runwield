import { readFileSync } from "node:fs";
import { versions } from "node:process";

interface RuntimeManifest {
    engines: { bun: string };
}

export function requireSupportedBun(): void {
    const { engines }: RuntimeManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (!versions.bun || !Bun.semver.satisfies(versions.bun, engines.bun)) {
        throw new Error(`RunWield requires Bun ${engines.bun}; found ${versions.bun || "another runtime"}.`);
    }
}

if (import.meta.main) requireSupportedBun();
