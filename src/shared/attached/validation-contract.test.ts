import { assert, assertEquals } from "@std/assert";
import { parseValidationInput } from "./operations.ts";
import { EVIDENCE } from "./attached-test-fixture.ts";
import type { AttachedJsonObject } from "./operations.ts";

function input(payload: AttachedJsonObject) {
    return { operationId: "op", workflowId: "workflow", expectedRevision: 1, evidence: EVIDENCE, payload };
}
Deno.test("review outcomes reject transcript imports and fabricated coverage", () => {
    const extras: AttachedJsonObject[] = [{ transcript: "private conversation" }, { coverage: [] }];
    for (const extra of extras) {
        const parsed = parseValidationInput(
            "/project",
            input({ actionId: "review", ...{ approved: true, ...extra } }),
            "review_complete",
        );
        assert(!parsed.ok);
        assertEquals(parsed.rejection.code, "transcript" in extra ? "transcript_field" : "unknown_field");
    }
});
Deno.test("review outcomes preserve stable finding states and reject malformed finding rows", () => {
    const parsed = parseValidationInput(
        "/project",
        input({
            actionId: "review",
            ...{
                approved: false,
                findings: [{
                    id: "R1-1",
                    title: "Wrong value",
                    status: "fix_rejected",
                    rejectionReason: "Still wrong",
                }],
            },
        }),
        "review_complete",
    );
    assert(parsed.ok);
    assertEquals(parsed.envelope.payload.outcome?.findings?.[0].id, "R1-1");
    const malformed = parseValidationInput(
        "/project",
        input({ actionId: "review", ...{ approved: true, findings: [null] } }),
        "review_complete",
    );
    assert(!malformed.ok);
});
Deno.test("review_diff accepts candidate-relative paths but rejects host-selected cwd and byte fraud", () => {
    const parsed = parseValidationInput(
        "/project",
        input({ actionId: "review", command: "show", path: "src/value.ts", offsetBytes: 0, maxBytes: 256 }),
        "review_diff",
    );
    assert(parsed.ok);
    const extras: AttachedJsonObject[] = [{ cwd: "/other" }, { offsetBytes: -1 }];
    for (const extra of extras) {
        const invalid = parseValidationInput(
            "/project",
            input({ actionId: "review", command: "show", ...extra }),
            "review_diff",
        );
        assert(!invalid.ok);
    }
});
Deno.test("validation decisions preserve the user's answer without host metadata or history", () => {
    const parsed = parseValidationInput(
        "/project",
        input({ actionId: "decision", answer: { outcome: "submitted", value: false } }),
        "validation_decision",
    );
    assert(parsed.ok);
    assertEquals(parsed.envelope.payload.answer, {
        outcome: "submitted",
        value: false,
        valueLabel: undefined,
        message: undefined,
    });
    const invalid = parseValidationInput(
        "/project",
        input({ actionId: "decision", answer: { outcome: "submitted", history: [] } }),
        "validation_decision",
    );
    assert(!invalid.ok);
});
