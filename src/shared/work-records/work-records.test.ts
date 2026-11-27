import { projects } from "@runwield/projects";
import { workRecordFiles } from "@runwield/plans/work-record-files";
import { readdir, readFile } from "node:fs/promises";
import {
    workRecords,
    type GeneratedWorkRecordSections,
    type WorkRecordFrontMatter,
} from "@runwield/plans/work-records";
import { seedPlan, seedPlanState } from "../testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../testing/retained-plan-fixture.ts";
import { syncEpicChildPlanDeviations, archivePlan } from "../../plan-store/index.ts";
import { loadArchivedPlan, loadPlan } from "../testing/plan-query-fixture.ts";
import { captureForegroundProcess } from "@runwield/resources/process";
import { mkdtemp as fsMkdtemp, rm as fsRm, stat as fsStat, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import {
    buildWorkRecordIndexDocument,
    deleteWorkRecord,
    findWorkRecordById,
    formatHydratedWorkRecord,
    formatWorkRecordList,
    generateWorkRecordForSource,
    getWorkRecordIndexCollectionName,
    isWorkRecordIndexEmpty,
    parseRecorderSections,
    previewWorkRecordBackfill,
    readWorkRecordById,
    rebuildWorkRecordIndex,
    runWorkRecordBackfill,
    searchWorkRecords,
    syncWorkRecordToIndex,
    restoreWorkRecordDocument,
} from "./index.ts";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";
import { type WorkRecordMnemotecaPort } from "./mnemoteca-port.ts";

const INTERNAL_ATTRS: WorkRecordFrontMatter = {
    kind: "work_record",
    recordId: "11111111-1111-4111-8111-111111111111",
    status: "approved",
    scope: "planned_change",
    origin: "internal",
    completionMode: "verified",
    createdAt: "2026-07-14T08:32:00-04:00",
    provenance: { sourcePlans: ["22222222-2222-4222-8222-222222222222"] },
};

const BODY = `# Example Work\n\n## Summary\n\nBuilt the durable store.\n\n## Future Planning Notes\n\nReuse this pattern.`;

/** @param {string} stdout */
function ok(stdout: string) {
    return { success: true, code: 0, stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array() };
}

type MnemotecaCommand = (
    command: string,
    ...args: Parameters<WorkRecordMnemotecaPort["run"]>
) => ReturnType<WorkRecordMnemotecaPort["run"]>;

/** @param {(command: string, args: string[], options?: { cwd?: string }) => Promise<ReturnType<typeof ok>>} commandOutput */
function createCommandMnemotecaPort(commandOutput: MnemotecaCommand): WorkRecordMnemotecaPort {
    return {
        run: (args, options) => commandOutput("mnemoteca", args, options),
    };
}

/**
 * Script only the external Recorder model response. Prompt construction,
 * structured-output parsing, Work Record persistence, and Plan backlinks stay real.
 *
 * @param {GeneratedWorkRecordSections} sections
 */
function recorderResponse(sections: GeneratedWorkRecordSections) {
    return () => Promise.resolve(sections);
}

/** @param {string} cwd */
async function cleanupTempProject(cwd: string) {
    await fsRm(cwd, { recursive: true });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd: string, args: string[]) {
    const result = await captureForegroundProcess("git", {
        args,
        cwd,
    });
    if (result.code !== 0) {
        const decoder = new TextDecoder();
        throw new Error(
            `git ${args.join(" ")} failed: ${decoder.decode(result.stderr) || decoder.decode(result.stdout)}`,
        );
    }
    return new TextDecoder().decode(result.stdout).trim();
}

test("Work Record store writes flat files and resolves by recordId", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const written = await restoreWorkRecordDocument(cwd, INTERNAL_ATTRS, BODY, {
            fileName: "2026-07-14-example.md",
        });
        assertEquals(written.relativePath, "work-records/2026-07-14-example.md");
        const found = await findWorkRecordById(cwd, INTERNAL_ATTRS.recordId.toUpperCase());
        assertEquals(found?.title, "Example Work");
        await assertRejects(
            () => restoreWorkRecordDocument(cwd, INTERNAL_ATTRS, BODY, { fileName: "../escape.md" }),
            Error,
            "flat Markdown filename",
        );
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record create collision preserves the old record and uses a deterministic identity path", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const fileName = "2026-07-14-example.md";
        const oldRecord = await restoreWorkRecordDocument(cwd, INTERNAL_ATTRS, BODY, { fileName });
        const newAttrs = { ...INTERNAL_ATTRS, recordId: "33333333-3333-4333-8333-333333333333" };
        const newRecord = await restoreWorkRecordDocument(cwd, newAttrs, BODY.replaceAll("Example", "Replacement"), {
            fileName,
        });

        assertEquals((await findWorkRecordById(cwd, INTERNAL_ATTRS.recordId))?.markdown, oldRecord.markdown);
        assertEquals(newRecord.relativePath, "work-records/2026-07-14-example-33333333-3333-4333-8333-333333333333.md");
        await assertRejects(
            () => restoreWorkRecordDocument(cwd, newAttrs, BODY.replaceAll("Example", "Third"), { fileName }),
            Error,
            "No file was overwritten",
        );
        assertEquals((await findWorkRecordById(cwd, newAttrs.recordId))?.markdown, newRecord.markdown);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record documentation Work Kind normalizes and displays", () => {
    const record = workRecords.documents.parse(
        workRecords.documents.format(
            {
                ...INTERNAL_ATTRS,
                workKind: "DOCUMENTATION",
            },
            BODY,
        ),
        { relativePath: "docs/work-records/documentation.md" },
    );

    assertEquals(record.attrs.workKind, "DOCUMENTATION");
    assertEquals(formatHydratedWorkRecord(record).workKind, "DOCUMENTATION");
    assertStringIncludes(formatWorkRecordList([record]), "Planned documentation");
});

