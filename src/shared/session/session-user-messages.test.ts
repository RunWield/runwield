import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import {
    buildActiveConversationStatusMessage,
    buildActiveConversationSubmissionMessage,
    buildConversationRestoredMessage,
} from "./session-user-messages.ts";

test("session messages describe an active terminal without internal terms", () => {
    assertEquals(
        buildActiveConversationSubmissionMessage("tui"),
        "This conversation is still running in another terminal. Continue there, or wait for its current turn to finish before sending here.",
    );
    assertEquals(
        buildActiveConversationStatusMessage("tui"),
        "This conversation is running in another terminal. Messages sent here will queue until its current turn finishes.",
    );
    assertEquals(
        buildConversationRestoredMessage("tui"),
        "Conversation restored in read-only mode because it is still running in another terminal. Continue there, or wait for its current turn to finish; this screen will become available automatically.",
    );
});

test("session restored message omits implementation identifiers", () => {
    assertEquals(buildConversationRestoredMessage(), "Conversation restored.");
});
