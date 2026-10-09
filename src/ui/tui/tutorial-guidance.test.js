import { assertEquals, assertStringIncludes } from "@std/assert";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { savePlan } from "../../plan-store.js";
import { writeControllerState } from "../../shared/workflow/controller-registry.ts";
import { RuntimeEventTypes } from "../../shared/session/session-runtime-events.js";
import { getTutorialExplanation, presentTutorialEvent, restoreVerifiedTutorialRecap } from "./tutorial-guidance.ts";
import { setCustomSetting } from "../../shared/settings.js";
import { INIT_VERIFICATION_COMMAND_PLACEHOLDER } from "../../tools/init-verification-command.ts";

const CHECKS = { ci: "passed", semanticReview: "passed", humanReview: "skipped", merge: "passed" };

/** @typedef {{ shownExplanationIds?: string[], recapShown?: boolean }} TutorialUpdate */

Deno.test("tutorial explanations follow semantic workflow events", () => {
    assertEquals(
        getTutorialExplanation(
            /** @type {any} */ ({
                type: RuntimeEventTypes.INTERACTION_REQUESTED,
                interactionType: "plan_review",
            }),
        )?.id,
        "plan-review",
    );
    assertEquals(
        getTutorialExplanation(
            /** @type {any} */ ({
                type: RuntimeEventTypes.AGENT_CHANGED,
                agentName: "plan-engineer",
                rootHandoff: true,
            }),
        )?.id,
        "implementation",
    );
    assertEquals(
        getTutorialExplanation(
            /** @type {any} */ ({
                type: RuntimeEventTypes.SYSTEM_STATUS,
                validationProgress: { stage: "engineer_repair", outcome: "started", checks: CHECKS },
            }),
        )?.id,
        "ai-repair",
    );
    const projectRepair = getTutorialExplanation(
        /** @type {any} */ ({
            type: RuntimeEventTypes.SYSTEM_STATUS,
            validationProgress: {
                stage: "engineer_repair",
                outcome: "started",
                checks: { ...CHECKS, ci: "failed", semanticReview: "pending" },
            },
        }),
    );
    assertEquals(projectRepair?.id, "project-repair");
    assertStringIncludes(projectRepair?.text || "", "Project checks found an issue");
    assertEquals(
        getTutorialExplanation(
            /** @type {any} */ ({
                type: RuntimeEventTypes.SYSTEM_STATUS,
                validationProgress: { stage: "terminal", outcome: "verified", checks: CHECKS },
            }),
        )?.id,
        "verified-recap",
    );
    assertEquals(
        getTutorialExplanation(
            /** @type {any} */ ({
                type: RuntimeEventTypes.SYSTEM_STATUS,
                validationProgress: { stage: "terminal", outcome: "paused", checks: CHECKS },
            }),
        ),
        null,
    );
});

Deno.test("tutorial verified recap requires exact verified status", async () => {
    await withRuntimeCommandFixture("tutorial-manual-status-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Choose a small change.");
        for (
            const status of /** @type {const} */ ([
                "implemented",
                "user_verified",
                "closed_without_verification",
            ])
        ) {
            const planId = `${status}-plan-id`;
            const planName = `${status}-plan`;
            await savePlan(projectRoot, planName, `# ${planName}\n`, {
                planId,
                status,
                classification: "PLANNED_CHANGE",
                complexity: "LOW",
            });
            await writeControllerState(projectRoot, { planId, planName }, {
                verifiedAt: "2026-01-01T00:00:00.000Z",
                deliveryEvidence: { version: 1, mode: "non_git_in_place" },
            });

            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            /** @type {string[]} */
            const messages = [];
            try {
                await runtime.promptUserTurn(created.sessionId, {
                    initialRequest: "Start tutorial",
                    initialImages: [],
                    agentName: "planner",
                    initialTutorialContext: {
                        version: 1,
                        guidanceEnabled: true,
                        shownExplanationIds: ["choose-improvement"],
                        recapShown: false,
                        planId: null,
                    },
                });
                await runtime.recordPlanAssociation(created.sessionId, {
                    planId,
                    planName,
                    purpose: "planning",
                });
                await runtime.updateTutorialContext(created.sessionId, { planId });
                await presentTutorialEvent({
                    runtime,
                    sessionId: created.sessionId,
                    uiAPI: /** @type {any} */ ({
                        appendSystemMessage: (/** @type {string} */ text) => messages.push(text),
                    }),
                    event: /** @type {any} */ ({ type: RuntimeEventTypes.BUSY_CHANGED, busy: false }),
                });
                assertEquals(messages, [], `${status} must not produce a verified recap`);
                assertEquals(runtime.getSessionSnapshot(created.sessionId)?.tutorialContext?.recapShown, false);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        }
    });
});

