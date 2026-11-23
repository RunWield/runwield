import { mock } from "bun:test";
import { realpathSync } from "node:fs";
import process from "node:process";
import { openNativeFileLock } from "../native-file-lock.ts";

const open = openNativeFileLock;
const target = realpathSync(process.argv[2]);
let reportedContention = false;

// Delegate every operation to the original OS lock. The test gets a receipt
// only when this child actually tries the exact Plan lock and the OS refuses.
mock.module("../native-file-lock.ts", () => ({
    openNativeFileLock: (path: string, create?: boolean | "exclusive") => {
        const lock = open(path, create);
        return {
            ...lock,
            async lock(exclusive = false) {
                if (exclusive && !reportedContention && realpathSync(path) === target) {
                    if (lock.tryLockSync(true)) return;
                    reportedContention = true;
                    console.log("waiting for exact Plan lock");
                }
                await lock.lock(exclusive);
            },
        };
    },
}));

const { runAttachedCommand } = await import("../../cmd/attached/index.ts");
console.log("Attached command loaded");
await runAttachedCommand(["task_completed"]);
