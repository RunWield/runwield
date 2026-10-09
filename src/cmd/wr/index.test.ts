import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { loadPlan, savePlan } from "../../plan-store.js";
import type { WorkRecordFrontMatter } from "../../shared/work-records/schema.ts";
import { findWorkRecordById, listWorkRecords, writeWorkRecord } from "../../shared/work-records/index.ts";
import { createWorkRecordMnemotecaFixture } from "../../shared/work-records/test-fixtures/mnemoteca-port.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { runWorkRecordsCommand, type WorkRecordCommandOptions } from "./index.ts";

const CURRENT_RECORD_ID = "a1111111-1111-4111-8111-111111111111";
const ARCHIVED_RECORD_ID = "b2222222-2222-4222-8222-222222222222";

function recordAttrs(
    recordId: string,
    sourcePlan: string,
    archivedAt?: string,
): WorkRecordFrontMatter {
    return {
        kind: "work_record",
        recordId,
        status: "approved",
        scope: "planned_change",
        origin: "internal",
        completionMode: "verified",
        createdAt: "2026-07-14T00:00:00.000Z",
        provenance: { sourcePlans: [sourcePlan] },
        ...(archivedAt ? { archivedAt } : {}),
    };
}

async function writeFixtureRecords(projectRoot: string): Promise<void> {
    await writeWorkRecord(
        projectRoot,
        recordAttrs(CURRENT_RECORD_ID, "plan-current"),
        "# Current Record\n\n## Summary\n\nBuilt the durable current machinery.",
        { fileName: "2026-07-14-current.md" },
    );
    await writeWorkRecord(
        projectRoot,
        recordAttrs(ARCHIVED_RECORD_ID, "plan-archived", "2026-07-15T00:00:00.000Z"),
        "# Archived Record\n\n## Summary\n\nPreserved the obsolete zephyr history.",
        { fileName: "2026-07-14-archived.md" },
    );
}

async function writeSupersessionFixture(projectRoot: string): Promise<void> {
    await writeWorkRecord(
        projectRoot,
        recordAttrs(CURRENT_RECORD_ID, "plan-current"),
        "# Current Record\n\n## Summary\n\nOlder implementation.",
        { fileName: "2026-07-14-current.md" },
    );
    await writeWorkRecord(
        projectRoot,
        {
            ...recordAttrs(ARCHIVED_RECORD_ID, "plan-successor"),
            supersessionProposal: {
                candidates: [{ recordId: CURRENT_RECORD_ID, reason: "The newer outcome replaces the old path." }],
            },
        },
        "# Successor Record\n\n## Summary\n\nNewer implementation.",
        { fileName: "2026-07-15-successor.md" },
    );
}

async function saveVerifiedPlan(projectRoot: string): Promise<void> {
    await savePlan(projectRoot, "standalone", "# Standalone\n\n## Plan\n\nBuild the fixture feature.", {
        planId: "plan-standalone",
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        summary: "Built the standalone fixture feature.",
        affectedPaths: [],
        createdAt: "2026-07-14T00:00:00.000Z",
        status: "verified",
    });
}

async function captureCommand(
    argv: string[],
    options: WorkRecordCommandOptions = { mnemotecaPort: createWorkRecordMnemotecaFixture() },
): Promise<string> {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...values) => logs.push(values.map(String).join(" "));
    try {
        await runWorkRecordsCommand(argv, options);
    } finally {
        console.log = originalLog;
    }
    return logs.join("\n");
}

Deno.test("wld wr defaults to current Work Records from the project store", async () => {
    await withRuntimeCommandFixture("wr-list-current-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await writeFixtureRecords(projectRoot);

        const output = await captureCommand([]);

        assertStringIncludes(output, "Current Record");
        assertStringIncludes(output, "completionMode: verified");
        assertStringIncludes(output, "sourcePlans: plan-current");
        assertEquals(output.includes("Archived Record"), false);
    });
});

Deno.test("wld wr list --all includes archived project records with warnings", async () => {
    await withRuntimeCommandFixture("wr-list-all-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await writeFixtureRecords(projectRoot);

        const output = await captureCommand(["list", "--all"]);

        assertStringIncludes(output, "Archived Record");
        assertStringIncludes(output, "WARNING: archived at 2026-07-15T00:00:00.000Z.");
    });
});

