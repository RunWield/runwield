import { makeTempDirectory } from "../../../src/testing/temp-file.ts";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
// Historical audit probe; run explicitly through scripts/run-tests.js.
// See ../2026-09-07-plan-workflow-transitions.md.
import { assertEquals } from "../../../src/testing/assertions.ts";
import { loadPlan } from "../../../src/plan-store.js";
import { HostedSession } from "../../../src/shared/session/hosted-session.js";
import { listPendingWorkflowToolEvents } from "../../../src/shared/workflow/workflow-tool-events.ts";
import { createPlanWrittenTool } from "../../../src/tools/plan-written.ts";

test("AUDIT A1: PROJECT approve-later emits its saved workflow event", async () => {
    const cwd = await makeTempDirectory({ prefix: "epic-save-audit-" });
    await mkdir(`${cwd}/docs/plans`, { recursive: true });
    // Real lifecycle writes require the approval established by Plan Review.
    await writeFile(
        `${cwd}/docs/plans/audit-epic.md`,
        "---\nclassification: PROJECT\nstatus: approved\n---\n# Audit Epic\n",
    );
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd });
    hostedSession.setInteractionAdapter({
        requestInteraction: async (request) => {
            if (request.type === "approval") return { outcome: "canceled", value: false };
            const plan = await loadPlan(cwd, "audit-epic");
            return {
                outcome: "accepted",
                _meta: { approved: true, revision: plan?.revision, approvalAction: "later" },
            };
        },
    });
    const tool = createPlanWrittenTool({
        hostedSession,
        agentName: "architect",
        triageMeta: { classification: "PROJECT", complexity: "MEDIUM", summary: "Audit save event", affectedPaths: [] },
    });
    try {
        const result = await tool.execute(
            "audit-epic-save",
            { planName: "audit-epic" },
            new AbortController().signal,
            () => {},
            {},
        );
        const plan = await loadPlan(cwd, "audit-epic");
        const events = listPendingWorkflowToolEvents(hostedSession);
        console.log(
            "AUDIT A1",
            JSON.stringify({
                outcome: result.details?.outcome,
                status: plan?.attrs.status,
                events: events.map((event) => event.kind),
            }),
        );
        assertEquals(result.details?.outcome, "saved");
        assertEquals(plan?.attrs.status, "ready_for_decomposition");
        assertEquals(
            events.some((event) => event.kind === "plan_written" && event.payload.outcome === "saved"),
            true,
        );
    } finally {
        hostedSession.dispose();
        await rm(cwd, { recursive: true });
    }
});
