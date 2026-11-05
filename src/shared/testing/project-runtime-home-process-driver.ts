import { withWorktreeRegistryLockAtPath } from "../worktree-registry.js";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { enterProjectRuntime } from "../project-runtime-layout.ts";
import { openNativeFileLock } from "../native-file-lock.ts";
import { getRunWieldRuntimeDir } from "../../constants.js";

interface TransferCheckpointFile {
    digest: string;
    publishedDigest?: string;
}
interface TransferCheckpoint {
    phase: string;
    files: TransferCheckpointFile[];
}

const [command, root, boundary] = process.argv.slice(2);
if (command === "hold-registry") {
    const path = join(getRunWieldRuntimeDir(root), "internal", "worktrees.lock");
    await withWorktreeRegistryLockAtPath(path, async () => {
        console.log("held");
        setInterval(() => {}, 1000);
        await new Promise(() => {});
    });
} else if (command === "hold") {
    const path = join(getRunWieldRuntimeDir(root), "internal", boundary);
    await fs.mkdir(dirname(path), { recursive: true });
    const lock = openNativeFileLock(path);
    lock.lockSync(true);
    console.log("held");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
} else {
    const originalCopy = fs.copyFile;
    const originalRename = fs.rename;
    const originalRemove = fs.rm;
    const exit = (effect: string) => {
        if (effect === boundary) {
            console.log(`reached:${effect}`);
            process.exit(86);
        }
    };
    Object.defineProperty(fs, "copyFile", {
        value: async (...args: Parameters<typeof fs.copyFile>) => {
            await originalCopy(...args);
            exit("copy");
        },
    });
    Object.defineProperty(fs, "rename", {
        value: async (...args: Parameters<typeof fs.rename>) => {
            // Source-to-home rename is a cross-device operation in this environment.
            if (String(args[0]).startsWith(getRunWieldRuntimeDir(root)))
                throw Object.assign(new Error("cross device"), { code: "EXDEV" });
            if (String(args[0]).endsWith("/!link.runtime-copy")) exit("staged-payload-link");
            await originalRename(...args);
            if (String(args[1]).endsWith("/payload-link")) exit("payload-link");
            if (String(args[1]).endsWith("/!link")) exit("early-payload-link");
            if (String(args[1]).endsWith("layout-migration.json")) {
                const journal: TransferCheckpoint = JSON.parse(await fs.readFile(args[1], "utf8"));
                if (
                    journal.phase === "verified" &&
                    journal.files.some((file) => file.publishedDigest && file.publishedDigest !== file.digest)
                )
                    exit("mapping-intent");
                exit(journal.phase);
            }
            if (String(args[0]).endsWith(".runtime-mapping")) exit("mapping");
            if (String(args[1]).endsWith("layout.json")) exit("marker");
        },
    });
    Object.defineProperty(fs, "rm", {
        value: async (...args: Parameters<typeof fs.rm>) => {
            await originalRemove(...args);
            if (String(args[0]).startsWith(getRunWieldRuntimeDir(root))) exit("retirement");
            if (String(args[0]).endsWith("layout-migration.json")) exit("cleanup");
        },
    });
    await enterProjectRuntime(root);
    console.log("complete");
}
