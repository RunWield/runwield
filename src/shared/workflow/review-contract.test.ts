import { test } from "node:test";
import { assertEquals, assertExists, assertStringIncludes } from "../../testing/assertions.ts";
import { HostedSession } from "../session/hosted-session.js";
import { makeToolProjectFixture } from "../../testing/workflow-metrics-fixture.ts";
import { createReviewCompletedTool } from "../../tools/review-complete.ts";
import { createReviewDiffTool, parseDiffFiles } from "./review-diff-tool.js";
import { ReviewInspection } from "./review-inspection.ts";
import { applyRoundFindings, claimReviewFixes, createLedger, normalizeLedger, openItems } from "./review-ledger.ts";
import { buildSemanticReviewAttempt, reviewFindingMetrics } from "./validation-semantic.ts";
import { createValidationSessionPort } from "./validation-session-adapter.ts";
import { executeWorkflowTestTools } from "../../testing/workflow-agent-tools.ts";

const ROOT = makeToolProjectFixture("review-contract-");
type CoreToolExecute<Params, Result> = (id: string, params: Params) => Result;

// These core tools do not consume Pi extension context. Keep their real execution and result types.
function diffTool(...args: Parameters<typeof createReviewDiffTool>) {
    const tool = createReviewDiffTool(...args);
    return {
        ...tool,
        execute: tool.execute as CoreToolExecute<Parameters<typeof tool.execute>[1], ReturnType<typeof tool.execute>>,
    };
}

function completionTool(...args: Parameters<typeof createReviewCompletedTool>) {
    const tool = createReviewCompletedTool(...args);
    return {
        ...tool,
        execute: tool.execute as CoreToolExecute<Parameters<typeof tool.execute>[1], ReturnType<typeof tool.execute>>,
    };
}
const DIFF = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/b.ts b/b.ts
deleted file mode 100644
--- a/b.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
`;

function setup(scope: "full" | "repair" = "full") {
    const files = parseDiffFiles(DIFF);
    const inspection = new ReviewInspection(
        files.map((file) => ({ scope, path: file.path, byteLength: file.byteLength })),
    );
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: ROOT });
    const diff = diffTool({ full: DIFF, repair: DIFF }, { inspection });
    const complete = completionTool({ hostedSession, inspection });
    return { files, inspection, hostedSession, diff, complete };
}

for (const approved of [true, false]) {
    test(`completion refuses ${approved ? "approval" : "rejection"} until every chunk is read`, async () => {
        const { files, inspection, hostedSession, diff, complete } = setup();
        try {
            await diff.execute("list", { command: "list" });
            await diff.execute("bad", { command: "show", path: "missing.ts" });
            await diff.execute("end", { command: "show", path: "a.ts", offsetBytes: 99999 });
            await diff.execute("wrong-scope", { command: "show", scope: "repair", path: "a.ts" });
            const args = { approved, findings: approved ? [] : [{ title: "Concrete defect", status: "new" as const }] };
            let result = await complete.execute("early", args);
            assertEquals(result.terminate, false);
            assertEquals(inspection.unread().length, 2);
            const content = result.content[0];
            assertEquals(content.type, "text");
            if (content.type === "text") {
                assertStringIncludes(content.text, "b.ts");
                assertStringIncludes(content.text, '"offsetBytes":0');
            }
            const size = files[0].byteLength;
            // Read out of order and overlap. Only the actual missing interval matters.
            await diff.execute("tail", { command: "show", path: "a.ts", offsetBytes: 20 });
            await diff.execute("tail-again", { command: "show", path: "a.ts", offsetBytes: 20 });
            assertEquals(inspection.unread()[0].start, 0);
            assertEquals(inspection.unread()[0].end, 20);
            await diff.execute("head", { command: "show", path: "a.ts", maxBytes: size });
            result = await complete.execute("still-incomplete", args);
            assertEquals(result.terminate, false);
            assertEquals(inspection.unread().map((span) => span.path), ["b.ts"]);
            await diff.execute("deleted-file", { command: "show", path: "b.ts" });
            result = await complete.execute("done", args);
            assertEquals(result.terminate, true);
        } finally {
            hostedSession.dispose();
        }
    });
}

test("repair coverage requires repair reads, with precise 64KiB continuation", async () => {
    const large = DIFF + "+" + "é".repeat(40000) + "\n";
    const files = parseDiffFiles(large);
    const inspection = new ReviewInspection(
        files.map((file) => ({ scope: "repair", path: file.path, byteLength: file.byteLength })),
    );
    const diff = diffTool({ full: large, repair: large }, { inspection });
    for (const file of files) await diff.execute("full", { command: "show", path: file.path });
    assertEquals(inspection.unread().length, 2);
    let nextOffsetBytes = 0;
    for (const file of files) {
        const result = await diff.execute("repair", { command: "show", scope: "repair", path: file.path });
        if (result.details?.truncated) nextOffsetBytes = Number(result.details.nextOffsetBytes);
    }
    const remaining = inspection.unread();
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].start, nextOffsetBytes);
    assertStringIncludes(inspection.feedback(), `"offsetBytes":${nextOffsetBytes}`);
    await diff.execute("rest", {
        command: "show",
        scope: "repair",
        path: remaining[0].path,
        offsetBytes: nextOffsetBytes,
    });
    assertEquals(inspection.unread(), []);
});

test("coverage includes quoted paths and prefers exact paths over suffix matches", async () => {
    const quoted = String.raw`diff --git "a/caf\303\251.ts" "b/caf\303\251.ts"
