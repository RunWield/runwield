import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import {
    classifyRoutingIntentDisagreement,
    normalizeRoutingIntentCell,
    parseCsv,
    routingIntentDistance,
    scoreAgainstHuman,
    toCsv,
    withRouterJudgementMetrics,
} from "./router-eval-utils.js";

test("CSV utilities round-trip quoted cells", () => {
    const csv = toCsv(["decisionId", "requestText"], [{
        decisionId: "d1",
        requestText: 'hello, "Router"\nplease',
    }]);

    assertEquals(parseCsv(csv), [{
        decisionId: "d1",
        requestText: 'hello, "Router" please',
    }]);
});

test("routingIntentDistance follows routing-intent workflow order", () => {
    assertEquals(routingIntentDistance("OPERATION", "QUICK_FIX"), 1);
    assertEquals(routingIntentDistance("QUICK_FIX", "PLANNED_CHANGE"), 1);
    assertEquals(routingIntentDistance("QUICK_FIX", "INQUIRY"), 3);
    assertEquals(routingIntentDistance("INQUIRY", "PROJECT"), 5);
    assertEquals(routingIntentDistance("bad", "PROJECT"), null);
});

test("normalizeRoutingIntentCell aliases legacy FEATURE to PLANNED_CHANGE", () => {
    assertEquals(normalizeRoutingIntentCell("FEATURE"), "PLANNED_CHANGE");
    assertEquals(normalizeRoutingIntentCell("feature"), "PLANNED_CHANGE");
    assertEquals(normalizeRoutingIntentCell("PLANNED_CHANGE"), "PLANNED_CHANGE");
    assertEquals(normalizeRoutingIntentCell("INQUIRY"), "INQUIRY");
    assertEquals(normalizeRoutingIntentCell("bogus"), "");
});

test("classifyRoutingIntentDisagreement names common router-eval cases", () => {
    assertEquals(classifyRoutingIntentDisagreement("QUICK_FIX", "INQUIRY"), "legacy_quick_fix_to_inquiry");
    assertEquals(classifyRoutingIntentDisagreement("OPERATION", "QUICK_FIX"), "operation_quick_fix_boundary");
    assertEquals(classifyRoutingIntentDisagreement("QUICK_FIX", "PLANNED_CHANGE"), "scope_underestimated");
    assertEquals(classifyRoutingIntentDisagreement("PLANNED_CHANGE", "QUICK_FIX"), "scope_overestimated");
    assertEquals(classifyRoutingIntentDisagreement("PLANNED_CHANGE", "PROJECT"), "feature_project_boundary");
    assertEquals(classifyRoutingIntentDisagreement("QUICK_FIX", "FEATURE"), "scope_underestimated");
});

test("scoreAgainstHuman reports agreement and correction counts", () => {
    const score = scoreAgainstHuman([
        { humanJudgement: "PLANNED_CHANGE", routerDecision: "QUICK_FIX" },
        { humanJudgement: "INQUIRY", routerDecision: "INQUIRY" },
        { humanJudgement: "", routerDecision: "PROJECT" },
        { humanJudgement: "IDEATION", routerDecision: "" },
    ], "routerDecision");

    assertEquals(score, {
        total: 2,
        agreementCount: 1,
        agreementRate: 0.5,
        meanDistance: 0.5,
        invalidRows: 0,
        unscoredRows: 1,
        corrections: { "QUICK_FIX->PLANNED_CHANGE": 1 },
    });
});

test("withRouterJudgementMetrics annotates Router agreement columns", () => {
    assertEquals(
        withRouterJudgementMetrics({
            routerDecision: "PLANNED_CHANGE",
            humanJudgement: "QUICK_FIX",
        }),
        {
            routerDecision: "PLANNED_CHANGE",
            humanJudgement: "QUICK_FIX",
            routerAgreesWithHuman: "FALSE",
            routerCorrection: "PLANNED_CHANGE->QUICK_FIX",
            routerDistanceFromHuman: 1,
            routerDisagreementKind: "scope_overestimated",
        },
    );
});

test("withRouterJudgementMetrics aliases legacy FEATURE cells", () => {
    assertEquals(
        withRouterJudgementMetrics({
            routerDecision: "FEATURE",
            humanJudgement: "FEATURE",
        }),
        {
            routerDecision: "PLANNED_CHANGE",
            humanJudgement: "PLANNED_CHANGE",
            routerAgreesWithHuman: "TRUE",
            routerCorrection: "",
            routerDistanceFromHuman: 0,
            routerDisagreementKind: "exact",
        },
    );
});
