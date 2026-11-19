import { test } from "node:test";
import { ok as assert, deepStrictEqual as assertEquals, throws } from "node:assert/strict";
import { rename, symlink, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeCwdForSessionDir } from "../project-directory-key.ts";
import { git } from "../git-test-fixture.ts";
import { locateAttachedWorkflows } from "./record-store.ts";
import {
    activateInput,
    pendingTriage,
    readRecordBytes,
    runOperation as run,
    triageReportInput,
    withProject,
} from "./attached-test-fixture.ts";

test("a retained checkout alias resumes the original workflow and lock namespace", async () => {
    await withProject(async (projectRoot) => {
        const activation = await run("activate", projectRoot, activateInput());
        const triage = pendingTriage(activation);
        const original = locateAttachedWorkflows(projectRoot);
        const before = await readRecordBytes(projectRoot, triage.workflowId);
        const movedRoot = `${projectRoot}-moved`;
        await rename(projectRoot, movedRoot);
        await symlink(movedRoot, projectRoot, "dir");
        try {
            const status = await run("status", movedRoot, { workflowId: triage.workflowId, inspectOnly: true });
            assert(status.ok, JSON.stringify(status));
            assertEquals(status.workflow.recovery, null);
            assertEquals(status.workflow.revision, 1);
            assertEquals(await readRecordBytes(projectRoot, triage.workflowId), before);
            assertEquals(locateAttachedWorkflows(movedRoot), original);
            const latest = await run("status", movedRoot, { inspectOnly: true });
            assert(latest.ok, JSON.stringify(latest));
            assertEquals(latest.workflow.workflowId, triage.workflowId);
            const submitted = await run("triage_report", movedRoot, triageReportInput(triage));
            assert(submitted.ok, JSON.stringify(submitted));
            assertEquals(submitted.workflow.revision, 2);
            assertEquals(await run("triage_report", projectRoot, triageReportInput(triage)), submitted);
            assertEquals(await run("activate", movedRoot, activateInput()), activation);
            const duplicateDirectory = join(original.homeBaseDir, encodeCwdForSessionDir(movedRoot), "workflows");
            assertEquals(
                await stat(duplicateDirectory).then(
                    () => true,
                    () => false,
                ),
                false,
            );
        } finally {
            await rm(projectRoot);
            await rename(movedRoot, projectRoot);
        }
    });
});

test("alias and linked-worktree callers serialize competing revisions in the original directory", async () => {
    await withProject(async (projectRoot) => {
        const triage = pendingTriage(await run("activate", projectRoot, activateInput()));
        const original = locateAttachedWorkflows(projectRoot);
        const movedRoot = `${projectRoot}-moved`;
        const linkedRoot = `${projectRoot}-linked`;
        await git(projectRoot, ["worktree", "add", "-q", "-b", "linked", linkedRoot]);
        await rename(projectRoot, movedRoot);
        await symlink(movedRoot, projectRoot, "dir");
        try {
            assertEquals(locateAttachedWorkflows(linkedRoot), original);
            const results = await Promise.all([
                run("triage_report", movedRoot, triageReportInput({ ...triage, operationId: "first-writer" })),
                run("triage_report", linkedRoot, triageReportInput({ ...triage, operationId: "second-writer" })),
            ]);
            assertEquals(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
            const rejected = results.find((result) => !result.ok);
            assert(rejected && !rejected.ok);
            assertEquals(rejected.rejection.code, "revision_conflict");
            const status = await run("status", projectRoot, { workflowId: triage.workflowId, inspectOnly: true });
            assert(status.ok);
            assertEquals(status.workflow.revision, 2);
        } finally {
            await rm(projectRoot);
            await rename(movedRoot, projectRoot);
            await rm(linkedRoot, { recursive: true, force: true });
        }
    });
});

test("competing persisted alias namespaces are rejected without rewriting either record", async () => {
    await withProject(async (projectRoot) => {
        const triage = pendingTriage(await run("activate", projectRoot, activateInput()));
        const original = locateAttachedWorkflows(projectRoot);
        const before = await readRecordBytes(projectRoot, triage.workflowId);
        const movedRoot = `${projectRoot}-moved`;
        await rename(projectRoot, movedRoot);
        await symlink(movedRoot, projectRoot, "dir");
        const duplicateDirectory = join(original.homeBaseDir, encodeCwdForSessionDir(movedRoot), "workflows");
        try {
            await mkdir(duplicateDirectory, { recursive: true });
            const duplicate = { ...JSON.parse(before), projectRoot: movedRoot };
            await writeFile(join(duplicateDirectory, `${triage.workflowId}.json`), JSON.stringify(duplicate));
            throws(() => locateAttachedWorkflows(movedRoot), /project_alias_conflict/);
            throws(() => locateAttachedWorkflows(projectRoot), /project_alias_conflict/);
        } finally {
            await rm(duplicateDirectory, { recursive: true, force: true });
            assertEquals(await readRecordBytes(projectRoot, triage.workflowId), before);
            await rm(projectRoot);
            await rename(movedRoot, projectRoot);
        }
    });
});
