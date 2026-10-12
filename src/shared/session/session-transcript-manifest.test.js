import { assertEquals } from "../../testing/assertions.ts";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    truncate as fsTruncate,
    utimes as fsUtimes,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import { openOwnerCoordinationDatabase } from "../owner-coordination/database.js";
import { registerProject } from "../owner-coordination/projects.js";
import {
    appendSessionTranscriptSegment,
    ensureSessionCatalogRecord,
    getCurrentSessionSegment,
    listSessionTranscriptSegments,
    sealSessionTranscriptSegment,
} from "../owner-coordination/sessions.js";
import { captureTranscriptEvidence } from "./session-transcript-projection.js";
import { projectAggregateTranscript } from "./session-transcript-manifest.ts";
import { getRunWieldSessionDir } from "./root-session.js";

function idFactory(prefix = "id") {
    let next = 0;
    return () => `${prefix}-${++next}`;
}

/** @param {string} cwd @param {string} piSessionId @param {string} timestamp @param {Array<Record<string, unknown>>} bodyEntries */
async function writeTranscript(cwd, piSessionId, timestamp, bodyEntries) {
    const sessionDir = getRunWieldSessionDir(cwd);
    await fsMkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    const entries = [
        { type: "session", id: piSessionId, cwd, timestamp },
        ...bodyEntries,
    ];
    await fsWriteFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return { path, entries };
}

/**
 * @param {Array<Record<string, unknown>> | null} [firstBodyEntries]
 * @param {Array<Record<string, unknown>> | null} [secondBodyEntries]
 */
async function createTwoSegmentFixture(firstBodyEntries = null, secondBodyEntries = null) {
    const firstEntries = firstBodyEntries || [
        {
            type: "message",
            id: "duplicate",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: { role: "user", content: "first" },
        },
    ];
    const secondEntries = secondBodyEntries || [
        {
            type: "message",
            id: "duplicate",
            timestamp: "2026-01-01T00:00:03.000Z",
            message: { role: "assistant", content: "second" },
        },
    ];
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-aggregate-transcript-"));
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    const root = `${dir}/repo`;
    await fsMkdir(root);
    const project = registerProject(database, { root, idFactory: idFactory("project"), now: () => "t0" });
    const first = await writeTranscript(root, "pi-one", "2026-01-01T00:00:00.000Z", firstEntries);
    const session = await ensureSessionCatalogRecord(database, {
        projectId: project.projectId,
        piSessionId: "pi-one",
        transcriptPath: first.path,
        transcriptCwd: root,
        idFactory: idFactory("session"),
        now: () => "t1",
    });
    const firstSegment = getCurrentSessionSegment(database, session.runwieldSessionId);
    assert(firstSegment);
    const firstEvidence = await captureTranscriptEvidence({ transcriptPath: first.path, transcriptCwd: root });
    await sealSessionTranscriptSegment(database, {
        runwieldSessionId: session.runwieldSessionId,
        segmentId: firstSegment.segmentId,
        evidence: firstEvidence,
        now: () => "t2",
    });
    const second = await writeTranscript(root, "pi-two", "2026-01-01T00:00:02.000Z", secondEntries);
    const secondSegment = await appendSessionTranscriptSegment(database, {
        runwieldSessionId: session.runwieldSessionId,
        projectId: project.projectId,
        piSessionId: "pi-two",
        transcriptPath: second.path,
        transcriptCwd: root,
        kind: "execution",
        lineageParentSegmentId: firstSegment.segmentId,
        idFactory: idFactory("segment"),
        now: () => "t3",
    });
    const secondEvidence = await captureTranscriptEvidence({ transcriptPath: second.path, transcriptCwd: root });
    const generation = {
        generation: 1,
        byteLength: secondEvidence.byteLength,
        terminalEntryId: secondEvidence.terminalEntryId,
        digestHex: secondEvidence.digestHex,
        currentSegmentId: secondSegment.segmentId,
    };
    return { dir, database, root, session, firstSegment, firstEvidence, first, second, secondSegment, generation };
}

/** @param {Awaited<ReturnType<typeof createTwoSegmentFixture>>} fixture */
async function cleanupFixture(fixture) {
    fixture.database.close();
    await fsRm(fixture.dir, { recursive: true });
}

test("aggregate projection adds safe segment context without exposing segment evidence", async () => {
    const fixture = await createTwoSegmentFixture();
    try {
        const projected = await projectAggregateTranscript({
            cwd: fixture.root,
            runwieldSessionId: fixture.session.runwieldSessionId,
            runtimeSessionId: "runtime-1",
            generation: fixture.generation,
            segments: listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId),
        });
        assert(projected.ok);
        assertEquals(projected.events.map((event) => event.eventId), [
            `${fixture.firstSegment.segmentId}:duplicate:user_message:0`,
            `${fixture.secondSegment.segmentId}:duplicate:assistant_text_delta:0`,
        ]);
        assertEquals(projected.snapshot.name, null);
        assertEquals(projected.snapshot.sessionStats, {
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: 0,
            compactionCount: 0,
        });
        assertEquals(projected.events.map((event) => [event.segmentOrdinal, event.segmentKind]), [
            [0, "planning"],
            [1, "execution"],
        ]);
        assertEquals(projected.segments, [
            { ordinal: 0, kind: "planning", label: "Planning segment 1", sealed: true, current: false },
            { ordinal: 1, kind: "execution", label: "Execution segment 2", sealed: false, current: true },
        ]);
        assertEquals(JSON.stringify(projected.segments).includes(fixture.firstSegment.segmentId), false);
    } finally {
        await cleanupFixture(fixture);
    }
});

