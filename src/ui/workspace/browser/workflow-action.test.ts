import { test } from "node:test";
import { assertEquals, assertRejects } from "../../../testing/assertions.ts";
import { submitWorkflowAction } from "./workflow-action.ts";

test("held Plan warnings require confirmation and preserve revision on retry", async () => {
    const originalFetch = globalThis.fetch;
    const originalConfirm = Object.getOwnPropertyDescriptor(globalThis, "confirm");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const request = {
        requestId: "first",
        action: "resume_from_hold",
        planId: "held",
        expectedRevision: "reviewed-revision",
        expectedGeneration: 7,
    };
    const submissions: typeof request[] = [];
    const confirmations: string[] = [];
    try {
        Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "rw_owner_csrf=proof" } });
        Object.defineProperty(globalThis, "confirm", {
            configurable: true,
            value: (message: string) => {
                confirmations.push(message);
                return false;
            },
        });
        globalThis.fetch = (_url, init) => {
            assertEquals(new Headers(init?.headers).get("x-runwield-csrf"), "proof");
            const body = JSON.parse(String(init?.body));
            submissions.push(body);
            return Promise.resolve(
                body.acceptResumeWarnings
                    ? Response.json({ result: { kind: "success", message: "Plan resumed to ready_for_work." } })
                    : Response.json({
                        requiresConfirmation: true,
                        resumeCheck: { warnings: ["Uncommitted work exists."] },
                    }, { status: 409 }),
            );
        };
        assertEquals((await submitWorkflowAction("/workflow", request)).canceled, true);
        assertEquals(submissions.length, 1);
        assertEquals(confirmations[0].includes("Uncommitted work exists."), true);
        Object.defineProperty(globalThis, "confirm", { configurable: true, value: () => true });
        const result = await submitWorkflowAction("/workflow", request);
        assertEquals(result.result?.kind, "success");
        assertEquals(submissions.length, 3);
        assertEquals(submissions[2].expectedRevision, "reviewed-revision");
        assertEquals(submissions[2].expectedGeneration, 7);
        assertEquals(submissions[2].requestId === "first", false);
        globalThis.fetch = () =>
            Promise.resolve(
                Response.json({ result: { kind: "refresh_required", message: "Plan changed." } }, { status: 409 }),
            );
        await assertRejects(() => submitWorkflowAction("/workflow", request), Error, "Plan changed.");
    } finally {
        globalThis.fetch = originalFetch;
        if (originalConfirm) Object.defineProperty(globalThis, "confirm", originalConfirm);
        else Reflect.deleteProperty(globalThis, "confirm");
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else Reflect.deleteProperty(globalThis, "document");
    }
});
