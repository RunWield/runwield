import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import {
    buildRouterGoldenReport,
    createBenchmarkBashNudgeTool,
    main,
    mergeGoldenRowsWithResultRows,
    runRouterForGoldenRequest,
    runRouterGoldenSet,
    runRouterGoldenSetWithSelection,
} from "./run-router-golden-set.js";

type GoldenRows = Awaited<ReturnType<typeof runRouterGoldenSet>>;
type BenchmarkToolContext = Parameters<ReturnType<typeof createBenchmarkBashNudgeTool>["execute"]>[4];

test("benchmark resume preserves completed rows while normalizing legacy labels and metrics", async () => {
    assertEquals(
        (
            await runRouterGoldenSet(
                [
                    {
                        requestText: "fix it",
                        routerDecision: "QUICK_FIX",
                        humanJudgement: "FEATURE",
                    },
                ],
                {
                    resume: true,
                    runAgentSession: () => {
                        throw new Error("Completed row must not rerun");
                    },
                },
            )
        )[0],
        {
            decisionId: "golden-0001",
            timestamp: "",
            attribution: "golden_fixture",
            requestText: "fix it",
            routerDecision: "QUICK_FIX",
            humanJudgement: "PLANNED_CHANGE",
            humanNotes: "",
            routerSummary: "",
            routerAffectedPaths: "",
            contextCommit: "",
            routerAgreesWithHuman: "FALSE",
            routerCorrection: "QUICK_FIX->PLANNED_CHANGE",
            routerDistanceFromHuman: 1,
            routerDisagreementKind: "scope_underestimated",
        },
    );
});

test("runRouterForGoldenRequest returns latest triage_report outcome", async () => {
    let capturedToolNames: string[] | undefined;
    let capturedCustomToolNames: string[] | undefined;
    const triage = await runRouterForGoldenRequest("where is router?", {
        runAgentSession: (opts) => {
            capturedToolNames = opts.toolNames;
            capturedCustomToolNames = opts.customTools?.map((tool) => tool.name);
            return Promise.resolve([
                {
                    role: "toolResult",
                    toolName: "triage_report",
                    details: { routingIntent: "OPERATION", summary: "superseded" },
                },
                {
                    role: "toolResult",
                    toolName: "triage_report",
                    details: {
                        routingIntent: "INQUIRY",
                        complexity: "LOW",
                        summary: "answer",
                    },
                },
            ]);
        },
    });

    assertEquals(triage.routingIntent, "INQUIRY");
    assertEquals(capturedToolNames?.includes("triage_report"), true);
    assertEquals(capturedToolNames?.includes("bash"), false);
    assertEquals(capturedCustomToolNames?.includes("bash"), true);
});

