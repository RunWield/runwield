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
import type { PersistedActiveAgentState } from "./active-agent-session.ts";
import { tmpdir } from "node:os";
import { ok as assert } from "node:assert/strict";
import { join } from "node:path";
import { captureTranscriptEvidence } from "./session-transcript-projection.ts";
import { projectAggregateTranscript } from "./session-transcript-manifest.ts";
import { getRunWieldSessionDir } from "./root-session.ts";

interface FixtureTranscriptMessage {
    role: "user" | "assistant";
    content: string;
}

interface FixtureMessageEntry {
    type: "message";
    id: string;
    timestamp: string;
    message: FixtureTranscriptMessage;
}

interface FixtureActiveAgentEntry {
    type: "custom";
    id: string;
    customType: string;
    data: PersistedActiveAgentState;
}

type FixtureBodyEntry = FixtureMessageEntry | FixtureActiveAgentEntry;

async function writeTranscript(cwd: string, piSessionId: string, timestamp: string, bodyEntries: FixtureBodyEntry[]) {
    const sessionDir = getRunWieldSessionDir(cwd);
    await fsMkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    const entries = [{ type: "session", id: piSessionId, cwd, timestamp }, ...bodyEntries];
    await fsWriteFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return { path, entries };
}

async function createTwoSegmentFixture(
    firstBodyEntries: FixtureBodyEntry[] | null = null,
    secondBodyEntries: FixtureBodyEntry[] | null = null,
) {
    const firstEntries: FixtureBodyEntry[] = firstBodyEntries || [
        {
            type: "message",
            id: "duplicate",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: { role: "user", content: "first" },
        },
    ];
    const secondEntries: FixtureBodyEntry[] = secondBodyEntries || [
        {
            type: "message",
            id: "duplicate",
            timestamp: "2026-01-01T00:00:03.000Z",
            message: { role: "assistant", content: "second" },
        },
    ];
    const dir = await fsMkdtemp(join(tmpdir(), "runwield-aggregate-transcript-"));
    const root = `${dir}/repo`;
    await fsMkdir(root);
    const first = await writeTranscript(root, "pi-one", "2026-01-01T00:00:00.000Z", firstEntries);
    const firstEvidence = await captureTranscriptEvidence({ transcriptPath: first.path, transcriptCwd: root });
    const session = { runwieldSessionId: "fixture-session" };
    const firstSegment = {
        segmentId: "first",
        runwieldSessionId: session.runwieldSessionId,
        projectId: "fixture-project",
        piSessionId: "pi-one",
        transcriptPath: first.path,
        transcriptCwd: root,
        ordinal: 0,
        kind: "planning",
        sealedAt: "2026-01-01T00:00:02.000Z",
        sealedByteLength: firstEvidence.byteLength,
        sealedDigestHex: firstEvidence.digestHex,
        sealedTerminalEntryId: firstEvidence.terminalEntryId,
    };
    const second = await writeTranscript(root, "pi-two", "2026-01-01T00:00:02.000Z", secondEntries);
    const secondSegment = {
        segmentId: "second",
        runwieldSessionId: session.runwieldSessionId,
        projectId: "fixture-project",
        piSessionId: "pi-two",
        transcriptPath: second.path,
        transcriptCwd: root,
        ordinal: 1,
        kind: "execution",
        sealedAt: null,
        sealedByteLength: null,
        sealedDigestHex: null,
        sealedTerminalEntryId: null,
    };
    const secondEvidence = await captureTranscriptEvidence({ transcriptPath: second.path, transcriptCwd: root });
    const generation = {
        generation: 1,
        byteLength: secondEvidence.byteLength,
        terminalEntryId: secondEvidence.terminalEntryId,
        digestHex: secondEvidence.digestHex,
        currentSegmentId: secondSegment.segmentId,
    };
    return { dir, root, session, firstSegment, firstEvidence, first, second, secondSegment, generation };
}

type TwoSegmentFixture = Awaited<ReturnType<typeof createTwoSegmentFixture>>;

async function cleanupFixture(fixture: TwoSegmentFixture) {
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
            segments: [fixture.firstSegment, fixture.secondSegment],
        });
        assert(projected.ok);
        assertEquals(
            projected.events.map((event) => event.eventId),
            [
                `${fixture.firstSegment.segmentId}:duplicate:user_message:0`,
                `${fixture.secondSegment.segmentId}:duplicate:assistant_text_delta:0`,
                `${fixture.secondSegment.segmentId}:duplicate:usage:0`,
            ],
        );
        assertEquals(projected.snapshot.name, null);
        assertEquals(projected.snapshot.sessionStats, {
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: 0,
            compactionCount: 0,
        });
        assertEquals(
            projected.events.map((event) => [event.segmentOrdinal, event.segmentKind]),
            [
                [0, "planning"],
                [1, "execution"],
                [1, "execution"],
            ],
        );
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
        assertEquals(
            projected.events.map((event) => event.eventId),
            ["segment-1:first:user_message:0", "segment-2:second:assistant_text_delta:0", "segment-2:second:usage:0"],
        );
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
            segments: [fixture.firstSegment, fixture.secondSegment],
        });
        assert(projected.ok);
        assertEquals(
            projected.events.map((event) => [
                event.type,
                event.eventId,
                event.message || event.delta || "",
                event.agentName || "",
            ]),
            [
                [
                    "assistant_text_delta",
                    `${fixture.firstSegment.segmentId}:guide-reply:assistant_text_delta:0`,
                    "first",
                    "Guide",
                ],
                ["usage", `${fixture.firstSegment.segmentId}:guide-reply:usage:0`, "", ""],
                [
                    "assistant_text_delta",
                    `${fixture.secondSegment.segmentId}:pre-marker-reply:assistant_text_delta:0`,
                    "still guide",
                    "Guide",
                ],
                ["usage", `${fixture.secondSegment.segmentId}:pre-marker-reply:usage:0`, "", ""],
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
                segments: [fixture.firstSegment, fixture.secondSegment],
                cursorEventId:
                    mutate === "missing" ? `${fixture.firstSegment.segmentId}:duplicate:user_message:0` : null,
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
            segments: [fixture.firstSegment, fixture.secondSegment],
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
            segments: [fixture.firstSegment, fixture.secondSegment],
            cursorEventId: "old-client-cursor",
        });
        assert(projected.ok);
        assertEquals(projected.cursorReset, true);
        assertEquals(projected.events.length, 3);
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
            segments: [fixture.firstSegment, fixture.secondSegment],
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
            segments: [fixture.firstSegment, fixture.secondSegment],
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
            segments: [fixture.firstSegment, fixture.secondSegment],
            cursorEventId: `${fixture.firstSegment.segmentId}:duplicate:user_message:0`,
            cursorEventOrdinal: 0,
        });
        assert(projected.ok);
        assertEquals(
            projected.events.map((event) => event.eventId),
            [
                `${fixture.secondSegment.segmentId}:duplicate:assistant_text_delta:0`,
                `${fixture.secondSegment.segmentId}:duplicate:usage:0`,
            ],
        );
    } finally {
        await cleanupFixture(fixture);
    }
});
