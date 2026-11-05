import { test } from "node:test";
import { assertEquals } from "../src/testing/assertions.ts";
import { buildJudgementCsv } from "./write-router-judgement-csv.js";
import { parseCsv } from "./router-eval-utils.ts";

test("serialized judgement CSV retains human corrections and Router disagreement metrics", () => {
    const [row] = parseCsv(
        buildJudgementCsv(
            [
                {
                    decisionId: "d1",
                    timestamp: "now",
                    attribution: "active_agent_router",
                    requestText: "add version command",
                    routingIntent: "QUICK_FIX",
                    summary: "add version output",
                    affectedPaths: ["src/cmd/version/index.js"],
                },
            ],
            [{ decisionId: "d1", humanJudgement: "FEATURE", humanNotes: "manual correction" }],
        ),
    );

    assertEquals(row.humanJudgement, "PLANNED_CHANGE");
    assertEquals(row.routerAgreesWithHuman, "FALSE");
    assertEquals(row.routerCorrection, "QUICK_FIX->PLANNED_CHANGE");
    assertEquals(row.routerDistanceFromHuman, "1");
    assertEquals(row.routerDisagreementKind, "scope_underestimated");
    assertEquals(row.routerSummary, "add version output");
    assertEquals(row.routerAffectedPaths, "src/cmd/version/index.js");
});

test("buildJudgementCsv preserves existing human judgement cells", () => {
    const csv = buildJudgementCsv(
        [
            {
                decisionId: "d1",
                timestamp: "now",
                attribution: "active_agent_router",
                requestText: "hi",
                routingIntent: "INQUIRY",
            },
        ],
        [{ decisionId: "d1", humanJudgement: "INQUIRY", humanNotes: "clear" }],
    );

    const rows = parseCsv(csv);
    assertEquals(rows[0].humanJudgement, "INQUIRY");
    assertEquals(rows[0].humanNotes, "clear");
    assertEquals(rows[0].routerAgreesWithHuman, "TRUE");
});

test("buildJudgementCsv preserves existing repository context pins", () => {
    const contextCommit = "a".repeat(40);
    const csv = buildJudgementCsv(
        [{ decisionId: "d1", requestText: "check the code", routingIntent: "INQUIRY" }],
        [{ decisionId: "d1", humanJudgement: "INQUIRY", contextCommit }],
    );
    assertEquals(parseCsv(csv)[0].contextCommit, contextCommit);
});
