import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const proof = process.argv[2];
if (proof === "seam-check") {
    const result = Bun.spawnSync(["bun", "run", "seams:check"], { cwd: project });
    if (result.exitCode !== 0) {
        assert.match(
            result.stderr.toString(),
            /OWNED_CAPABILITY_REPLACEABLE/,
            "Checker failed for an unrelated reason",
        );
    }
    assert.equal(result.exitCode, 0, "RV-D12-OWNED-SEAM");
    console.log("PASS seam-check");
} else if (proof === "mutation-coverage") {
    const root = await mkdtemp(join(tmpdir(), "registry-mutation-"));
    try {
        for (const path of ["src", "tests", "scripts", "package.json"]) {
            await cp(join(project, path), join(root, path), { recursive: true });
        }
        const file = join(root, "src", "registry.ts");
        const original = await readFile(file, "utf8");
        const write = "await rename(staged, file);";
        assert.equal(original.split(write).length, 2, "Mutation anchor must occur exactly once");
        await writeFile(file, original.replace(write, "await rm(staged, { force: true });"));
        const result = Bun.spawnSync(["bun", "run", "test"], { cwd: root });
        const output = result.stdout.toString() + result.stderr.toString();
        assert.notEqual(result.exitCode, 0, "RV-D12-MUTATION-SURVIVED");
        assert.match(output, /REGISTRATION_NOT_DURABLE/, "Mutation failed for an unrelated reason");
        console.log("PASS mutation-coverage: the public suite detects a missing durable write");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
} else {
    throw new Error("Select seam-check or mutation-coverage");
}
