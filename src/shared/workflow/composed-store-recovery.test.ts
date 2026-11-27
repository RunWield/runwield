import { projects } from "@runwield/projects";
import { test } from "node:test";
import { equal, ok, rejects } from "node:assert/strict";
import { mkdir, readFile, writeFile, chmod, stat, lstat, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { defineCommittedGitFixture, git } from "../git-test-fixture.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import { getRunWieldRuntimeDir } from "@runwield/project-runtime/legacy-paths";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { importPlans } from "../../plan-store/index.ts";
import { loadPlan, listPlans } from "../testing/plan-query-fixture.ts";

const repository = defineCommittedGitFixture({ "README.md": "Recovery composition\n" });
const driver = new URL("./testing/composed-runtime-process.ts", import.meta.url).pathname;
interface TransferObservation {
    phase: string;
    files: Array<{ source: string; destination: string; retired?: boolean }>;
}

for (const boundary of ["copying", "published"]) {
    test(`explicit import after ${boundary} transfer interruption preserves repair bytes and one home authority`, async () => {
        const root = await realpath(await repository.checkout());
        const linked = `${root}-linked`;
        try {
            equal((await projects.checkout.admit(root)).kind, "existing");
            await git(root, ["worktree", "add", "-b", "linked", linked]);
            const sourceRoot = getRunWieldRuntimeDir(root);
            const source = join(sourceRoot, "internal/debug/repair");
            await mkdir(join(source, ".."), { recursive: true });
            await writeFile(source, "retained repair\0sentinel");
            await chmod(source, 0o600);
            // Real payload makes the durable transfer phases observable without replacing filesystem operations.
            for (let index = 0; index < 160; index++)
                await writeFile(
                    join(sourceRoot, "internal/debug", `payload-${index}`),
                    "retained bytes\n".repeat(2048),
                );
            await mkdir(join(root, ".wld/agents"), { recursive: true });
            await writeFile(join(root, ".wld/settings.json"), '{"custom":{}}\n');
            await writeFile(join(root, ".wld/agents/personal.md"), "Personal override\n");
            await writeFile(join(linked, "user-change"), "Uncommitted source\n");
            await mkdir(join(root, "docs/plans"), { recursive: true });
            const legacy =
                "---\nplanId: recovery-plan\nclassification: PLANNED_CHANGE\nstatus: draft\n---\n# Retained request\n";
            await writeFile(join(root, "docs/plans/request.md"), legacy);
            const layout = resolveProjectRuntimeLayout(root);
            const child = spawn(process.execPath, [driver, root], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
            let errors = "";
            child.stderr.on("data", (chunk) => {
                errors += chunk.toString();
            });
            const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
            let observed: TransferObservation | undefined;
            try {
                const deadline = Date.now() + 15000;
                while (Date.now() < deadline && child.exitCode === null) {
                    const bytes = await readFile(layout.primary.layoutMigrationJournalPath, "utf8").catch(() => "");
                    if (bytes) {
                        const journal: TransferObservation = JSON.parse(bytes);
                        if (journal.phase === boundary && journal.files.some((file) => !file.retired)) {
                            child.kill("SIGSTOP");
                            observed = JSON.parse(await readFile(layout.primary.layoutMigrationJournalPath, "utf8"));
                            break;
                        }
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1));
                }
                ok(observed && observed.phase === boundary, `Missed durable ${boundary} boundary: ${errors}`);
            } finally {
                child.kill("SIGKILL");
                await exited;
            }
            const retained = observed.files.filter((file) => !file.retired);
            ok(retained.length > 0);
            let remainingSources = 0;
            for (const file of retained) {
                const exists = await stat(file.source).then(
                    () => true,
                    (error: NodeJS.ErrnoException) => {
                        if (error.code === "ENOENT") return false;
                        throw error;
                    },
                );
                if (boundary === "copying") ok(exists, "Unpublished input must remain at its source");
                if (exists) remainingSources++;
                else {
                    // Unlink may finish before its retired journal bit. Published bytes must already be complete.
                    equal(boundary, "published");
                    const expected = file.source.endsWith("/repair")
                        ? "retained repair\0sentinel"
                        : "retained bytes\n".repeat(2048);
                    equal(await readFile(file.destination, "utf8"), expected);
                }
            }
            ok(remainingSources > 0, "Interruption precedes complete source retirement");
            if (boundary === "copying") equal(await readFile(source, "utf8"), "retained repair\0sentinel");
            const resumed = await captureForegroundProcess(process.execPath, { cwd: root, args: [driver, root] });
            equal(resumed.code, 0, new TextDecoder().decode(resumed.stderr));
            equal(await readFile(join(layout.primary.debugRoot, "repair"), "utf8"), "retained repair\0sentinel");
            equal((await stat(join(layout.primary.debugRoot, "repair"))).mode & 0o777, 0o600);
            for (let index = 0; index < 160; index++)
                equal(
                    await readFile(join(layout.primary.debugRoot, `payload-${index}`), "utf8"),
                    "retained bytes\n".repeat(2048),
                );
            await rejects(stat(join(sourceRoot, "internal")), { code: "ENOENT" });
            equal((await listPlans(root)).length, 0);
            equal((await importPlans(root, join(root, "docs/plans/request.md"))).kind, "committed");
            await importPlans(root, join(root, "docs/plans/request.md"));
            equal((await listPlans(linked)).length, 1);
            equal((await loadPlan(linked, "request"))?.attrs.planId, "recovery-plan");
            ok((await loadPlan(linked, "request"))?.markdown.includes("Retained request"));
            equal(await readFile(join(root, "docs/plans/request.md"), "utf8"), legacy);
            equal(await readFile(join(root, ".wld/settings.json"), "utf8"), '{"custom":{}}\n');
            equal(await readFile(join(root, ".wld/agents/personal.md"), "utf8"), "Personal override\n");
            equal(await readFile(join(linked, "user-change"), "utf8"), "Uncommitted source\n");
            ok((await git(root, ["worktree", "list", "--porcelain"])).includes(linked));
            for (const cwd of [root, linked]) {
                await rejects(lstat(join(getRunWieldRuntimeDir(cwd), "internal")), { code: "ENOENT" });
                await rejects(lstat(join(cwd, ".wld/plans")), { code: "ENOENT" });
            }
        } finally {
            await rm(linked, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });
}
