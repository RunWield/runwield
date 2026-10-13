/** Run filesystem cases inside the isolated runner's disposable HOME and database. */
import { test } from "node:test";

export function testWithFsPermissions(name: string, fn: () => void | Promise<void>): void {
    // Bun has no per-test permission API; the isolated runner supplies the
    // disposable HOME/database/filesystem boundary for this identical case.
    test(name, fn);
}
