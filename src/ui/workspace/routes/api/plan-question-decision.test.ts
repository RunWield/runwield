import { test } from "node:test";
import { assertEquals } from "../../../../testing/assertions.ts";
import { registerReviewDecisionPromise, reviewDecisionApi } from "./review-handlers.js";

test("approval transport keeps only question answers with a string id and boolean or string value", async () => {
    const token = "question-review";
    const pending = registerReviewDecisionPromise(token);
    const request = () =>
        new Request(`http://localhost/api/review/decision?token=${token}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                approved: true,
                approvalAction: "later",
                questionAnswers: [
                    { id: "choice", value: "all" },
                    { id: "keep", value: false },
                    null,
                    { id: 5, value: "no" },
                    { id: "bad", value: 7 },
                    { id: "array", value: [] },
                    { id: "missing" },
                ],
            }),
        });
    const response = await reviewDecisionApi({ req: request(), state: { cwd: ".", reviewToken: token } });
    assertEquals(response.status, 200);
    const decision = await pending.promise;
    assertEquals(decision.questionAnswers, [
        { id: "choice", value: "all" },
        { id: "keep", value: false },
    ]);
    assertEquals((await reviewDecisionApi({ req: request(), state: { cwd: ".", reviewToken: token } })).status, 404);
});
