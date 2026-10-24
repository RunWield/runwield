import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Zero baseline for the two owned capabilities. CatalogPort is a required network port.
// Reject replaceable capability types AND aliases selected from caller-provided bags.
const owned = ["putEntry", "withRegistryLock"];
const failures: string[] = [];
for (const file of await readdir(new URL("../src/", import.meta.url))) {
    if (!file.endsWith(".ts")) continue;
    const content = await readFile(new URL("../src/" + file, import.meta.url), "utf8");
    for (const capability of owned) {
        const replaceableType = new RegExp("typeof\\s+" + capability + "\\b");
        const selectedAlias = new RegExp("\\?\\.[A-Za-z]+\\s*\\?\\?\\s*" + capability + "\\b");
        if (replaceableType.test(content) || selectedAlias.test(content)) {
            failures.push(join("src", file) + ": " + capability);
        }
    }
}
if (failures.length) {
    console.error("OWNED_CAPABILITY_REPLACEABLE: " + failures.join(", "));
    console.error("Registry writes and locks are ours. Use real temporary registry fixtures; do not rebaseline.");
    process.exitCode = 1;
} else {
    console.log("Seam baseline: zero. CatalogPort remains a genuine external port.");
}
