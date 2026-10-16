import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { doctorCheckMessage, doctorCleanMessage, doctorNeedsHelpMessage } from "./doctor-messages.ts";

test("doctor messages stay plain", () => {
    const messages = [
        doctorCleanMessage(0),
        doctorCleanMessage(3),
        doctorNeedsHelpMessage(2, 1),
        doctorNeedsHelpMessage(0, 13),
        doctorCheckMessage(0),
        doctorCheckMessage(4),
    ];
    const forbidden = ["registry", "front matter", "lifecycle", "checkpoint", "settlement", "planid"];
    for (const message of messages) {
        const lower = message.toLowerCase();
        assert(message.split(/\s+/).length <= 20, message);
        for (const term of forbidden) assertEquals(lower.includes(term), false, message);
    }
});
