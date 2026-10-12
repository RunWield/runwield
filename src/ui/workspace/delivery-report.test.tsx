import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDeliveryReport } from "../../shared/workflow/delivery-report.ts";
import { reduceSessionEvents, SessionTimeline } from "./components/SessionTimeline.jsx";
import { createPublicationAttempt } from "../../shared/workflow/publication-attempt.ts";

Deno.test("Plan Branch completion card names the landing and the user's next merge", () => {
    const report = buildDeliveryReport({
        planName: "example",
        attrs: { classification: "PLANNED_CHANGE", targetBranch: "release", deliveryBranch: "plan/example" },
        publication: {
            ...createPublicationAttempt({
                attemptId: "card",
                planId: "card",
                planName: "example",
                targetBranch: "plan/example",
                executionBranch: "worktree/example",
                executionCwd: "/fixture",
                publicationRoot: "/fixture",
                validatedCommit: "a".repeat(40),
                targetHeadAtSeal: "c".repeat(40),
            }),
            publishedCommit: "b".repeat(40),
            verifiedAt: "2026-10-08T10:00:00Z",
        },
        guidedReview: "auto",
        codeReview: "none",
        workRecordFailed: false,
        semanticRequired: true,
    });
    const items = reduceSessionEvents([{
        type: "system_status",
        eventId: "off-path",
        message: "Delivered",
        validationProgress: { deliveryReport: report },
    }]);
    const html = renderToStaticMarkup(createElement(SessionTimeline, { items, sessionPath: "/projects/p/sessions/s" }));
    assertStringIncludes(html, "<h3>Ready for your merge/PR</h3>");
    assertStringIncludes(html, "<dt>Landing branch</dt><dd>plan/example</dd>");
    assertStringIncludes(html, "open a PR to release");
});

Deno.test("delivery report survives replay as an inline Session card with safe artifact links", () => {
    const report = buildDeliveryReport({
        planName: "<script>fixture</script>",
        attrs: { planId: "fixture", workRecord: { status: "generated", path: "docs/work-records/example.md" } },
        guidedReview: "auto",
        codeReview: "none",
        workRecordFailed: false,
        semanticRequired: true,
    });
    report.artifacts[0].artifactId = "id/with?characters";
    const events = [{
        type: "system_status",
        eventId: "receipt-1",
        message: "Delivered",
        validationProgress: { deliveryReport: report },
    }];
    const items = reduceSessionEvents(events);
    assertEquals(items[0].kind, "delivery-report");
    const html = renderToStaticMarkup(createElement(SessionTimeline, { items, sessionPath: "/projects/p/sessions/s" }));
    assertStringIncludes(html, 'aria-label="Delivery evidence"');
    assertStringIncludes(html, "/projects/p/sessions/s/artifacts/id%2Fwith%3Fcharacters");
    assertStringIncludes(html, ">Work Record</a>");
    assertStringIncludes(html, "Not recorded");
    assertEquals(html.includes("in browser"), false);
    assertEquals(html.includes('aria-label="Delivery artifacts"'), false);
    assertEquals(html.includes("<script>fixture"), false);
});
