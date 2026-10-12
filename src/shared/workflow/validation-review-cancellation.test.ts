import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { loadPlan } from "../../plan-store.js";
import { HostedSession } from "../session/hosted-session.js";
import { createTuiInteractionAdapter } from "../../ui/tui/runtime-interaction-adapter.js";
import { readDeliveryEvidence } from "./delivery-evidence.ts";
import { normalizeHumanReview } from "./validation-human-review.ts";
import {
    attachRecorder,
    makeUi,
    makeValidationProjectRoot,
    NO_ISOLATED_AGENT_PORT,
    runValidationPhase,
} from "./validation-test-helpers.js";

for (
    const response of [
        { outcome: "canceled", message: "Interaction canceled." },
        {
            outcome: "selected",
            _meta: {
                canceled: true,
                approved: true,
                feedback: "Unsubmitted draft",
                images: [{ base64: "ZHJhZnQ=", mimeType: "image/png" }],
                conversationTurn: true,
            },
        },
        { outcome: "selected", _meta: { exit: true, feedback: "Unsubmitted draft", annotations: [{ text: "draft" }] } },
    ] as const
) {
    Deno.test(`Code Review cancellation overrides decision data: ${JSON.stringify(response)}`, () => {
        const review = normalizeHumanReview(response);
        assertEquals(review.approved, false);
        assertEquals(review.feedback, "");
        assertEquals(review.annotations, []);
        assertEquals(review.images, []);
        assertEquals(review.canceled, true);
        assertEquals(review.conversationTurn, false);
    });
}

Deno.test("real broker cancellation twice preserves review for a fresh Session and HTTP approval", async () => {
    const projectRoot = await makeValidationProjectRoot("p", {
        classification: "QUICK_FIX",
        status: "reviewed",
        humanReviewMode: "always",
        humanReviewDecision: null,
    });
    const urls: string[] = [];
    for (let round = 0; round < 3; round++) {
        const ui = makeUi();
        const session = attachRecorder(new HostedSession({ id: crypto.randomUUID(), cwd: projectRoot }), ui);
        const plan = await loadPlan(projectRoot, "p");
        assertExists(plan);
        session.setActiveExecutionWorkflow({
            planName: "p",
            triageMeta: plan.attrs,
            executionAgent: "engineer",
            projectRoot,
            executionCwd: projectRoot,
            nonGitInPlace: true,
        });
        const events: Array<{ type: string; outcome?: string; message?: string }> = [];
        const unsubscribe = session.subscribeRuntimeEvents((event) => {
            events.push({
                type: event.type,
                message: "message" in event && typeof event.message === "string" ? event.message : undefined,
            });
        });
        const opened = Promise.withResolvers<string>();
        const adapter = createTuiInteractionAdapter(ui, {
            browser: {
                open: (url) => {
                    opened.resolve(url);
                    return Promise.resolve(false);
                },
            },
        });
        session.setInteractionAdapter(adapter);
        const phase = runValidationPhase({
            hostedSession: session,
            planName: "p",
            planContent: plan.body,
            triageMeta: plan.attrs,
            semanticReviewPort: NO_ISOLATED_AGENT_PORT,
        });
        const url = await opened.promise;
        urls.push(url);
        const parsed = new URL(url);
        const token = parsed.searchParams.get("token") || "";
        const live = await fetch(new URL(`/api/review/conversation?token=${token}`, parsed.origin));
        assertEquals(live.status, 200, "the reopened link must serve the real review surface");
        await live.text();
        assertStringIncludes(ui.toolOutputs.join("\n"), `Review Code: \x1b]8;;${url}`);
        if (round < 2) {
            assertEquals(session.cancelActiveInteractions(), true);
        } else {
            const approved = await fetch(new URL(`/api/review/decision?token=${token}`, parsed.origin), {
                method: "POST",
                headers: { "content-type": "application/json", "x-runwield-review-token": token },
                body: JSON.stringify({ approved: true }),
            });
            assertEquals(approved.ok, true);
            await approved.text();
        }
        const result = await phase;
        unsubscribe();
        const saved = await loadPlan(projectRoot, "p");
        assertExists(saved);
        assertEquals(saved.attrs.status, "reviewed");
        const evidence = await readDeliveryEvidence(projectRoot, "p", "in-place");
        assertEquals(evidence.entries.filter((entry) => entry.kind === "human-revision").length, 0);
        if (round < 2) {
            assertEquals(saved.attrs.humanReviewDecision, null);
            assertEquals(evidence.entries.filter((entry) => entry.kind === "human").length, 0);
            assertEquals(
                events.some((event) =>
                    event.type === "interaction_canceled" && event.message === "Interaction canceled."
                ),
                true,
            );
            assertStringIncludes(result.reason || "", "pending");
        } else {
            assertEquals(saved.attrs.humanReviewDecision, "approved");
            assertEquals(evidence.entries.filter((entry) => entry.kind === "human").map((entry) => entry.outcome), [
                "Approved",
            ]);
        }
    }
    assertEquals(new Set(urls).size, 3, "resume must present each current live URL");
});
