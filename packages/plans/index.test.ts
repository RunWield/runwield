import { deepEqual, equal, match, notEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { plans, type PlanId } from "@runwield/plans";
import { mergeFrontMatterText, parsePlanArtifactReference, planArtifactReference } from "@runwield/plans/format";
import { workRecords } from "@runwield/plans/work-records";

test("logical Plan resource paths preserve imported IDs without aliasing URI escapes", () => {
    for (const resource of ["context.md", "integration-report.md"] as const) {
        const ids = ["release notes", "release%20notes", "%", ".", "..", "parent/child"];
        const references = ids.map((id) => planArtifactReference(id, resource));
        equal(new Set(references).size, ids.length);
        deepEqual(
            references.map((reference) => parsePlanArtifactReference(reference, resource)),
            ids,
        );
    }
});

test("an existing Plan keeps its identity, custom fields and body across a review decision", async () => {
    const markdown =
        '---\r\nplanId: " imported-17 "\r\nclassification: FEATURE\r\nstatus: draft\r\ncustomKey: keep\r\n---\r\n# Repair checkout\r\n';
    const { attrs, body } = plans.documents.parse(markdown);
    equal(attrs.classification, "PLANNED_CHANGE");
    const parsedId: PlanId | undefined = attrs.planId;
    equal(parsedId, "imported-17");
    equal(plans.identity.isValid(" imported-17 "), false);
    const changes = plans.lifecycle.changesFor("review_approved", attrs.status);
    const updated = mergeFrontMatterText(markdown, changes);
    const saved = plans.documents.parse(updated);
    match(updated, /planId: " imported-17 "\r\nclassification: FEATURE\r\n/);
    equal(saved.attrs.planId, "imported-17");
    equal(saved.attrs.status, "approved");
    equal(saved.attrs.customKey, "keep");
    equal(saved.body, body);
    match(updated, /customKey: keep\r\n/);
    notEqual(await plans.documents.revision(updated), await plans.documents.revision(markdown));
});

test("document revisions cover the exact front matter and body bytes used by the store", async () => {
    const markdown = plans.documents.create("# Before\n", { status: "draft", planId: "created-17" });
    equal(await plans.documents.revision(markdown), createHash("sha256").update(markdown).digest("hex"));
    const changedBody = markdown.replace("# Before", "# After");
    notEqual(await plans.documents.revision(changedBody), await plans.documents.revision(markdown));
});

test("Work Record documents preserve legacy Markdown and textual identity", () => {
    const markdown = `---
kind: work_record
recordId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
status: approved
scope: feature
origin: internal
completionMode: verified
createdAt: 2026-07-14T08:32:00-04:00
provenance:
    sourcePlans: ["historical-plan"]
---
# Legacy record

## Result

Implemented the original plan.

## Deferred Work

Some follow-up work.
`;
    const path = "/repo/work-records/legacy.md";
    const relativePath = "work-records/legacy.md";
    const record = workRecords.documents.parse(markdown, { path, relativePath });

    equal(record.markdown, markdown);
    equal(record.attrs.recordId, "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE");
    equal(record.attrs.scope, "planned_change");
    equal(record.attrs.createdAt, "2026-07-14T12:32:00.000Z");
    deepEqual(record.attrs.provenance?.sourcePlans, ["historical-plan"]);
    equal(record.summary, "Implemented the original plan.");
    deepEqual(record.sections, { "Deferred Work": "Some follow-up work." });
    equal(record.path, path);
    equal(record.relativePath, relativePath);

    const formatted = workRecords.documents.format(record.attrs, record.body);
    match(formatted, /recordId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"/);
    match(formatted, /scope: "planned_change"/);
    equal(workRecords.documents.parse(formatted).body, record.body);
});