Deno.test("wld wr --help uses the registered command documentation", async () => {
    await withRuntimeCommandFixture("wr-help-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);

        const output = await captureCommand(["--help"]);

        assertStringIncludes(output, "wr read <recordId> [--no-open]");
        assertStringIncludes(output, "backfill --dry-run");
    });
});

Deno.test("wld wr backfill --dry-run previews a real completed Plan without writing", async () => {
    await withRuntimeCommandFixture("wr-backfill-preview-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await saveVerifiedPlan(projectRoot);

        const output = await captureCommand(["backfill", "--dry-run"]);

        assertStringIncludes(output, "Work Record backfill preview");
        assertStringIncludes(output, "standalone");
        assertStringIncludes(output, "Dry run only");
        assertEquals(await listWorkRecords(projectRoot), []);
        assertEquals((await loadPlan(projectRoot, "standalone"))?.attrs.workRecord, undefined);
    });
});

Deno.test("wld wr backfill accepts older Result headings without rewriting records", async () => {
    await withRuntimeCommandFixture("wr-backfill-result-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await saveVerifiedPlan(projectRoot);
        await writeFixtureRecords(projectRoot);
        const path = `${projectRoot}/docs/work-records/2026-07-14-current.md`;
        const legacy = (await Deno.readTextFile(path)).replace("## Summary", "## Result");
        await Deno.writeTextFile(path, legacy);
        const output = await captureCommand(["backfill", "--dry-run"]);
        assertStringIncludes(output, "standalone");
        assertStringIncludes(output, "Dry run only");
        assertEquals(await Deno.readTextFile(path), legacy);
    });
});

Deno.test("wld wr backfill names an invalid existing record without crashing or writing", async () => {
    await withRuntimeCommandFixture("wr-backfill-invalid-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await saveVerifiedPlan(projectRoot);
        await writeFixtureRecords(projectRoot);
        const path = `${projectRoot}/docs/work-records/2026-07-14-current.md`;
        const invalid = (await Deno.readTextFile(path)).replace("## Summary", "## Unrelated");
        await Deno.writeTextFile(path, invalid);
        const output = await captureCommand(["backfill", "--yes"]);
        assertStringIncludes(output, "docs/work-records/2026-07-14-current.md");
        assertStringIncludes(output, "Summary");
        assertStringIncludes(output, "No files were changed");
        assertEquals(await Deno.readTextFile(path), invalid);
        assertEquals((await loadPlan(projectRoot, "standalone"))?.attrs.workRecord, undefined);
    });
});

Deno.test("wld wr backfill --yes writes a Work Record and its Plan backlink", async () => {
    await withRuntimeCommandFixture("wr-backfill-write-", async ({ projectRoot, setModelMessages }) => {
        Deno.chdir(projectRoot);
        await saveVerifiedPlan(projectRoot);
        setModelMessages([fauxAssistantMessage(fauxToolCall("work_record_completed", {
            title: "Standalone Outcome",
            summary: "Completed the fixture feature through real Work Record machinery.",
            futurePlanningNotes: "Reuse the verified fixture path.",
        }))]);

        const output = await captureCommand(["backfill", "--yes"], {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });

        assertStringIncludes(output, "Generated standalone");
        const records = await listWorkRecords(projectRoot);
        assertEquals(records.length, 1);
        assertEquals(records[0].attrs.provenance?.sourcePlans, ["plan-standalone"]);
        const backlink = (await loadPlan(projectRoot, "standalone"))?.attrs.workRecord;
        assertEquals(backlink?.recordId, records[0].attrs.recordId);
        assertEquals(await findWorkRecordById(projectRoot, records[0].attrs.recordId), records[0]);
    });
});