test("aggregate projection reads segments from each segment transcript directory", async () => {
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-aggregate-transcript-dirs-"));
    try {
        const firstRoot = `${dir}/repo`;
        const secondRoot = `${dir}/worktree-repo`;
        await fsMkdir(firstRoot);
        await fsMkdir(secondRoot);
        const first = await writeTranscript(firstRoot, "pi-one", "2026-01-01T00:00:00.000Z", [
            {
                type: "message",
                id: "first",
                timestamp: "2026-01-01T00:00:01.000Z",
                message: { role: "user", content: "first" },
            },
        ]);
        const second = await writeTranscript(secondRoot, "pi-two", "2026-01-01T00:00:02.000Z", [
            {
                type: "message",
                id: "second",
                timestamp: "2026-01-01T00:00:03.000Z",
                message: { role: "assistant", content: "second" },
            },
        ]);
        const firstEvidence = await captureTranscriptEvidence({ transcriptPath: first.path, transcriptCwd: firstRoot });
        const secondEvidence = await captureTranscriptEvidence({
            transcriptPath: second.path,
            transcriptCwd: secondRoot,
        });
        const projected = await projectAggregateTranscript({
            cwd: firstRoot,
            runwieldSessionId: "session-1",
            generation: {
                generation: 1,
                byteLength: secondEvidence.byteLength,
                terminalEntryId: secondEvidence.terminalEntryId,
                digestHex: secondEvidence.digestHex,
                currentSegmentId: "segment-2",
            },
            segments: [
                {
                    segmentId: "segment-1",
                    runwieldSessionId: "session-1",
                    projectId: "project-1",
                    piSessionId: "pi-one",
                    transcriptPath: first.path,
                    transcriptCwd: firstRoot,
                    ordinal: 0,
                    kind: "planning",
                    sealedAt: "t1",
                    sealedByteLength: firstEvidence.byteLength,
                    sealedDigestHex: firstEvidence.digestHex,
                    sealedTerminalEntryId: firstEvidence.terminalEntryId,
                },
                {
                    segmentId: "segment-2",
                    runwieldSessionId: "session-1",
                    projectId: "project-1",
                    piSessionId: "pi-two",
                    transcriptPath: second.path,
                    transcriptCwd: secondRoot,
                    ordinal: 1,
                    kind: "execution",
                    sealedAt: null,
                    sealedByteLength: null,
                    sealedDigestHex: null,
                    sealedTerminalEntryId: null,
                },
            ],
        });

        assert(projected.ok);
        assertEquals(projected.events.map((event) => event.eventId), [
            "segment-1:first:user_message:0",
            "segment-2:second:assistant_text_delta:0",
        ]);
    } finally {
        await fsRm(dir, { recursive: true });
    }
});

test("aggregate projection carries active Agent state across segment boundaries", async () => {
    const fixture = await createTwoSegmentFixture(
        [
            {
                type: "custom",
                id: "agent-guide",
                customType: "runwield.active_agent",
                data: { agentName: "guide", displayName: "Guide" },
            },
            {
                type: "message",
                id: "guide-reply",
                timestamp: "2026-01-01T00:00:01.000Z",
                message: { role: "assistant", content: "first" },
            },
        ],
        [
            {
                type: "message",
                id: "pre-marker-reply",
                timestamp: "2026-01-01T00:00:03.000Z",
                message: { role: "assistant", content: "still guide" },
            },
            {
                type: "custom",
                id: "agent-guide-repeat",
                customType: "runwield.active_agent",
                data: { agentName: "guide", displayName: "Guide" },
            },
            {
                type: "custom",
                id: "agent-operator",
                customType: "runwield.active_agent",
                data: { agentName: "operator", displayName: "Operator" },
            },
        ],
    );
    try {
        const projected = await projectAggregateTranscript({
            cwd: fixture.root,
            runwieldSessionId: fixture.session.runwieldSessionId,
            runtimeSessionId: "runtime-1",
            generation: fixture.generation,
            segments: listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId),
        });
        assert(projected.ok);
        assertEquals(
            projected.events.map((
                event,
            ) => [event.type, event.eventId, event.message || event.delta || "", event.agentName || ""]),
            [
                [
                    "assistant_text_delta",
                    `${fixture.firstSegment.segmentId}:guide-reply:assistant_text_delta:0`,
                    "first",
                    "Guide",
                ],
                [
                    "assistant_text_delta",
                    `${fixture.secondSegment.segmentId}:pre-marker-reply:assistant_text_delta:0`,
                    "still guide",
                    "Guide",
                ],
                [
                    "system_status",
                    `${fixture.secondSegment.segmentId}:agent-operator:agent_switch:0`,
                    "Agent switched to Operator",
                    "",
                ],
            ],
        );
    } finally {
        await cleanupFixture(fixture);
    }
});

