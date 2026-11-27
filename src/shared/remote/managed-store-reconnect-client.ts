/** A reconnect starts a fresh remote process and reuses only the admitted personal owner. */
import { equal, ok, rejects } from "node:assert/strict";
import { plans } from "@runwield/plans";
import { projects } from "@runwield/projects";
import { stdinStream } from "../../testing/stdin-stream.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { activateRemoteProjectOwner } from "./managed-project-owner.ts";
import type { RemoteInteractiveConfig } from "./entry.ts";
const lines = processLines(stdinStream());
const input: Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection"> & {
    planId: string;
    expectedPath: string;
} = JSON.parse((await lines.read()).value || "{}");
await lines.cancel();
const clear = await activateRemoteProjectOwner(input);
try {
    const {
        archiveSavedPlan,
        planDocumentsForCheckout,
        openProjectPlanStore,
        restoreSavedPlan,
        withLocalPlanWorkflow,
        readPlanResource,
    } = await import("../../plan-store/index.ts");
    const plan = await planDocumentsForCheckout(input.cwd).load(input.planId);
    if (!plan || plan.path !== input.expectedPath || !plan.path.startsWith(input.resources.globalRoot))
        throw new Error("Reconnect changed canonical ownership.");
    await withLocalPlanWorkflow(input.cwd, input.planId, async () => {
        const document = await readPlanResource(input.cwd, { planId: input.planId, planName: "import-source" });
        if (!document.body.includes("Preserve source bytes."))
            throw new Error("Reconnect lost canonical imported bytes.");
    });
    const checkout = projects.checkout.inspect(input.cwd);
    ok(checkout.kind === "existing");
    const planId = plans.identity.parse(input.planId);
    ok(planId);
    const store = openProjectPlanStore(checkout.identity.projectId);
    const current = await store.read(planId);
    ok(current.planId === planId && current.body.includes("Preserve source bytes."));
    const created = await store.create({ planName: "z-bound-store", contextMarkdown: "# Draft\n" });
    const alias = await store.create({ planName: created.planId, contextMarkdown: created.body });
    equal(alias.revision, created.revision);
    equal((await store.read(created.planId)).name, created.name);
    const edited = await store.editBody(created.planId, { body: "# Reviewed\n", expectedRevision: created.revision });
    equal(edited.body, "# Reviewed\n");
    equal((await store.read(alias.planId)).body, created.body);
    const approved = await store.applyEvent(created.planId, {
        event: "review_approved",
        expectedRevision: edited.revision,
    });
    equal(approved.attrs.status, "approved");
    equal((await store.read(alias.planId)).attrs.status, "draft");
    const archived = await store.archive(created.planId, { expectedRevision: approved.revision, force: true });
    await rejects(() => store.read(created.planId));
    equal((await archiveSavedPlan(input.cwd, alias.name, { force: true })).attrs.planId, alias.planId);
    equal((await store.readArchived(created.planId)).body, edited.body);
    equal((await store.readArchived(alias.planId)).body, created.body);
    const restored = await store.restore(created.planId, archived.revision);
    equal(restored.body, edited.body);
    equal((await restoreSavedPlan(input.cwd, alias.name)).attrs.planId, alias.planId);
    equal((await store.read(alias.planId)).body, created.body);
    const approvedAlias = await store.applyEvent(alias.planId, {
        event: "review_approved",
        expectedRevision: (await store.read(alias.planId)).revision,
    });
    equal(approvedAlias.attrs.status, "approved");
    await store.archive(created.planId, { expectedRevision: restored.revision, force: true });
    await store.archive(alias.planId, { expectedRevision: approvedAlias.revision, force: true });
    clear();
    await rejects(() => store.read(planId), /managed|owner|authority/i);
} finally {
    clear();
}
