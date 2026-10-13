import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import { buildBaseline, checkThresholds, summarizeJudgements } from "./evaluate-router-judgements.js";

test("summarizeJudgements compares router against human labels", () => {
    const summary = summarizeJudgements([
        {
            humanJudgement: "FEATURE",
            routerDecision: "QUICK_FIX",
        },
        {
            humanJudgement: "INQUIRY",
            routerDecision: "INQUIRY",
        },
        {
            humanJudgement: "",
            routerDecision: "PROJECT",
        },
    ]);

    assertEquals(summary.labelledRows, 2);
    assertEquals(summary.unlabelledRows, 1);
    assertEquals(summary.router.agreementRate, 0.5);
    assertEquals(summary.router.unscoredRows, 0);
    assertEquals(summary.router.corrections, { "QUICK_FIX->PLANNED_CHANGE": 1 });
});

test("checkThresholds reports threshold failures", () => {
    const summary = /** @type {any} */ ({
        router: {
            agreementRate: 0.7,
            meanDistance: 0.4,
        },
    });

    assertEquals(
        checkThresholds(summary, {
            minRouterAgreementRate: 0.75,
            maxRouterMeanDistance: 0.3,
        }),
        [
            "Router agreement 0.7 < threshold 0.75",
            "Router mean distance 0.4 > threshold 0.3",
        ],
    );
});

test("buildBaseline creates suggested Router thresholds", () => {
    const baseline = buildBaseline(
        /** @type {any} */ ({
            labelledRows: 10,
            router: {
                agreementRate: 0.82,
                meanDistance: 0.2,
            },
        }),
        "router-judgements.csv",
    );

    assertEquals(baseline.thresholds, {
        minRouterAgreementRate: 0.77,
        maxRouterMeanDistance: 0.3,
    });
});
