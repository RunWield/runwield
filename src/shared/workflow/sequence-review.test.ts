import { dirname } from "@std/path";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { getTransitionJournalPath } from "./state-transition.ts";
import { assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { HostedSession } from "../session/hosted-session.js";
import { defineCommittedGitFixture } from "../git-test-fixture.ts";
import { loadPlan, resolveSiblingChildPlanDependencies, savePlan, updatePlanFrontMatter } from "../../plan-store.js";
import { applySequenceReviewDecision, prepareSequenceReview } from "./sequence-review.ts";
import {
    claimWorkflowToolEvent,
    listPendingWorkflowToolEvents,
    waitForWorkflowToolEvent,
} from "./workflow-tool-events.ts";
import type { PlanWrittenEventPayload } from "./workflow-tool-events.ts";
import { normalizePlanApprovalAction, primaryPlanApprovalActionForClassification } from "./plan-approval.ts";
import { isEpicPlan, isProjectPlan, isSequencePlan, projectPlanType } from "../project-plan.ts";
import { createPlanWrittenTool } from "../../tools/plan-written.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const fixture = defineCommittedGitFixture({ ".gitignore": ".wld/\n" });
type HostedManager = NonNullable<ConstructorParameters<typeof HostedSession>[0]["sessionManager"]>;

async function setup() {
    const cwd = await fixture.checkout();
    await savePlan(cwd, "sequence", "# Search improvements\n\n## Context\n\nIndex then search.", {
        classification: "PROJECT",
        type: "sequence",
        status: "draft",
        affectedPaths: [],
    });
    for (const [index, name] of ["index", "search"].entries()) {
        await savePlan(cwd, `sequence/${name}`, `# ${name}\n\n## Context\n\nImplement ${name}.`, {
            classification: "PLANNED_CHANGE",
            status: "draft",
            parentPlan: "sequence",
            order: index + 1,
            dependencies: index ? ["index"] : [],
            affectedPaths: [],
        });
    }
    const manager = SessionManager.inMemory(cwd);
    const hostedSession = new HostedSession({ id: crypto.randomUUID(), cwd, sessionManager: manager as HostedManager });
    hostedSession.setRootAgentSession({ dispose() {} });
    hostedSession.beginTurn("review");
    return { cwd, hostedSession };
}

Deno.test("PROJECT type persists and selects actions without making containers executable", async () => {
    const { cwd } = await setup();
    try {
        const plan = await loadPlan(cwd, "sequence");
        assertExists(plan);
        assertEquals(plan.attrs.type, "sequence");
        assertEquals(isProjectPlan(plan.attrs), true);
        assertEquals(isSequencePlan(plan.attrs), true);
        assertEquals(isEpicPlan(plan.attrs), false);
        assertEquals(projectPlanType({ classification: "PROJECT" }), "epic");
        assertEquals(primaryPlanApprovalActionForClassification("PROJECT", "sequence"), "run");
        assertEquals(primaryPlanApprovalActionForClassification("PROJECT"), "decompose");
        assertEquals(normalizePlanApprovalAction({ classification: "PROJECT", type: "epic", action: "run" }), "later");
        assertEquals(isEpicPlan({ classification: "PLANNED_CHANGE", type: "epic" }), false);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

for (const approvalAction of ["run", "later"] as const) {
    Deno.test(`Sequence ${approvalAction} settles every child and publishes one correct handoff`, async () => {
        const { cwd, hostedSession } = await setup();
        try {
            hostedSession.setWorkflowPlanName("sequence");
            const documents = await prepareSequenceReview(cwd, "sequence");
            const result = await applySequenceReviewDecision({
                cwd,
                documents,
                hostedSession,
                toolCallId: "approve",
                decision: {
                    approved: true,
                    approvalAction,
                    documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                },
            });
            assertEquals(result.approved, true, result.feedback);
            for (const doc of documents) {
                assertEquals((await loadPlan(cwd, doc.planName))?.attrs.status, "ready_for_work");
            }
            const events = listPendingWorkflowToolEvents(hostedSession);
            assertEquals(events.length, 1);
            const expectedPlanName = approvalAction === "run" ? "sequence/index" : "sequence";
            assertEquals(result.workflowOutcome?.planName, expectedPlanName);
            assertEquals(result.workflowOutcome?.outcome, approvalAction === "run" ? "approved_execute" : "saved");
            const event = claimWorkflowToolEvent(hostedSession, { kinds: ["plan_written"], owningSession: null });
            assertEquals(event?.kind, "plan_written");
            const payload = event?.payload as PlanWrittenEventPayload | undefined;
            assertEquals(payload?.planName, expectedPlanName);
        } finally {
            await Deno.remove(cwd, { recursive: true });
        }
    });
}

Deno.test("Sequence rejects stale child content before approving any member", async () => {
    const { cwd, hostedSession } = await setup();
    try {
        const documents = await prepareSequenceReview(cwd, "sequence");
        const last = documents[2];
        await Deno.writeTextFile(last.planPath, `${last.plan}\nA changed requirement.\n`);
        const result = await applySequenceReviewDecision({
            cwd,
            documents,
            hostedSession,
            toolCallId: "stale",
            decision: {
                approved: true,
                approvalAction: "run",
                documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
            },
        });
        assertEquals(result.approved, false);
        assertStringIncludes(result.feedback || "", "changed");
        assertEquals((await loadPlan(cwd, "sequence/index"))?.attrs.status, "draft");
        assertEquals(listPendingWorkflowToolEvents(hostedSession).length, 0);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Sequence feedback keeps each direct edit on its Plan and does not authorize execution", async () => {
    const { cwd, hostedSession } = await setup();
    try {
        const documents = await prepareSequenceReview(cwd, "sequence");
        const result = await applySequenceReviewDecision({
            cwd,
            documents,
            hostedSession,
            toolCallId: "feedback",
            decision: {
                approved: false,
                documents: documents.map((doc, index) => ({
                    planId: doc.planId,
                    plan: `${doc.plan}\nEdit ${index}.\n`,
                    feedback: `Comment ${index}`,
                })),
            },
        });
        assertEquals(result.workflowOutcome?.outcome, "feedback");
        for (const [index, doc] of documents.entries()) {
            const plan = await loadPlan(cwd, doc.planName);
            assertEquals(plan?.attrs.status, "feedback");
            assertStringIncludes(plan?.body || "", `Edit ${index}.`);
            assertStringIncludes(result.feedback || "", `${doc.planName} (${doc.planId})`);
        }
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Sequence preflight rejects omitted children and forward dependencies", async () => {
    const { cwd } = await setup();
    try {
        await assertRejects(
            () => prepareSequenceReview(cwd, "sequence", [{ planName: "sequence/index" }]),
            Error,
            "every child",
        );
        await updatePlanFrontMatter(cwd, "sequence/index", { dependencies: ["search"] }, {}, {
            expectedRevision: (await loadPlan(cwd, "sequence/index"))!.revision,
        });
        await assertRejects(() => prepareSequenceReview(cwd, "sequence"), Error, "forward dependency");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Sibling Plan ID dependency survives a child rename", async () => {
    const { cwd } = await setup();
    try {
        const documents = await prepareSequenceReview(cwd, "sequence");
        const first = documents[1];
        await updatePlanFrontMatter(cwd, "sequence/search", { dependencies: [first.planId] }, {}, {
            expectedRevision: documents[2].revision,
        });
        await Deno.rename(first.planPath, first.planPath.replace("/index.md", "/renamed.md"));
        const dependencies = await resolveSiblingChildPlanDependencies(cwd, "sequence", [first.planId]);
        assertEquals(dependencies[0].planName, "sequence/renamed");
        assertEquals(dependencies[0].planId, first.planId);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("plan_written reviews all Sequence tabs and dispatches the first child without Slicer", async () => {
    const { cwd, hostedSession } = await setup();
    try {
        hostedSession.setInteractionAdapter({
            requestInteraction: (request) => {
                const documents = request._meta?.sequenceDocuments as Awaited<ReturnType<typeof prepareSequenceReview>>;
                assertEquals(documents.length, 3);
                return Promise.resolve({
                    outcome: "accepted",
                    _meta: {
                        approved: true,
                        sequenceDecision: {
                            approved: true,
                            approvalAction: "run",
                            documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                        },
                    },
                });
            },
        });
        const tool = createPlanWrittenTool({ hostedSession });
        const result = await tool.execute(
            "tool-review",
            { planName: "sequence", plans: [{ planName: "sequence/index" }, { planName: "sequence/search" }] },
            undefined,
            undefined,
            {} as ExtensionToolContext,
        );
        assertEquals((result.details as ToolOutcome).outcome, "approved_execute");
        assertEquals((result.details as ToolOutcome).planName, "sequence/index");
        assertEquals(listPendingWorkflowToolEvents(hostedSession).length, 1);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

interface ToolOutcome {
    outcome?: string;
    planName?: string;
}

Deno.test("Sequence browser transport preserves the full decision for the workflow owner", async () => {
    const { cwd, hostedSession } = await setup();
    try {
        const documents = await prepareSequenceReview(cwd, "sequence");
        const { createScriptedReviewBrowser } = await import("../../ui/review/review-test-fixture.ts");
        const { submitPlanForReview } = await import("../../ui/review/plan-review.ts");
        const scripted = createScriptedReviewBrowser("decision", {
            approved: true,
            approvalAction: "run",
            documents: documents.map((doc, index) => ({
                planId: doc.planId,
                plan: `${doc.plan}\nReviewed tab ${index}.\n`,
                ...(index ? { executionAgent: "engineer" as const, collaborationRecommendation: "pair" as const } : {}),
            })),
        });
        const response = await submitPlanForReview({
            cwd,
            planName: "sequence",
            planPath: documents[0].planPath,
            sequenceDocuments: documents,
            browser: scripted.browser,
        });
        assertExists(response.sequenceDecision);
        assertEquals(response.sequenceDecision.documents?.length, 3);
        assertEquals((await loadPlan(cwd, "sequence"))?.attrs.status, "draft");
        const accepted = await applySequenceReviewDecision({
            cwd,
            documents,
            hostedSession,
            toolCallId: "browser",
            decision: response.sequenceDecision,
        });
        assertEquals(accepted.approved, true, accepted.feedback);
        assertEquals((await loadPlan(cwd, "sequence/search"))?.attrs.collaborationRecommendation, "pair");
        assertStringIncludes((await loadPlan(cwd, "sequence/index"))!.body, "Reviewed tab 1.");
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("An interrupted Sequence write blocks child actions until the complete group is restored", async () => {
    const { cwd } = await setup();
    try {
        const documents = await prepareSequenceReview(cwd, "sequence");
        const { getTransitionJournalPath } = await import("./state-transition.ts");
        const { getPlanRevisionForText } = await import("../../plan-store.js");
        const { healSettledTransitionRecords } = await import("./transition-recovery.ts");
        const { executePlanAction } = await import("./plan-actions.ts");
        const plans = await Promise.all(documents.map(async (doc) => {
            const after = doc.plan.replace('status: "draft"', 'status: "ready_for_work"');
            return {
                planName: doc.planName,
                before: doc.plan,
                beforeRevision: doc.revision,
                after,
                afterRevision: await getPlanRevisionForText(after),
            };
        }));
        assertEquals(plans[1].before === plans[1].after, false);
        const path = getTransitionJournalPath(cwd, "interrupted-sequence");
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
        await Deno.writeTextFile(
            path,
            JSON.stringify({
                transitionId: "interrupted-sequence",
                planName: "sequence",
                operation: "sequence_review_approved",
                state: "applying",
                resources: [{ kind: "catalog" }, ...plans.map((plan) => ({ kind: "plan", id: plan.planName }))],
                completedEffects: [{ effect: "sequence_review_prepared", proof: { plans } }],
            }),
        );
        await Deno.writeTextFile(documents[1].planPath, plans[1].after);
        assertEquals((await healSettledTransitionRecords(cwd)).remaining.length, 1);
        const child = await loadPlan(cwd, "sequence/index");
        assertExists(child);
        const action = await executePlanAction(cwd, {
            planId: documents[1].planId,
            expectedRevision: child.revision,
            expectedStatus: child.attrs.status,
            expectedWorktree: { kind: "none" },
            action: "put_on_hold",
        });
        assertEquals(action.kind, "invalid_action");
        assertEquals((await loadPlan(cwd, "sequence/index"))?.attrs.status, "ready_for_work");
        await Deno.writeTextFile(documents[1].planPath, `${plans[1].after}\nNew external edit.\n`);
        assertEquals((await healSettledTransitionRecords(cwd)).remaining.length, 1);
        assertStringIncludes(await Deno.readTextFile(documents[1].planPath), "New external edit.");
        await Deno.writeTextFile(documents[1].planPath, plans[1].before);
        assertEquals((await healSettledTransitionRecords(cwd)).closed.length, 1);
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Sequence continuation uses sibling IDs and stops at a held child", async () => {
    const { cwd, hostedSession } = await setup();
    try {
        const docs = await prepareSequenceReview(cwd, "sequence");
        await updatePlanFrontMatter(cwd, "sequence/search", { dependencies: [docs[1].planId] }, {}, {
            expectedRevision: docs[2].revision,
        });
        const documents = await prepareSequenceReview(cwd, "sequence");
        await applySequenceReviewDecision({
            cwd,
            documents,
            hostedSession,
            toolCallId: "save",
            decision: {
                approved: true,
                approvalAction: "later",
                documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
            },
        });
        const { resolveEpicContinuation } = await import("./epic-continuation.ts");
        const first = await loadPlan(cwd, "sequence/index");
        await updatePlanFrontMatter(cwd, "sequence/index", { status: "verified" }, {}, {
            expectedRevision: first!.revision,
        });
        const next = await resolveEpicContinuation({ cwd, completedPlanName: "sequence/index" });
        assertEquals(next.kind, "execute");
        assertEquals(next.childPlanName, "sequence/search");
        const second = await loadPlan(cwd, "sequence/search");
        await updatePlanFrontMatter(
            cwd,
            "sequence/search",
            { status: "on_hold", heldFromStatus: "ready_for_work" },
            {},
            { expectedRevision: second!.revision },
        );
        assertEquals(
            (await resolveEpicContinuation({ cwd, completedPlanName: "sequence/index" })).reason,
            "child_on_hold",
        );
    } finally {
        await Deno.remove(cwd, { recursive: true });
    }
});

interface SequenceJournalState {
    state: string;
    completedEffects: Array<{ effect: string }>;
}

for (const failurePoint of ["acceptance", "commit"] as const) {
    Deno.test(`Sequence ${failurePoint} persistence failure cannot dispatch a child and permits retry`, async () => {
        await withProcessGlobalTestLock(async () => {
            const { cwd, hostedSession } = await setup();
            const originalRename = Deno.rename;
            const abort = new AbortController();
            const waiting = waitForWorkflowToolEvent(hostedSession, {
                kinds: ["plan_written"],
                owningSession: null,
                signal: abort.signal,
            }).catch((error) => {
                if (!abort.signal.aborted) throw error;
                return null;
            });
            try {
                const documents = await prepareSequenceReview(cwd, "sequence");
                const journalDir = dirname(getTransitionJournalPath(cwd, "unused"));
                let failed = false;
                // Fail the filesystem replacement, keeping real Plan writes, locks and journals.
                Deno.rename = async (from, to) => {
                    if (!failed && dirname(String(to)) === journalDir) {
                        const record: SequenceJournalState = JSON.parse(await Deno.readTextFile(from));
                        const atFailure = failurePoint === "commit"
                            ? record.state === "committed"
                            : record.state === "applying" &&
                                record.completedEffects.some((effect) => effect.effect === "sequence_review_accepted");
                        if (atFailure) {
                            failed = true;
                            throw new Deno.errors.PermissionDenied(`injected ${failurePoint} persistence failure`);
                        }
                    }
                    return await originalRename(from, to);
                };
                const result = await applySequenceReviewDecision({
                    cwd,
                    documents,
                    hostedSession,
                    toolCallId: "retry-approval",
                    decision: {
                        approved: true,
                        approvalAction: "run",
                        documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                    },
                });
                assertEquals(failed, true);
                assertEquals(result.approved, false);
                assertStringIncludes(result.feedback || "", `injected ${failurePoint}`);
                abort.abort();
                assertEquals(await waiting, null, "a failed decision must not wake the execution consumer");
                assertEquals(listPendingWorkflowToolEvents(hostedSession), []);
                const reopened = new HostedSession({
                    id: "reopened",
                    cwd,
                    sessionManager: hostedSession.getRootSessionManager(),
                });
                assertEquals(
                    listPendingWorkflowToolEvents(reopened),
                    [],
                    "no failed approval may replay from the Session",
                );
                for (const doc of documents) {
                    assertEquals((await loadPlan(cwd, doc.planName))?.revision, doc.revision);
                }
                Deno.rename = originalRename;
                const retry = await applySequenceReviewDecision({
                    cwd,
                    documents: await prepareSequenceReview(cwd, "sequence"),
                    hostedSession,
                    toolCallId: "retry-approval",
                    decision: {
                        approved: true,
                        approvalAction: "run",
                        documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
                    },
                });
                assertEquals(retry.approved, true, retry.feedback);
                assertEquals(listPendingWorkflowToolEvents(hostedSession).length, 1);
                assertEquals(retry.workflowOutcome?.planName, "sequence/index");
            } finally {
                Deno.rename = originalRename;
                abort.abort();
                await waiting;
                await Deno.remove(cwd, { recursive: true });
            }
        });
    });
}

Deno.test("Sequence live consumer sees committed approval before receiving the child handoff", async () => {
    const { cwd, hostedSession } = await setup();
    const abort = new AbortController();
    const waiting = waitForWorkflowToolEvent(hostedSession, {
        kinds: ["plan_written"],
        owningSession: null,
        signal: abort.signal,
    }).then((event) => {
        const dir = dirname(getTransitionJournalPath(cwd, "unused"));
        const journals = [...Deno.readDirSync(dir)].filter((entry) => entry.name.endsWith(".json"));
        const states = journals.map((entry) => {
            const record: SequenceJournalState = JSON.parse(Deno.readTextFileSync(`${dir}/${entry.name}`));
            return record.state;
        });
        return { event, states };
    }).catch((error) => {
        if (!abort.signal.aborted) throw error;
        return null;
    });
    try {
        const documents = await prepareSequenceReview(cwd, "sequence");
        await applySequenceReviewDecision({
            cwd,
            documents,
            hostedSession,
            toolCallId: "committed-approval",
            decision: {
                approved: true,
                approvalAction: "run",
                documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
            },
        });
        abort.abort();
        const dispatched = await waiting;
        assertExists(dispatched);
        assertEquals(
            dispatched.states.every((state) => state === "committed"),
            true,
            "handoff preceded durable commit",
        );
        assertEquals("planName" in dispatched.event.payload && dispatched.event.payload.planName, "sequence/index");
    } finally {
        abort.abort();
        await waiting;
        await Deno.remove(cwd, { recursive: true });
    }
});

Deno.test("Sequence preserves committed approval when Session publication fails and can retry", async () => {
    const { cwd, hostedSession } = await setup();
    const manager = hostedSession.getRootSessionManager()!;
    assertExists(manager.appendCustomEntry);
    const append = manager.appendCustomEntry.bind(manager);
    try {
        const documents = await prepareSequenceReview(cwd, "sequence");
        manager.appendCustomEntry = () => {
            throw new Error("Session storage unavailable");
        };
        const decision = {
            approved: true,
            approvalAction: "run" as const,
            documents: documents.map((doc) => ({ planId: doc.planId, plan: doc.plan })),
        };
        const result = await applySequenceReviewDecision({
            cwd,
            documents,
            decision,
            hostedSession,
            toolCallId: "publish-retry",
        });
        assertEquals(result.cancellationReason, "sequence_handoff_failed");
        assertStringIncludes(result.feedback || "", "decision was saved");
        assertEquals(listPendingWorkflowToolEvents(hostedSession), []);
        for (const doc of documents) {
            assertEquals((await loadPlan(cwd, doc.planName))?.attrs.status, "ready_for_work");
        }
        manager.appendCustomEntry = append;
        const fresh = await prepareSequenceReview(cwd, "sequence");
        const retry = await applySequenceReviewDecision({
            cwd,
            documents: fresh,
            hostedSession,
            toolCallId: "publish-retry",
            decision: { ...decision, documents: fresh.map((doc) => ({ planId: doc.planId, plan: doc.plan })) },
        });
        assertEquals(retry.approved, true, retry.feedback);
        assertEquals(retry.cancellationReason, undefined);
        assertEquals(listPendingWorkflowToolEvents(hostedSession).length, 1);
    } finally {
        manager.appendCustomEntry = append;
        await Deno.remove(cwd, { recursive: true });
    }
});
