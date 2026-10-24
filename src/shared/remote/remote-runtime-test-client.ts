/** Separate remote process: all Session, tool and save behavior is production code. */
import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createMnemotecaTools, type MemoryParams } from "../../extensions/mnemoteca/tools.ts";
import { denoHelperBinaryExec } from "../../extensions/helper-binary-exec.ts";
import { assembleFinalSystemPrompt } from "../session/session.js";
import { loadAgentDef } from "../session/agents.js";
import { runSleepCommand, SYSTEM_SLEEP_MNEMOTECA_PORT } from "../../cmd/sleep/index.ts";
import { startInteractiveSession } from "../../ui/tui/chat-session.ts";
import { stdinStream } from "../../testing/stdin-stream.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { configureRemotePersonalResources } from "./personal-resources.ts";
import { configureRemoteModelConnection } from "../models/model-registry.ts";
import { configureRemoteMemoryConnection } from "./memory-bridge.ts";
import { configureRemoteSettingsConnection } from "./settings-bridge.ts";
import { configureRemoteMcpConnection } from "./mcp-bridge.ts";
import { RemoteSessionControl, type RemoteSessionControlConnection } from "./session-control-client.ts";
import { SessionHost } from "../session/session-host.ts";
import { createPlanWrittenTool } from "../../tools/plan-written.ts";
import { SessionRuntime } from "../session/session-runtime.ts";
import { HostedSession } from "../session/hosted-session.js";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildAgentSession } from "../session/session.js";
import { createRemoteRootSessionManager, getRemoteSessionSaveBridge } from "../session/root-session.js";
import { readImageRef } from "../session/image-attachments.ts";
import { recordNormalizedWorkflowContext } from "../session/workflow-context-session.js";
import { recordTutorialContext } from "../session/tutorial-context-session.ts";
import { appendExecutionWorkflowSnapshot } from "../session/execution-workflow-session.ts";
import { runResumeCommand } from "../../cmd/resume/index.ts";
import { requestLocalReviewInteraction } from "../session/local-review-interactions.ts";
import { resolveWorkflowPlanLocation } from "../workflow/plan-location.ts";
import { listEntries } from "../worktree-registry.js";
import { reconcileStoredPublication } from "../workflow/publication-machine.ts";
import { loadPlan } from "../../plan-store.js";
import { continueWorkflowValidation } from "../workflow/validation-supervisor.ts";
import { createGitPort } from "../git-port.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { loadPlanActionEvidence } from "../workflow/plan-actions.ts";
import { configureRemoteReviewHost } from "../../ui/workspace/server/review-host.ts";
import { configureGuideRunner } from "../../ui/workspace/routes/api/review-agent-handlers.js";
import { runRemoteGuideCommand } from "./guide-runner.ts";
import { createRemoteBrowserPort } from "./browser-bridge.ts";

