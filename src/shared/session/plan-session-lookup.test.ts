import { assertEquals } from "../../testing/assertions.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openFileSessionStore } from "./file-session-store.ts";
import { findPlanAssociatedSessions } from "./plan-session-lookup.ts";
import { encodeCwdForSessionDir } from "../project-directory-key.ts";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

async function makeFixture() {
    const rootDir = await fsMkdtemp(join(tmpdir(), "runwield-plan-session-lookup-"));
    const projectRoot = join(rootDir, "project");
    const sessionBaseDir = join(rootDir, "sessions");
    await fsMkdir(projectRoot);
    const canonicalProjectRoot = await fsRealpath(projectRoot);
    const sessionDir = join(sessionBaseDir, encodeCwdForSessionDir(canonicalProjectRoot));
    await fsMkdir(sessionDir, { recursive: true });
    return { rootDir, projectRoot, sessionBaseDir, sessionDir };
}

async function writeTranscript(sessionDir: string, cwd: string, id: string) {
    const path = join(sessionDir, `${TIMESTAMP.replace(/[:.]/g, "-")}_${id}.jsonl`);
    await fsWriteFile(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: TIMESTAMP, cwd })}\n`);
    return path;
}

async function publishAssociation(
    store: ReturnType<typeof openFileSessionStore>,
    session: Awaited<ReturnType<ReturnType<typeof openFileSessionStore>["ensureSessionCatalogRecord"]>>,
    projectId: string,
    purpose: "planning" | "review" | "execution" | "recovery" = "planning",
) {
    let proof = store.acquireSessionActivation({
        runwieldSessionId: session.runwieldSessionId,
        projectId,
        ownerInstanceId: "owner",
        ownerProcessKind: "test",
    });
    const segment = store.getCurrentSessionSegment(session.runwieldSessionId);
    assert(segment);
    store.stagePlanAssociation(proof, {
        planId: "plan-1",
        planName: "example-plan",
        purpose,
        segmentId: segment.segmentId,
        segmentKind: segment.kind,
        recordedAt: TIMESTAMP,
    });
    proof = store.changeSessionActivationPhase(proof, "hydrated");
    proof = store.changeSessionActivationPhase(proof, "checkpointing");
    const bytes = await fsReadFile(session.transcriptPath);
    store.publishGenerationAndRelease(proof, {
        generation: 0,
        byteLength: bytes.byteLength,
        terminalEntryId: null,
        digestHex: createHash("sha256").update(bytes).digest("hex"),
    });
}

test("findPlanAssociatedSessions returns safe planning candidates from manifests", async () => {
    const fixture = await makeFixture();
    try {
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "safe-session");
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "safe-session",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        await publishAssociation(store, session, project.projectId);

        const candidates = await findPlanAssociatedSessions(store, { cwd: fixture.projectRoot, planId: "plan-1" });

        assertEquals(candidates.length, 1);
        assertEquals(candidates[0].runwieldSessionId, session.runwieldSessionId);
        assertEquals(candidates[0].safePlanningResume, true);
        assertEquals(candidates[0].reason, null);
    } finally {
        await fsRm(fixture.rootDir, { recursive: true });
    }
});

test("findPlanAssociatedSessions does not catalog lineage transcripts during lookup", async () => {
    const fixture = await makeFixture();
    try {
        const planningPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "planning");
        await fsWriteFile(
            planningPath,
            `${JSON.stringify({
                type: "custom",
                customType: "runwield.segment_lineage",
                data: {
                    runwieldSessionId: "lineage-session",
                    segmentId: "planning-segment",
                    parentSegmentId: null,
                    parentPiSessionId: null,
                    lineageGroupKey: "planning-segment",
                    kind: "planning",
                },
            })}\n${JSON.stringify({
                type: "custom",
                customType: "runwield.plan_association",
                data: {
                    planId: "plan-1",
                    planName: "example-plan",
                    purpose: "planning",
                    segmentId: "planning-segment",
                    segmentKind: "planning",
                    recordedAt: TIMESTAMP,
                },
            })}\n`,
            { flag: "a" },
        );
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        store.ensureRuntimeProject({ root: fixture.projectRoot });

        assertEquals(await findPlanAssociatedSessions(store, { cwd: fixture.projectRoot, planId: "plan-1" }), []);
        assertEquals(store.getSessionById("lineage-session"), null);
    } finally {
        await fsRm(fixture.rootDir, { recursive: true });
    }
});

test("findPlanAssociatedSessions ignores raw transcript associations that were not published", async () => {
    const fixture = await makeFixture();
    try {
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "raw-tail-session");
        await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "raw-tail-session",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
            source: "created",
        });
        await fsWriteFile(
            transcriptPath,
            `${JSON.stringify({
                type: "custom",
                customType: "runwield.plan_association",
                data: {
                    planId: "plan-1",
                    planName: "example-plan",
                    purpose: "planning",
                    segmentId: "segment-tail",
                    segmentKind: "planning",
                    recordedAt: TIMESTAMP,
                },
            })}\n`,
            { flag: "a" },
        );

        assertEquals(await findPlanAssociatedSessions(store, { cwd: fixture.projectRoot, planId: "plan-1" }), []);
    } finally {
        await fsRm(fixture.rootDir, { recursive: true });
    }
});

test("Plan lookup includes archived Sessions and their archive status", async () => {
    const fixture = await makeFixture();
    const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
    try {
        const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
        const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "archived-plan");
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: "archived-plan",
            transcriptPath,
            transcriptCwd: fixture.projectRoot,
        });
        await publishAssociation(store, session, project.projectId);
        const archived = store.archiveSession(session.runwieldSessionId);
        const candidates = await findPlanAssociatedSessions(store, { cwd: fixture.projectRoot, planId: "plan-1" });
        assertEquals(candidates.length, 1);
        assertEquals(candidates[0].runwieldSessionId, session.runwieldSessionId);
        assertEquals(candidates[0].archivedAt, archived.archivedAt);
        assertEquals(candidates[0].associations, store.listSessionPlanAssociations(session.runwieldSessionId));
    } finally {
        store.close();
        await fsRm(fixture.rootDir, { recursive: true });
    }
});

for (const scenario of [
    { name: "saved title", title: "Dashboard planning", expected: "Dashboard planning" },
    { name: "first user message", title: "   ", expected: "Build a reliable usage dashboard" },
]) {
    test(`Plan Session labels use the ${scenario.name} from committed history`, async () => {
        const fixture = await makeFixture();
        const store = openFileSessionStore({ baseDir: fixture.sessionBaseDir });
        try {
            const project = store.ensureRuntimeProject({ root: fixture.projectRoot });
            const transcriptPath = await writeTranscript(fixture.sessionDir, fixture.projectRoot, "label-session");
            const session = await store.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId: "label-session",
                transcriptPath,
                transcriptCwd: fixture.projectRoot,
            });
            await fsWriteFile(
                transcriptPath,
                [
                    { type: "session_info", name: scenario.title },
                    { type: "message", message: { role: "user", content: "Build a reliable usage dashboard" } },
                ]
                    .map((entry) => JSON.stringify(entry))
                    .join("\n") + "\n",
                { flag: "a" },
            );
            await publishAssociation(store, session, project.projectId);

            const candidates = await findPlanAssociatedSessions(store, { cwd: fixture.projectRoot, planId: "plan-1" });

            assertEquals(candidates[0].displayName, scenario.expected);
        } finally {
            store.close();
            await fsRm(fixture.rootDir, { recursive: true });
        }
    });
}
