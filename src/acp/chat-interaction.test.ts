import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import type { RuntimeInteractionRequest } from "../shared/session/session-runtime-interactions.js";
import { formatChatQuestion, parseChatReply } from "./chat-interaction.ts";

test("interview chat only matches a unique exact label or displayed number", () => {
    const interaction: RuntimeInteractionRequest = {
        type: "select",
        _meta: { source: "user_interview" },
        prompt: "Pick",
        otherOptionValue: "other",
        options: [
            { value: "first", label: "Same (recommended)" },
            { value: "second", label: "Same" },
            { value: "other", label: "Other" },
        ],
    };
    assertStringIncludes(formatChatQuestion(interaction), "1. Same — recommended");
    assertEquals(parseChatReply(interaction, "2")?.value, "second");
    assertEquals(parseChatReply(interaction, "Same")?.otherText, "Same");
    assertEquals(parseChatReply(interaction, "99")?.otherText, "99");
    assertEquals(parseChatReply(interaction, "/agent ideator")?.otherText, "/agent ideator");
    assertEquals(parseChatReply(interaction, "Other")?.otherText, undefined);
    assertEquals(parseChatReply(interaction, "  "), null);
});

const menu: RuntimeInteractionRequest = {
    type: "select",
    prompt: "Choose",
    options: [
        { value: "provider/model", label: "Model", description: "Fast" },
        { value: "second", label: "Another" },
    ],
};

test("chat menus show descriptions and match only numbers or unique exact labels and values", () => {
    assertStringIncludes(formatChatQuestion(menu), "1. Model — Fast");
    for (const reply of ["1", " MODEL ", "Provider/Model"]) {
        assertEquals(parseChatReply(menu, reply)?.value, "provider/model");
    }
    for (const reply of ["0", "3", "banana", "/agent", "Mod", " "]) {
        assertEquals(parseChatReply(menu, reply), null);
    }
    assertEquals(
        parseChatReply(
            {
                ...menu,
                options: [
                    { value: "x", label: "Same" },
                    { value: "y", label: "same" },
                ],
            },
            "same",
        ),
        null,
    );
});

test("chat menu cancellation respects options named cancel", () => {
    assertEquals(parseChatReply(menu, " Cancel "), { outcome: "canceled" });
    assertEquals(parseChatReply({ ...menu, options: [{ value: "keep", label: "Cancel" }] }, "cancel"), {
        outcome: "selected",
        value: "keep",
        valueLabel: "Cancel",
    });
});

test("an ambiguous cancel label does not cancel a menu", () => {
    assertEquals(
        parseChatReply(
            {
                ...menu,
                options: [
                    { value: "x", label: "Cancel" },
                    { value: "y", label: "Cancel" },
                ],
            },
            "cancel",
        ),
        null,
    );
});

test("chat text requires nonblank text and treats cancel as text", () => {
    const text: RuntimeInteractionRequest = { type: "text", prompt: "Name?", allowEmpty: true };
    assertEquals(parseChatReply(text, " "), null);
    assertEquals(parseChatReply(text, "cancel"), { outcome: "text", value: "cancel" });
});

test("chat approvals provide yes and no and respect explicit acceptance metadata", () => {
    const approval: RuntimeInteractionRequest = { type: "approval", prompt: "Proceed?" };
    assertStringIncludes(formatChatQuestion(approval), "1. Yes");
    assertStringIncludes(formatChatQuestion(approval), "2. No");
    assertEquals(parseChatReply(approval, "yes"), { outcome: "accepted", value: true });
    assertEquals(parseChatReply(approval, "2"), { outcome: "canceled", value: false });
    assertEquals(
        parseChatReply({ ...approval, options: [{ value: "ship", label: "Ship", _meta: { accepted: true } }] }, "1"),
        { outcome: "accepted", value: true },
    );
});
