import { assertEquals, assertStringIncludes } from "@std/assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDeliveryReport } from "../../shared/workflow/delivery-report.ts";
import { reduceSessionEvents, SessionTimeline } from "./components/SessionTimeline.jsx";

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
