import { equal, match, notEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { plans, type PlanId } from "@runwield/plans";
import { mergeFrontMatterText } from "@runwield/plans/format";

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
