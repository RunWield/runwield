import { assertEquals } from "@std/assert";
import { createReplayEvents } from "./session-transcript-projection.js";

Deno.test("saved interrupted attempts replay once per entry without a live retry claim", () => {
    const entries = [
        {
            type: "message",
            id: "old-eof",
            message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Unexpected EOF" },
        },
        {
            type: "message",
            id: "new-eof",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "partial" }],
                stopReason: "error",
                errorMessage: "Network error: Unexpected EOF",
            },
        },
        {
            type: "message",
            id: "failed-tool",
            message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "never-ran", name: "write", arguments: { path: "unfinished" } }],
                stopReason: "error",
                errorMessage: "Unexpected EOF",
            },
        },
        {
            type: "message",
            id: "answer",
            message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
        },
        {
            type: "message",
            id: "abort",
            message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Unexpected EOF" },
        },
    ];
    const original = JSON.stringify(entries);
    const first = createReplayEvents("saved", entries);
    const second = createReplayEvents("saved", entries);
    assertEquals(first, second);
    assertEquals(JSON.stringify(entries), original);
    assertEquals(
        first.filter((event) => event.type === "terminal_error").map((event) => [event.eventId, event.message]),
        [
            ["old-eof:terminal_error:0", "The model service stopped responding before the reply was complete."],
            ["new-eof:terminal_error:0", "The model service stopped responding before the reply was complete."],
            ["failed-tool:terminal_error:0", "The model service stopped responding before the reply was complete."],
        ],
    );
    assertEquals(first.some((event) => event.type === "tool_start" && event.toolCallId === "never-ran"), false);
    assertEquals(first.some((event) => /retrying|currently stopped/i.test(event.message || "")), false);
    assertEquals(first.filter((event) => event.type === "assistant_text_delta").map((event) => event.delta), [
        "partial",
        "Done",
    ]);
});
