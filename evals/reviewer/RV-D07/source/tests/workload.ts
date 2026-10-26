import { spawn } from "node:child_process";
import { writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const [role, root] = process.argv.slice(2);
async function announce(name: string): Promise<void> {
    const path = join(root, name);
    await writeFile(path + ".pending", String(process.pid));
    await rename(path + ".pending", path);
}
if (role === "branch" || role === "exiting-branch") {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "leaf", root], {
        stdio: role === "exiting-branch" ? "inherit" : "ignore",
    });
}
if (role === "leaf") {
    await announce("leaf-ready");
    while (!existsSync(join(root, "go"))) await setTimeout(5);
    await writeFile(join(root, "sentinel"), "command still active");
    await writeFile(join(root, "done"), "written");
} else {
    await announce("ready");
    if (role === "exiting-branch") {
        while (!existsSync(join(root, "exit-parent"))) await setTimeout(5);
        process.exit(0);
    }
}
setInterval(() => {}, 1000);