Deno.test("wld wr index rebuild and search hydrate canonical project records", async () => {
    await withRuntimeCommandFixture("wr-search-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await writeFixtureRecords(projectRoot);

        const mnemotecaPort = createWorkRecordMnemotecaFixture();
        const options = { mnemotecaPort };
        const rebuildOutput = await captureCommand(["index", "rebuild"], options);
        const currentOutput = await captureCommand(["search", "durable current machinery"], options);
        const hiddenOutput = await captureCommand(["search", "obsolete zephyr history"], options);
        const allOutput = await captureCommand(["search", "obsolete zephyr history", "--all"], options);

        assertStringIncludes(rebuildOutput, "canonical records: 2");
        assertStringIncludes(rebuildOutput, "indexed: 2");
        assertStringIncludes(currentOutput, CURRENT_RECORD_ID);
        assertStringIncludes(currentOutput, "Built the durable current machinery.");
        assertStringIncludes(hiddenOutput, "No matching current Work Records found.");
        assertStringIncludes(allOutput, ARCHIVED_RECORD_ID);
        assertStringIncludes(allOutput, "WARNING: archived at 2026-07-15T00:00:00.000Z.");
    });
});

Deno.test("wld wr read --no-open serves canonical Markdown without launching a browser", async () => {
    await withRuntimeCommandFixture("wr-read-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await writeFixtureRecords(projectRoot);
        const logs: string[] = [];
        const urlReady = Promise.withResolvers<string>();
        const originalLog = console.log;
        console.log = (...values) => {
            const line = values.map(String).join(" ");
            logs.push(line);
            const match = line.match(/Work Record read-only view: (http:\/\/\S+)/);
            if (match) urlReady.resolve(match[1]);
        };

        let readUrl = "";
        const command = runWorkRecordsCommand(["read", CURRENT_RECORD_ID, "--no-open"], {
            mnemotecaPort: createWorkRecordMnemotecaFixture(),
        });
        try {
            readUrl = await Promise.race([
                urlReady.promise,
                new Promise<string>((_resolve, reject) =>
                    setTimeout(() => reject(new Error("Timed out waiting for Work Record read URL.")), 5_000)
                ),
            ]);
            const page = await (await fetch(readUrl)).text();
            assertStringIncludes(page, "artifact-read");
            assertStringIncludes(page, "Current Record");
            assertStringIncludes(page, "Built the durable current machinery.");

            const url = new URL(readUrl);
            const token = url.searchParams.get("token");
            if (!token) throw new Error("Work Record read URL did not include a token.");
            const response = await fetch(new URL(`/api/review/exit?token=${encodeURIComponent(token)}`, url.origin), {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-review-token": token,
                },
                body: JSON.stringify({ reviewType: "plan" }),
            });
            assertEquals(response.status, 200);
            await command;
        } finally {
            console.log = originalLog;
        }

        assertEquals(logs.some((line) => line.includes("Could not open your browser automatically")), false);
        assertStringIncludes(readUrl, "/review/plan?token=");
    });
});

Deno.test("wld wr supersede lists pending reasons and confirms one pending relation", async () => {
    await withRuntimeCommandFixture("wr-supersede-confirm-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await writeSupersessionFixture(projectRoot);
        const options = { mnemotecaPort: createWorkRecordMnemotecaFixture() };

        const pending = await captureCommand(["supersede"], options);
        assertStringIncludes(pending, "The newer outcome replaces the old path.");
        assertStringIncludes(pending, `${ARCHIVED_RECORD_ID} may supersede ${CURRENT_RECORD_ID}`);

        const output = await captureCommand(
            ["supersede", ARCHIVED_RECORD_ID, "--confirm", CURRENT_RECORD_ID],
            options,
        );
        assertStringIncludes(output, "Confirmed Work Record supersession proposal");
        assertEquals(
            (await findWorkRecordById(projectRoot, CURRENT_RECORD_ID))?.attrs.supersededBy,
            ARCHIVED_RECORD_ID,
        );
        assertEquals((await findWorkRecordById(projectRoot, ARCHIVED_RECORD_ID))?.attrs.supersedes, [
            CURRENT_RECORD_ID,
        ]);
    });
});

