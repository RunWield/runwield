import { test } from "node:test";
import { assertEquals } from "../../testing/assertions.ts";
import { normalizeTriageOutcome } from "./triage-outcome.ts";

test("normalizeTriageOutcome keeps classification and Work Kind for a planned change", () => {
    assertEquals(
        normalizeTriageOutcome({
            routingIntent: "PLANNED_CHANGE",
            workKind: "BUG_FIX",
            complexity: "MEDIUM",
            summary: "fix login",
            sessionName: " fix\tlogin ",
        }),
        {
            routingIntent: "PLANNED_CHANGE",
            classification: "PLANNED_CHANGE",
            workKind: "BUG_FIX",
            complexity: "MEDIUM",
            summary: "fix login",
            sessionName: "fix login",
        },
    );
});

test("normalizeTriageOutcome maps the legacy FEATURE label and classification field", () => {
    assertEquals(
        normalizeTriageOutcome({ routingIntent: "FEATURE", complexity: "LOW", summary: "s" })?.routingIntent,
        "PLANNED_CHANGE",
    );
    assertEquals(normalizeTriageOutcome({ classification: "PROJECT", complexity: "HIGH", summary: "s" }), {
        routingIntent: "PROJECT",
        classification: "PROJECT",
        complexity: "HIGH",
        summary: "s",
    });
});

test("normalizeTriageOutcome drops Work Kind and classification outside planned work", () => {
    assertEquals(
        normalizeTriageOutcome({
            routingIntent: "OPERATION",
            workKind: "DOCUMENTATION",
            complexity: "LOW",
            summary: "s",
        }),
        { routingIntent: "OPERATION", complexity: "LOW", summary: "s" },
    );
});

test("normalizeTriageOutcome rejects a missing intent, an unknown complexity, or an empty summary", () => {
    assertEquals(normalizeTriageOutcome({ complexity: "LOW", summary: "s" }), null);
    assertEquals(normalizeTriageOutcome({ routingIntent: "INQUIRY", complexity: "EXTREME", summary: "s" }), null);
    assertEquals(normalizeTriageOutcome({ routingIntent: "INQUIRY", complexity: "LOW", summary: "" }), null);
    assertEquals(normalizeTriageOutcome(null), null);
});