export interface RuntimeReviewConfiguration {
    socketPath: string;
    origin: string;
}
export interface RuntimeClientInput {
    review?: RuntimeReviewConfiguration;
    connection: RemoteSessionControlConnection;
    resources: string;
    memoryCollection: string;
    cwd: string;
}
export interface RuntimeClientCommand {
    kind:
        | "background-wait"
        | "workflow-plan"
        | "workflow-execute"
        | "workflow-validate"
        | "local-recovery"
        | "local-validation-recovery"
        | "turn-tutorial"
        | "plan-written"
        | "plan-sessions"
        | "verify-plan-session"
        | "tutorial"
        | "reopen-review"
        | "artifact"
        | "seed-rollover-context"
        | "rollover"
        | "memory"
        | "core-prompt"
        | "sleep"
        | "mcp"
        | "handoff"
        | "reload"
        | "blocker"
        | "turn"
        | "turn-start"
        | "cancel"
        | "load"
        | "close"
        | "guard"
        | "upload"
        | "image-read"
        | "resume-command"
        | "load-start"
        | "close-session"
        | "snapshots"
        | "image-preflight-turn";
    text?: string;
    planId?: string;
    candidate?: import("../session/plan-session-lookup.ts").PlanAssociatedSession;
    tutorial?: import("../session/tutorial-context-session.ts").TutorialContextUpdate;
    initialTutorial?: import("../session/tutorial-context-session.ts").TutorialContext;
    segmentKind?: "execution" | "semantic_repair";
    memory?: MemoryParams;
    sessionId?: string;
    image?: boolean;
    ref?: string;
    modelOverride?: string;
}
export interface RuntimeClientSnapshot {
    id: string;
    busy: boolean;
    disposed: boolean;
}
export interface RuntimeClientReport {
    kind: string;
    text?: string;
    activeAgent?: string | null;
    ok?: boolean;
    error?: string;
    sessionId?: string;
    savedId?: string;
    managed?: boolean;
    dormant?: boolean;
    ref?: string;
    base64?: string;
    errors?: string[];
    selectedId?: string;
    notices?: string[];
    snapshots?: RuntimeClientSnapshot[];
    closed?: boolean;
    preparedModelOverride?: string;
    candidates?: import("../session/plan-session-lookup.ts").PlanAssociatedSession[];
    planAssociations?: import("../session/plan-association.ts").PlanAssociation[];
    reviewCount?: number;
    reviewKind?: string;
    canReopen?: boolean;
    rollover?: import("../session/segment-rollover.ts").SegmentRolloverResult;
    workflowContext?: import("../session/workflow-context-session.js").WorkflowContext | null;
    tutorialContext?: import("../session/tutorial-context-session.ts").TutorialContext | null;
    activeWorkflow?: import("../types.js").ActiveExecutionWorkflow | null;
    piSessionId?: string;
    result?: Awaited<ReturnType<SessionRuntime["runValidation"]>>;
    reviewUrl?: string;
    publicationPhase?: string | null;
    priorValidationCheckpoint?: import("../workflow/validation-checkpoint.ts").ValidationCheckpoint;
    validationCheckpoint?: import("../workflow/validation-checkpoint.ts").ValidationCheckpoint;
}
const lines = processLines(stdinStream());
const input: RuntimeClientInput = JSON.parse((await lines.read()).value || "{}");
configureRemotePersonalResources({ globalRoot: input.resources });
configureRemoteSettingsConnection(input.connection);
const clearMcp = configureRemoteMcpConnection(input.connection);
const clearMemory = configureRemoteMemoryConnection({ ...input.connection, collection: input.memoryCollection });
const clearModels = await configureRemoteModelConnection(input.connection);
if (!input.review) throw new Error("Remote runtime client requires review configuration");
const clearReviewHost = configureRemoteReviewHost(input.review);
const clearGuideRunner = configureGuideRunner(runRemoteGuideCommand);
const browser = createRemoteBrowserPort(input.connection);
const control = new RemoteSessionControl(input.connection);
const host = new SessionHost();
const runtime = new SessionRuntime({
    sessionHost: host,
    sessionStore: null,
    remoteSessionControl: control,
    ownerProcessKind: "test",
    ownerInstanceId: crypto.randomUUID(),
});
let sessionId = await runtime.createPromptReadySession({ cwd: input.cwd, agentName: "remote-runtime" });
const report = (kind: string, ok?: boolean, error?: string) => {
    const snapshot = runtime.getSessionSnapshot(sessionId);
    console.log(
        JSON.stringify({
            kind,
            ok,
            error,
            sessionId,
            savedId: snapshot?.managed?.runwieldSessionId,
            managed: Boolean(snapshot?.managed),
            dormant: runtime.isManagedSessionDormant(sessionId),
            workflowContext: snapshot?.workflowContext,
            tutorialContext: snapshot?.tutorialContext,
            activeWorkflow: runtime.getRuntimeActiveExecutionWorkflow(sessionId),
            piSessionId: snapshot?.sessionManagerId,
            planAssociations: snapshot?.planAssociations,
            canReopen: snapshot?.workflowContext?.canReopenPlanReview,
        }),
    );
};
const pending: Promise<void>[] = [];
let turnTools: ToolDefinition[] | undefined;
let reviewCount = 0;
function attachReviewInput() {
    runtime.setInteractionAdapter(sessionId, {
        supportsInteraction: (type) => type === "plan_review",
        requestInteraction(request) {
            if (request.type !== "plan_review") throw new Error("Unexpected interaction");
            reviewCount++;
            return { outcome: "canceled" };
        },
    });
}
try {
    report("ready");
    while (true) {
        const next = await lines.read();
        if (next.done) break;
        const command: RuntimeClientCommand = JSON.parse(next.value);
        if (command.kind === "close") break;
        try {
            if (command.kind === "background-wait") {
                const status = await host.requireSession(sessionId).backgroundTasks.wait(command.text || "");
                const deadline = Date.now() + 10000;
                while (
                    runtime.getSessionBackgroundTaskState(sessionId)?.pending ||
                    !runtime.isManagedSessionDormant(sessionId)
                ) {
                    if (Date.now() > deadline)
                        throw new Error("Background result did not settle in the laptop transcript");
                    await new Promise((resolve) => setTimeout(resolve, 5));
                }
                console.log(
                    JSON.stringify({
                        kind: command.kind,
                        text: JSON.stringify(status),
                        ok: status.state === "completed",
                    }),
                );
            } else if (command.kind === "local-validation-recovery") {
                const location = await resolveWorkflowPlanLocation(input.cwd, "remote-delivery");
                if (!location.plan) throw new Error("Delivery Plan missing");
                const local = new HostedSession({ id: crypto.randomUUID(), cwd: input.cwd });
                try {
                    const result = await continueWorkflowValidation({
                        hostedSession: local,
                        planName: "remote-delivery",
                        planContent: location.plan.markdown,
                        triageMeta: location.plan.attrs,
                        trigger: "session_resume",
                        git: createGitPort(),
                        workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                        // Cancel at the external CI boundary, after real local checkpoint recovery.
                        localCI: {
                            run: () => Promise.resolve({ kind: "canceled", output: "Local recovery comparison" }),
                        },
                    });
                    const recovered = await loadPlan(location.documentRoot, "remote-delivery");
                    console.log(
                        JSON.stringify({
                            kind: command.kind,
                            result,
                            priorValidationCheckpoint: location.plan.attrs.validationCheckpoint,
                            validationCheckpoint: recovered?.attrs.validationCheckpoint,
                        }),
                    );
                } finally {
                    local.dispose();
                }
            } else if (command.kind === "local-recovery") {
                // The local delivery recovery API reads these same project and Git receipts, without a Session bridge.
                const entries = await listEntries(input.cwd, { migrate: false });
                const attempt = entries.find((entry) => entry.planId === "remote-delivery-plan")?.publication;
                const recovered = attempt
                    ? await reconcileStoredPublication(input.cwd, attempt, { apply: false })
                    : null;
                console.log(JSON.stringify({ kind: command.kind, publicationPhase: recovered?.phase || null }));
            } else if (command.kind === "workflow-plan") {
                runtime.setInteractionAdapter(sessionId, {
                    supportsInteraction: (type) => type === "plan_review",
                    requestInteraction: (request, signal) =>
                        requestLocalReviewInteraction(request, signal, {
                            async onSurfaceReady(url: string) {
                                await browser.open(url);
                                console.log(JSON.stringify({ kind: "review-ready", reviewUrl: url }));
                            },
                        }),
                });
                const tool = createPlanWrittenTool({
                    hostedSession: host.requireSession(sessionId),
                    agentName: "remote-runtime",
                });
                const result = await runtime.promptUserTurn(sessionId, {
                    initialRequest: command.text || "Write and review the delivery Plan.",
                    agentName: "remote-runtime",
                    customTools: [tool],
                });
                report(command.kind, result.ok, result.error);
            } else if (command.kind === "workflow-execute" || command.kind === "workflow-validate") {
                runtime.setInteractionAdapter(sessionId, {
                    requestInteraction: (request) => {
                        console.log(JSON.stringify({ kind: "workflow-interaction", text: JSON.stringify(request) }));
                        return { outcome: "canceled" };
                    },
                });
                const { plan } = await resolveWorkflowPlanLocation(input.cwd, "remote-delivery");
                if (!plan) throw new Error("Delivery Plan missing");
                const evidence = await loadPlanActionEvidence(input.cwd, plan.attrs.planId || "");
                if (evidence.kind !== "success") throw new Error(evidence.message);
                const options = {
                    planName: "remote-delivery",
                    planContent: plan.markdown,
                    triageMeta: plan.attrs,
                    approvalEvidence: evidence.evidence,
                };
                const result =
                    command.kind === "workflow-execute"
                        ? await runtime.executePlan(sessionId, options)
                        : await runtime.runValidation(sessionId, options);
                console.log(
                    JSON.stringify({
                        kind: command.kind,
                        result,
                        savedId: runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId,
                        activeWorkflow: runtime.getRuntimeActiveExecutionWorkflow(sessionId),
                    }),
                );
            } else if (command.kind === "turn-tutorial") {
                const result = await runtime.promptUserTurn(sessionId, {
                    initialRequest: command.text || "Use the saved Plan context.",
                    agentName: "remote-runtime",
                    initialTutorialContext: command.initialTutorial,
                });
                report(command.kind, result.ok, result.error);
            } else if (command.kind === "plan-written") {
                attachReviewInput();
                const tool = createPlanWrittenTool({
                    hostedSession: host.requireSession(sessionId),
                    agentName: "remote-runtime",
                });
                const result = await runtime.promptUserTurn(sessionId, {
                    initialRequest: command.text || "Review the saved Plan.",
                    agentName: "remote-runtime",
                    customTools: [tool],
                });
                console.log(
                    JSON.stringify({
                        kind: command.kind,
                        ...result,
                        savedId: runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId,
                        reviewCount,
                        planAssociations: runtime.getSessionSnapshot(sessionId)?.planAssociations,
                        canReopen: runtime.getSessionSnapshot(sessionId)?.workflowContext?.canReopenPlanReview,
                    }),
                );
            } else if (command.kind === "plan-sessions") {
                console.log(
                    JSON.stringify({
                        kind: command.kind,
                        candidates: await runtime.listPlanAssociatedSessions(input.cwd, command.planId || ""),
                    }),
                );
            } else if (command.kind === "verify-plan-session") {
                if (!command.candidate) throw new Error("Candidate required");
                console.log(
                    JSON.stringify({
                        kind: command.kind,
                        ...(await runtime.verifyPlanAssociatedSession(command.candidate)),
                    }),
                );
            } else if (command.kind === "tutorial") {
                const result = await runtime.updateTutorialContext(
                    sessionId,
                    command.tutorial || { guidanceEnabled: true },
                );
                console.log(JSON.stringify({ kind: command.kind, ...result }));
            } else if (command.kind === "reopen-review") {
                attachReviewInput();
                const result = await runtime.reopenPlanReview(sessionId);
                console.log(JSON.stringify({ kind: command.kind, reviewKind: result.kind, reviewCount }));
            } else if (command.kind === "artifact") {
                const hosted = host.requireSession(sessionId);
                const result = await runtime.promptUserTurn(sessionId, {
                    initialRequest: "Register the artifact.",
                    agentName: "remote-runtime",
                    customTools: [
                        {
                            name: "fixture_artifact",
                            label: "Artifact",
                            description: "Register an artifact",
                            parameters: Type.Object({}),
                            async execute() {
                                const artifact = hosted.getManagedOperationCapability()!.registerArtifact({
                                    kind: "report",
                                    path: "docs/report.md",
                                    title: command.text || "report",
                                    registeredBy: "remote-runtime",
                                });
                                hosted.recordPlanAssociation({
                                    planId: "large-record-plan",
                                    planName: command.text,
                                    purpose: "planning",
                                });
                                hosted.getManagedOperationCapability()!.recordLastPlanReview!({
                                    planId: "large-record-plan",
                                    planName: command.text || "Report",
                                    planningAgentName: "remote-runtime",
                                });
                                return await Promise.resolve({
                                    content: [{ type: "text", text: JSON.stringify(artifact) }],
                                    details: null,
                                });
                            },
                        },
                    ],
                });
                report(command.kind, result.ok, result.error);
            } else if (command.kind === "turn-start") {
                pending.push(
                    runtime
                        .promptUserTurn(sessionId, {
                            initialRequest: command.text || "Call the slow MCP tool.",
                            agentName: "remote-runtime",
                            customTools: turnTools,
                        })
                        .then(
                            (result) => report("turn", result.ok, result.error),
                            (error: Error) => report("turn", false, String(error)),
                        ),
                );
                report("turn-started", true);
            } else if (command.kind === "seed-rollover-context") {
                const id = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId;
                if (!id) throw new Error("Session identity is unavailable");
                const operation = await control.begin(id);
                let bridge: ReturnType<typeof getRemoteSessionSaveBridge>;
                try {
                    const manager = await createRemoteRootSessionManager(
                        input.cwd,
                        control.sessionConnection(operation),
                    );
                    bridge = getRemoteSessionSaveBridge(manager);
                    recordNormalizedWorkflowContext(manager, {
                        routingIntent: "CHANGE",
                        complexity: "LOW",
                        planName: "remote-rollover",
                        planId: "rollover-plan",
                    });
                    recordTutorialContext(manager, {
                        version: 1,
                        guidanceEnabled: true,
                        shownExplanationIds: ["rollover"],
                        recapShown: true,
                        planId: "rollover-plan",
                    });
                    appendExecutionWorkflowSnapshot(manager, {
                        planName: "remote-rollover",
                        executionAgent: "engineer",
                        executionStarted: true,
                        executionMode: "non_git_in_place",
                        projectRoot: input.cwd,
                        executionCwd: input.cwd,
                        triageMeta: { planId: "rollover-plan", classification: "QUICK_FIX", complexity: "LOW" },
                    });
                    await control.checkpoint(operation);
                } catch (error) {
                    await control.markUncertain(operation).catch(() => {});
                    throw error;
                } finally {
                    bridge?.close();
                }
                report("seed-rollover-context", true);
            } else if (command.kind === "rollover") {
                const result = await runtime.rollManagedSessionSegment(sessionId, {
                    kind: command.segmentKind || "execution",
                    continuation: { handoff: command.text || "remote rollover" },
                });
                console.log(
                    JSON.stringify({
                        kind: "rollover",
                        ok: true,
                        rollover: result,
                        savedId: result.runwieldSessionId,
                        workflowContext: runtime.getSessionSnapshot(sessionId)?.workflowContext,
                        tutorialContext: runtime.getSessionSnapshot(sessionId)?.tutorialContext,
                    }),
                );
            } else if (command.kind === "cancel") {
                const result = runtime.cancelSession(sessionId);
                report("cancel", result.ok);
            } else if (command.kind === "memory") {
                if (!command.memory) throw new Error("Missing Memory operation");
                const [tool] = createMnemotecaTools({ cwd: input.cwd, exec: denoHelperBinaryExec });
                const result = await tool.execute(
                    "remote-memory",
                    command.memory,
                    undefined,
                    undefined,
                    {} as Parameters<typeof tool.execute>[4],
                );
                console.log(JSON.stringify({ kind: "memory", text: result.content, ok: true }));
            } else if (command.kind === "core-prompt") {
                const definition = await loadAgentDef("guide", input.cwd);
                const text = await assembleFinalSystemPrompt(
                    { ...definition, systemPrompt: "{{MEMORIES}}" },
                    [],
                    [],
                    input.cwd,
                );
                console.log(JSON.stringify({ kind: "core-prompt", text, ok: true }));
            } else if (command.kind === "sleep") {
                const notices: string[] = [];
                await runSleepCommand([], {
                    sessionId,
                    sessionRuntime: runtime,
                    uiAPI: { appendSystemMessage: (message) => notices.push(message) },
                    mnemotecaPort: SYSTEM_SLEEP_MNEMOTECA_PORT,
                    sessionPort: { startInteractiveSession },
                });
                console.log(
                    JSON.stringify({
                        kind: "sleep",
                        notices,
                        activeAgent: runtime.getSessionSnapshot(sessionId)?.activeAgent,
                    }),
                );
            } else if (command.kind === "blocker") {
                turnTools = [
                    {
                        name: "fixture_blocker",
                        label: "Fixture blocker",
                        description: "Wait for external release",
                        parameters: Type.Object({}),
                        executionMode: "sequential",
                        async execute() {
                            await writeFile(join(input.cwd, "block-started"), "started");
                            while (
                                !(await stat(join(input.cwd, "block-release")).then(
                                    () => true,
                                    () => false,
                                ))
                            ) {
                                await new Promise((resolve) => setTimeout(resolve, 5));
                            }
                            return { content: [{ type: "text", text: "Released" }], details: {} };
                        },
                    },
                ];
                report("blocker", true);
            } else if (command.kind === "handoff") {
                const result = await runtime.switchAgent(sessionId, { agentName: command.text || "remote-runtime" });
                report("handoff", result.ok, result.error);
            } else if (command.kind === "reload") {
                const result = await runtime.reloadSession(sessionId);
                report("reload", result.ok, result.error);
            } else if (command.kind === "mcp") {
                console.log(
                    JSON.stringify({
                        kind: "mcp",
                        notices: (await runtime.runMcpCommand(sessionId, command.text || "")).notifications.map(
                            (notice) => notice.message,
                        ),
                    }),
                );
            } else if (command.kind === "guard") {
                const errors: string[] = [];
                const hosted = new HostedSession({ id: crypto.randomUUID(), cwd: input.cwd });
                const missing =
                    command.text === "persisted"
                        ? SessionManager.create(input.cwd, join(input.cwd, "guard-sessions"))
                        : SessionManager.inMemory(input.cwd);
                hosted.setRootSessionManager(
                    command.text === "unbridged root" ? missing : SessionManager.inMemory(input.cwd),
                );
                try {
                    await buildAgentSession({
                        hostedSession: hosted,
                        cwd: input.cwd,
                        agentName: "remote-runtime",
                        sessionManager: missing,
                    });
                } catch (error) {
                    errors.push(String(error));
                }
                console.log(JSON.stringify({ kind: "guard", errors }));
            } else if (command.kind === "upload") {
                const image = await runtime.persistSessionImage(sessionId, {
                    base64: "AQIDBA==",
                    mimeType: "image/png",
                });
                console.log(JSON.stringify({ kind: "upload", ...image }));
            } else if (command.kind === "image-read") {
                const operation = await control.begin(command.sessionId || "");
                let bridge: ReturnType<typeof getRemoteSessionSaveBridge>;
                try {
                    const manager = await createRemoteRootSessionManager(
                        input.cwd,
                        control.sessionConnection(operation),
                    );
                    bridge = getRemoteSessionSaveBridge(manager);
                    const image = await readImageRef(command.ref || "", { cwd: input.cwd, sessionManager: manager });
                    await control.checkpoint(operation);
                    console.log(JSON.stringify({ kind: "image-read", ...image }));
                } finally {
                    bridge?.close();
                }
            } else if (command.kind === "snapshots") {
                console.log(JSON.stringify({ kind: "snapshots", snapshots: runtime.listSessions() }));
            } else if (command.kind === "load-start") {
                await runtime.closeAllSessionsWhenIdle();
                pending.push(
                    runtime.loadSession({ cwd: input.cwd, sessionId: command.sessionId || "" }).then(
                        (loaded) => {
                            sessionId = loaded.sessionId;
                            report("load", true);
                        },
                        (error: Error) => report("load", false, String(error)),
                    ),
                );
                report("load-started", true);
            } else if (command.kind === "close-session") {
                pending.push(
                    runtime.closeSession(command.sessionId || "").then(
                        (result) => console.log(JSON.stringify({ kind: "close-session", ...result })),
                        (error: Error) => report("close-session", false, String(error)),
                    ),
                );
                report("close-requested", true);
            } else if (command.kind === "resume-command") {
                const notices: string[] = [];
                let selectedId = "";
                await runResumeCommand([], {
                    sessionRuntime: runtime,
                    sessionId,
                    editor: { disableSubmit: false, setText() {} },
                    uiAPI: {
                        appendSystemMessage(message) {
                            notices.push(message);
                        },
                        promptSelect(_title, items) {
                            // Fixed human input at the UI boundary: select the presented id.
                            selectedId = items.find((item) => item.value === command.sessionId)?.value || "";
                            return Promise.resolve(selectedId || null);
                        },
                    },
                    replaceRuntimeSession(id) {
                        sessionId = id;
                    },
                });
                const snapshot = runtime.getSessionSnapshot(sessionId);
                console.log(
                    JSON.stringify({
                        kind: "resume-command",
                        ok: true,
                        selectedId,
                        notices,
                        workflowContext: snapshot?.workflowContext,
                        savedId: snapshot?.managed?.runwieldSessionId,
                    }),
                );
            } else if (command.kind === "image-preflight-turn") {
                const initialImages = [
                    {
                        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                        mimeType: "image/png",
                    },
                ];
                const preflight = await runtime.preflightUserTurnImages(sessionId, {
                    initialRequest: command.text || "Describe this image.",
                    agentName: "remote-runtime",
                    initialImages,
                    modelOverride: command.modelOverride,
                });
                if (!preflight.ok) throw new Error(preflight.message);
                const preparedModelOverride =
                    "preparedModelOverride" in preflight ? preflight.preparedModelOverride : undefined;
                console.log(JSON.stringify({ kind: "image-preflight", ok: true, preparedModelOverride }));
                const result = await runtime.promptUserTurn(sessionId, {
                    initialRequest: command.text || "Describe this image.",
                    agentName: "remote-runtime",
                    initialImages,
                    preparedModelOverride,
                });
                report("turn", result.ok, result.error);
            } else if (command.kind === "load") {
                await runtime.closeAllSessionsWhenIdle();
                sessionId = (await runtime.loadSession({ cwd: input.cwd, sessionId: command.sessionId || "" }))
                    .sessionId;
                report("load", true);
            } else {
                const result = await runtime.promptUserTurn(sessionId, {
                    initialRequest: command.text || "Read and write the remote project.",
                    agentName: "remote-runtime",
                    initialImages: command.image
                        ? [
                              {
                                  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                                  mimeType: "image/png",
                              },
                          ]
                        : [],
                });
                report("turn", result.ok, result.error);
            }
        } catch (error) {
            report(command.kind, false, String(error));
        }
    }
} finally {
    await Promise.all(pending);
    await runtime.closeAllSessionsWhenIdle();
    clearGuideRunner();
    clearReviewHost();
    await clearMcp();
    clearModels();
    clearMemory();
    await lines.cancel();
    lines.releaseLock();
}
