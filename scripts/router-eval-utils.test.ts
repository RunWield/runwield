import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import { parseCsv, scoreAgainstHuman, toCsv, withRouterJudgementMetrics } from "./router-eval-utils.ts";

test("CSV utilities round-trip quoted cells", () => {
    const csv = toCsv(
        ["decisionId", "requestText"],
        [
            {
                decisionId: "d1",
                requestText: 'hello, "Router"\nplease',
            },
        ],
    );

    assertEquals(parseCsv(csv), [
        {
            decisionId: "d1",
            requestText: 'hello, "Router" please',
        },
    ]);
});

test("scoreAgainstHuman reports agreement and correction counts", () => {
    const score = scoreAgainstHuman(
        [
            { humanJudgement: "PLANNED_CHANGE", routerDecision: "QUICK_FIX" },
            { humanJudgement: "INQUIRY", routerDecision: "INQUIRY" },
            { humanJudgement: "", routerDecision: "PROJECT" },
            { humanJudgement: "IDEATION", routerDecision: "" },
        ],
        "routerDecision",
    );

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

test("judgement metrics classify corrections and leave invalid judgements unscored", () => {
    const cases = [
        ["OPERATION", "QUICK_FIX", 1, "operation_quick_fix_boundary"],
        ["QUICK_FIX", "PLANNED_CHANGE", 1, "scope_underestimated"],
        ["QUICK_FIX", "INQUIRY", 3, "legacy_quick_fix_to_inquiry"],
        ["INQUIRY", "PROJECT", 5, "answer_action_boundary"],
        ["PLANNED_CHANGE", "QUICK_FIX", 1, "scope_overestimated"],
        ["PLANNED_CHANGE", "PROJECT", 1, "feature_project_boundary"],
        ["QUICK_FIX", "feature", 1, "scope_underestimated"],
    ] as const;
    for (const [routerDecision, humanJudgement, distance, kind] of cases) {
        const row = withRouterJudgementMetrics({ routerDecision, humanJudgement });
        assertEquals(row.routerAgreesWithHuman, "FALSE");
        assertEquals(row.routerDistanceFromHuman, distance);
        assertEquals(row.routerDisagreementKind, kind);
    }
    const invalid = withRouterJudgementMetrics({ routerDecision: "bad", humanJudgement: "PROJECT" });
    assertEquals(invalid.routerDecision, "");
    assertEquals(invalid.routerAgreesWithHuman, "");
    assertEquals(invalid.routerDistanceFromHuman, "");
    assertEquals(invalid.routerCorrection, "");
});
