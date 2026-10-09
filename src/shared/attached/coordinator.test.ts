import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { WORK_KINDS } from "../../constants.js";
import { git } from "../git-test-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import type { AttachedJsonObject } from "./operations.ts";
import { loadAttachedWorkflowRecord, locateAttachedWorkflows, writeAttachedWorkflowRecord } from "./record-store.ts";
import {
    activateInput,
    pendingTriage,
    readRecordBytes,
    rejectionCode,
    runOperation as run,
    triageReportInput,
    type TriageReportInputOptions,
    withProject,
} from "./attached-test-fixture.ts";

async function activated(projectRoot: string) {
    const result = await run("activate", projectRoot, activateInput());
    return { result, ...pendingTriage(result) };
}

Deno.test("activate saves revision 1 with a pending Router Triage action", async () => {
    await withProject(async (projectRoot) => {
        const { result } = await activated(projectRoot);
        assert(result.ok);
        assertEquals(result.workflow.revision, 1);
        assertEquals(result.workflow.state, "triaging");
        assertEquals(result.workflow.nextAction.kind, "triage");
        assert(result.workflow.nextAction.kind === "triage");
        assertEquals(result.workflow.nextAction.role, "router");
        assertEquals(result.workflow.nextAction.contractVersion, "runwield.attached.triage/1");

        const status = await run("status", projectRoot, { workflowId: result.workflow.workflowId });
        assertEquals(status.ok && status.workflow, result.workflow);
    });
});

for (const workKind of WORK_KINDS) {
    Deno.test(`a PLANNED_CHANGE ${workKind} outcome moves the workflow to planning`, async () => {
        await withProject(async (projectRoot) => {
            const triage = await activated(projectRoot);
            const outcome = { routingIntent: "PLANNED_CHANGE", workKind, complexity: "LOW", summary: "planned" };
            const submitted = await run("triage_report", projectRoot, triageReportInput({ ...triage, outcome }));
            assert(submitted.ok, JSON.stringify(submitted));
            assertEquals(submitted.workflow.revision, 2);
            assertEquals(submitted.workflow.state, "awaiting_planning");
            const action = submitted.workflow.nextAction;
            assert(action.kind === "plan", JSON.stringify(action));
            assertEquals(action.role, "planner");
            assertEquals(action.contractVersion, "runwield.attached.planner/1");
            // The test sandbox keeps runtime state outside the repository, so only the
            // managed .gitignore block is a repository change here.
            assertEquals(action.projectSetup, [".gitignore"]);
            assertEquals(submitted.workflow.triageOutcome?.workKind, workKind);
            assertEquals(submitted.workflow.closure, null);
        });
    });
}

for (const routingIntent of ["INQUIRY", "QUICK_FIX", "PROJECT"]) {
    Deno.test(`a ${routingIntent} outcome closes the workflow as unsupported in this Preview`, async () => {
        await withProject(async (projectRoot) => {
            const triage = await activated(projectRoot);
            const outcome = { routingIntent, complexity: "LOW", summary: "not planned here" };
            const submitted = await run("triage_report", projectRoot, triageReportInput({ ...triage, outcome }));
            assert(submitted.ok, JSON.stringify(submitted));
            assertEquals(submitted.workflow.state, "closed");
            assertEquals(submitted.workflow.closure, { reason: "unsupported_in_preview", routingIntent });
            assertEquals(submitted.workflow.nextAction, { kind: "return_to_host", reason: "unsupported_in_preview" });
        });
    });
}

Deno.test("repeating an accepted triage_report returns the saved result and changes nothing", async () => {
    await withProject(async (projectRoot) => {
        const triage = await activated(projectRoot);
        const first = await run("triage_report", projectRoot, triageReportInput(triage));
        const bytes = await readRecordBytes(projectRoot, triage.workflowId);
        const repeated = await run("triage_report", projectRoot, triageReportInput(triage));
        assertEquals(repeated, first);
        assertEquals(await readRecordBytes(projectRoot, triage.workflowId), bytes);
    });
});

Deno.test("repeating an accepted activation returns the same workflow", async () => {
    await withProject(async (projectRoot) => {
        const first = await run("activate", projectRoot, activateInput("op-retry"));
        const repeated = await run("activate", projectRoot, activateInput("op-retry"));
        assertEquals(repeated, first);
    });
});

