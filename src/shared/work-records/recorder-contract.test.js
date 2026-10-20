import { test } from "node:test";
import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { getCwd } from "../../constants.js";
import { savePlan } from "../../plan-store.js";
import { assertEquals, assertExists, assertThrows } from "../../testing/assertions.ts";
import { createWorkRecordCompletedTool } from "../../tools/work-record-completed.ts";
import { HostedSession } from "../session/hosted-session.js";
import {
    findWorkRecordById,
    formatWorkRecordMarkdown,
    parseRecorderSections,
    parseWorkRecordMarkdown,
    runWorkRecordBackfill,
} from "./index.ts";
import { createWorkRecordMnemotecaFixture } from "./test-fixtures/mnemoteca-port.ts";

/** @type {import('./schema.ts').WorkRecordFrontMatter} */
const INTERNAL_ATTRS = {
    kind: "work_record",
    recordId: "11111111-1111-4111-8111-111111111111",
    status: "approved",
    scope: "planned_change",
    origin: "internal",
    completionMode: "verified",
    createdAt: "2026-07-14T08:32:00-04:00",
    provenance: { sourcePlans: ["22222222-2222-4222-8222-222222222222"] },
};

for (const field of ["deviationsFromPlan", "deferredWork"]) {
    test(`Recorder tool rejects obsolete ${field} arguments`, () => {
        const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: getCwd() });
        try {
            const tool = createWorkRecordCompletedTool(hostedSession);
            assertThrows(
                () =>
                    validateToolArguments(tool, {
                        type: "toolCall",
                        id: "record",
                        name: tool.name,
                        arguments: {
                            title: "Search cache",
                            summary: "Search uses a local cache.",
                            [field]: "Run event.",
                        },
                    }),
                Error,
                "additional",
            );
            const args = {
                title: "Search cache",
                summary: "Search uses a local cache.",
                outOfScope: "No remote cache.",
            };
            assertEquals(
                validateToolArguments(tool, {
                    type: "toolCall",
                    id: "record",
                    name: tool.name,
                    arguments: args,
                }),
                args,
            );
        } finally {
            hostedSession.dispose();
        }
    });
}

test("Recorder normalization ignores obsolete fields and retains Out of Scope", () => {
    assertEquals(
        parseRecorderSections(
            JSON.stringify({
                title: "Search cache",
                summary: "Search uses a local cache.",
                outOfScope: "No remote cache.",
                deviationsFromPlan: "A rerun passed.",
                deferredWork: "Retry later.",
            }),
        ),
        { title: "Search cache", summary: "Search uses a local cache.", outOfScope: "No remote cache." },
    );
});

for (const recorded of [false, true]) {
    test(`Work Records contain only recorded deviations (recorded: ${recorded})`, async () => {
        const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
        try {
            await savePlan(cwd, "cache", "# Search cache", {
                planId: "plan-cache",
                classification: "PLANNED_CHANGE",
                status: "verified",
                planDeviations: recorded
                    ? [
                          {
                              id: "call-cache",
                              supersededRequirement: "Use a remote cache.",
                              replacementRequirement: "Use a local cache.",
                              approvedAt: "2026-09-10T00:00:00.000Z",
                          },
                      ]
                    : [],
            });
            const result = await runWorkRecordBackfill(cwd, {
                runRecorderStep: () =>
                    Promise.resolve({
                        title: "Search cache",
                        summary: "Search uses a local cache.",
                        deviationsFromPlan: "A rerun passed.",
                        deferredWork: "Retry later.",
                        outOfScope: "This work does not include a remote cache.",
                    }),
                mnemotecaPort: createWorkRecordMnemotecaFixture(),
            });
            assertEquals(result.outcomes[0].status, "generated");
            assertExists(result.outcomes[0].recordId);
            const record = await findWorkRecordById(cwd, result.outcomes[0].recordId);
            assertExists(record);
            assertEquals(
                record.sections["Deviations from Plan"],
                recorded
                    ? "1. Superseded requirement: Use a remote cache.\n   Replacement requirement: Use a local cache."
                    : undefined,
            );
            assertEquals(record.sections["Out of Scope"], "This work does not include a remote cache.");
            assertEquals(record.body.includes("## Deferred Work"), false);
            assertEquals(record.body.includes("Additional Recorder notes"), false);
            assertEquals(record.body.includes("A rerun passed"), false);
        } finally {
            await fsRm(cwd, { recursive: true });
        }
    });
}

for (const heading of ["Out of Scope", "Deferred Work"]) {
    test(`Work Record readers retain ${heading}`, () => {
        const record = parseWorkRecordMarkdown(
            formatWorkRecordMarkdown(
                INTERNAL_ATTRS,
                `# Search cache\n\n## Summary\n\nSearch uses a local cache.\n\n## ${heading}\n\nNo remote cache.`,
            ),
        );
        assertEquals(record.sections[heading], "No remote cache.");
    });
}

/**
 * @typedef {Object} CompletionLabelCase
 * @property {"user_verified"|"closed_without_verification"|"done_enough"} mode
 * @property {string} label
 */
/** @type {CompletionLabelCase[]} */
const completionLabels = [
    {
        mode: "user_verified",
        label: "The user attested verification; RunWield Workflow Validation did not establish this result.",
    },
    {
        mode: "closed_without_verification",
        label: "This work was completed but RunWield Workflow Validation was skipped.",
    },
    { mode: "done_enough", label: "The Epic was closed as done enough." },
];
for (const { mode, label } of completionLabels) {
    for (const modelLabel of [false, true]) {
        test(`Completion label appears once (${mode}, model label: ${modelLabel})`, async () => {
            const cwd = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
            try {
                await savePlan(cwd, "cache", "# Search cache", {
                    planId: "plan-cache",
                    classification: mode === "done_enough" ? "PROJECT" : "PLANNED_CHANGE",
                    status: mode === "done_enough" ? "verified" : mode,
                    ...(mode === "done_enough" ? { epicCompletionMode: "done_enough" } : {}),
                    userVerificationNote: "│ Checked   in staging. │",
                    closedWithoutVerificationReason: "User accepted the scope.",
                });
                const note = mode === "user_verified" ? " User verification note: Checked in staging." : "";
                const reason =
                    mode === "closed_without_verification" ? " Closure reason: User accepted the scope." : "";
                const result = await runWorkRecordBackfill(cwd, {
                    runRecorderStep: () =>
                        Promise.resolve({
                            title: "Search cache",
                            summary: `${modelLabel ? label + note + reason + " " : ""}Search uses a local cache.`,
                        }),
                    mnemotecaPort: createWorkRecordMnemotecaFixture(),
                });
                assertEquals(result.outcomes[0].status, "generated");
                assertExists(result.outcomes[0].recordId);
                const record = await findWorkRecordById(cwd, result.outcomes[0].recordId);
                assertExists(record);
                assertEquals(record.attrs.completionMode, mode);
                assertEquals(record.summary.split(label).length - 1, 1);
                if (mode === "user_verified") {
                    assertEquals(record.summary.split("Checked in staging.").length - 1, 1);
                    assertEquals(record.summary.includes("│"), false);
                }
                if (mode === "closed_without_verification") {
                    assertEquals(record.summary.split("User accepted the scope.").length - 1, 1);
                }
            } finally {
                await fsRm(cwd, { recursive: true });
            }
        });
    }
}
