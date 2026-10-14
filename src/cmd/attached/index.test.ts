import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { rm as fsRm, mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { join } from "node:path";
import { git } from "../../shared/git-test-fixture.ts";
import { type AttachedJsonObject } from "../../shared/attached/operations.ts";
import {
    activateInput,
    CLI_PATH,
    DENO_CONFIG_PATH,
    pendingTriage,
    planWrittenInput,
    projectFixture,
    reachPlanning,
    readRecordBytes,
    runOperation,
    spawnAttachedCli,
    triageReportInput,
} from "../../shared/attached/attached-test-fixture.ts";
import process from "node:process";

async function withProject(fn: (projectRoot: string) => Promise<void>): Promise<void> {
    const projectRoot = await projectFixture.checkout({ prefix: "runwield-attached-cli-" });
    try {
        await fn(projectRoot);
    } finally {
        await fsRm(projectRoot, { recursive: true }).catch(() => undefined);
    }
}

test("separate Core processes activate, accept Triage once, and replay the saved result", async () => {
    await withProject(async (projectRoot) => {
        const a = await spawnAttachedCli("activate", projectRoot, activateInput());
        assertEquals(a.code, 0, a.stderr);
        const triage = pendingTriage(a.result);

        const b = await spawnAttachedCli("triage_report", projectRoot, triageReportInput(triage));
        assertEquals(b.code, 0, b.stderr);
        assertEquals(b.result.ok && b.result.workflow.revision, 2);
        const bytesAfterB = await readRecordBytes(projectRoot, triage.workflowId);

        const c = await spawnAttachedCli("triage_report", projectRoot, triageReportInput(triage));
        assertEquals(c.result, b.result);
        assertEquals(await readRecordBytes(projectRoot, triage.workflowId), bytesAfterB);

        const d = await spawnAttachedCli("status", projectRoot, { workflowId: triage.workflowId });
        assertEquals(d.result.ok && d.result.workflow, b.result.ok && b.result.workflow);
        assertEquals(await readRecordBytes(projectRoot, triage.workflowId), bytesAfterB);
        assertEquals(await git(projectRoot, ["status", "--porcelain", "--ignored"]), "");
    });
});

test("two processes racing on one revision leave exactly one accepted outcome", async () => {
    await withProject(async (projectRoot) => {
        const triage = pendingTriage((await spawnAttachedCli("activate", projectRoot, activateInput())).result);
        const outcomes: AttachedJsonObject[] = [
            { routingIntent: "PLANNED_CHANGE", workKind: "FEATURE", complexity: "LOW", summary: "first" },
            { routingIntent: "INQUIRY", complexity: "LOW", summary: "second" },
        ];
        const runs = await Promise.all(
            outcomes.map((outcome, index) =>
                spawnAttachedCli(
                    "triage_report",
                    projectRoot,
                    triageReportInput({ ...triage, operationId: `op-race-${index}`, outcome }),
                ),
            ),
        );

        const accepted = runs.filter((run) => run.result.ok);
        const conflicts = runs.filter((run) => !run.result.ok && run.result.rejection.code === "revision_conflict");
        assertEquals(accepted.length, 1, JSON.stringify(runs.map((run) => run.result)));
        assertEquals(conflicts.length, 1);
        assertEquals(conflicts[0].code, 1);

        const status = await spawnAttachedCli("status", projectRoot, { workflowId: triage.workflowId });
        assert(status.result.ok && accepted[0].result.ok);
        assertEquals(status.result.workflow.revision, 2);
        assertEquals(status.result.workflow.triageOutcome, accepted[0].result.workflow.triageOutcome);
    });
});

test("CLI plan_written accepts the Plan and matches the coordinator replay", async () => {
    await withProject(async (projectRoot) => {
        const { planning } = await reachPlanning(projectRoot);
        await fsMkdir(join(projectRoot, "docs", "plans"), { recursive: true });
        await fsWriteFile(join(projectRoot, "docs", "plans", "dark-mode-toggle.md"), "# Toggle\n");
        const input = planWrittenInput(planning);
        const cli = await spawnAttachedCli("plan_written", projectRoot, input);
        assertEquals(cli.code, 0, cli.stderr);
        assertEquals(cli.result.ok && cli.result.workflow.state, "awaiting_review");
        assertEquals(cli.result, await runOperation("plan_written", projectRoot, input));
    });
});

test("the removed submit CLI name prints a usage error", async () => {
    await withProject(async (projectRoot) => {
        const result = await captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs([
                "run",
                "-A",
                "--quiet",
                "--no-check",
                "--config",
                DENO_CONFIG_PATH,
                CLI_PATH,
                "attached",
                "submit",
            ]),
            cwd: projectRoot,
        });
        assertEquals(result.code, 1);
        assert(new TextDecoder().decode(result.stderr).includes("Usage: wld attached"));
    });
});

test("CLI activation still requires host evidence", async () => {
    await withProject(async (projectRoot) => {
        const { evidence: _evidence, ...input } = activateInput();
        const result = await spawnAttachedCli("activate", projectRoot, input);
        assertEquals(result.code, 1);
        assertEquals(result.result.ok, false);
        assert(!result.result.ok && result.result.rejection.field === "evidence");
    });
});
