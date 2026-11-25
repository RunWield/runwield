import {
    openPlanStoreForCheckout,
    planDocumentsForCheckout,
    readPlanDocuments,
    withLocalPlanWorkflow,
    withPlanSubmission,
    type PlanSubmissionDocument,
    selectPlanAccess,
} from "./index.ts";
import { equal, notEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { packageFixture } from "../shared/testing/plan-package-fixture.ts";
import { seedPlan } from "../shared/testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../shared/testing/retained-plan-fixture.ts";
import { archiveSavedPlan, openProjectPlanStore, restoreSavedPlan, StalePlanWriteError } from "./index.ts";

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
        equal((await planDocumentsForCheckout(fixture.root).load("proposal"))?.attrs.planId, id);
        await rejects(second.create({ planName: "proposal", contextMarkdown: "duplicate" }), StalePlanWriteError);
        const foreign = openProjectPlanStore(other.identity.projectId, { admitted: other.identity });
        await rejects(foreign.read(id));

        const attempts = await Promise.allSettled(
            [first, second].map((store, i) =>
                store.editBody(id, { body: `# Revision ${i}\n`, expectedRevision: created.revision }),
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
        const history = await second.history.list(id);
        equal(history.revision, approved.revision);
        const version = history.milestones[0].version;
        equal((await first.history.read(id, version))["context.md"], edited.body);
        await foreign.create({ planName: id, contextMarkdown: "Names cannot grant access to this ID." });
        await rejects(foreign.history.list(id), /requires an admitted Plan/);
        await rejects(foreign.history.read(id, version), /requires an admitted Plan/);
        await rejects(foreign.history.restore(id, version, history.revision), /requires an admitted Plan/);

        await rejects(second.archive(id, { expectedRevision: edited.revision, force: true }), StalePlanWriteError);
        const archived = await second.archive(id, { expectedRevision: approved.revision, force: true });
        const savedArchive = await open().readArchived(id);
        equal(savedArchive.revision, archived.revision);
        equal(savedArchive.planId, id);
        await rejects(first.read(id));
        equal((await first.history.read(id, version))["context.md"], edited.body);
        await rejects(first.history.restore(id, version, archived.revision), /Restore the archived Plan/);
        await rejects(first.restore(id, approved.revision), StalePlanWriteError);
        const restored = await open().restore(id, savedArchive.revision);
        equal(restored.planId, id);
        await rejects(first.readArchived(id));
        equal((await planDocumentsForCheckout(fixture.root).load("proposal"))?.body, edited.body);
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
        const edited = await store.revise(created.planId, {
            contextMarkdown: "# Edited\n",
            definition: { title: "Edited title", executionAgent: "frontend-engineer" },
            validationMarkdown: "# Updated validation\n",
            expectedRevision: created.revision,
        });
        const reopened = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        equal((await reopened.read(created.planId)).body, "# Edited\n");
        const validation = await withLocalPlanWorkflow(
            fixture.root,
            created.name,
            () => readPlanDocuments(created.planId, "validation.md"),
            created.planId,
        );
        equal(validation.body, "# Updated validation\n");
        equal(edited.attrs.title, "Edited title");
        equal(edited.attrs.executionAgent, "frontend-engineer");
        await rejects(
            store.revise(created.planId, { contextMarkdown: "stale", expectedRevision: created.revision }),
            StalePlanWriteError,
        );
        equal((await store.read(alias.planId)).body, created.body);
        equal((await store.read(alias.planId)).attrs.title, alias.attrs.title);
        const approved = await store.applyEvent(created.planId, {
            event: "review_approved",
            expectedRevision: edited.revision,
        });
        equal((await store.read(alias.planId)).attrs.status, "draft");
        const byReference = openPlanStoreForCheckout(fixture.root)!;
        equal(await byReference.resolveHistoryPlan(alias.name), created.planId);
        equal((await store.history.list(created.planId)).milestones.length, 1);
        equal((await store.history.list(alias.planId)).milestones.length, 0);

        const archived = await store.archive(created.planId, { expectedRevision: approved.revision, force: true });
        equal(await byReference.resolveHistoryPlan(alias.name), created.planId);
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

test("a checkout reader and picker keep the Project that admitted the Plan", async () => {
    const first = await packageFixture();
    const second = await packageFixture();
    try {
        const owner = openPlanStoreForCheckout(first.root)!;
        const other = openProjectPlanStore(second.identity.projectId, { admitted: second.identity });
        const saved = await owner.create({ planName: "proposal", contextMarkdown: "First" });
        const foreign = await other.create({ planName: "proposal", contextMarkdown: "Second" });
        const reader = planDocumentsForCheckout(second.root);
        equal((await reader.load("proposal"))?.body, "Second");
        await owner.withWorkflow(saved.planId, saved.name, async () => {
            await rejects(() => reader.load("proposal"), /different Project/);
            await rejects(() => other.history.list(foreign.planId), /different Project/);
        });
        await rejects(
            () => selectPlanAccess(second.root, saved.name, saved.planId, owner.projectId),
            /another Project/,
        );
    } finally {
        await Promise.all([first.cleanup(), second.cleanup()]);
    }
});

test("retained submission checks the Session Project and exact Plan before any write", async () => {
    const fixture = await packageFixture();
    const foreign = await packageFixture();
    try {
        const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const canonical = await store.create({ planName: "proposal", contextMarkdown: "# Canonical\n" });
        await withRetainedPlanFixture(fixture.root, async () => {
            const retainedId = crypto.randomUUID();
            await seedPlan(fixture.root, "proposal", "# Retained\n", { planId: retainedId });
            const save = ({ saveDefinition }: PlanSubmissionDocument) => saveDefinition({ executionAgent: "engineer" });
            await rejects(
                () =>
                    withPlanSubmission(
                        fixture.root,
                        "proposal",
                        { expectedProjectId: foreign.identity.projectId },
                        save,
                    ),
                /another Session Project/,
            );
            await rejects(
                () => withPlanSubmission(fixture.root, "proposal", { expectedPlanId: canonical.planId }, save),
                /bound Plan identity changed/,
            );
            await rejects(
                () =>
                    withPlanSubmission(
                        fixture.root,
                        "proposal",
                        { prepareAuthor: () => ({ contextMarkdown: "# Replacement\n" }) },
                        save,
                    ),
                /requires the canonical Project owner/,
            );
            const before = await planDocumentsForCheckout(fixture.root).load("proposal");
            equal(before?.attrs.executionAgent, undefined);
            equal(before?.body, "# Retained\n");
            await withPlanSubmission(
                fixture.root,
                "proposal",
                { expectedProjectId: fixture.identity.projectId, expectedPlanId: retainedId },
                save,
            );
            const submitted = await planDocumentsForCheckout(fixture.root).load("proposal");
            equal(submitted?.attrs.executionAgent, "engineer");
            equal(submitted?.attrs.planId, retainedId);
        });
        const after = await store.read(canonical.planId);
        equal(after.revision, canonical.revision);
        equal(after.body, canonical.body);
    } finally {
        await Promise.all([fixture.cleanup(), foreign.cleanup()]);
    }
});
