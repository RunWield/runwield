import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { loadPlan, savePlan } from "../../plan-store.js";
import { makeManagedSessionFixture } from "../../testing/managed-session-fixture.ts";
import { git } from "../git-test-fixture.ts";
import { openPersistedRootSession } from "./root-session.js";
import { RuntimeEventTypes } from "./session-runtime-events.js";
import {
    readPersistedPendingSegmentContinuation,
    readPersistedSegmentLineageEvidence,
} from "./workflow-context-session.js";
import { buildExecutionSegmentContinuation } from "../workflow/execution-segment-handoff.ts";
import { loadPlanActionEvidence } from "../workflow/plan-actions.ts";

interface TranscriptEntry {
    type?: string;
    message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
}

function executionSeedCount(transcript: string): number {
    const entries: TranscriptEntry[] = transcript.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return entries.filter((entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        JSON.stringify(entry.message.content).includes("Execution owner: plan-engineer.")
    ).length;
}

test("preparation failure leaves the planning segment current", async () => {
    const source = await fsReadFile(new URL("./runtime/workflows.ts", import.meta.url), "utf8");
    assertStringIncludes(source, "prepareSegmentHandoff: !interrupted");
    assertStringIncludes(source, "await this.turns.rollManagedSessionSegment");
    assert(
        source.indexOf("prepareSegmentHandoff: !interrupted") <
            source.indexOf("await this.turns.rollManagedSessionSegment"),
    );
});

test("execution handoff revalidates the approved Plan snapshot before preparation", async () => {
    const source = await fsReadFile(new URL("../workflow/plan-executor.ts", import.meta.url), "utf8");
    assertStringIncludes(source, "validateApprovedPlanSnapshotForHandoff");
    assertStringIncludes(source, "Plan revision changed after approval");
    assertStringIncludes(source, "Plan status changed after approval");
    assertStringIncludes(source, "Managed execution handoff requires complete approval-time Plan action evidence");
    assertStringIncludes(source, "normalizeApprovalSnapshotForHandoff(approvalTriageMeta)");
    assert(!source.includes("approvalTriageMeta: _triageMeta || effectiveMeta"));
    assert(
        source.indexOf("const approvalValidation") <
            source.indexOf("executionContext = await startActiveExecutionWorkflow"),
    );
});

test("managed execution rollover writes one fresh successor and rejects stale Plan evidence before another roll", async () => {
    await withRuntimeCommandFixture(
        "execution-segment-runtime-",
        async ({ homeDir, projectRoot, setModelResponseFactory }) => {
            const fixture = await makeManagedSessionFixture({
                home: homeDir,
                projectRoot,
                dbPath: `${homeDir}/owner.sqlite3`,
            });
            let handle: ReturnType<typeof fixture.openRuntime> | null = null;
            try {
                await git(fixture.projectRoot, ["init", "-b", "main"]);
                await git(fixture.projectRoot, ["config", "user.email", "test@example.com"]);
                await git(fixture.projectRoot, ["config", "user.name", "RunWield Test"]);
                await fsWriteFile(`${fixture.projectRoot}/README.md`, "fixture\n");
                await git(fixture.projectRoot, ["add", "."]);
                await git(fixture.projectRoot, ["commit", "-m", "fixture: initial project"]);
                await savePlan(fixture.projectRoot, "execution-handoff", "# Execution Handoff\n\nApproved", {
                    planId: "plan-execution-handoff",
                    status: "ready_for_work",
                    classification: "PLANNED_CHANGE",
                    executionAgent: "engineer",
                });
                const plan = await loadPlan(fixture.projectRoot, "execution-handoff");
                if (!plan) throw new Error("Expected saved Plan");
                const evidence = await loadPlanActionEvidence(fixture.projectRoot, "plan-execution-handoff");
                if (evidence.kind !== "success") throw new Error(evidence.message);
                const continuation = buildExecutionSegmentContinuation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    planId: "plan-execution-handoff",
                    planName: "execution-handoff",
                    approvedRevision: evidence.evidence.revision,
                    approvedStatus: evidence.evidence.status,
                    approvedMarkdown: plan.markdown,
                    preparedEvidence: evidence.evidence,
                    activeWorkflow: { planName: "execution-handoff", triageMeta: {}, executionAgent: "engineer" },
                    executionOwner: "plan-engineer",
                    collaborationStyle: "autonomous",
                    collaborationRecommendation: "autonomous",
                });

                let modelCalls = 0;
                setModelResponseFactory(() => {
                    modelCalls += 1;
                    return fauxAssistantMessage(fauxToolCall("task_completed", { message: "unexpected" }));
                });
                const runtimeHandle = fixture.openRuntime("test", "execution-handoff-owner");
                handle = runtimeHandle;
                const before = runtimeHandle.store.listSessionTranscriptSegments(fixture.session.runwieldSessionId);
                await savePlan(fixture.projectRoot, "execution-handoff", "# Execution Handoff\n\nChanged", plan.attrs, {
                    expectedRevision: plan.revision,
                });
                const rejected = await runtimeHandle.runtime.executePlan(runtimeHandle.adoptedSessionId, {
                    planName: "execution-handoff",
                    planContent: plan.markdown,
                    triageMeta: {
                        ...plan.attrs,
                        revision: evidence.evidence.revision,
                        status: evidence.evidence.status,
                        worktree: evidence.evidence.worktree,
                    },
                });
                assertStringIncludes(rejected.error || "", "Plan revision changed after approval");
                assertEquals(
                    runtimeHandle.store.listSessionTranscriptSegments(fixture.session.runwieldSessionId).length,
                    1,
                );
                assertEquals(modelCalls, 0);
                const rolled = await runtimeHandle.runtime.rollManagedSessionSegment(runtimeHandle.adoptedSessionId, {
                    kind: "execution",
                    continuation,
                    expectedGeneration:
                        runtimeHandle.runtime.getSessionSnapshot(runtimeHandle.adoptedSessionId)?.managed
                            ?.generation ?? null,
                });
                const after = runtimeHandle.store.listSessionTranscriptSegments(fixture.session.runwieldSessionId);
                assertEquals(after.length, 2);
                assertEquals(after[0].segmentId, before[0].segmentId);
                assertEquals(after[1].segmentId, rolled.successorSegmentId);
                assertEquals(after[1].sealedAt, null);
                assertEquals(typeof after[0].sealedAt, "string");
                const successorText = await fsReadFile(rolled.transcriptPath, "utf8");
                assertEquals(successorText.includes("Committed hello."), false);

                const { sessionManager } = await openPersistedRootSession({
                    cwd: fixture.projectRoot,
                    sessionId: rolled.piSessionId,
                    sessionPath: rolled.transcriptPath,
                });
                const pending = readPersistedPendingSegmentContinuation(sessionManager);
                assert(pending && typeof pending === "object" && !Array.isArray(pending));
                assertEquals(pending.kind, "execution");
                assertEquals(pending.executionOwner, "plan-engineer");
                assertEquals(pending.preparedEvidence, continuation.preparedEvidence);
                assertEquals(readPersistedSegmentLineageEvidence(sessionManager)?.parentSegmentId, before[0].segmentId);
                const disposeManager = Reflect.get(sessionManager, "dispose");
                if (typeof disposeManager === "function") await disposeManager.call(sessionManager);

                assertEquals(
                    runtimeHandle.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state,
                    "idle",
                );
            } finally {
                if (handle) await handle.close();
                await fixture.cleanup();
            }
        },
    );
});

