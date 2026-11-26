import { test } from "node:test";
import { assertEquals, assertStringIncludes, assertThrows } from "../../test-support/assertions.ts";
import { workRecords, type WorkRecordFrontMatter } from "@runwield/plans/work-records";

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

test("Work Record markdown parses nested provenance and body sections", () => {
    const markdown = workRecords.documents.format(
        {
            ...INTERNAL_ATTRS,
            provenance: {
                sourcePlans: ["22222222-2222-4222-8222-222222222222"],
                evidence: [{ path: "src/example.js", note: "Shows the stable seam." }],
            },
        },
        BODY,
    );

    const record = workRecords.documents.parse(markdown, { relativePath: "docs/work-records/example.md" });

    assertEquals(record.title, "Example Work");
    assertEquals(record.summary, "Built the durable store.");
    assertEquals(record.sections["Future Planning Notes"], "Reuse this pattern.");
    assertEquals(record.attrs.provenance?.evidence?.[0].path, "src/example.js");
    assertStringIncludes(markdown, "provenance:\n    sourcePlans:");
    assertStringIncludes(markdown, "    evidence:\n        - path:");
});

test("Work Record supersession proposals reject every malformed candidate before deduplication", () => {
    const malformedCandidates = [
        "{}",
        '{ recordId: "", reason: "Reason." }',
        '{ recordId: "33333333-3333-4333-8333-333333333333", reason: "   " }',
        '"33333333-3333-4333-8333-333333333333"',
    ];
    const markdown = workRecords.documents.format(INTERNAL_ATTRS, BODY);
    for (const candidate of malformedCandidates) {
        assertThrows(
            () =>
                workRecords.documents.parse(
                    markdown.replace("\n---\n", `\nsupersessionProposal:\n    candidates: [${candidate}]\n---\n`),
                ),
            Error,
            "supersessionProposal candidate",
        );
    }
    assertThrows(
        () =>
            workRecords.documents.format(
                {
                    ...INTERNAL_ATTRS,
                    supersessionProposal: {
                        candidates: [
                            { recordId: "33333333-3333-4333-8333-333333333333", reason: "Valid." },
                            { recordId: "33333333-3333-4333-8333-333333333333", reason: " " },
                        ],
                    },
                },
                BODY,
            ),
        Error,
        "reason must be a non-blank string",
    );
    const empty = workRecords.documents.format(
        {
            ...INTERNAL_ATTRS,
            supersessionProposal: { candidates: [] },
        },
        BODY,
    );
    assertEquals(empty.includes("supersessionProposal:"), false);
});

test("Work Record validation rejects missing required fields", () => {
    assertThrows(
        () => workRecords.documents.parse(`---\nkind: work_record\n---\n# Missing\n\n## Summary\n\nNo metadata.`),
        Error,
        "recordId must be a plain UUID",
    );
    assertThrows(
        () =>
            workRecords.documents.parse(
                workRecords.documents.format({ ...INTERNAL_ATTRS, provenance: undefined }, BODY),
            ),
        Error,
        "provenance.sourcePlans is required",
    );
});

test("Work Record validation reports malformed provenance evidence entries", () => {
    const markdown = workRecords.documents.format(INTERNAL_ATTRS, BODY);
    const malformed = markdown.replace("\n---\n", '\n    evidence:\n        - path: "src/example.js"\n---\n');
    assertThrows(
        () => workRecords.documents.parse(malformed),
        Error,
        "provenance.evidence entries require path and note",
    );
});