test("benchmark bash tool nudges without executing commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "router-no-execution-"));
    const sentinel = join(root, "unexpected.txt");
    const command = `printf executed > ${JSON.stringify(sentinel)}`;
    try {
        const tool = createBenchmarkBashNudgeTool();
        const result = await tool.execute(
            "call-1",
            { command },
            new AbortController().signal,
            () => {},
            {} as BenchmarkToolContext,
        );

        const content = result.content[0];
        assertEquals(result.details.blocked, true);
        assertEquals(result.details.command, command);
        assertEquals(content.type, "text");
        if (content.type !== "text") throw new Error("expected text content");
        assertEquals(content.text.includes("bash is disabled"), true);
        assertEquals(content.text.includes("and the command below was not executed"), true);
        assertEquals(content.text.includes("OPERATION"), false);
        assertEquals(content.text.includes("QUICK_FIX"), false);
        assertEquals(existsSync(sentinel), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("runRouterGoldenSet updates labelled rows and honors limit", async () => {
    const rows = await runRouterGoldenSet(
        [
            { decisionId: "d1", requestText: "hi", humanJudgement: "INQUIRY" },
            { decisionId: "d2", requestText: "fix it", humanJudgement: "QUICK_FIX" },
        ],
        {
            limit: 1,
            runAgentSession: () =>
                Promise.resolve([
                    {
                        role: "toolResult",
                        toolName: "triage_report",
                        details: {
                            routingIntent: "INQUIRY",
                            complexity: "LOW",
                            summary: "greeting",
                        },
                    },
                ]),
        },
    );

    assertEquals(rows[0].routerDecision, "INQUIRY");
    assertEquals(rows[0].routerSummary, "greeting");
    assertEquals(rows[0].routerAffectedPaths, "");
    assertEquals(rows[0].routerAgreesWithHuman, "TRUE");
    assertEquals(rows[1].routerDecision, "");
});

test("runRouterGoldenSetWithSelection returns selected indexes for limited reports", async () => {
    const result = await runRouterGoldenSetWithSelection(
        [
            { decisionId: "d1", requestText: "hi", humanJudgement: "INQUIRY" },
            { decisionId: "d2", requestText: "fix it", humanJudgement: "QUICK_FIX", routerDecision: "QUICK_FIX" },
        ],
        {
            limit: 1,
            runAgentSession: () =>
                Promise.resolve([
                    {
                        role: "toolResult",
                        toolName: "triage_report",
                        details: {
                            routingIntent: "INQUIRY",
                            complexity: "LOW",
                            summary: "greeting",
                        },
                    },
                ]),
        },
    );

    assertEquals(result.selectedIndexes, [0]);
    assertEquals(buildRouterGoldenReport(result.selectedIndexes.map((index) => result.rows[index])), {
        labelledRows: 1,
        unlabelledRows: 0,
        router: {
            total: 1,
            agreementCount: 1,
            agreementRate: 1,
            meanDistance: 0,
            invalidRows: 0,
            unscoredRows: 0,
            corrections: {},
        },
    });
});

test("runRouterGoldenSet clears stale decisions only when rerunning rows", async () => {
    const checkpoints: GoldenRows[] = [];
    const rows = await runRouterGoldenSet(
        [
            {
                decisionId: "d1",
                requestText: "hi",
                humanJudgement: "INQUIRY",
                routerDecision: "QUICK_FIX",
                routerSummary: "old summary",
                routerAffectedPaths: "old.js",
            },
        ],
        {
            resume: false,
            runAgentSession: () => new Promise<GoldenRows>(() => {}),
            rowTimeoutMs: 1,
            onRowComplete: (checkpointRows) => {
                checkpoints.push(checkpointRows.map((row) => ({ ...row })));
            },
        },
    );

    assertEquals(rows[0].routerDecision, "");
    assertEquals(rows[0].routerSummary, "ERROR: Router golden row timed out after 1ms.");
    assertEquals(rows[0].routerAffectedPaths, "");
    assertEquals(checkpoints[0][0].routerDecision, "");
});

test("runRouterGoldenSet resume skips completed rows and runs unfinished rows", async () => {
    const requests: string[] = [];
    const result = await runRouterGoldenSetWithSelection(
        [
            {
                decisionId: "d1",
                requestText: "hi",
                humanJudgement: "INQUIRY",
                routerDecision: "INQUIRY",
                routerSummary: "done",
            },
            {
                decisionId: "d2",
                requestText: "fix it",
                humanJudgement: "QUICK_FIX",
                routerDecision: "",
                routerSummary: "ERROR: timed out",
            },
        ],
        {
            resume: true,
            runAgentSession: (opts) => {
                requests.push(opts.userRequest);
                return Promise.resolve([
                    {
                        role: "toolResult",
                        toolName: "triage_report",
                        details: {
                            routingIntent: "QUICK_FIX",
                            complexity: "LOW",
                            summary: "fixed route",
                        },
                    },
                ]);
            },
        },
    );

    assertEquals(result.selectedIndexes, [1]);
    assertEquals(requests, ["fix it"]);
    assertEquals(result.rows[0].routerDecision, "INQUIRY");
    assertEquals(result.rows[0].routerSummary, "done");
    assertEquals(result.rows[1].routerDecision, "QUICK_FIX");
    assertEquals(result.rows[1].routerSummary, "fixed route");
});

test("mergeGoldenRowsWithResultRows keeps labels from the golden rows and completed router results", () => {
    const rows = mergeGoldenRowsWithResultRows(
        [
            { decisionId: "d1", requestText: "hi", humanJudgement: "INQUIRY" },
            { decisionId: "d2", requestText: "fix it", humanJudgement: "QUICK_FIX" },
        ],
        [
            {
                decisionId: "d1",
                requestText: "old",
                humanJudgement: "PROJECT",
                routerDecision: "INQUIRY",
                routerSummary: "done",
            },
        ],
    );

    assertEquals(rows, [
        {
            decisionId: "d1",
            requestText: "hi",
            humanJudgement: "INQUIRY",
            routerDecision: "INQUIRY",
            routerSummary: "done",
            routerAffectedPaths: "",
        },
        {
            decisionId: "d2",
            requestText: "fix it",
            humanJudgement: "QUICK_FIX",
            routerDecision: "",
            routerSummary: "",
            routerAffectedPaths: "",
        },
    ]);
});

test("buildRouterGoldenReport scores router decisions", () => {
    assertEquals(
        buildRouterGoldenReport([
            { humanJudgement: "INQUIRY", routerDecision: "INQUIRY" },
            { humanJudgement: "FEATURE", routerDecision: "QUICK_FIX" },
            { humanJudgement: "", routerDecision: "PROJECT" },
        ]),
        {
            labelledRows: 2,
            unlabelledRows: 1,
            router: {
                total: 2,
                agreementCount: 1,
                agreementRate: 0.5,
                meanDistance: 0.5,
                invalidRows: 0,
                unscoredRows: 0,
                corrections: { "QUICK_FIX->PLANNED_CHANGE": 1 },
            },
        },
    );
});

test("router benchmark rejects invalid thinking levels before reading the dataset", async () => {
    await assertRejects(() => main(["--thinking-level", "invalid"]), Error, "Invalid --thinking-level");
});

test("router benchmark rejects invalid temperatures before reading the dataset", async () => {
    for (const temperature of ["", "NaN", "Infinity", "-0.1", "2.1"]) {
        await assertRejects(() => main(["--temperature", temperature]), Error, "Invalid --temperature");
    }
});