test("committed execution continuation reloads in one successor and writes one seed turn", async () => {
    await withRuntimeCommandFixture(
        "execution-segment-resume-",
        async ({ homeDir, projectRoot, setModelResponseFactories }) => {
            const fixture = await makeManagedSessionFixture({
                home: homeDir,
                projectRoot,
                dbPath: `${homeDir}/owner.sqlite3`,
            });
            let handle: ReturnType<typeof fixture.openRuntime> | null = null;
            try {
                await git(fixture.projectRoot, ["init", "-b", "main"]);
                await git(fixture.projectRoot, ["config", "user.email", "test@example.com"]);
                await git(fixture.projectRoot, ["config", "user.name", "RunWield Test"]);
                await fsWriteFile(`${fixture.projectRoot}/README.md`, "fixture\n");
                await git(fixture.projectRoot, ["add", "."]);
                await git(fixture.projectRoot, ["commit", "-m", "fixture: initial project"]);
                await savePlan(fixture.projectRoot, "execution-resume", "# Execution Resume\n\nApproved", {
                    planId: "plan-execution-resume",
                    status: "ready_for_work",
                    classification: "PLANNED_CHANGE",
                    complexity: "MEDIUM",
                    summary: "Execution resume",
                    affectedPaths: ["implemented.txt"],
                    executionAgent: "engineer",
                });
                const plan = await loadPlan(fixture.projectRoot, "execution-resume");
                if (!plan) throw new Error("Expected saved Plan");
                const evidence = await loadPlanActionEvidence(fixture.projectRoot, "plan-execution-resume");
                if (evidence.kind !== "success") throw new Error(evidence.message);
                const continuation = buildExecutionSegmentContinuation({
                    runwieldSessionId: fixture.session.runwieldSessionId,
                    planId: "plan-execution-resume",
                    planName: "execution-resume",
                    approvedRevision: evidence.evidence.revision,
                    approvedStatus: evidence.evidence.status,
                    approvedMarkdown: plan.markdown,
                    preparedEvidence: evidence.evidence,
                    activeWorkflow: {
                        planName: "execution-resume",
                        triageMeta: plan.attrs,
                        executionAgent: "engineer",
                        collaborationStyle: "autonomous",
                        collaborationRecommendation: "autonomous",
                        executionMode: "non_git_in_place",
                        nonGitInPlace: true,
                        projectRoot: fixture.projectRoot,
                        executionCwd: fixture.projectRoot,
                    },
                    executionOwner: "plan-engineer",
                    collaborationStyle: "autonomous",
                    collaborationRecommendation: "autonomous",
                });
                setModelResponseFactories([
                    () => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.2" })),
                    () =>
                        fauxAssistantMessage(
                            fauxToolCall("write", { path: "implemented.txt", content: "implemented\n" }),
                        ),
                    () =>
                        fauxAssistantMessage(
                            fauxToolCall("task_completed", { message: "- Implemented and verified the Plan." }),
                        ),
                ]);

                handle = fixture.openRuntime("test", "execution-resume-owner");
                const rolled = await handle.runtime.rollManagedSessionSegment(handle.adoptedSessionId, {
                    kind: "execution",
                    continuation,
                    expectedGeneration: 0,
                });
                handle = await fixture.restartRuntime(handle, "execution-resume-restarted-owner");
                let resolveToolStarted = () => {};
                const toolStarted = new Promise<void>((resolve) => {
                    resolveToolStarted = resolve;
                });
                handle.runtime.subscribeSessionEvents(handle.adoptedSessionId, (event) => {
                    if (event.type === RuntimeEventTypes.TOOL_START) resolveToolStarted();
                });
                const execution = handle.runtime.executePlan(handle.adoptedSessionId, {
                    planName: "execution-resume",
                    planContent: plan.markdown,
                    triageMeta: plan.attrs,
                });
                await toolStarted;
                let closeSettled = false;
                const close = handle.runtime.closeSession(handle.adoptedSessionId).then((result) => {
                    closeSettled = true;
                    return result;
                });
                await new Promise((resolve) => setTimeout(resolve, 20));
                assertEquals(closeSettled, false);
                assertEquals((await execution).executionComplete, true);
                assertEquals(await close, { ok: true, closed: true });
                const resumedSegments = handle.store.listSessionTranscriptSegments(fixture.session.runwieldSessionId);
                assertEquals(resumedSegments.length, 2);
                assertEquals(resumedSegments[1].segmentId, rolled.successorSegmentId);
                assertEquals(executionSeedCount(await fsReadFile(rolled.transcriptPath, "utf8")), 1);

                handle = await fixture.restartRuntime(handle, "execution-resume-consumed-owner");
                const segments = handle.store.listSessionTranscriptSegments(fixture.session.runwieldSessionId);
                assertEquals(segments.length, 2);
                assertEquals(segments[1].segmentId, rolled.successorSegmentId);
                assertEquals(executionSeedCount(await fsReadFile(rolled.transcriptPath, "utf8")), 1);
                assertEquals(
                    handle.store.inspectSessionActivation(fixture.session.runwieldSessionId).activation?.state,
                    "idle",
                );
            } finally {
                if (handle) await handle.close();
                await fixture.cleanup();
            }
        },
    );
});