Deno.test("verified tutorial recap links available review and QA artifacts", async () => {
    await withRuntimeCommandFixture("tutorial-recap-artifacts-", async ({ projectRoot }) => {
        const planId = "verified-plan-id";
        const planName = "verified-plan";
        await savePlan(projectRoot, planName, "# Verified plan\n", {
            planId,
            status: "verified",
            classification: "PLANNED_CHANGE",
            complexity: "LOW",
        });
        await writeControllerState(projectRoot, { planId, planName }, {
            verifiedAt: "2026-01-01T00:00:00.000Z",
            deliveryEvidence: { version: 1, mode: "non_git_in_place" },
        });
        const snapshot = {
            cwd: projectRoot,
            workflowContext: { planId },
            planAssociations: [{ planId, planName, purpose: "execution" }],
            tutorialContext: {
                version: 1,
                guidanceEnabled: true,
                shownExplanationIds: ["choose-improvement"],
                recapShown: false,
                planId,
            },
            artifacts: [{
                artifactId: "qa-report",
                kind: "report",
                path: "docs/reports/manual-qa.md",
                title: "Manual QA report",
            }],
        };
        /** @type {string[]} */
        const messages = [];
        await presentTutorialEvent({
            runtime: /** @type {any} */ ({
                getSessionSnapshot: () => snapshot,
                getSessionProjectRoot: () => projectRoot,
                updateTutorialContext: /** @param {string} _sessionId @param {TutorialUpdate} update */
                    (_sessionId, update) => {
                        snapshot.tutorialContext.recapShown = update.recapShown || false;
                        snapshot.tutorialContext.shownExplanationIds = update.shownExplanationIds || [];
                        return Promise.resolve({ ok: true });
                    },
            }),
            sessionId: "session-1",
            uiAPI: /** @type {any} */ ({
                appendSystemMessage: (/** @type {string} */ text) => messages.push(text),
            }),
            event: /** @type {any} */ ({ type: RuntimeEventTypes.BUSY_CHANGED, busy: false }),
        });
        assertEquals(messages.length, 1);
        assertStringIncludes(messages[0], "Review/QA Artifact: docs/reports/manual-qa.md");
    });
});

