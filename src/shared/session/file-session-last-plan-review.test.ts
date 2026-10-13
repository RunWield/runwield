import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { spawnNativeProcess } from "../foreground-process.ts";
import { getCwd } from "../../constants.js";
import { test } from "node:test";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { openFileSessionStore } from "./file-session-store.ts";
import { encodeCwdForSessionDir } from "./root-session.js";

test("the latest Plan review is readable from another store before the writer settles", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const projectRoot = join(root, "project");
    const baseDir = join(root, "sessions");
    await fsMkdir(projectRoot);
    const transcriptDir = join(baseDir, encodeCwdForSessionDir(await fsRealpath(projectRoot)));
    await fsMkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, "2026-01-01T00-00-00-000Z_pi-session.jsonl");
    await fsWriteFile(
        transcriptPath,
        `${
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-session",
                timestamp: "2026-01-01T00:00:00.000Z",
                cwd: projectRoot,
            })
        }\n`,
    );
    const writer = openFileSessionStore({ baseDir, now: () => "2026-01-02T00:00:00.000Z" });
    const reader = openFileSessionStore({ baseDir });
    try {
        const project = writer.ensureRuntimeProject({ root: projectRoot });
        const session = await writer.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "pi-session",
            transcriptPath,
            transcriptCwd: projectRoot,
        });
        assertEquals(reader.getLastPlanReview(session.runwieldSessionId, project.projectId), null);
        const segment = writer.getCurrentSessionSegment(session.runwieldSessionId);
        if (!segment) throw new Error("Session segment missing");
        const proof = writer.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: project.projectId,
            ownerInstanceId: "writer",
            ownerProcessKind: "test",
            expectedCurrentSegmentId: segment.segmentId,
        });
        const first = writer.recordLastPlanReview(proof, {
            planId: "plan-a",
            planName: "plan-a",
            planningAgentName: "planner",
        });
        assertEquals(first, {
            planId: "plan-a",
            planName: "plan-a",
            planningAgentName: "planner",
            requestedAt: "2026-01-02T00:00:00.000Z",
        });
        // A second store sees the atomic manifest update while the first writer still owns the lock.
        assertEquals(reader.getLastPlanReview(session.runwieldSessionId, project.projectId), first);
        assertThrows(() =>
            writer.recordLastPlanReview({ ...proof, fence: proof.fence + 1 }, {
                planId: "bad",
                planName: "bad",
                planningAgentName: "planner",
            })
        );
        assertEquals(reader.getLastPlanReview(session.runwieldSessionId, project.projectId), first);
        const second = writer.recordLastPlanReview(proof, {
            planId: "sequence-id",
            planName: "sequence-container",
            planningAgentName: "architect",
        });
        assertEquals(reader.getLastPlanReview(session.runwieldSessionId, project.projectId), second);
        writer.releaseUnchangedActivation(proof);
        reader.close();
        const reopened = openFileSessionStore({ baseDir });
        try {
            assertEquals(reopened.getLastPlanReview(session.runwieldSessionId, project.projectId), second);
        } finally {
            reopened.close();
        }
    } finally {
        reader.close();
        writer.close();
        await fsRm(root, { recursive: true });
    }
});

test("a Plan review reference survives a writer process crash before settlement", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-fixture-"));
    const projectRoot = join(root, "project");
    const baseDir = join(root, "sessions");
    const readyPath = join(root, "writer-ready.json");
    await fsMkdir(projectRoot);
    const transcriptDir = join(baseDir, encodeCwdForSessionDir(await fsRealpath(projectRoot)));
    await fsMkdir(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, "2026-01-01T00-00-00-000Z_pi-session.jsonl");
    await fsWriteFile(
        transcriptPath,
        `${
            JSON.stringify({
                type: "session",
                version: 3,
                id: "pi-session",
                timestamp: "2026-01-01T00:00:00.000Z",
                cwd: projectRoot,
            })
        }\n`,
    );
    const script = `
        import { openFileSessionStore } from ${JSON.stringify(import.meta.resolve("./file-session-store.ts"))};
        const store = openFileSessionStore({ baseDir: ${JSON.stringify(baseDir)} });
        const project = store.ensureRuntimeProject({ root: ${JSON.stringify(projectRoot)} });
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId, piSessionId: "pi-session",
            transcriptPath: ${JSON.stringify(transcriptPath)}, transcriptCwd: ${JSON.stringify(projectRoot)},
        });
        const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
        const proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId, projectId: project.projectId,
            ownerInstanceId: "crashing-writer", ownerProcessKind: "test",
            expectedCurrentSegmentId: segment.segmentId,
        });
        store.recordLastPlanReview(proof, {
            planId: "crash-plan-id", planName: "crash-plan", planningAgentName: "planner",
        });
        (await import("node:fs")).writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({
            sessionId: session.runwieldSessionId, projectId: project.projectId,
        }));
        setInterval(() => {}, 1000);
    `;
    const worker = spawnNativeProcess(process.execPath, {
        args: runtimeSourceArgs(["eval", script]),
        stdout: "null",
        stderr: "piped",
        cwd: getCwd(),
        stdin: "null",
    });
    try {
        const deadline = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < deadline) {
            try {
                await fsStat(readyPath);
                ready = true;
                break;
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!ready) {
            try {
                worker.kill("SIGKILL");
            } catch { /* Worker already stopped. */ }
            const result = await collectProcessOutput(worker);
            throw new Error(`Writer never recorded the review: ${new TextDecoder().decode(result.stderr)}`);
        }
        const { sessionId, projectId } = JSON.parse(await fsReadFile(readyPath, "utf8"));
        worker.kill("SIGKILL");
        await worker.status;
        const reopened = openFileSessionStore({ baseDir });
        try {
            assertEquals(reopened.getLastPlanReview(sessionId, projectId)?.planId, "crash-plan-id");
        } finally {
            reopened.close();
        }
    } finally {
        try {
            worker.kill("SIGKILL");
        } catch { /* Worker already stopped. */ }
        await fsRm(root, { recursive: true });
    }
});
