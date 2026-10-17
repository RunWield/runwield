import { assertEquals } from "../src/testing/assertions.ts";
import { test } from "node:test";
import { curateRows, getUnambiguousHumanSeed, isPureGreetingRow } from "./curate-router-judgement-csv.js";

test("isPureGreetingRow identifies greeting rows", () => {
    assertEquals(isPureGreetingRow({ requestText: "hi there" }), true);
    assertEquals(isPureGreetingRow({ requestText: "hello there who are you?" }), false);
});

test("getUnambiguousHumanSeed seeds clear current-intent mappings", () => {
    assertEquals(getUnambiguousHumanSeed({ requestText: "is @ci.js used anywhere?" })?.intent, "INQUIRY");
    assertEquals(getUnambiguousHumanSeed({ requestText: "commit the changes" })?.intent, "OPERATION");
    assertEquals(getUnambiguousHumanSeed({ requestText: "help me flush this out more" }), null);
});

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
