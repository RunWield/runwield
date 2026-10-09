import { test } from "node:test";
import { equal, match, ok, rejects } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enterProjectRuntime } from "../../shared/project-runtime-layout.ts";
import { listPlans } from "../../plan-store.js";
import { runPlansDoctor } from "./doctor.ts";

test("Doctor repairs a legacy Plan identity when its lock directory is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "doctor-missing-lock-directory-"));
    try {
        const layout = await enterProjectRuntime(cwd);
        const planPath = join(cwd, "docs/plans/legacy.md");
        await mkdir(join(cwd, "docs/plans"), { recursive: true });
        await writeFile(planPath, "---\nclassification: FEATURE\nstatus: ready_for_work\n---\n# Legacy Plan\n");
        await rejects(stat(layout.selected.planLocksDir), { code: "ENOENT" });
        equal((await listPlans(cwd))[0]?.attrs.planId, undefined);
        const report = await runPlansDoctor(cwd, true);
        ok(report.repaired > 0);
        equal(report.issues.some((issue) => issue.kind === "missing_plan_id"), false);
        const repaired = (await listPlans(cwd)).find((plan) => plan.name === "legacy");
        ok(repaired?.attrs.planId);
        match(await readFile(planPath, "utf8"), /# Legacy Plan/);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});
