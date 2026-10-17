import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { buildJudgementCsv, buildJudgementCsvRow, parseJsonlRows } from "./write-router-judgement-csv.js";
import { parseCsv } from "./router-eval-utils.js";

test("buildJudgementCsvRow adds human columns and Router disagreement metrics", () => {
    const row = buildJudgementCsvRow(
        {
            decisionId: "d1",
            timestamp: "now",
            attribution: "active_agent_router",
            requestText: "add version command",
            routingIntent: "QUICK_FIX",
            summary: "add version output",
            affectedPaths: ["src/cmd/version/index.js"],
        },
        { decisionId: "d1", humanJudgement: "FEATURE", humanNotes: "manual correction" },
    );

    assertEquals(row.humanJudgement, "PLANNED_CHANGE");
    assertEquals(row.routerAgreesWithHuman, "FALSE");
    assertEquals(row.routerCorrection, "QUICK_FIX->PLANNED_CHANGE");
    assertEquals(row.routerDistanceFromHuman, 1);
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

test("parseJsonlRows reads reviewed rows", () => {
    const rows = parseJsonlRows('{"decisionId":"d1"}\n{"decisionId":"d2"}\n');
    assertEquals(
        rows.map((row) => row.decisionId),
        ["d1", "d2"],
    );
});

test("buildJudgementCsv includes expected headers", () => {
    const csv = buildJudgementCsv([]);
    assertStringIncludes(csv, "humanJudgement");
    assertStringIncludes(csv, "routerDistanceFromHuman");
});