Deno.test("tutorial pause before Plan approval settles cancellation and reloads saved context", async () => {
    await withRuntimeCommandFixture("tutorial-pause-plan-review-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Choose a small change.");
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        let runwieldSessionId = "";
        try {
            await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "Start tutorial",
                initialImages: [],
                agentName: "planner",
                initialTutorialContext: {
                    version: 1,
                    guidanceEnabled: true,
                    shownExplanationIds: ["choose-improvement"],
                    recapShown: false,
                    planId: null,
                },
            });
            await runtime.recordPlanAssociation(created.sessionId, {
                planId: "plan-1",
                planName: "plan",
                purpose: "planning",
            });
            await runtime.updateTutorialContext(created.sessionId, { planId: "plan-1" });
            let interactionRequests = 0;
            runtime.setInteractionAdapter(created.sessionId, {
                requestInteraction: () => {
                    interactionRequests += 1;
                    return interactionRequests === 1 ? Promise.resolve({ outcome: "accepted" }) : new Promise(() => {});
                },
            });
            /** @type {import("../../shared/session/session-runtime-events.js").SessionRuntimeEvent[]} */
            const reviewEvents = [];
            /** @type {import("../../shared/session/session-runtime-events.js").RuntimeCancellationEvent[]} */
            const cancellationEvents = [];
            runtime.subscribeSessionEvents(created.sessionId, (event) => {
                if (event.type === RuntimeEventTypes.INTERACTION_REQUESTED) reviewEvents.push(event);
                if (event.type === RuntimeEventTypes.CANCELLATION) cancellationEvents.push(event);
            });
            assertEquals(
                (await runtime.requestInteraction(created.sessionId, {
                    type: "plan_review",
                    prompt: "Review Plan",
                    _meta: { planId: "plan-1", planName: "plan", planningAgentName: "planner" },
                })).outcome,
                "accepted",
            );
            const reviewEvent = reviewEvents[0];
            if (!reviewEvent) throw new Error("Expected a real Plan Review interaction event.");
            /** @type {Array<ReturnType<typeof runtime.requestInteraction>>} */
            const activeReviews = [];
            await presentTutorialEvent({
                runtime,
                sessionId: created.sessionId,
                uiAPI: /** @type {any} */ ({
                    appendSystemMessage() {},
                    promptSelect: async () => {
                        activeReviews.push(runtime.requestInteraction(created.sessionId, {
                            type: "plan_review",
                            prompt: "Review Plan before approval",
                            _meta: { planId: "plan-1", planName: "plan", planningAgentName: "planner" },
                        }));
                        while (reviewEvents.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
                        return "pause";
                    },
                }),
                event: reviewEvent,
            });
            const activeReview = activeReviews[0];
            if (!activeReview) throw new Error("Expected the active Plan Review to start.");
            assertEquals((await activeReview).outcome, "canceled");
            assertEquals(cancellationEvents.length, 1);
            assertEquals(cancellationEvents[0].aborted, true);
            assertEquals(runtime.getSessionSnapshot(created.sessionId)?.busy, false);
            assertEquals(
                runtime.getSessionSnapshot(created.sessionId)?.tutorialContext?.shownExplanationIds,
                ["choose-improvement", "plan-review"],
            );
            runwieldSessionId = runtime.getSessionSnapshot(created.sessionId)?.managed?.runwieldSessionId || "";
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }

        const restarted = createSessionRuntime();
        try {
            const loaded = await restarted.createInteractiveSession({
                cwd: projectRoot,
                mode: "continue",
                resumeSessionId: runwieldSessionId,
            });
            assertEquals(restarted.getSessionSnapshot(loaded.sessionId)?.tutorialContext?.planId, "plan-1");
            assertEquals(
                restarted.getSessionSnapshot(loaded.sessionId)?.tutorialContext?.shownExplanationIds,
                ["choose-improvement", "plan-review"],
            );
        } finally {
            await restarted.closeAllSessionsWhenIdle();
        }
    });
});

Deno.test("tutorial does not infer AI repair from implementation repeats or recovery associations", async () => {
    const snapshot = {
        cwd: "/project",
        activeAgent: "plan-engineer",
        workflowContext: { planId: "plan-1" },
        planAssociations: [{ planId: "plan-1", planName: "plan", purpose: "recovery" }],
        tutorialContext: {
            version: 1,
            guidanceEnabled: true,
            shownExplanationIds: ["choose-improvement", "implementation", "ai-review"],
            recapShown: false,
            planId: "plan-1",
        },
        artifacts: [],
    };
    /** @type {string[]} */
    const messages = [];
    await presentTutorialEvent({
        runtime: /** @type {any} */ ({
            getSessionSnapshot: () => snapshot,
            updateTutorialContext: () => Promise.resolve({ ok: true }),
        }),
        sessionId: "session-1",
        uiAPI: /** @type {any} */ ({
            appendSystemMessage: (/** @type {string} */ text) => messages.push(text),
        }),
        event: /** @type {any} */ ({
            type: RuntimeEventTypes.AGENT_CHANGED,
            agentName: "plan-engineer",
            rootHandoff: true,
        }),
    });
    assertEquals(messages, []);
    assertEquals(snapshot.tutorialContext.shownExplanationIds.includes("ai-repair"), false);
});