--- "a/caf\303\251.ts"
+++ "b/caf\303\251.ts"
@@ -1 +1 @@
-old
+new
`;
    const diffText = DIFF.replaceAll("a.ts", "nested/a.ts").replaceAll("b.ts", "nested/b.ts") + DIFF + quoted;
    const files = parseDiffFiles(diffText);
    assertEquals(files.map((file) => file.path), ["nested/a.ts", "nested/b.ts", "a.ts", "b.ts", "café.ts"]);
    const inspection = new ReviewInspection(
        files.map((file) => ({ scope: "full", path: file.path, byteLength: file.byteLength })),
    );
    const tool = diffTool({ full: diffText }, { inspection });
    await tool.execute("exact", { command: "show", path: "a.ts" });
    assertEquals(inspection.unread().some((span) => span.path === "a.ts"), false);
    assertEquals(inspection.unread().some((span) => span.path === "nested/a.ts"), true);
    for (const file of files) await tool.execute("read", { command: "show", path: file.path });
    assertEquals(inspection.unread(), []);
});

test("issue state retains its identity across claimed, rejected, reclaimed and confirmed repairs", () => {
    const initial = applyRoundFindings(createLedger(), [{
        title: "Missing guard",
        requirement: "Step 1",
        evidence: "a.ts",
        resolved: false,
    }], 1).ledger;
    assertEquals(initial.items[0].status, "new");
    const claimed = claimReviewFixes(initial);
    assertEquals(claimed.items[0].status, "fix_claimed");
    const id = claimed.items[0].id;
    const rejected = applyRoundFindings(claimed, [{
        id,
        resolved: false,
        status: "fix_rejected",
        rejectionReason: "The empty case remains unguarded.",
        title: "Missing guard",
        requirement: "Step 1",
        evidence: "a.ts",
    }], 2).ledger;
    const restored = normalizeLedger(JSON.parse(JSON.stringify(rejected)));
    assertEquals(restored.items[0].status, "fix_rejected");
    assertStringIncludes(restored.items[0].rejectionReason || "", "empty case");
    assertEquals(openItems(restored).length, 1);
    const confirmed = applyRoundFindings(claimReviewFixes(restored), [{
        id,
        resolved: true,
        status: "fix_confirmed",
        title: "Missing guard",
        requirement: "Step 1",
        evidence: "a.ts",
    }], 3).ledger;
    assertEquals(confirmed.items.length, 1);
    assertEquals(confirmed.items[0].id, id);
    assertEquals(confirmed.items[0].status, "fix_confirmed");
    assertEquals(openItems(confirmed), []);
    assertEquals(claimReviewFixes(confirmed).items[0].status, "fix_confirmed");
});

test("review completion requires valid identities and a reason for rejected fixes", async () => {
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: ROOT });
    const ledger = applyRoundFindings(createLedger(), [{
        title: "Guard",
        requirement: "Step 1",
        evidence: "a.ts",
        resolved: false,
    }], 1).ledger;
    const tool = completionTool({ hostedSession, ledger });
    try {
        assertEquals((await tool.execute("omit", { approved: true })).terminate, false);
        assertEquals(
            (await tool.execute("reason", {
                approved: false,
                findings: [{ id: "R1-1", title: "Guard", status: "fix_rejected" }],
            })).terminate,
            false,
        );
        assertEquals(
            (await tool.execute("identity", {
                approved: true,
                findings: [{ id: "R7-9", title: "Guard", status: "fix_confirmed" }],
            })).terminate,
            false,
        );
        // Diagnostic attribution does not change acceptance or become a ledger state.
        assertEquals(
            (await tool.execute("classified", {
                approved: false,
                findings: [
                    { id: "R1-1", title: "Guard", status: "fix_confirmed" },
                    { title: "Old unrelated issue", status: "new", origin: "missed_original" },
                ],
            })).terminate,
            true,
        );
        const result = await tool.execute("reject", {
            approved: false,
            findings: [{
                id: "R1-1",
                title: "Guard",
                status: "fix_rejected",
                rejectionReason: "Empty input remains unguarded.",
            }],
        });
        assertEquals(result.terminate, true);
        assertEquals(result.details.outcome, "feedback");
    } finally {
        hostedSession.dispose();
    }
});

test("normal session binding enforces coverage and supplies the Plan without losing receipts between calls", async () => {
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd: ROOT });
    const inspection = new ReviewInspection(
        parseDiffFiles(DIFF).map((file) => ({ scope: "full", path: file.path, byteLength: file.byteLength })),
    );
    const state = {
        semanticRound: 2,
        reviewLedger: createLedger(),
        repairBaselineTree: "before",
        lastRepairReport: "Report",
    };
    const config = buildSemanticReviewAttempt(
        1,
        undefined,
        state,
        "discovery",
        DIFF,
        DIFF,
        "# Approved\nPreserve empty selection.",
        inspection,
    );
    let invoked = false;
    const port = createValidationSessionPort(hostedSession, {
        semanticReviewPort: {
            runIsolatedAgentSession: async (options) => {
                invoked = true;
                assertStringIncludes(options.userRequest, "Preserve empty selection.");
                await executeWorkflowTestTools(options, [{ name: "review_diff", arguments: { command: "list" } }, {
                    name: "review_complete",
                    arguments: { approved: true },
                }]);
                assertEquals(inspection.unread().length, 2);
                await executeWorkflowTestTools(options, [
                    { name: "review_diff", arguments: { command: "show", path: "a.ts" } },
                    { name: "review_diff", arguments: { command: "show", path: "b.ts" } },
                    { name: "review_complete", arguments: { approved: true } },
                ]);
                return [];
            },
        },
    });
    try {
        const result = await port.runIsolatedAgentSession({
            kind: "reviewer",
            agentName: "reviewer",
            reviewerMode: "discovery",
            userRequest: config.prompt,
            cwd: ROOT,
            customTools: config.customTools,
            sessionManager: port.createInMemorySessionManager(ROOT),
        });
        assertEquals(invoked, true);
        assertEquals(result.outcome, "completed");
        assertEquals(inspection.unread(), []);
        if (result.outcome === "completed") assertExists(result.reviewOutcome);
    } finally {
        hostedSession.dispose();
    }
});

test("finding origin metrics stay separate from repair status", () => {
    const base = { title: "Issue", requirement: "Step", evidence: "a.ts", resolved: false };
    assertEquals(
        reviewFindingMetrics([
            { ...base, origin: "missed_original" },
            { ...base, origin: "repair_regression" },
            { ...base, id: "R1-1", status: "fix_rejected" },
            { ...base, id: "R1-2", resolved: true },
        ], 2),
        {
            initialFindingCount: 0,
            missedOriginalCount: 1,
            repairRegressionCount: 1,
            unclassifiedNewCount: 0,
            existingStillOpenCount: 1,
            fixConfirmedCount: 1,
        },
    );
    assertEquals(reviewFindingMetrics([base], 2).unclassifiedNewCount, 1);
    assertEquals(reviewFindingMetrics([base], 1).initialFindingCount, 1);
});
