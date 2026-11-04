import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { withExistingRuntimeInteraction } from "./testing/live-interaction-fixture.ts";

test("owner Session HTTP enforces Project scope, stages settings, answers Core and cancels live work", async () => {
    await withRuntimeCommandFixture("owner-session-http-", async (fixture) => {
        await withExistingRuntimeInteraction(
            fixture,
            { type: "text", prompt: "Choose the next direction" },
            async ({ app, origin, cookie, csrf, store, service, reference, response }) => {
                const route = `/api/owner/projects/${reference.projectId}/sessions/${reference.runwieldSessionId}`;
                const headers = { cookie, origin, "x-runwield-csrf": csrf, "content-type": "application/json" };
                const timeline = await app.handler()(new Request(origin + route + "/timeline", { headers }));
                assertEquals(timeline.status, 200);
                const timelineText = await timeline.text();
                assertEquals(JSON.parse(timelineText).activeSurface, "workspace");
                assertEquals(timelineText.includes('"segments"'), false);
                assertEquals(timelineText.includes('"terminalEntryId"'), false);
                const other = store.registerProject({ root: fixture.alternateRoot });
                const answer = (projectId: string) =>
                    app.handler()(
                        new Request(
                            `${origin}/api/owner/projects/${projectId}/session-operations/${reference.operationId}/interactions/${reference.interactionId}/answer`,
                            {
                                method: "POST",
                                headers,
                                body: JSON.stringify({
                                    requestId: `answer-${projectId}`,
                                    response: { outcome: "text", value: "Continue the review" },
                                }),
                            },
                        ),
                    );
                assertEquals((await answer(other.projectId)).status, 409);
                assertEquals(
                    service.getOperation(reference.operationId).liveInteraction?.interactionId,
                    reference.interactionId,
                );
                assertEquals((await answer(reference.projectId)).status, 202);
                assertEquals(await response, { outcome: "text", value: "Continue the review" });
                const canceled = await app.handler()(
                    new Request(`${origin}/api/owner/session-operations/${reference.operationId}/cancel`, {
                        method: "POST",
                        headers,
                        body: "{}",
                    }),
                );
                assertEquals(canceled.status, 202);
                assertEquals((await canceled.json()).aborted, true);
                for (
                    let attempt = 0;
                    attempt < 200 && service.getOperation(reference.operationId).status === "running";
                    attempt++
                )
                    await new Promise((resolve) => setTimeout(resolve, 10));
                assertEquals(service.getOperation(reference.operationId).status === "running", false);
                const idle = await service.timeline(reference.runwieldSessionId, { projectId: reference.projectId });
                const configuration = await app.handler()(
                    new Request(origin + route + "/configure", {
                        method: "POST",
                        headers,
                        body: JSON.stringify({
                            expectedGeneration: idle.generation,
                            agentName: "guide",
                            thinkingLevel: "off",
                        }),
                    }),
                );
                assertEquals(configuration.status, 202, await configuration.clone().text());
                const updated = await service.timeline(reference.runwieldSessionId, { projectId: reference.projectId });
                assertEquals(updated.snapshot.activeAgent, "guide");
            },
        );
    });
});
