import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import { curateRows } from "./curate-router-judgement-csv.ts";

test("curateRows collapses duplicate greetings and preserves existing human labels", () => {
    const result = curateRows([
        { decisionId: "d1", requestText: "hi", humanJudgement: "", humanNotes: "" },
        { decisionId: "d2", requestText: "hello", humanJudgement: "", humanNotes: "" },
        { decisionId: "d3", requestText: "commit the changes", humanJudgement: "FEATURE", humanNotes: "manual" },
    ]);

    assertEquals(result.removedGreetings, 1);
    assertEquals(result.seededHumanJudgements, 1);
    assertEquals(
        result.rows.map((row) => row.decisionId),
        ["d1", "d3"],
    );
    assertEquals(result.rows[0].humanJudgement, "INQUIRY");
    assertEquals(result.rows[1].humanJudgement, "FEATURE");
    assertEquals(result.rows[1].humanNotes, "manual");
});

test("curation keeps substantive requests and seeds only unambiguous unlabelled intent", () => {
    const result = curateRows([
        { decisionId: "greeting", requestText: "hi there" },
        { decisionId: "question", requestText: "hello there who are you?" },
        { decisionId: "inquiry", requestText: "is @ci.js used anywhere?" },
        { decisionId: "operation", requestText: "commit the changes" },
        { decisionId: "ambiguous", requestText: "help me flush this out more" },
    ]);
    assertEquals(result.removedGreetings, 0);
    assertEquals(result.seededHumanJudgements, 4);
    assertEquals(
        result.rows.map((row) => [row.decisionId, row.humanJudgement ?? ""]),
        [
            ["greeting", "INQUIRY"],
            ["question", "INQUIRY"],
            ["inquiry", "INQUIRY"],
            ["operation", "OPERATION"],
            ["ambiguous", ""],
        ],
    );
});