test("aggregate projection fails closed with zero events when sealed segment evidence is unavailable", async () => {
    for (const mutate of ["missing", "truncated", "extended", "byte-modified"]) {
        const fixture = await createTwoSegmentFixture();
        try {
            if (mutate === "missing") await fsRm(fixture.first.path);
            if (mutate === "truncated") await fsTruncate(fixture.first.path, fixture.firstEvidence.byteLength - 1);
            if (mutate === "extended") await fsWriteFile(fixture.first.path, "{}\n", { flag: "a" });
            if (mutate === "byte-modified") {
                const text = await fsReadFile(fixture.first.path, "utf8");
                await fsWriteFile(fixture.first.path, text.replace("first", "FIrst"));
            }
            const projected = await projectAggregateTranscript({
                cwd: fixture.root,
                runwieldSessionId: fixture.session.runwieldSessionId,
                runtimeSessionId: "runtime-1",
                generation: fixture.generation,
                segments: listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId),
                cursorEventId: mutate === "missing"
                    ? `${fixture.firstSegment.segmentId}:duplicate:user_message:0`
                    : null,
            });
            assertEquals(projected.ok, false, mutate);
            assertEquals(projected.events, [], mutate);
        } finally {
            await cleanupFixture(fixture);
        }
    }
});

test("aggregate projection fails closed when segments extend beyond committed generation", async () => {
    const fixture = await createTwoSegmentFixture();
    try {
        const projected = await projectAggregateTranscript({
            cwd: fixture.root,
            runwieldSessionId: fixture.session.runwieldSessionId,
            runtimeSessionId: "runtime-1",
            generation: {
                generation: 0,
                byteLength: fixture.firstEvidence.byteLength,
                terminalEntryId: fixture.firstEvidence.terminalEntryId,
                digestHex: fixture.firstEvidence.digestHex,
                currentSegmentId: fixture.firstSegment.segmentId,
            },
            segments: listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId),
        });
        if (projected.ok) throw new Error("projection should have failed");
        assertEquals(projected.state, "degraded");
        assertEquals(projected.code, "projection_failed");
        assertEquals(projected.message, "Committed generation references an ambiguous segment lineage");
        assertEquals(projected.events, []);
    } finally {
        await cleanupFixture(fixture);
    }
});

test("aggregate projection replays from start when a cursor is absent after full verification", async () => {
    const fixture = await createTwoSegmentFixture();
    try {
        const projected = await projectAggregateTranscript({
            cwd: fixture.root,
            runwieldSessionId: fixture.session.runwieldSessionId,
            runtimeSessionId: "runtime-1",
            generation: fixture.generation,
            segments: listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId),
            cursorEventId: "old-client-cursor",
        });
        assert(projected.ok);
        assertEquals(projected.cursorReset, true);
        assertEquals(projected.events.length, 2);
    } finally {
        await cleanupFixture(fixture);
    }
});

test("aggregate projection fails closed after a same-size sealed segment mutation with restored mtime", async () => {
    const fixture = await createTwoSegmentFixture();
    try {
        const firstProjection = await projectAggregateTranscript({
            cwd: fixture.root,
            runwieldSessionId: fixture.session.runwieldSessionId,
            runtimeSessionId: "runtime-1",
            generation: fixture.generation,
            segments: listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId),
        });
        assert(firstProjection.ok);
        const stat = await fsStat(fixture.first.path);
        const text = await fsReadFile(fixture.first.path, "utf8");
        await fsWriteFile(fixture.first.path, text.replace("first", "FIrst"));
        if (stat.atime && stat.mtime) await fsUtimes(fixture.first.path, stat.atime, stat.mtime);
        const secondProjection = await projectAggregateTranscript({
            cwd: fixture.root,
            runwieldSessionId: fixture.session.runwieldSessionId,
            runtimeSessionId: "runtime-1",
            generation: fixture.generation,
            segments: listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId),
        });
        assertEquals(secondProjection.ok, false);
        assertEquals(secondProjection.events, []);
    } finally {
        await cleanupFixture(fixture);
    }
});

test("aggregate projection resumes across a segment boundary", async () => {
    const fixture = await createTwoSegmentFixture();
    try {
        const projected = await projectAggregateTranscript({
            cwd: fixture.root,
            runwieldSessionId: fixture.session.runwieldSessionId,
            runtimeSessionId: "runtime-1",
            generation: fixture.generation,
            segments: listSessionTranscriptSegments(fixture.database, fixture.session.runwieldSessionId),
            cursorEventId: `${fixture.firstSegment.segmentId}:duplicate:user_message:0`,
            cursorEventOrdinal: 0,
        });
        assert(projected.ok);
        assertEquals(projected.events.map((event) => event.eventId), [
            `${fixture.secondSegment.segmentId}:duplicate:assistant_text_delta:0`,
        ]);
    } finally {
        await cleanupFixture(fixture);
    }
});