Deno.test("wld wr supersede matches explicit UUID arguments case-insensitively", async () => {
    await withRuntimeCommandFixture("wr-supersede-case-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await writeSupersessionFixture(projectRoot);

        const output = await captureCommand(
            ["supersede", ARCHIVED_RECORD_ID.toUpperCase(), "--confirm", CURRENT_RECORD_ID.toUpperCase()],
            { mnemotecaPort: createWorkRecordMnemotecaFixture() },
        );

        assertStringIncludes(output, `${CURRENT_RECORD_ID} -> ${ARCHIVED_RECORD_ID}`);
        assertEquals(
            (await findWorkRecordById(projectRoot, CURRENT_RECORD_ID))?.attrs.supersededBy,
            ARCHIVED_RECORD_ID,
        );
    });
});

Deno.test("wld wr supersede supports reject and interactive cancel without losing pending state", async () => {
    await withRuntimeCommandFixture("wr-supersede-reject-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await writeSupersessionFixture(projectRoot);
        const mnemotecaPort = createWorkRecordMnemotecaFixture();
        const messages: string[] = [];
        const canceled = await captureCommand(["supersede", ARCHIVED_RECORD_ID], {
            mnemotecaPort,
            uiAPI: {
                appendSystemMessage: (message) => messages.push(message),
                promptSelect: () => Promise.resolve(null),
            },
        });
        assertStringIncludes(canceled, "remains pending");
        assertEquals(
            (await findWorkRecordById(projectRoot, ARCHIVED_RECORD_ID))?.attrs.supersessionProposal?.candidates.length,
            1,
        );

        const rejected = await captureCommand(
            ["supersede", ARCHIVED_RECORD_ID, "--reject", CURRENT_RECORD_ID],
            { mnemotecaPort },
        );
        assertStringIncludes(rejected, "Rejected Work Record supersession proposal");
        assertEquals(
            (await findWorkRecordById(projectRoot, ARCHIVED_RECORD_ID))?.attrs.supersessionProposal,
            undefined,
        );
        assertEquals((await findWorkRecordById(projectRoot, CURRENT_RECORD_ID))?.attrs.supersededBy, undefined);
    });
});

Deno.test("wld wr rejects invalid command arguments before touching project state", async () => {
    await withRuntimeCommandFixture("wr-invalid-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);

        await assertRejects(
            () =>
                runWorkRecordsCommand(["backfill", "--yes", "--dry-run"], {
                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                }),
            Error,
            "Cannot combine --yes with --dry-run",
        );
        await assertRejects(
            () =>
                runWorkRecordsCommand(["read", CURRENT_RECORD_ID, "--all"], {
                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                }),
            Error,
            "Unsupported flag: --all",
        );
        await assertRejects(
            () =>
                runWorkRecordsCommand(["index", "rebuild", "--all"], {
                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                }),
            Error,
            "Unsupported flag: --all",
        );
        assertEquals(await listWorkRecords(projectRoot), []);
    });
});

Deno.test("wld wr retry regenerates only its completed Plan and is idempotent", async () => {
    await withRuntimeCommandFixture("wr-targeted-retry-", async ({ projectRoot, setModelMessages }) => {
        Deno.chdir(projectRoot);
        await saveVerifiedPlan(projectRoot);
        await savePlan(projectRoot, "unrelated", "# Unrelated", {
            planId: "unrelated",
            classification: "PLANNED_CHANGE",
            status: "verified",
        });
        const unrelated = await Deno.readTextFile(`${projectRoot}/docs/plans/unrelated.md`);
        setModelMessages([fauxAssistantMessage(fauxToolCall("work_record_completed", {
            title: "Retried record",
            summary: "Regenerated the selected record.",
        }))]);
        const options = { mnemotecaPort: createWorkRecordMnemotecaFixture() };
        assertStringIncludes(await captureCommand(["retry", "standalone"], options), "Work Record generated");
        assertEquals((await loadPlan(projectRoot, "standalone"))?.attrs.status, "verified");
        assertEquals((await listWorkRecords(projectRoot)).length, 1);
        assertEquals(await Deno.readTextFile(`${projectRoot}/docs/plans/unrelated.md`), unrelated);
        assertStringIncludes(await captureCommand(["retry", "standalone"], options), "existing_backlink");
        assertEquals((await listWorkRecords(projectRoot)).length, 1);
    });
});
