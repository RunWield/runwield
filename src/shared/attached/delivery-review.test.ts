import { startReviewWorkspaceServer } from "../../review-workspace-server.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { attachedValidationFixture } from "./validation-test-fixture.ts";
import { toDelivery } from "./delivery-test-fixture.ts";
import { applyAttachedCodeReviewDecision } from "./code-review-decision.ts";
import { listWorkRecords, writeWorkRecord } from "../work-records/store.js";

for (const answer of ["open", "skip"]) {
    Deno.test(`Attached ask code review honors ${answer}`, async () => {
        const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "ask" } });
        try {
            const offered = await toDelivery(fixture);
            assert(offered.workflow.nextAction.kind === "validation");
            assert(offered.workflow.nextAction.request.kind === "decision");
            const answered = await fixture.call("validation_decision", offered.workflow, {
                actionId: offered.workflow.nextAction.actionId,
                answer: { outcome: "selected", value: answer },
            });
            assert(answered.ok, JSON.stringify(answered));
            assertEquals(answered.workflow.nextAction.kind, answer === "open" ? "code_review" : "recorder");
        } finally {
            await fixture.close();
        }
    });
}

Deno.test("Attached browser feedback preserves images for the Claude repair", async () => {
    const fixture = await attachedValidationFixture();
    try {
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "code_review");
        const image = join(fixture.parent, "feedback.png");
        await Deno.writeFile(
            image,
            Uint8Array.from(
                atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHuoAAAAASUVORK5CYII="),
                (char) => char.charCodeAt(0),
            ),
        );
        await applyAttachedCodeReviewDecision(
            fixture.root,
            started.workflow.workflowId,
            started.workflow.nextAction.actionId,
            {
                approved: false,
                feedback: "",
                annotations: [{ images: [{ path: image, name: "reference" }] }],
            },
        );
        const status = await fixture.status();
        assert(status.nextAction.kind === "validation" && status.nextAction.request.kind === "repair");
        assertStringIncludes(status.nextAction.request.prompt, image);
        await Deno.writeTextFile(join(fixture.cwd, "implementation.ts"), "export const value = 3;\n");
        const repaired = await fixture.call("task_completed", status, {
            actionId: status.nextAction.actionId,
            message: "- Applied the image reference.",
        });
        assert(repaired.ok && repaired.workflow.nextAction.kind === "code_review", JSON.stringify(repaired));
        assertEquals(await fixture.ciCount(), 2);
    } finally {
        await fixture.close();
    }
});

Deno.test("Attached delivery leaves valid supersession proposals for wld wr supersede", async () => {
    const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "none" } });
    try {
        const oldId = crypto.randomUUID();
        await writeWorkRecord(fixture.cwd, {
            kind: "work_record",
            recordId: oldId,
            status: "approved",
            scope: "planned_change",
            workKind: "FEATURE",
            origin: "internal",
            completionMode: "verified",
            createdAt: "2026-01-01T00:00:00.000Z",
            provenance: { sourcePlans: [crypto.randomUUID()] },
        }, "# Previous value\n\n## Summary\n\nThe old value was implemented.\n");
        const started = await toDelivery(fixture);
        assert(started.workflow.nextAction.kind === "recorder");
        const completed = await fixture.call("work_record_completed", started.workflow, {
            actionId: started.workflow.nextAction.actionId,
            title: "New value",
            summary: "Implemented the new value.",
            supersessionProposals: [{ recordId: oldId, reason: "The new value replaces the old one." }],
        });
        assert(completed.ok && completed.workflow.nextAction.kind === "delivered", JSON.stringify(completed));
        assertStringIncludes(completed.workflow.nextAction.guidance, "wld wr supersede");
        const records = await listWorkRecords(fixture.root);
        assertEquals(records.find((record) => record.attrs.recordId === oldId)?.attrs.status, "approved");
        assertEquals(
            records.find((record) => record.attrs.recordId !== oldId)?.attrs.supersessionProposal?.candidates,
            [{ recordId: oldId, reason: "The new value replaces the old one." }],
        );
    } finally {
        await fixture.close();
    }
});

Deno.test("Attached code review cannot launch a Core Guided Review model turn", async () => {
    const fixture = await attachedValidationFixture();
    const token = crypto.randomUUID();
    const server = startReviewWorkspaceServer({
        cwd: fixture.cwd,
        token,
        reviewType: "code",
        reviewPayload: { rawPatch: "", agentTurnOwner: "host" },
    });
    try {
        const capabilitiesUrl = new URL("/api/agents/capabilities", server.url);
        capabilitiesUrl.searchParams.set("token", token);
        const capabilities = await fetch(capabilitiesUrl);
        assertEquals((await capabilities.json()).available, false);
        const jobsUrl = new URL("/api/agents/jobs", server.url);
        jobsUrl.searchParams.set("token", token);
        const job = await fetch(jobsUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "guide" }),
        });
        assertEquals(job.status, 403);
        assertStringIncludes((await job.json()).error, "Claude Code owns agent turns");
    } finally {
        server.stop();
        await fixture.close();
    }
});

Deno.test("closing the ask Code Review offer leaves a fresh choice on continuation", async () => {
    const fixture = await attachedValidationFixture({ attrs: { humanReviewMode: "ask" } });
    try {
        const offered = await toDelivery(fixture);
        assert(offered.workflow.nextAction.kind === "validation");
        const closed = await fixture.call("validation_decision", offered.workflow, {
            actionId: offered.workflow.nextAction.actionId,
            answer: { outcome: "selected", value: "close" },
        });
        assert(closed.ok && closed.workflow.nextAction.kind === "validation_recovery", JSON.stringify(closed));
        const resumed = await fixture.call("start_validation", closed.workflow);
        assert(resumed.ok && resumed.workflow.nextAction.kind === "validation", JSON.stringify(resumed));
        assertEquals(resumed.workflow.nextAction.request.kind, "decision");
        assert(resumed.workflow.nextAction.actionId !== offered.workflow.nextAction.actionId);
        const opened = await fixture.call("validation_decision", resumed.workflow, {
            actionId: resumed.workflow.nextAction.actionId,
            answer: { outcome: "selected", value: "open" },
        });
        assert(opened.ok && opened.workflow.nextAction.kind === "code_review", JSON.stringify(opened));
        assertEquals(await fixture.ciCount(), 1);
    } finally {
        await fixture.close();
    }
});