Deno.test("a different operation against an old revision is rejected", async () => {
    await withProject(async (projectRoot) => {
        const triage = await activated(projectRoot);
        await run("triage_report", projectRoot, triageReportInput(triage));
        const bytes = await readRecordBytes(projectRoot, triage.workflowId);
        const late = await run("triage_report", projectRoot, triageReportInput({ ...triage, operationId: "op-late" }));
        assertEquals(rejectionCode(late), "revision_conflict");
        assertEquals(await readRecordBytes(projectRoot, triage.workflowId), bytes);
    });
});

type RejectionCase = {
    name: string;
    code: string;
    input: (triage: TriageReportInputOptions) => AttachedJsonObject;
};

const REJECTION_CASES: RejectionCase[] = [
    {
        name: "a wrong action ID",
        code: "action_superseded",
        input: (triage) => triageReportInput({ ...triage, actionId: "not-the-pending-action" }),
    },
    {
        name: "a mismatched revision",
        code: "revision_conflict",
        input: (triage) => triageReportInput({ ...triage, expectedRevision: 2 }),
    },
    {
        name: "a malformed outcome",
        code: "invalid_outcome",
        input: (triage) =>
            triageReportInput({
                ...triage,
                outcome: { routingIntent: "PLANNED_CHANGE", complexity: "EXTREME", summary: "s" },
            }),
    },
    {
        name: "an oversized payload",
        code: "payload_too_large",
        input: (triage) =>
            triageReportInput({
                ...triage,
                outcome: { routingIntent: "PLANNED_CHANGE", complexity: "LOW", summary: "x".repeat(70 * 1024) },
            }),
    },
    {
        name: "a transcript-shaped field",
        code: "transcript_field",
        input: (triage) => {
            const input = triageReportInput(triage);
            return { ...input, payload: { actionId: triage.actionId, outcome: {}, messages: [{ role: "user" }] } };
        },
    },
    {
        name: "a path-escape workflow ID",
        code: "path_field",
        input: (triage) => triageReportInput({ ...triage, workflowId: `../${triage.workflowId}` }),
    },
    {
        name: "a path-like field",
        code: "path_field",
        input: (triage) => ({ ...triageReportInput(triage), projectRoot: "/somewhere/else" }),
    },
    {
        name: "an unknown field",
        code: "unknown_field",
        input: (triage) => ({ ...triageReportInput(triage), force: true }),
    },
];

for (const rejectionCase of REJECTION_CASES) {
    Deno.test(`triage_report rejects ${rejectionCase.name} and leaves the record unchanged`, async () => {
        await withProject(async (projectRoot) => {
            const triage = await activated(projectRoot);
            const bytes = await readRecordBytes(projectRoot, triage.workflowId);
            const result = await run("triage_report", projectRoot, rejectionCase.input(triage));
            assertEquals(rejectionCode(result), rejectionCase.code, JSON.stringify(result));
            assertEquals(await readRecordBytes(projectRoot, triage.workflowId), bytes);
        });
    });
}

Deno.test("a record write with a stale expected revision is a conflict and leaves the file unchanged", async () => {
    await withProject(async (projectRoot) => {
        const triage = await activated(projectRoot);
        const location = locateAttachedWorkflows(projectRoot);
        const loaded = await loadAttachedWorkflowRecord(location, triage.workflowId);
        assert(loaded.status === "found");
        const bytes = await readRecordBytes(projectRoot, triage.workflowId);
        const written = await writeAttachedWorkflowRecord(location, { ...loaded.record, revision: 3 }, 2);
        assertEquals(written.status, "conflict");
        assertEquals(written.status === "conflict" && written.current?.revision, 1);
        assertEquals(await readRecordBytes(projectRoot, triage.workflowId), bytes);
    });
});