test("Recorder structured output parses JSON and rejects empty sections", () => {
    assertEquals(parseRecorderSections('{"title":"Outcome","summary":"Completed."}'), {
        title: "Outcome",
        summary: "Completed.",
    });
    assertThrows(() => parseRecorderSections('{"title":"Outcome","summary":""}'), Error, "non-empty summary");
    assertThrows(
        () =>
            parseRecorderSections(
                '{"title":"Outcome","summary":"Done.","supersessionProposals":[{"recordId":"not-a-uuid","reason":"Replace it."}]}',
            ),
        Error,
        "valid UUID",
    );
    assertThrows(
        () =>
            parseRecorderSections(
                '{"title":"Outcome","summary":"Done.","supersessionProposals":[{"recordId":"11111111-1111-4111-8111-111111111111","reason":"   "}]}',
            ),
        Error,
        "non-blank",
    );
    assertThrows(
        () =>
            parseRecorderSections(
                '{"title":"Outcome","summary":"Done.","supersessionProposals":[{"recordId":"11111111-1111-4111-8111-111111111111","reason":"Valid."},{"recordId":"11111111-1111-4111-8111-111111111111","reason":" "}]}',
            ),
        Error,
        "non-blank",
    );
});

test("Work Record backfill previews eligible sources, child skips, and existing record links", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "standalone", "# Standalone\n\n## Plan\n\nBody", {
            planId: "plan-standalone",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Built standalone feature.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        await seedPlan(cwd, "already-recorded", "# Already\n\n## Plan\n\nBody", {
            planId: "plan-existing",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Existing record.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        await seedPlan(cwd, "epic", "# Epic\n\n## Plan\n\nBody", {
            planId: "plan-epic",
            classification: "PROJECT",
            complexity: "MEDIUM",
            summary: "Epic complete enough.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
            epicCompletionMode: "done_enough",
        });
        await seedPlan(cwd, "epic/01-child", "# Child\n\n## Plan\n\nBody", {
            planId: "plan-child",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Child feature.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
            parentPlan: "epic",
            order: 1,
        });
        await restoreWorkRecordDocument(
            cwd,
            {
                ...INTERNAL_ATTRS,
                recordId: "33333333-3333-4333-8333-333333333333",
                provenance: { sourcePlans: ["plan-existing"] },
            },
            "# Already\n\n## Summary\n\nAlready generated.",
            { fileName: "2026-07-14-already.md" },
        );

        const preview = await previewWorkRecordBackfill(cwd);

        assertEquals(preview.eligible.map((source) => source.name).sort(), ["already-recorded", "epic", "standalone"]);
        assertEquals(
            preview.eligible.find((source) => source.name === "already-recorded")?.existingRecord?.attrs.recordId,
            "33333333-3333-4333-8333-333333333333",
        );
        assertEquals(
            preview.eligible.find((source) => source.name === "epic")?.children?.map((child) => child.name),
            ["epic/01-child"],
        );
        assertEquals(preview.skipped.find((source) => source.name === "epic/01-child")?.skipReason, "child_feature");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation writes a record and active Plan backlink", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "standalone", "# Standalone\n\n## Plan\n\nBody", {
            planId: "plan-standalone",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Built standalone feature.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        const preview = await previewWorkRecordBackfill(cwd);
        let requestedId: string | undefined;
        const outcome = await generateWorkRecordForSource(cwd, preview.eligible[0], {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: (prompt) => {
                const request: { successorRecordId: string } = JSON.parse(prompt);
                requestedId = request.successorRecordId;
                return Promise.resolve({
                    title: "Standalone Outcome",
                    summary: "Completed the standalone feature.",
                    futurePlanningNotes: "Reuse this seam.",
                });
            },
        });

        assertEquals(outcome.status, "generated");
        assertEquals(outcome.recordId, requestedId);
        const record = await findWorkRecordById(cwd, outcome.recordId!);
        assertEquals(record?.attrs.provenance?.sourcePlans, ["plan-standalone"]);
        const plan = await loadPlan(cwd, "standalone");
        assertEquals(plan?.attrs.workRecord?.recordId, outcome.recordId);
        assertEquals(plan?.attrs.status, "verified");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("backfill reconciles the checkpointed identity when another record cites the same Plan", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const planId = "recording-checkpoint-plan";
        const planName = "recording-checkpoint";
        const recordId = "43214321-4321-4321-8321-432143214321";
        await seedPlan(cwd, planName, "# Recorder checkpoint", {
            planId,
            classification: "PLANNED_CHANGE",
            status: "verified",
        });
        const plan = (await loadPlan(cwd, planName))!;
        await seedPlanState(
            cwd,
            planName,
            {
                validationCheckpoint: {
                    version: 1,
                    attemptId: "attempt",
                    generation: "generation",
                    expectedStatus: "verified",
                    nextPhase: "delivery",
                    state: "ready",
                    updatedAt: "2026-07-16T00:00:00.000Z",
                    hostRecorder: {
                        recordId,
                        invalidSubmissions: 0,
                        request: {
                            kind: "recorder",
                            identity: { attemptId: "attempt", generation: "generation" },
                            prompt: "Record the outcome.",
                            cwd,
                        },
                    },
                },
            },
            plan.attrs,
            { expectedRevision: plan.revision },
        );
        const attrs = { ...INTERNAL_ATTRS, provenance: { sourcePlans: [planId] } };
        await restoreWorkRecordDocument(cwd, attrs, BODY, { fileName: "a-other.md" });
        await restoreWorkRecordDocument(cwd, { ...attrs, recordId }, BODY, { fileName: "z-checkpointed.md" });

        assertEquals((await loadPlan(cwd, planName))?.attrs.validationCheckpoint?.hostRecorder?.recordId, recordId);
        const result = await runWorkRecordBackfill(cwd, {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            runRecorderStep: () => Promise.reject(new Error("A persisted matching record needs no Recorder turn.")),
        });
        assertEquals(result.outcomes[0]?.status, "linked");
        assertEquals(result.outcomes[0]?.recordId, recordId);
        assertEquals((await loadPlan(cwd, planName))?.attrs.workRecord?.recordId, recordId);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("generation discards a previewed Work Record that was deleted before recording", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const planId = "stale-preview-plan";
        await seedPlan(cwd, "stale-preview", "# Stale preview", {
            planId,
            classification: "PLANNED_CHANGE",
            status: "verified",
        });
        const removed = await restoreWorkRecordDocument(
            cwd,
            { ...INTERNAL_ATTRS, provenance: { sourcePlans: [planId] } },
            BODY,
        );
        const source = (await previewWorkRecordBackfill(cwd)).eligible[0];
        assertEquals(source.existingRecord?.attrs.recordId, removed.attrs.recordId);
        await deleteWorkRecord(cwd, removed);

        const outcome = await generateWorkRecordForSource(cwd, source, {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            runRecorderStep: recorderResponse({ title: "New result", summary: "Completed the plan." }),
        });
        assertEquals(outcome.status, "generated");
        assertEquals(outcome.source.existingRecord, undefined);
        assertEquals(await findWorkRecordById(cwd, removed.attrs.recordId), null);
        assertEquals((await loadPlan(cwd, source.name))?.attrs.workRecord?.recordId, outcome.recordId);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("backfill retries an interrupted Recorder turn with the original store reservation", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const planId = "interrupted-recording-plan";
        await seedPlan(cwd, "interrupted-recording", "# Interrupted recording", {
            planId,
            classification: "PLANNED_CHANGE",
            status: "verified",
        });
        const requestedIds: string[] = [];
        const mnemotecaPort = createWorkRecordMnemotecaFixture();
        const admitted = projects.checkout.inspect(cwd);
        if (admitted.kind !== "existing") throw new Error("Expected an admitted Project.");
        const internal = workRecordFiles.forOwner(admitted.identity).layout.internal;
        let persistedId = "";
        const first = await runWorkRecordBackfill(cwd, {
            mnemotecaPort,
            runRecorderStep: async (prompt) => {
                const request: { successorRecordId: string } = JSON.parse(prompt);
                requestedIds.push(request.successorRecordId);
                const files = await readdir(internal, { recursive: true });
                const receipts = files.filter(
                    (file) => file.endsWith(".json") && file.split(/[\\/]/).includes("recording-creations"),
                );
                assertEquals(receipts.length, 1);
                const receipt: { recordId: string } = JSON.parse(await readFile(join(internal, receipts[0]), "utf8"));
                persistedId = receipt.recordId;
                throw new Error("Recorder stopped before its first write.");
            },
        });
        assertEquals(first.outcomes[0]?.status, "failed");
        assertEquals(requestedIds.length, 1);
        assertEquals(await findWorkRecordById(cwd, requestedIds[0]), null);
        await restoreWorkRecordDocument(cwd, { ...INTERNAL_ATTRS, provenance: { sourcePlans: [planId] } }, BODY);

        const retry = await runWorkRecordBackfill(cwd, {
            mnemotecaPort,
            runRecorderStep: (prompt) => {
                const request: { successorRecordId: string } = JSON.parse(prompt);
                requestedIds.push(request.successorRecordId);
                return Promise.resolve({ title: "Recovered result", summary: "Completed the plan." });
            },
        });
        assertEquals(persistedId, requestedIds[0]);
        assertEquals(requestedIds, [requestedIds[0], requestedIds[0]]);
        assertEquals(retry.outcomes[0]?.status, "generated");
        assertEquals(retry.outcomes[0]?.recordId, requestedIds[0]);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation always includes confirmed Plan Deviations", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "deviated", "# Deviated\n\n## Plan\n\nReplace nav.", {
            planId: "plan-deviated",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Built deviated feature.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
            planDeviations: [
                {
                    id: "call-1",
                    supersededRequirement: "Replace nav.",
                    replacementRequirement: "Keep current nav.",
                    reason: "The user chose continuity.",
                    approvedAt: "2026-09-10T00:00:00.000Z",
                },
            ],
        });
        const preview = await previewWorkRecordBackfill(cwd);
        const outcome = await generateWorkRecordForSource(cwd, preview.eligible[0], {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({
                title: "Deviated Outcome",
                summary: "Completed with the confirmed user direction.",
            }),
        });

        assertEquals(outcome.status, "generated");
        const record = await findWorkRecordById(cwd, outcome.recordId!);
        assertStringIncludes(record?.body || "", "## Deviations from Plan");
        assertStringIncludes(record?.sections["Deviations from Plan"] || "", "Superseded requirement: Replace nav.");
        assertStringIncludes(
            record?.sections["Deviations from Plan"] || "",
            "Replacement requirement: Keep current nav.",
        );
        assertStringIncludes(record?.sections["Deviations from Plan"] || "", "Reason: The user chose continuity.");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation includes confirmed child Plan Deviations in Epic records", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "epic", "# Epic\n\n## Plan\n\nParent body.", {
            planId: "plan-epic-deviated",
            classification: "PROJECT",
            complexity: "MEDIUM",
            summary: "Epic with child deviation.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
            epicCompletionMode: "done_enough",
        });
        await seedPlan(cwd, "epic/01-child", "# Child\n\n## Plan\n\nReplace nav.", {
            planId: "plan-child-deviated",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Child feature.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
            parentPlan: "epic",
            order: 1,
            planDeviations: [
                {
                    id: "call-child",
                    supersededRequirement: "Replace child nav.",
                    replacementRequirement: "Keep child nav.",
                    approvedAt: "2026-09-10T00:00:00.000Z",
                },
            ],
        });
        await syncEpicChildPlanDeviations(cwd, "epic/01-child");
        const source = (await previewWorkRecordBackfill(cwd)).eligible.find((candidate) => candidate.name === "epic");
        if (!source) throw new Error("Expected Epic source.");

        const outcome = await generateWorkRecordForSource(cwd, source, {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({ title: "Epic Outcome", summary: "Completed the Epic." }),
        });

        assertEquals(outcome.status, "generated");
        const record = await findWorkRecordById(cwd, outcome.recordId!);
        assertEquals(
            (record?.sections["Deviations from Plan"] || "").split("Replacement requirement: Keep child nav.").length,
            2,
        );
        assertStringIncludes(
            record?.sections["Deviations from Plan"] || "",
            "Superseded requirement: Replace child nav.",
        );
        assertStringIncludes(
            record?.sections["Deviations from Plan"] || "",
            "Replacement requirement: Keep child nav.",
        );
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation rejects missing and self Recorder proposals before successor write", async () => {
    const cases = [
        {
            name: "missing-proposal",
            candidateId: "55555555-5555-4555-8555-555555555555",
            error: "was not found",
        },
        {
            name: "self-proposal",
            error: "cannot target the successor",
        },
    ];
    for (const testCase of cases) {
        const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        try {
            await seedPlan(cwd, testCase.name, `# ${testCase.name}\n\n## Plan\n\nBody`, {
                planId: `plan-${testCase.name}`,
                classification: "PLANNED_CHANGE",
                complexity: "LOW",
                summary: "Proposal validation fixture.",
                affectedPaths: [],
                createdAt: "2026-07-14T00:00:00.000Z",
                status: "verified",
            });
            const source = (await previewWorkRecordBackfill(cwd)).eligible[0];
            let successorId = "";
            const outcome = await generateWorkRecordForSource(cwd, source, {
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
                runRecorderStep: (prompt) => {
                    const request: { successorRecordId: string } = JSON.parse(prompt);
                    successorId = request.successorRecordId;
                    return Promise.resolve({
                        title: "Invalid Proposal Outcome",
                        summary: "Must not be written.",
                        supersessionProposals: [
                            { recordId: testCase.candidateId ?? successorId, reason: "Material correction." },
                        ],
                    });
                },
            });

            assertEquals(outcome.status, "failed");
            assertStringIncludes(outcome.error || "", testCase.error);
            assertEquals(await findWorkRecordById(cwd, successorId), null);
        } finally {
            await cleanupTempProject(cwd);
        }
    }
});

test("Work Record generation preserves canonical state when the external index is unavailable", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "index-unavailable", "# Index Unavailable\n\n## Plan\n\nBody", {
            planId: "plan-index-unavailable",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Built while the derived index was unavailable.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        const source = (await previewWorkRecordBackfill(cwd)).eligible[0];
        const outcome = await generateWorkRecordForSource(cwd, source, {
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({
                title: "Index Unavailable Outcome",
                summary: "The canonical Work Record still exists.",
            }),
            mnemotecaPort: {
                run: () =>
                    Promise.resolve({
                        success: false,
                        code: 1,
                        stdout: new Uint8Array(),
                        stderr: new TextEncoder().encode("fixture index unavailable"),
                    }),
            },
        });

        assertEquals(outcome.status, "generated");
        if (!("indexWarning" in outcome)) throw new Error("Expected an index warning");
        assertStringIncludes(outcome.indexWarning || "", "fixture index unavailable");
        assertEquals((await findWorkRecordById(cwd, outcome.recordId!))?.attrs.recordId, outcome.recordId);
        assertEquals((await loadPlan(cwd, "index-unavailable"))?.attrs.workRecord?.recordId, outcome.recordId);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation distills the task completion report into the summary", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const executionReport = "- Implemented the settings save action.\n- Verification passed: deno task ci.";
        await seedPlan(cwd, "reported", "# Reported\n\n## Plan\n\nBody", {
            planId: "plan-reported",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Built reported feature.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
            executionReport,
        });
        const preview = await previewWorkRecordBackfill(cwd);
        const outcome = await generateWorkRecordForSource(cwd, preview.eligible[0], {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({
                title: "Reported Outcome",
                summary: `Completed with evidence: ${executionReport}`,
            }),
        });

        assertEquals(outcome.status, "generated");
        const record = await findWorkRecordById(cwd, outcome.recordId!);
        assertStringIncludes(record?.summary || "", "Completed with evidence");
        assertStringIncludes(record?.summary || "", "Implemented the settings save action.");
        assertStringIncludes(record?.summary || "", "Verification passed: deno task ci.");
        assertEquals(record?.sections["Execution Report"], undefined);
        assertEquals(record?.body.includes("## Execution Report"), false);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation includes deterministic Plan record requirements", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const required = "The generated Work Record must include the approved delivery decision.";
        await seedPlan(cwd, "required-note", `# Required note\n\n## Work Record Requirements\n\n${required}\n`, {
            planId: "plan-required-note",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Built the requested feature.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        const preview = await previewWorkRecordBackfill(cwd);
        const outcome = await generateWorkRecordForSource(cwd, preview.eligible[0], {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({ title: "Required Outcome", summary: "Completed." }),
        });

        assertEquals(outcome.status, "generated");
        const record = await findWorkRecordById(cwd, outcome.recordId!);
        assertEquals(record?.sections["Required Record Notes"], required);
        assertStringIncludes(record?.markdown || "", required);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation discloses skipped verification reason fallback", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "closed", "# Closed\n\n## Plan\n\nBody", {
            planId: "plan-closed",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Closed work.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "closed_without_verification",
        });
        const result = await runWorkRecordBackfill(cwd, {
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({ title: "Closed", summary: "Implemented and accepted manually." }),
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.outcomes[0].status, "generated");
        const record = await findWorkRecordById(cwd, result.outcomes[0].recordId!);
        assertStringIncludes(record?.summary || "", "RunWield Workflow Validation was skipped");
        assertStringIncludes(record?.summary || "", "Reason not specified.");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation preserves User Verification attribution and note", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "user-verified", "# User Verified\n\n## Plan\n\nBody", {
            planId: "plan-user-verified",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "User accepted work.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "user_verified",
            userVerifiedAt: "2026-07-15T00:00:00.000Z",
            userVerificationNote: "Checked in staging with Alice.",
        });
        const result = await runWorkRecordBackfill(cwd, {
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({ title: "User Verified", summary: "Implemented feature." }),
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.outcomes[0].status, "generated");
        const record = await findWorkRecordById(cwd, result.outcomes[0].recordId!);
        assertEquals(record?.attrs.completionMode, "user_verified");
        assertStringIncludes(record?.summary || "", "The user attested verification");
        assertStringIncludes(record?.summary || "", "Checked in staging with Alice.");
        assertEquals(
            formatHydratedWorkRecord(record!).notices.includes(
                "NOTICE: verification was attested by the user, not RunWield Workflow Validation.",
            ),
            true,
        );
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record backfill updates archived Plan backlinks", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "archived-source", "# Archived Source\n\n## Plan\n\nBody", {
            planId: "plan-archived",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Archived completed feature.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        await archivePlan(cwd, "archived-source", { now: "2026-07-15T00:00:00.000Z" });
        const result = await runWorkRecordBackfill(cwd, {
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({ title: "Archived Source", summary: "Archived completed feature." }),
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.outcomes[0].status, "generated");
        const archived = await loadArchivedPlan(cwd, "archived-source");
        assertEquals(archived?.attrs.workRecord?.recordId, result.outcomes[0].recordId);
        assertEquals(archived?.attrs.archivedAt, "2026-07-15T00:00:00.000Z");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record backfill retries failed Plan backlinks", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "retry", "# Retry\n\n## Plan\n\nBody", {
            planId: "plan-retry",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Retry failed Work Record generation.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
            workRecord: {
                status: "failed",
                lastAttemptAt: "2026-07-15T00:00:00.000Z",
                error: "Recorder exploded",
            },
        });

        const preview = await previewWorkRecordBackfill(cwd);
        assertEquals(
            preview.eligible.map((source) => source.name),
            ["retry"],
        );
        const result = await runWorkRecordBackfill(cwd, {
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({ title: "Retry Outcome", summary: "Retry succeeded." }),
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.outcomes[0].status, "generated");
        const plan = await loadPlan(cwd, "retry");
        assertEquals(plan?.attrs.workRecord?.status, "generated");
        assertEquals(plan?.attrs.workRecord?.recordId, result.outcomes[0].recordId);
        assertEquals(plan?.attrs.workRecord?.error, undefined);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation rejects empty structured sections and records failure backlink", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "empty", "# Empty\n\n## Plan\n\nBody", {
            planId: "plan-empty",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Empty output.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        const preview = await previewWorkRecordBackfill(cwd);
        const outcome = await generateWorkRecordForSource(cwd, preview.eligible[0], {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({ title: "", summary: "" }),
        });

        assertEquals(outcome.status, "failed");
        const plan = await loadPlan(cwd, "empty");
        assertEquals(plan?.attrs.status, "verified");
        assertEquals(plan?.attrs.workRecord?.status, "failed");
        assertStringIncludes(plan?.attrs.workRecord?.error || "", "non-empty title");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation records failure backlink without changing terminal status", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "bad", "# Bad\n\n## Plan\n\nBody", {
            planId: "plan-bad",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Bad generated output.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        const preview = await previewWorkRecordBackfill(cwd);
        const outcome = await generateWorkRecordForSource(cwd, preview.eligible[0], {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: () => Promise.reject(new Error("Recorder exploded")),
        });

        assertEquals(outcome.status, "failed");
        const plan = await loadPlan(cwd, "bad");
        assertEquals(plan?.attrs.status, "verified");
        assertEquals(plan?.attrs.workRecord?.status, "failed");
        assertStringIncludes(plan?.attrs.workRecord?.error || "", "Recorder exploded");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record backfill preview does not create docs/work-records", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "standalone", "# Standalone\n\n## Plan\n\nBody", {
            planId: "plan-dry-run",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Dry-run source.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });

        const preview = await previewWorkRecordBackfill(cwd);

        assertEquals(preview.eligible.length, 1);
        await assertRejects(() => fsStat(`${cwd}/docs/work-records`), Error, "ENOENT");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record backfill ignores non-linkable existing records and generates approved internal record", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "standalone", "# Standalone\n\n## Plan\n\nBody", {
            planId: "plan-needs-approved",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
            summary: "Needs approved internal record.",
            affectedPaths: [],
            createdAt: "2026-07-14T00:00:00.000Z",
            status: "verified",
        });
        await restoreWorkRecordDocument(
            cwd,
            {
                ...INTERNAL_ATTRS,
                recordId: "99999999-9999-4999-8999-999999999999",
                status: "draft",
                origin: "external",
                provenance: { sourcePlans: ["plan-needs-approved"] },
            },
            "# Draft External\n\n## Summary\n\nNot approved internal history.",
            { fileName: "2026-07-14-draft-external.md" },
        );

        const preview = await previewWorkRecordBackfill(cwd);
        assertEquals(preview.eligible[0].existingRecord, undefined);
        const result = await runWorkRecordBackfill(cwd, {
            now: () => new Date("2026-07-16T00:00:00.000Z"),
            runRecorderStep: recorderResponse({
                title: "Approved Internal",
                summary: "Generated approved internal record.",
            }),
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertEquals(result.outcomes[0].status, "generated");
        const plan = await loadPlan(cwd, "standalone");
        assertEquals(plan?.attrs.workRecord?.recordId, result.outcomes[0].recordId);
        const generated = await findWorkRecordById(cwd, result.outcomes[0].recordId!);
        assertEquals(generated?.attrs.status, "approved");
        assertEquals(generated?.attrs.origin, "internal");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record index emptiness ignores Mnemoteca plain-list footer", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "work-record-index-project-"));
    try {
        assertEquals(
            await isWorkRecordIndexEmpty(cwd, {
                mnemotecaPort: createCommandMnemotecaPort(
                    (/** @type {string} */ _command, /** @type {string[]} */ args) => {
                        assertEquals(args[0], "list");
                        return Promise.resolve(
                            ok("[42] indexed\n\nShowing 1 of 90 documents. Use --limit to see more."),
                        );
                    },
                ),
            }),
            false,
        );
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record index collection name is stable across linked git worktrees", async () => {
    const primary = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const worktreeParent = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const worktree = `${worktreeParent}/linked-worktree`;
    try {
        await git(primary, ["init"]);
        await git(primary, ["config", "user.email", "test@example.com"]);
        await git(primary, ["config", "user.name", "Test User"]);
        await fsWriteFile(`${primary}/README.md`, "# Test\n");
        await git(primary, ["add", "README.md"]);
        await git(primary, ["commit", "-m", "init"]);
        await git(primary, ["worktree", "add", worktree, "HEAD"]);

        assertEquals(await getWorkRecordIndexCollectionName(worktree), await getWorkRecordIndexCollectionName(primary));
    } finally {
        await fsRm(worktreeParent, { recursive: true }).catch(() => {});
        await fsRm(primary, { recursive: true }).catch(() => {});
    }
});

test("Work Record index sync adds absent records and strictly updates existing records", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "work-record-index-project-"));
    try {
        const record = workRecords.documents.parse(workRecords.documents.format(INTERNAL_ATTRS, BODY), {
            relativePath: "docs/work-records/example.md",
        });
        /** @type {string[][]} */
        const calls: string[][] = [];
        let listCalls = 0;
        const commandOutput: MnemotecaCommand = (/** @type {string} */ _command, /** @type {string[]} */ args) => {
            calls.push(args);
            if (args[0] === "update" && args[1] === "--help") {
                return Promise.resolve(ok("Usage: mnemoteca update <id> [text] --replace-tags"));
            }
            if (args[0] === "init") return Promise.resolve(ok(""));
            if (args[0] === "list") {
                listCalls += 1;
                return Promise.resolve(ok(listCalls === 1 ? "" : "[42] 2026-07-19 - old"));
            }
            if (args[0] === "add" || args[0] === "update") return Promise.resolve(ok(""));
            throw new Error(`unexpected ${args.join(" ")}`);
        };

        const mnemotecaPort = createCommandMnemotecaPort(commandOutput);
        await syncWorkRecordToIndex(cwd, record, { mnemotecaPort });
        await syncWorkRecordToIndex(cwd, record, { mnemotecaPort });

        assertEquals(
            calls.some((args) => args[0] === "add" && args.includes(`work-record:${INTERNAL_ATTRS.recordId}`)),
            true,
        );
        const updateCall = calls.find((args) => args[0] === "update" && args[1] !== "--help");
        assertEquals(updateCall?.[1], "42");
        assertEquals(updateCall?.includes("--replace-tags"), true);
        assertEquals(updateCall?.includes(`work-record:${INTERNAL_ATTRS.recordId}`), true);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record index sync rejects duplicate locator matches with rebuild guidance", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "work-record-index-project-"));
    try {
        const record = workRecords.documents.parse(workRecords.documents.format(INTERNAL_ATTRS, BODY), {
            relativePath: "docs/work-records/example.md",
        });
        await assertRejects(
            () =>
                syncWorkRecordToIndex(cwd, record, {
                    mnemotecaPort: createCommandMnemotecaPort(
                        (/** @type {string} */ _command, /** @type {string[]} */ args) => {
                            if (args[0] === "update" && args[1] === "--help") {
                                return Promise.resolve(ok("Usage: mnemoteca update <id> [text] --replace-tags"));
                            }
                            if (args[0] === "init") return Promise.resolve(ok(""));
                            if (args[0] === "list") return Promise.resolve(ok("[1] old\n[2] duplicate"));
                            return Promise.resolve(ok(""));
                        },
                    ),
                }),
            Error,
            "wld wr index rebuild",
        );
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record search rejects duplicate indexed locator candidates", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await restoreWorkRecordDocument(cwd, INTERNAL_ATTRS, BODY, { fileName: "2026-07-14-example.md" });
        await assertRejects(
            () =>
                searchWorkRecords(cwd, "durable", {
                    mnemotecaPort: createCommandMnemotecaPort((_command, args) => {
                        if (args[0] === "list") return Promise.resolve(ok("[1] indexed"));
                        if (args[0] === "search") {
                            return Promise.resolve(
                                ok(
                                    JSON.stringify({
                                        results: [
                                            {
                                                document_id: 1,
                                                metadata: { tags: [`work-record:${INTERNAL_ATTRS.recordId}`] },
                                            },
                                            {
                                                document_id: 2,
                                                metadata: { tags: [`work-record:${INTERNAL_ATTRS.recordId}`] },
                                            },
                                        ],
                                    }),
                                ),
                            );
                        }
                        return Promise.resolve(ok(""));
                    }),
                }),
            Error,
            "wld wr index rebuild",
        );
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record search hydrates indexed candidates from a single canonical scan", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const first = await restoreWorkRecordDocument(cwd, INTERNAL_ATTRS, BODY, { fileName: "2026-07-14-example.md" });
        const second = await restoreWorkRecordDocument(
            cwd,
            {
                ...INTERNAL_ATTRS,
                recordId: "33333333-3333-4333-8333-333333333333",
                createdAt: "2026-07-15T08:32:00-04:00",
            },
            BODY.replace("Example", "Second"),
            { fileName: "2026-07-15-second.md" },
        );
        const third = await restoreWorkRecordDocument(
            cwd,
            {
                ...INTERNAL_ATTRS,
                recordId: "44444444-4444-4444-8444-444444444444",
                createdAt: "2026-07-16T08:32:00-04:00",
            },
            BODY.replace("Example", "Third"),
            { fileName: "2026-07-16-third.md" },
        );

        const result = await searchWorkRecords(cwd, "durable", {
            mnemotecaPort: createCommandMnemotecaPort(
                async (/** @type {string} */ _command, /** @type {string[]} */ args) => {
                    if (args[0] === "list") return Promise.resolve(ok("[1] indexed"));
                    if (args[0] === "search") {
                        // Once the external search begins, remove its canonical
                        // source. Hydration must use the one completed scan.
                        await fsRm(dirname(first.path), { recursive: true });
                        return Promise.resolve(
                            ok(
                                JSON.stringify({
                                    results: [first, second, third].map((record, index) => ({
                                        document_id: index + 1,
                                        metadata: { tags: [`work-record:${record.attrs.recordId}`] },
                                    })),
                                }),
                            ),
                        );
                    }
                    return Promise.resolve(ok(""));
                },
            ),
        });

        assertEquals(
            result.records.map((record) => record.recordId),
            [first, second, third].map((record) => record.attrs.recordId),
        );
        assertEquals(result.staleRecordIds, []);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record search bootstraps empty index, filters current records, and omits body from results", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const currentRecord = await restoreWorkRecordDocument(cwd, INTERNAL_ATTRS, BODY, {
            fileName: "2026-07-14-example.md",
        });
        const draftAttrs: WorkRecordFrontMatter = {
            ...INTERNAL_ATTRS,
            recordId: "33333333-3333-4333-8333-333333333333",
            status: "draft",
        };
        const draftRecord = await restoreWorkRecordDocument(cwd, draftAttrs, BODY.replace("Example", "Draft"), {
            fileName: "2026-07-15-draft.md",
        });
        const calls: string[][] = [];
        const commandOutput: MnemotecaCommand = (_command, args) => {
            calls.push(args);
            if (args[0] === "update" && args[1] === "--help") {
                return Promise.resolve(ok("Usage: mnemoteca update <id> [text] --replace-tags"));
            }
            if (args[0] === "list") return Promise.resolve(ok(""));
            if (["forget", "init", "add"].includes(args[0])) return Promise.resolve(ok(""));
            if (args[0] === "search") {
                return Promise.resolve(
                    ok(
                        JSON.stringify({
                            results: [
                                { document_id: 1, metadata: { tags: [`work-record:${currentRecord.attrs.recordId}`] } },
                                { document_id: 2, metadata: { tags: [`work-record:${draftRecord.attrs.recordId}`] } },
                            ],
                        }),
                    ),
                );
            }
            return Promise.resolve(ok(""));
        };

        const result = await searchWorkRecords(cwd, "durable", {
            mnemotecaPort: createCommandMnemotecaPort(commandOutput),
        });

        assertEquals(result.bootstrapped, true);
        assertEquals(
            calls.some((args) => args[0] === "add"),
            true,
        );
        assertEquals(
            result.records.map((record) => record.recordId),
            [currentRecord.attrs.recordId],
        );
        assertEquals(Object.hasOwn(result.records[0], "record"), false);
        assertEquals(Object.hasOwn(formatHydratedWorkRecord(currentRecord), "body"), false);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record read current-only rejects non-current body while all mode returns it", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const draftAttrs: WorkRecordFrontMatter = {
            ...INTERNAL_ATTRS,
            recordId: "44444444-4444-4444-8444-444444444444",
            status: "draft",
        };
        const draft = await restoreWorkRecordDocument(cwd, draftAttrs, BODY, {
            fileName: "2026-07-15-draft.md",
        });
        await assertRejects(
            () => readWorkRecordById(cwd, draft.attrs.recordId, { accessMode: "current" }),
            Error,
            "current-only mode",
        );
        const result = await readWorkRecordById(cwd, draft.attrs.recordId, { accessMode: "all" });
        assertStringIncludes(result.body, "## Summary");
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record index rebuild forgets only the dedicated collection and reports partial failures", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await restoreWorkRecordDocument(cwd, INTERNAL_ATTRS, BODY, { fileName: "2026-07-14-example.md" });
        const mnemotecaPort = createWorkRecordMnemotecaFixture();

        const result = await rebuildWorkRecordIndex(cwd, { mnemotecaPort });
        const collection = await getWorkRecordIndexCollectionName(cwd);
        const calls = mnemotecaPort.commands();

        assertEquals(
            calls.some((args) => args[0] === "forget" && args.includes(collection)),
            true,
        );
        assertEquals(
            calls.some((args) => args[0] === "forget" && !args.includes(collection)),
            false,
        );
        assertEquals(mnemotecaPort.snapshot().length, 1);
        assertEquals(result.added, 1);
        assertEquals(result.failed, 0);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record index sync rejects locator listing without numeric document ID", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "work-record-index-project-"));
    try {
        const record = workRecords.documents.parse(workRecords.documents.format(INTERNAL_ATTRS, BODY), {
            relativePath: "docs/work-records/example.md",
        });
        /** @type {string[][]} */
        const calls: string[][] = [];
        await assertRejects(
            () =>
                syncWorkRecordToIndex(cwd, record, {
                    mnemotecaPort: createCommandMnemotecaPort(
                        (/** @type {string} */ _command, /** @type {string[]} */ args) => {
                            calls.push(args);
                            if (args[0] === "update" && args[1] === "--help") {
                                return Promise.resolve(ok("Usage: mnemoteca update <id> [text] --replace-tags"));
                            }
                            if (args[0] === "init") return Promise.resolve(ok(""));
                            if (args[0] === "list") return Promise.resolve(ok("work-record row missing numeric id"));
                            if (args[0] === "add") throw new Error("must not add duplicate");
                            return Promise.resolve(ok(""));
                        },
                    ),
                }),
            Error,
            "parseable Mnemoteca numeric document ID",
        );
        assertEquals(
            calls.some((args) => args[0] === "add"),
            false,
        );
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record markdown round-trips Ticket References and index/search surfaces include URLs", () => {
    const markdown = workRecords.documents.format(
        {
            ...INTERNAL_ATTRS,
            tickets: [{ url: " https://example.com/tickets/ABC-123 ", label: "Primary" }],
        },
        "# Ticketed\n\n## Summary\n\nDone.",
    );
    const record = workRecords.documents.parse(markdown);
    assertEquals(record.attrs.tickets, [{ url: "https://example.com/tickets/ABC-123", label: "Primary" }]);
    assertStringIncludes(markdown, 'tickets:\n    - url: "https://example.com/tickets/ABC-123"');
    assertStringIncludes(buildWorkRecordIndexDocument(record), "ticketUrls: https://example.com/tickets/ABC-123");
    assertEquals(formatHydratedWorkRecord(record).tickets, [
        {
            url: "https://example.com/tickets/ABC-123",
            label: "Primary",
        },
    ]);
});

