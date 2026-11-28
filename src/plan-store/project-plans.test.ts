import { StalePlanWriteError } from "@runwield/plans/store";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
    openPlanLifecycleForCheckout,
    openPlanStoreForCheckout,
    planDocumentsForCheckout,
    preparePlanReviewVersion,
    readPlanDocuments,
    withLocalPlanWorkflow,
    withPlanSubmission,
    type PlanSubmissionDocument,
    selectPlanAccess,
} from "./index.ts";
import { deepEqual, equal, match, notEqual, rejects } from "node:assert/strict";
import { test } from "node:test";
import { create, packageFixture } from "../shared/testing/plan-package-fixture.ts";
import { recordPlanEvent, seedPlan } from "../shared/testing/plan-state-fixture.ts";
import { withRetainedPlanFixture } from "../shared/testing/retained-plan-fixture.ts";
import { openProjectPlanLifecycle, openProjectPlanStore } from "./index.ts";
import {
    archiveSavedPlan,
    restoreSavedPlan,
    listArchivedPlans,
    listPlans,
    readPlanResourceCatalog,
} from "../shared/testing/plan-query-fixture.ts";

test("a project-bound store preserves Plan identity and guards each write across independent opens", async () => {
    const fixture = await packageFixture();
    const other = await packageFixture();
    try {
        // These are admitted CLI projects with no Workspace registration.
        const open = () => openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const first = open();
        const second = open();
        const lifecycle = () => openProjectPlanLifecycle(fixture.identity.projectId, { admitted: fixture.identity });
        const { layoutMarkerPath } = resolveProjectRuntimeLayout(fixture.root).primary;
        equal((await first.list()).resources.length, 0);
        await rejects(lstat(layoutMarkerPath), { code: "ENOENT" });
        const created = await first.create({ planName: "proposal", contextMarkdown: "# Draft\n" });
        equal((await lstat(layoutMarkerPath)).isFile(), true);
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
            lifecycle().applyEvent(id, { event: "readiness_passed", expectedRevision: created.revision }),
            StalePlanWriteError,
        );
        equal((await second.read(id)).attrs.status, "draft");
        const review = Reflect.apply(lifecycle().applyEvent, undefined, [
            id,
            { event: "review_approved", expectedRevision: edited.revision },
        ]);
        equal((await review).cancellationReason, "stale_plan_review");
        equal((await second.read(id)).revision, edited.revision);
        equal((await second.history.list(id)).milestones.length, 0);
        const source = (await planDocumentsForCheckout(fixture.root).load("proposal"))!;
        const { displayedVersion } = await preparePlanReviewVersion(fixture.root, "proposal", source.path, {
            expectedRevision: edited.revision,
        });
        const decision = await lifecycle().applyEvent(id, {
            event: "review_approved",
            displayedVersion,
            approvalAction: "later",
        });
        equal(decision.approved, true, decision.feedback ?? "The saved review should commit.");
        const approved = await first.read(id);
        equal(approved.attrs.status, "approved");
        equal(decision.revision, approved.revision);
        const history = await second.history.list(id);
        equal(history.revision, approved.revision);
        const version = history.milestones[0].version;
        equal((await first.history.read(id, version))["context.md"], edited.body);
        await foreign.create({ planName: id, contextMarkdown: "Names cannot grant access to this ID." });
        await rejects(foreign.history.list(id), /requires an admitted Plan/);
        await rejects(foreign.history.read(id, version), /requires an admitted Plan/);
        await rejects(foreign.history.restore(id, version, history.revision), /requires an admitted Plan/);

        await rejects(lifecycle().archive(id, { expectedRevision: edited.revision, force: true }), StalePlanWriteError);
        const archived = await lifecycle().archive(id, { expectedRevision: approved.revision, force: true });
        const savedArchive = await open().readArchived(id);
        deepEqual(savedArchive, archived);
        equal(savedArchive.planId, id);
        await rejects(first.read(id));
        equal((await first.history.read(id, version))["context.md"], edited.body);
        await rejects(first.history.restore(id, version, archived.revision), /Restore the archived Plan/);
        await rejects(lifecycle().restore(id, approved.revision), StalePlanWriteError);
        const restored = await lifecycle().restore(id, savedArchive.revision);
        equal(restored.planId, id);
        await rejects(first.readArchived(id));
        equal((await planDocumentsForCheckout(fixture.root).load("proposal"))?.body, edited.body);
        deepEqual(await open().read(id), restored);
    } finally {
        await Promise.all([fixture.cleanup(), other.cleanup()]);
    }
});

