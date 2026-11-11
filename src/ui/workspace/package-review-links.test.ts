import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { packageFixture, create } from "../../shared/testing/plan-package-fixture.ts";
import { withLocalProjectAction } from "../../shared/local-home-store.ts";
import { createReviewWorkspaceApp } from "./server.js";

test("Sequence link requests bind the displayed child and refuse unrelated Plan IDs", async () => {
    const fixture = await packageFixture();
    try {
        await create(fixture.identity, {
            documents: { "context.md": "# Canonical parent", "validation.md": "# Checks" },
        });
        await create(fixture.identity, { planId: "child-id", name: "nested/child" });
        await create(fixture.identity, { planId: "private-id", name: "private" });
        await mkdir(join(fixture.root, "docs/plans"), { recursive: true });
        await writeFile(join(fixture.root, "docs/plans/one.md"), "# Stale checkout parent");
        const app = await withLocalProjectAction(fixture.root, () =>
            Promise.resolve(
                createReviewWorkspaceApp({
                    cwd: fixture.root,
                    token: "review-token",
                    reviewType: "plan",
                    reviewPayload: { planId: "plan-one", sequenceDocuments: [{ planId: "child-id" }] },
                }),
            ),
        );
        const request = (planId: string) =>
            new Request(
                `http://localhost/api/file-content?token=review-token&planId=${planId}&path=../one.md&base=docs/plans/nested`,
            );
        const response = await app.handler()(request("child-id"));
        strictEqual(response.status, 200);
        const body = await response.text();
        ok(body.includes("Canonical parent"));
        ok(!body.includes("Stale checkout"));
        strictEqual((await app.handler()(request("private-id"))).status, 403);
        await app.cleanup();
    } finally {
        await fixture.cleanup();
    }
});
