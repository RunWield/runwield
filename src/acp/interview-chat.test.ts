import { assertEquals, assertStringIncludes } from "@std/assert";
import type { RuntimeInteractionRequest } from "../shared/session/session-runtime-interactions.js";
import { formatInterviewQuestion, parseInterviewReply } from "./interview-chat.ts";

Deno.test("interview chat only matches a unique exact label or displayed number", () => {
    const interaction: RuntimeInteractionRequest = {
        type: "select",
        prompt: "Pick",
        otherOptionValue: "other",
        options: [
            { value: "first", label: "Same (recommended)" },
            { value: "second", label: "Same" },
            { value: "other", label: "Other" },
        ],
    };
    assertStringIncludes(formatInterviewQuestion(interaction), "1. Same — recommended");
    assertEquals(parseInterviewReply(interaction, "2")?.value, "second");
    assertEquals(parseInterviewReply(interaction, "Same")?.otherText, "Same");
    assertEquals(parseInterviewReply(interaction, "99")?.otherText, "99");
    assertEquals(parseInterviewReply(interaction, "/agent ideator")?.otherText, "/agent ideator");
    assertEquals(parseInterviewReply(interaction, "Other")?.otherText, undefined);
    assertEquals(parseInterviewReply(interaction, "  "), null);
});
