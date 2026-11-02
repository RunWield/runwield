import { test } from "node:test";
import { join } from "node:path";
import { assertEquals } from "../../testing/assertions.ts";
import { RUNWIELD_ROOT } from "../../../runtime-root.js";
import { createReviewWorkspaceApp } from "./server.js";

for (const absolute of [false, true]) {
    test(`Plan review sends project-relative document paths (${absolute ? "absolute" : "relative"} input)`, async () => {
        const path = "docs/plans/external-plan-store/plan-2.md";
        const planPath = absolute ? join(RUNWIELD_ROOT, path) : path;
        const app = createReviewWorkspaceApp({
            cwd: RUNWIELD_ROOT,
            token: "review-paths",
            reviewType: "plan",
            reviewPayload: {
                plan: "# Child Plan",
                planPath,
                sequenceDocuments: [{ planId: "child", plan: "# Child Plan", planPath }],
            },
        }).handler();
        const response = await app(new Request("http://localhost/review/plan?token=review-paths"));
        const html = await response.text();
        const payload = JSON.parse(
            html.match(/<script[^>]+data-review-payload[^>]*>([\s\S]*?)<\/script>/)?.[1] || "null",
        );
        assertEquals(payload?.planPath, path);
        assertEquals(payload?.sequenceDocuments[0].planPath, path);
    });
}