test("canonical display catalogs report damaged packages while workflow and archive catalogs reject them", async () => {
    const fixture = await packageFixture();
    try {
        const store = openProjectPlanStore(fixture.identity.projectId, { admitted: fixture.identity });
        const healthy = await store.create({ planName: "healthy", contextMarkdown: "# Healthy\n" });
        const damaged = await create(fixture.identity, { name: "damaged" });
        const privatePath = join(damaged.path, "context.md");
        await unlink(privatePath);
        await mkdir(privatePath);

        const display = await store.list();
        deepEqual(display.resources, [healthy]);
        deepEqual(
            display.diagnostics.map(({ name, kind }) => ({ name, kind })),
            [{ name: "Plan package", kind: "malformed" }],
        );
        equal("path" in display.diagnostics[0], false);
        const operational = await readPlanResourceCatalog(fixture.root);
        equal(operational.diagnostics.length, 1);
        equal(operational.diagnostics[0].message, `Package resource is not a regular file: ${privatePath}`);
        match(display.diagnostics[0].message, /^Package resource is not a regular file: (?:\[workspace path\])+$/);
        await rejects(listPlans(fixture.root), { message: operational.diagnostics[0].message });
        await rejects(listArchivedPlans(fixture.root), { message: operational.diagnostics[0].message });
    } finally {
        await fixture.cleanup();
    }
});

test("a checkout-bound Plan store repairs missing registration only on authoring", async () => {
    const fixture = await packageFixture();
    try {
        const { executionAccountHome, projectId } = fixture.identity;
        const registration = join(executionAccountHome, ".wld", "projects", projectId, "project.wld.json");
        await unlink(registration);

        const store = openPlanStoreForCheckout(fixture.root)!;
        equal(store.projectId, projectId);
        equal((await store.list()).resources.length, 0);
        await rejects(lstat(registration), { code: "ENOENT" });

        const created = await store.create({ planName: "proposal", contextMarkdown: "# Draft\n" });
        equal((await lstat(registration)).isFile(), true);
        equal((await store.read(created.planId)).body, "# Draft\n");
    } finally {
        await fixture.cleanup();
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
        await recordPlanEvent({
            cwd: fixture.root,
            planName: created.name,
            expectedPlanId: created.planId,
            event: "review_approved",
            expectedRevision: edited.revision,
        });
        const lifecycle = openPlanLifecycleForCheckout(fixture.root)!;
        const approved = await lifecycle.applyEvent(created.planId, {
            event: "readiness_passed",
            expectedRevision: (await store.read(created.planId)).revision,
        });
        equal(approved.attrs.status, "ready_for_work");
        deepEqual(approved, await store.read(created.planId));
        equal((await store.read(alias.planId)).attrs.status, "draft");
        const byReference = openPlanStoreForCheckout(fixture.root)!;
        equal(await byReference.resolveHistoryPlan(alias.name), created.planId);
        equal((await store.history.list(created.planId)).milestones.length, 1);
        equal((await store.history.list(alias.planId)).milestones.length, 0);

        const archived = await lifecycle.archive(created.planId, { expectedRevision: approved.revision, force: true });
        equal(await byReference.resolveHistoryPlan(alias.name), created.planId);
        await archiveSavedPlan(fixture.root, alias.name, { force: true });
        equal((await store.readArchived(created.planId)).body, edited.body);
        equal((await store.readArchived(alias.planId)).body, created.body);
        const restored = await lifecycle.restore(created.planId, archived.revision);
        equal(restored.planId, created.planId);
        equal((await restoreSavedPlan(fixture.root, alias.name)).attrs.planId, alias.planId);
        equal((await store.read(alias.planId)).body, created.body);
        await recordPlanEvent({
            cwd: fixture.root,
            planName: alias.name,
            expectedPlanId: alias.planId,
            event: "review_approved",
            expectedRevision: (await store.read(alias.planId)).revision,
        });
        equal((await store.read(alias.planId)).attrs.status, "approved");
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
