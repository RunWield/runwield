import { projects } from "@runwield/projects";
import { equal, notEqual, rejects, throws } from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { defineCommittedGitFixture, git } from "../../test-support/git-test-fixture.ts";
import {
    currentRetainedCheckoutSource,
    hasRetainedCheckoutSource,
    validatedRetainedCheckoutSource,
    withRetainedCheckoutSource,
    withoutRetainedCheckoutSource,
} from "@runwield/plans/retained-checkout";

const fixture = defineCommittedGitFixture();
const mismatch = /Retained checkout source belongs to another Project or repository/;

test("retained scope verifies Project, repository and personal owner across checkout aliases", async () => {
    const root = await fixture.checkout();
    const foreignRoot = await fixture.checkout();
    const linkedRoot = `${root}-linked`;
    try {
        equal(validatedRetainedCheckoutSource(root), undefined);
        equal(hasRetainedCheckoutSource(root), false);
        const original = await projects.checkout.admit(root);
        const foreign = await projects.checkout.admit(foreignRoot);
        if (original.kind !== "existing" || foreign.kind !== "existing") throw new Error("Expected admitted Projects.");
        const identity = original.identity;
        const nested = join(linkedRoot, "nested");
        await git(root, ["worktree", "add", "-b", "linked", linkedRoot]);
        await mkdir(nested);
        const linked = await projects.checkout.admit(nested);
        if (linked.kind !== "existing") throw new Error("Expected an admitted linked checkout.");
        notEqual(linked.identity.checkoutId, identity.checkoutId);

        await withRetainedCheckoutSource(identity, async () => {
            equal(currentRetainedCheckoutSource(), identity);
            equal(validatedRetainedCheckoutSource(nested), identity);
            equal(hasRetainedCheckoutSource(linkedRoot), true);
            throws(() => hasRetainedCheckoutSource(foreignRoot), mismatch);
            throws(() => validatedRetainedCheckoutSource(join(root, "missing")), mismatch);

            await withRetainedCheckoutSource(foreign.identity, async () => {
                await Promise.resolve();
                equal(validatedRetainedCheckoutSource(foreignRoot), foreign.identity);
                throws(() => validatedRetainedCheckoutSource(root), mismatch);
            });
            await rejects(
                withoutRetainedCheckoutSource(async () => {
                    await Promise.resolve();
                    equal(currentRetainedCheckoutSource(), undefined);
                    equal(validatedRetainedCheckoutSource(root), undefined);
                    throw new Error("Canonical operation failed.");
                }),
                /Canonical operation failed/,
            );
            equal(currentRetainedCheckoutSource(), identity);
        });
        equal(currentRetainedCheckoutSource(), undefined);

        const resume = Promise.withResolvers<void>();
        const concurrent = [identity, foreign.identity].map((source) => {
            const ready = Promise.withResolvers<void>();
            const done = withRetainedCheckoutSource(source, async () => {
                ready.resolve();
                await resume.promise;
                equal(currentRetainedCheckoutSource(), source);
                equal(validatedRetainedCheckoutSource(source.checkoutRoot), source);
            });
            return { ready: ready.promise, done };
        });
        await Promise.all(concurrent.map(({ ready }) => ready));
        resume.resolve();
        await Promise.all(concurrent.map(({ done }) => done));
        equal(currentRetainedCheckoutSource(), undefined);

        for (const stale of [
            { ...identity, projectId: foreign.identity.projectId },
            { ...identity, repositoryId: foreign.identity.repositoryId },
            { ...identity, personalOwner: { ...identity.personalOwner, identity: foreignRoot } },
        ]) {
            await withRetainedCheckoutSource(stale, async () => {
                await Promise.resolve();
                throws(() => validatedRetainedCheckoutSource(root), mismatch);
            });
        }
    } finally {
        await Promise.all([root, foreignRoot, linkedRoot].map((path) => rm(path, { recursive: true, force: true })));
    }
});
