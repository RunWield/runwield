import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { ENGINEER_MESSAGE_DESCRIPTION, IMPLEMENTATION_REPORT_MIN_LENGTH } from "../workflow/implementation-report.ts";
import { EVIDENCE } from "./attached-test-fixture.ts";
import {
    ATTACHED_OPERATIONS,
    type AttachedJsonObject,
    parseStartExecutionInput,
    parseTaskCompletedInput,
} from "./operations.ts";

const root = fromFileUrl(new URL("./", import.meta.url));
const envelope = { workflowId: "workflow", operationId: "operation", expectedRevision: 1, evidence: EVIDENCE };

test("Attached task_completed keeps the exact Core name, message schema, and whitespace report contract", () => {
    const tool = ATTACHED_OPERATIONS.find((entry) => entry.name === "task_completed");
    assert(tool);
    const payload = tool.inputSchema.properties.payload;
    assert(payload && typeof payload === "object" && !Array.isArray(payload));
    const properties = payload.properties;
    assert(properties && typeof properties === "object" && !Array.isArray(properties));
    assertEquals(properties.message, {
        type: "string",
        minLength: IMPLEMENTATION_REPORT_MIN_LENGTH,
        description: ENGINEER_MESSAGE_DESCRIPTION,
    });
    const message = " \n- Implementation outcome\n  - Verification detail\n";
    const parsed = parseTaskCompletedInput(root, { ...envelope, payload: { actionId: "action", message } });
    assert(parsed.ok);
    assertEquals(parsed.envelope.payload.message, message);
    const whitespace = parseTaskCompletedInput(root, { ...envelope, payload: { actionId: "action", message: " " } });
    assert(whitespace.ok, "Core checks length, not trimmed length or Markdown shape.");
});

test("start_execution accepts only an empty start or a complete proceed/decline consent answer", () => {
    assert(parseStartExecutionInput(root, { ...envelope, payload: {} }).ok);
    for (const consent of ["proceed", "decline"]) {
        assert(parseStartExecutionInput(root, { ...envelope, payload: { actionId: "action", consent } }).ok);
    }
    const invalid: AttachedJsonObject[] = [
        { actionId: "action" },
        { consent: "proceed" },
        { actionId: "action", consent: "yes" },
        { cwd: root },
    ];
    for (const payload of invalid) {
        assertEquals(parseStartExecutionInput(root, { ...envelope, payload }).ok, false);
    }
});