test("legacy Session load acquires its writer lock before opening Pi", async () => {
    const source = await fsReadFile(new URL("./runtime/lifecycle-loading.ts", import.meta.url), "utf8");
    const loadStart = source.indexOf("async loadSession(");
    const loadSource = source.slice(loadStart);
    assert(loadStart >= 0);
    assert(
        loadSource.indexOf("ownerCoordinationStore.acquireSessionActivation") <
            loadSource.indexOf("await openPersistedRootSession"),
    );
});

test("managed operations rely on the OS lock without a heartbeat timer", async () => {
    const source = await fsReadFile(new URL("./runtime/managed-operations.ts", import.meta.url), "utf8");
    assert(!source.includes("setInterval(heartbeat"));
    assert(!source.includes("heartbeatFailureReason"));
});

test("semantic repair rolls managed Sessions and continues uncataloged Sessions", async () => {
    const source = await fsReadFile(new URL("./runtime/workflows.ts", import.meta.url), "utf8");
    assert(!source.includes("if (!managed) return validationResult"));
    assertStringIncludes(source, "runwieldSessionId: managed?.runwieldSessionId || session.id");
    assertStringIncludes(source, "if (managed) {");
    assert(!source.includes("Semantic repair handoff requires a segmented Session."));
    assertStringIncludes(source, 'kind: "semantic_repair"');
    assertStringIncludes(source, "return await this.runSemanticRepairContinuation");
});

test("execution seed excludes Planner history and carries approval images", async () => {
    const runner = await fsReadFile(new URL("../workflow/engineer-runner.ts", import.meta.url), "utf8");
    assertStringIncludes(runner, "runEngineerWithSegmentHandoff");
    assertStringIncludes(runner, "images: continuation.approval?.images");
    assert(
        !runner.includes("routerMessage") ||
            runner.indexOf("runEngineerWithSegmentHandoff") > runner.lastIndexOf("routerMessage"),
    );
});