Deno.test("tutorial discloses Init placeholder verification", async () => {
    await withRuntimeCommandFixture("tutorial-placeholder-checks-", async ({ projectRoot }) => {
        await setCustomSetting("verification_command", INIT_VERIFICATION_COMMAND_PLACEHOLDER, "project", projectRoot);
        const snapshot = {
            cwd: projectRoot,
            activeAgent: "plan-engineer",
            workflowContext: { planId: "plan-1" },
            planAssociations: [{ planId: "plan-1", planName: "plan", purpose: "execution" }],
            tutorialContext: {
                version: 1,
                guidanceEnabled: true,
                shownExplanationIds: ["choose-improvement", "implementation"],
                recapShown: false,
                planId: "plan-1",
            },
            artifacts: [],
        };
        /** @type {string[]} */
        const messages = [];
        await presentTutorialEvent({
            runtime: /** @type {any} */ ({
                getSessionSnapshot: () => snapshot,
                updateTutorialContext: /** @param {string} _sessionId @param {TutorialUpdate} update */
                    (_sessionId, update) => {
                        snapshot.tutorialContext.shownExplanationIds = update.shownExplanationIds || [];
                        return Promise.resolve({ ok: true });
                    },
            }),
            sessionId: "session-1",
            uiAPI: /** @type {any} */ ({
                appendSystemMessage: (/** @type {string} */ text) => messages.push(text),
            }),
            event: /** @type {any} */ ({
                type: RuntimeEventTypes.SYSTEM_STATUS,
                validationProgress: { stage: "ci", outcome: "started", checks: CHECKS },
            }),
        });
        assertEquals(messages.length, 1);
        assertStringIncludes(messages[0], "placeholder command, not real test coverage");
    });
});

Deno.test("tutorial guidance persists deduplication and requires an associated Plan for verified recap", async () => {
    await withRuntimeCommandFixture("tutorial-guidance-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Choose a small change.");
        const runtime = createSessionRuntime();
        const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
        const sessionId = created.sessionId;
        /** @type {string[]} */
        const messages = [];
        const uiAPI = /** @type {any} */ ({
            promptSelect: () => Promise.resolve("continue"),
            appendSystemMessage: (
                /** @type {string} */ text,
                /** @type {boolean} */ _isError,
                /** @type {string} */ header,
            ) => messages.push(`${header}: ${text}`),
        });
        try {
            await runtime.promptUserTurn(sessionId, {
                initialRequest: "Start tutorial",
                initialImages: [],
                agentName: "planner",
                initialTutorialContext: {
                    version: 1,
                    guidanceEnabled: true,
                    shownExplanationIds: ["choose-improvement"],
                    recapShown: false,
                    planId: null,
                },
            });
            const reviewEvent = /** @type {any} */ ({
                type: RuntimeEventTypes.INTERACTION_REQUESTED,
                interactionType: "plan_review",
            });
            await presentTutorialEvent({ runtime, sessionId, uiAPI, event: reviewEvent });
            await presentTutorialEvent({ runtime, sessionId, uiAPI, event: reviewEvent });
            assertEquals(messages.length, 1);
            assertEquals(runtime.getSessionSnapshot(sessionId)?.tutorialContext?.shownExplanationIds, [
                "choose-improvement",
                "plan-review",
            ]);

            const verifiedEvent = /** @type {any} */ ({
                type: RuntimeEventTypes.SYSTEM_STATUS,
                validationProgress: { stage: "terminal", outcome: "verified", checks: CHECKS },
            });
            await presentTutorialEvent({ runtime, sessionId, uiAPI, event: verifiedEvent });
            assertEquals(messages.length, 1, "verified recap needs committed Plan identity");

            assertEquals(
                (await runtime.recordPlanAssociation(sessionId, {
                    planId: "plan-1",
                    planName: "small-change",
                    purpose: "planning",
                })).ok,
                true,
            );
            assertEquals((await runtime.updateTutorialContext(sessionId, { planId: "plan-1" })).ok, true);
            await presentTutorialEvent({ runtime, sessionId, uiAPI, event: verifiedEvent });

            assertEquals(messages.length, 1, "an association alone does not prove the active workflow was published");
            assertEquals(runtime.getSessionSnapshot(sessionId)?.tutorialContext?.recapShown, false);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }
    });
});

