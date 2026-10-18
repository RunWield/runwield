import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { assertEquals } from "../testing/assertions.ts";
import { test } from "node:test";
/**
 * @module acp/interaction-mapper.test
 */

import { createAcpInteractionAdapter } from "./interaction-mapper.js";

test("ACP interaction adapter does not expose the obsolete Pair form", async () => {
    /** @type {unknown[]} */
    const requests = [];
    const adapter = createAcpInteractionAdapter({
        acpSessionId: "acp-1",
        clientCapabilities: { elicitation: { form: {} } },
        context: {
            request: (/** @type {unknown} */ request) => {
                requests.push(request);
                return Promise.resolve({ action: "accept", content: { answer: "continue" } });
            },
        },
    });
    assertEquals(adapter.supportsInteraction?.("pair_checkpoint"), false);
    assertEquals(
        await adapter.requestInteraction({
            id: "interaction-pair",
            type: "pair_checkpoint",
            prompt: "Review the increment",
        }),
        {
            outcome: "unsupported",
            message: "Pair checkpoints use ordinary ACP prompts, not structured interactions.",
        },
    );
    assertEquals(requests, []);
});

test("ACP interaction adapter maps valid selections and rejects invalid ones", async () => {
    const accepted = createAcpInteractionAdapter({
        acpSessionId: "acp-1",
        clientCapabilities: { elicitation: { form: {} } },
        context: { request: () => Promise.resolve({ action: "accept", content: { answer: "yes" } }) },
    });
    assertEquals(
        await accepted.requestInteraction({
            id: "interaction-1",
            type: "select",
            prompt: "Proceed?",
            options: [
                { value: "yes", label: "Yes" },
                { value: "no", label: "No" },
            ],
        }),
        { outcome: "selected", value: "yes", valueLabel: "Yes" },
    );

    const invalid = createAcpInteractionAdapter({
        acpSessionId: "acp-1",
        clientCapabilities: { elicitation: { form: {} } },
        context: { request: () => Promise.resolve({ action: "accept", content: { answer: "invalid" } }) },
    });
    const response = await invalid.requestInteraction({
        id: "interaction-2",
        type: "select",
        prompt: "Proceed?",
        options: [{ value: "yes", label: "Yes" }],
    });
    assertEquals(response.outcome, "unsupported");
    assertEquals(response.message, "ACP elicitation returned invalid option: invalid");
});

test("ACP interaction adapter distinguishes approval acceptance from decline", async () => {
    const makeAdapter = (/** @type {string} */ answer) =>
        createAcpInteractionAdapter({
            acpSessionId: "acp-1",
            clientCapabilities: { elicitation: { form: {} } },
            context: { request: () => Promise.resolve({ action: "accept", content: { answer } }) },
        });
    const request = {
        id: "interaction-1",
        type: /** @type {'approval'} */ ("approval"),
        prompt: "Approve?",
        options: [
            { value: "approve", label: "Approve" },
            { value: "deny", label: "Deny" },
        ],
    };
    assertEquals(await makeAdapter("approve").requestInteraction(request), {
        outcome: "accepted",
        value: true,
    });
    assertEquals(await makeAdapter("deny").requestInteraction(request), {
        outcome: "canceled",
        value: false,
        valueLabel: "Deny",
        message: "Approval was not accepted.",
    });
});

for (const type of /** @type {const} */ (["select", "text", "approval"])) {
    test(`ACP no-form ${type} is answered in chat, not a browser`, async () => {
        const adapter = createAcpInteractionAdapter({
            acpSessionId: "acp-1",
            clientCapabilities: {},
            context: {
                notify: () => {
                    throw new Error("No browser page expected");
                },
            },
            presentChatQuestion: (interaction) => Promise.resolve({ outcome: "text", value: interaction.prompt }),
        });
        assertEquals(await adapter.requestInteraction({ type, prompt: "Question" }), {
            outcome: "text",
            value: "Question",
        });
    });
}

test("ACP Artifact Review feedback rejects cross-origin submissions and cancels", async () => {
    await withRuntimeCommandFixture("acp-artifact-feedback-", async (fixture) => {
        /** @type {PromiseWithResolvers<string>} */
        const notified = Promise.withResolvers();
        const adapter = createAcpInteractionAdapter({
            acpSessionId: "acp-session-1",
            clientCapabilities: {},
            context: {
                notify: (
                    /** @type {string} */ _method,
                    /** @type {{ update: { _meta: { runwield: { questionUrl: string } } } }} */ params,
                ) => {
                    if (params.update._meta.runwield.questionUrl)
                        notified.resolve(params.update._meta.runwield.questionUrl);
                },
            },
        });
        const controller = new AbortController();
        const pending = adapter.requestInteraction(
            {
                id: "question-1",
                type: "artifact_review",
                prompt: "Name?",
                _meta: { markdown: "# Report", cwd: fixture.projectRoot },
            },
            controller.signal,
        );
        const ready = await Promise.race([
            notified.promise.then((questionUrl) => ({ questionUrl })),
            Promise.resolve(pending).then((response) => ({ response })),
        ]);
        if ("response" in ready) {
            assertEquals(ready.response.outcome, "unsupported");
            return;
        }
        const questionUrl = ready.questionUrl;

        const noOrigin = await fetch(questionUrl.replace("/session-question", "/api/session-question/answer"), {
            method: "POST",
            body: new URLSearchParams({ answer: "Ada" }),
        });
        assertEquals(noOrigin.status, 403);
        await noOrigin.body?.cancel();

        controller.abort();
        assertEquals((await pending).outcome, "canceled");
    });
});