Deno.test("concurrent triage_report calls in one process accept exactly one outcome", async () => {
    await withProject(async (projectRoot) => {
        const triage = await activated(projectRoot);
        const results = await Promise.all(
            ["PLANNED_CHANGE", "INQUIRY"].map((routingIntent, index) =>
                run(
                    "triage_report",
                    projectRoot,
                    triageReportInput({
                        ...triage,
                        operationId: `op-concurrent-${index}`,
                        outcome: { routingIntent, complexity: "LOW", summary: routingIntent },
                    }),
                )
            ),
        );
        assertEquals(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
        assertEquals(results.filter((result) => rejectionCode(result) === "revision_conflict").length, 1);
        const status = await run("status", projectRoot, { workflowId: triage.workflowId });
        assertEquals(status.ok && status.workflow.revision, 2);
    });
});

Deno.test("activate and Triage write nothing to an uninitialized repository", async () => {
    await withProject(async (projectRoot) => {
        const triage = await activated(projectRoot);
        await run("triage_report", projectRoot, triageReportInput(triage));
        await run("status", projectRoot, { workflowId: triage.workflowId });
        assertEquals(await git(projectRoot, ["status", "--porcelain", "--ignored"]), "");
        assertEquals(await Deno.stat(join(projectRoot, ".wld")).then(() => true, () => false), false);
    });
});

Deno.test("a lock from a dead process and a leftover temporary file do not block the next operation", async () => {
    await withProject(async (projectRoot) => {
        const triage = await activated(projectRoot);
        const workflowsDir = locateAttachedWorkflows(projectRoot).workflowsDir;
        const exited = new Deno.Command("true").spawn();
        await exited.status;
        const deadLock = { pid: exited.pid, hostname: Deno.hostname(), token: "dead", createdAt: Date.now() };
        await Deno.writeTextFile(join(workflowsDir, `${triage.workflowId}.lock`), JSON.stringify(deadLock));
        const leftover = join(workflowsDir, `${triage.workflowId}.json.crashed-writer.tmp`);
        await Deno.writeTextFile(leftover, "{ partial");

        const before = await run("status", projectRoot, { workflowId: triage.workflowId });
        assertEquals(before.ok && before.workflow.revision, 1);
        const submitted = await run("triage_report", projectRoot, triageReportInput(triage));
        assertEquals(submitted.ok && submitted.workflow.revision, 2, JSON.stringify(submitted));
        assertEquals(await Deno.stat(leftover).then(() => true, () => false), false);
    });
});

Deno.test("status reports a moved project folder instead of matching the record elsewhere", async () => {
    await withProject(async (projectRoot) => {
        const triage = await activated(projectRoot);
        const movedRoot = join(dirname(projectRoot), `${projectRoot.split("/").at(-1)}-moved`);
        await Deno.rename(projectRoot, movedRoot);
        try {
            const status = await run("status", movedRoot, { workflowId: triage.workflowId });
            assert(status.ok, JSON.stringify(status));
            assertEquals(status.workflow.recovery?.case, "project_moved");
            assertEquals(status.workflow.recovery?.currentProjectRoot, await Deno.realPath(movedRoot));
            const submitted = await run("triage_report", movedRoot, triageReportInput(triage));
            assertEquals(rejectionCode(submitted), "project_moved");
        } finally {
            await Deno.rename(movedRoot, projectRoot);
        }
    });
});

Deno.test("a linked worktree finds the records of its primary checkout", async () => {
    await withProject(async (projectRoot) => {
        const triage = await activated(projectRoot);
        const worktree = `${projectRoot}-linked`;
        await git(projectRoot, ["worktree", "add", "-q", "-b", "linked", worktree]);
        try {
            const status = await run("status", worktree, { workflowId: triage.workflowId });
            assertEquals(status.ok && status.workflow.recovery, null, JSON.stringify(status));
        } finally {
            await Deno.remove(worktree, { recursive: true }).catch(() => undefined);
        }
    });
});

Deno.test("without a home directory records fall back to the project internal runtime directory", async () => {
    await withProcessGlobalTestLock(async () => {
        const home = Deno.env.get("HOME");
        Deno.env.delete("HOME");
        try {
            await withProject(async (projectRoot) => {
                assertEquals(locateAttachedWorkflows(projectRoot).homeBaseDir, null);
                const triage = await activated(projectRoot);
                const submitted = await run("triage_report", projectRoot, triageReportInput(triage));
                assertEquals(submitted.ok && submitted.workflow.revision, 2);
            });
        } finally {
            if (home !== undefined) Deno.env.set("HOME", home);
        }
    });
});

for (const operationId of ["constructor", "toString"]) {
    Deno.test(`triage_report accepts and replays the valid operation ID ${operationId}`, async () => {
        await withProject(async (projectRoot) => {
            const triage = await activated(projectRoot);
            const input = triageReportInput({ ...triage, operationId });
            const accepted = await run("triage_report", projectRoot, input);
            assert(accepted.ok, JSON.stringify(accepted));
            assertEquals(accepted.workflow.state, "awaiting_planning");
            assertEquals(await run("triage_report", projectRoot, input), accepted);
        });
    });
}
