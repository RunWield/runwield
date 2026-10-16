/** Identify a compiled runtime without treating a generated build-id file as proof. */
import { versions } from "node:process";

export function isStandaloneExecutable(): boolean {
    if (!versions.bun) return false;
    // Bun exposes this directly on every supported target, including Windows.
    // Embedded filesystem path spellings differ by platform.
    const runtime: { isStandaloneExecutable: boolean } = Reflect.get(globalThis, String("Bun"));
    return runtime.isStandaloneExecutable;
}
