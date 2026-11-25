import { equal, notEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { packageFixture } from "../shared/testing/plan-package-fixture.ts";
import { archiveSavedPlan, loadPlan, openProjectPlanStore, restoreSavedPlan, StalePlanWriteError } from "./index.ts";

test("a project-bound store preserves Plan identity and guards each write across independent opens", async () => {
    const fixture = await packageFixture();
    const other = await packageFixture();
    try {
        // These are admitted CLI projects with no Workspace registration.
        const open = () => openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const first = open();
        const second = open();
        const created = await first.create({ planName: "proposal", contextMarkdown: "# Draft\n" });
        const id = created.planId;
        equal(created.attrs.status, "draft");
        equal((await loadPlan(fixture.root, "proposal"))?.attrs.planId, id);
        await rejects(second.create({ planName: "proposal", contextMarkdown: "duplicate" }), StalePlanWriteError);
        const foreign = openProjectPlanStore(other.identity.projectId, { admitted: other.identity });
        await rejects(foreign.read(id));

        const attempts = await Promise.allSettled(
            [first, second].map((store, i) =>
                store.edit(id, { body: `# Revision ${i}\n`, expectedRevision: created.revision }),
            ),
        );
        equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
        const winner = attempts[0].status === "fulfilled" ? 0 : 1;
        const edited = await open().read(id);
        equal(edited.body, `# Revision ${winner}\n`);
        notEqual(edited.revision, created.revision);
        await rejects(
            second.applyEvent(id, { event: "review_approved", expectedRevision: created.revision }),
            StalePlanWriteError,
        );
        equal((await second.read(id)).attrs.status, "draft");
        const approved = await first.applyEvent(id, { event: "review_approved", expectedRevision: edited.revision });
        equal(approved.attrs.status, "approved");

        await rejects(second.archive(id, { expectedRevision: edited.revision, force: true }), StalePlanWriteError);
        const archived = await second.archive(id, { expectedRevision: approved.revision, force: true });
        const savedArchive = await open().readArchived(id);
        equal(savedArchive.revision, archived.revision);
        equal(savedArchive.planId, id);
        await rejects(first.read(id));
        await rejects(first.restore(id, approved.revision), StalePlanWriteError);
        const restored = await open().restore(id, savedArchive.revision);
        equal(restored.planId, id);
        await rejects(first.readArchived(id));
        equal((await loadPlan(fixture.root, "proposal"))?.body, edited.body);
        equal((await open().read(id)).revision, restored.revision);
    } finally {
        await Promise.all([fixture.cleanup(), other.cleanup()]);
    }
});

test("local Plan ID operations stay exact when another Plan has that name", async () => {
    const fixture = await packageFixture();
    try {
        const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const created = await store.create({ planName: "z-proposal", contextMarkdown: "# Draft\n" });
        const alias = await store.create({ planName: created.planId, contextMarkdown: created.body });
        equal(alias.revision, created.revision);
        equal((await store.read(created.planId)).name, created.name);
        const edited = await store.edit(created.planId, { body: "# Edited\n", expectedRevision: created.revision });
        equal((await store.read(alias.planId)).body, created.body);
        const approved = await store.applyEvent(created.planId, {
            event: "review_approved",
            expectedRevision: edited.revision,
        });
        equal((await store.read(alias.planId)).attrs.status, "draft");

        const archived = await store.archive(created.planId, { expectedRevision: approved.revision, force: true });
        await archiveSavedPlan(fixture.root, alias.name, { force: true });
        equal((await store.readArchived(created.planId)).body, edited.body);
        equal((await store.readArchived(alias.planId)).body, created.body);
        const restored = await store.restore(created.planId, archived.revision);
        equal(restored.planId, created.planId);
        equal((await restoreSavedPlan(fixture.root, alias.name)).attrs.planId, alias.planId);
        equal((await store.read(alias.planId)).body, created.body);
        equal(
            (
                await store.applyEvent(alias.planId, {
                    event: "review_approved",
                    expectedRevision: (await store.read(alias.planId)).revision,
                })
            ).attrs.status,
            "approved",
        );
    } finally {
        await fixture.cleanup();
    }
});
