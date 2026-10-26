import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startValidation, planStatus } from "../src/lifecycle.ts";
import { readPlan } from "../src/plans.ts";

if (process.argv[2] !== "body-rollback") throw new Error("Select body-rollback");
const root = await mkdtemp(join(tmpdir(), "transition-proof-"));
try {
    const path = join(root, "plan.md");
    const metadata = "planId: plan-1\nstatus: approved\nowner: lee";
    await writeFile(path, `---\n${metadata}\n---\n# Delivery\nOriginal text.\n`);
    const body = "# Delivery\nConcurrent author revision.\n";
    const script = `import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[1];
const text = readFileSync(path, "utf8");
if (!text.includes("status: validating")) throw new Error("Transition must precede author edit");
writeFileSync(path, text.slice(0, text.indexOf("\\n---\\n") + 5) + ${JSON.stringify(body)});
process.exit(9);`;
    await assert.rejects(
        startValidation(path, { executable: process.execPath, args: ["-e", script, path] }),
        /Transition command failed \(9\)/,
    );
    assert.equal(await planStatus(path), "approved", "Owned status must roll back");
    assert.equal((await readPlan(path)).frontMatter, metadata, "Owned metadata must roll back");
    assert.equal((await readPlan(path)).body, body, "RV-D09-BODY-ROLLBACK");
    console.log("PASS body-rollback");
} finally {
    await rm(root, { recursive: true, force: true });
}