test("Work Record generation preserves child Ticket References when assigning active Epic planId", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await withRetainedPlanFixture(cwd, async () => {
            await seedPlan(cwd, "epic-without-plan-id", "# Epic", {
                classification: "PROJECT",
                status: "verified",
                epicCompletionMode: "done_enough",
                tickets: [{ url: "https://example.com/tickets/EPIC-NO-ID" }],
            });
            await seedPlan(cwd, "epic-without-plan-id/01-child", "# Child", {
                parentPlan: "epic-without-plan-id",
                order: 1,
                status: "verified",
                tickets: [{ url: "https://example.com/tickets/CHILD-NO-ID" }],
            });
            const source = (await previewWorkRecordBackfill(cwd)).eligible.find(
                (candidate) => candidate.name === "epic-without-plan-id",
            );
            if (!source) throw new Error("Expected active Epic source");
            assertEquals(source.planId, "");
            assertEquals(source.children?.length, 1);

            const outcome = await generateWorkRecordForSource(cwd, source, {
                runRecorderStep: recorderResponse({ title: "Epic Without Plan ID", summary: "Done." }),
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
            });

            assertEquals(outcome.status, "generated");
            assertEquals((await findWorkRecordById(cwd, outcome.recordId!))?.attrs.tickets, [
                { url: "https://example.com/tickets/EPIC-NO-ID" },
                { url: "https://example.com/tickets/CHILD-NO-ID" },
            ]);
        });
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("Work Record generation snapshots standalone and Epic Ticket References deterministically", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        await seedPlan(cwd, "standalone", "# Standalone", {
            planId: "plan-standalone",
            status: "verified",
            tickets: [{ url: "https://example.com/tickets/STAND-1", label: "standalone" }],
        });
        const standalone = (await previewWorkRecordBackfill(cwd)).eligible.find(
            (source) => source.name === "standalone",
        );
        if (!standalone) throw new Error("Expected standalone source");
        const standaloneOutcome = await generateWorkRecordForSource(cwd, standalone, {
            runRecorderStep: recorderResponse({ title: "Standalone", summary: "Done." }),
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });
        assertEquals(standaloneOutcome.status, "generated");
        assertEquals((await findWorkRecordById(cwd, standaloneOutcome.recordId!))?.attrs.tickets, [
            { url: "https://example.com/tickets/STAND-1", label: "standalone" },
        ]);

        await seedPlan(cwd, "epic", "# Epic", {
            classification: "PROJECT",
            planId: "plan-epic",
            status: "verified",
            epicCompletionMode: "done_enough",
            tickets: [{ url: "https://example.com/tickets/DUP", label: "epic" }],
        });
        await seedPlan(cwd, "epic/02-child", "# Child 2", {
            planId: "plan-child-2",
            parentPlan: "epic",
            order: 2,
            status: "draft",
            tickets: [{ url: "https://example.com/tickets/CHILD-2" }],
        });
        await seedPlan(cwd, "epic/01-child", "# Child 1", {
            planId: "plan-child-1",
            parentPlan: "epic",
            order: 1,
            status: "verified",
            tickets: [{ url: "https://example.com/tickets/DUP", label: "child" }],
        });
        const epic = (await previewWorkRecordBackfill(cwd)).eligible.find((source) => source.name === "epic");
        if (!epic) throw new Error("Expected Epic source");
        const epicOutcome = await generateWorkRecordForSource(cwd, epic, {
            runRecorderStep: recorderResponse({ title: "Epic", summary: "Done." }),
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });
        assertEquals(epicOutcome.status, "generated");
        assertEquals((await findWorkRecordById(cwd, epicOutcome.recordId!))?.attrs.tickets, [
            { url: "https://example.com/tickets/DUP", label: "epic" },
            { url: "https://example.com/tickets/CHILD-2" },
        ]);
        assertEquals((await loadPlan(cwd, "epic/01-child"))?.attrs.workRecord, undefined);
    } finally {
        await cleanupTempProject(cwd);
    }
});

test("legacy publication notes remain searchable after index rebuild", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    try {
        const body =
            "# Search cache\n\n## Summary\n\nDelivery metadata has been finalized.\n\n## Historical pre-publication notes\n\n> Search now uses a local cache.";
        await restoreWorkRecordDocument(cwd, INTERNAL_ATTRS, body, { fileName: "cache.md" });
        const mnemotecaPort = createWorkRecordMnemotecaFixture();
        const result = await rebuildWorkRecordIndex(cwd, { mnemotecaPort });
        assertEquals(result.failed, 0);
        const records = await searchWorkRecords(cwd, "local cache", { mnemotecaPort });
        assertEquals(records.records.length, 1);
    } finally {
        await cleanupTempProject(cwd);
    }
});
