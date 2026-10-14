import { rm } from "node:fs/promises";
import { makeTempDirectory } from "../../../../testing/temp-file.ts";
import { test } from "node:test";
import { assertEquals } from "../../../../testing/assertions.ts";
import { createReviewWorkspaceApp } from "../../server.js";
import { registerReviewDecisionPromise, unregisterReviewDecision } from "./review-handlers.js";
for (const action of ["post_comments", "approve_pr", "approve_commit", "request_changes", "arbitrary"]) {
    test(`review feedback validates ${action}`, async () => {
        const cwd = await makeTempDirectory();
        const token = crypto.randomUUID();
        const pending = registerReviewDecisionPromise(token);
        const app = createReviewWorkspaceApp({ cwd, token, reviewPayload: {}, reviewType: "code" });
        try {
            const response = await app.handler()(
                new Request(`http://localhost/api/review/feedback?token=${token}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ reviewAction: action }),
                }),
            );
            assertEquals(response.status, 200);
            await response.text();
            const decision = await pending.promise;
            assertEquals(
                decision.reviewAction,
                ["post_comments", "approve_pr", "approve_commit"].includes(action) ? action : undefined,
            );
        } finally {
            unregisterReviewDecision(token);
            await app.cleanup();
            await rm(cwd, { recursive: true });
        }
    });
}