Deno.test("completed tutorial recap restores after reload without changing saved progress and requires current proof", async () => {
    await withRuntimeCommandFixture("tutorial-recap-reload-", async ({ projectRoot, setModelResponse }) => {
        setModelResponse("Choose a small change.");
        const runtime = createSessionRuntime();
        const restarted = createSessionRuntime();
        const planId = "reloaded-tutorial-plan";
        const planName = "tutorial-change";
        await savePlan(projectRoot, planName, "# Delivered tutorial change\n", {
            planId,
            status: "verified",
            classification: "PLANNED_CHANGE",
        });
        await writeControllerState(projectRoot, { planId, planName }, {
            verifiedAt: "2026-01-01T00:00:00.000Z",
            deliveryEvidence: { version: 1, mode: "non_git_in_place" },
        });
        /** @type {string[]} */
        const messages = [];
        const uiAPI = /** @type {any} */ ({
            appendSystemMessage: (
                /** @type {string} */ text,
                /** @type {boolean} */ _error,
                /** @type {string} */ header,
            ) => messages.push(`${header}: ${text}`),
        });
        try {
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            await runtime.promptUserTurn(created.sessionId, {
                initialRequest: "Start tutorial",
                agentName: "planner",
                initialTutorialContext: {
                    version: 1,
                    guidanceEnabled: true,
                    shownExplanationIds: ["choose-improvement"],
                    recapShown: false,
                    planId: null,
                },
            });
            await runtime.recordPlanAssociation(created.sessionId, { planId, planName, purpose: "execution" });
            await runtime.updateTutorialContext(created.sessionId, { planId });
            const idle = /** @type {any} */ ({ type: RuntimeEventTypes.BUSY_CHANGED, busy: false });
            await presentTutorialEvent({ runtime, sessionId: created.sessionId, uiAPI, event: idle });
            assertEquals(messages.length, 1);
            const saved = runtime.getSessionSnapshot(created.sessionId);
            assertEquals(saved?.tutorialContext?.recapShown, true);
            const savedContext = structuredClone(saved?.tutorialContext);
            const savedGeneration = saved?.managed?.generation;
            const managed = saved?.managed;
            await runtime.closeAllSessionsWhenIdle();
            const loaded = await restarted.createInteractiveSession({
                cwd: projectRoot,
                mode: "continue",
                resumeSessionId: managed?.runwieldSessionId || "",
            });
            messages.length = 0;
            await restarted.replaySession(loaded.sessionId);
            await restoreVerifiedTutorialRecap({ runtime: restarted, sessionId: loaded.sessionId, uiAPI });
            assertEquals(messages.length, 1);
            assertStringIncludes(messages[0], "Tutorial complete");
            assertStringIncludes(messages[0], "Plan:");
            assertStringIncludes(messages[0], "tutorial-change.md");
            await presentTutorialEvent({ runtime: restarted, sessionId: loaded.sessionId, uiAPI, event: idle });
            assertEquals(messages.length, 1, "Ordinary idle events must not repeat the restored recap.");
            const restored = restarted.getSessionSnapshot(loaded.sessionId);
            assertEquals(restored?.tutorialContext, savedContext);
            assertEquals(restored?.managed?.generation, savedGeneration);

            await writeControllerState(projectRoot, { planId, planName }, { verifiedAt: null, deliveryEvidence: null });
            messages.length = 0;
            await restarted.replaySession(loaded.sessionId);
            await restoreVerifiedTutorialRecap({ runtime: restarted, sessionId: loaded.sessionId, uiAPI });
            assertEquals(messages, [], "A persisted completion flag alone must not restore an unproven recap.");
            assertEquals(restarted.getSessionSnapshot(loaded.sessionId)?.tutorialContext, savedContext);
        } finally {
            await runtime.closeAllSessionsWhenIdle();
            await restarted.closeAllSessionsWhenIdle();
        }
    });
});
