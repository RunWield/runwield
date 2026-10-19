/** Separate process. Exercise workflow boundaries with a real remote managed operation. */
import type { ExtensionToolContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createBackgroundTaskTool } from "../../tools/background-task.ts";
import { readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stdinStream } from "../../testing/stdin-stream.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { configureRemotePersonalResources } from "./personal-resources.ts";
import { configureRemoteSettingsConnection } from "./settings-bridge.ts";
import { configureRemoteModelConnection } from "../models/model-registry.ts";
import { RemoteSessionControl, type RemoteSessionControlConnection } from "./session-control-client.ts";
import { SessionRuntime } from "../session/session-runtime.ts";
import { SessionHost } from "../session/session-host.ts";
import { createExecutionStartPorts, startActiveExecutionWorkflow } from "../workflow/execution-start.ts";
import { finalizePlanImplementation } from "../workflow/implementation-checkpoint.ts";
import { runValidationPhase, createEngineValidationArgs } from "../workflow/validation.ts";
import { continueWorkflowValidation } from "../workflow/validation-supervisor.ts";
import { runPublicationPhase } from "../workflow/validation-publication.ts";
import { resolvePhaseContext } from "../workflow/validation-context.ts";
import type { PhaseContext } from "../workflow/validation-types.ts";
import { createValidationSessionPort } from "../workflow/validation-session-adapter.ts";
import { createGitPort } from "../git-port.ts";
import { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } from "../work-records/mnemoteca-port.ts";
import { loadPlan } from "../../plan-store.js";
import { remoteBackgroundTaskLogDirectory } from "./background-task-logs.ts";
import { git } from "../workflow/validation-test-helpers.js";

interface Input {
    connection: RemoteSessionControlConnection;
    resources: string;
    cwd: string;
    commandLog: string;
    scenario: "handoff" | "validation" | "publication" | "repair" | "supervisor" | "publication-catch" | "logs";
}
const lines = processLines(stdinStream());
const input: Input = JSON.parse((await lines.read()).value || "{}");
await lines.cancel();
configureRemotePersonalResources({ globalRoot: input.resources });
configureRemoteSettingsConnection(input.connection);
const clearModels = await configureRemoteModelConnection(input.connection);
const host = new SessionHost();
const runtime = new SessionRuntime({
    sessionHost: host,
    sessionStore: null,
    remoteSessionControl: new RemoteSessionControl(input.connection),
    ownerProcessKind: "test",
    ownerInstanceId: crypto.randomUUID(),
});
let ciStarted = 0;
try {
    const sessionId = await runtime.createPromptReadySession({ cwd: input.cwd, agentName: "remote-runtime" });
    await runtime
        .promptUserTurn(sessionId, {
            initialRequest: "Run the boundary scenario.",
            agentName: "remote-runtime",
            customTools: [
                {
                    name: "boundary_scenario",
                    label: "Boundary scenario",
                    description: "Run the requested workflow boundary.",
                    parameters: Type.Object({}),
                    execute: async () => {
                        const session = host.requireSession(sessionId);
                        if (input.scenario === "logs") {
                            const started = session.backgroundTasks.startShell({
                                command: "printf remote-output",
                                cwd: input.cwd,
                            });
                            await session.backgroundTasks.wait(started.task_id);
                            const tool = createBackgroundTaskTool({
                                hostedSession: session,
                                cwd: input.cwd,
                                allowShellStart: false,
                            });
                            const result = await tool.execute(
                                "background-status",
                                { action: "status", task_id: started.task_id },
                                undefined,
                                undefined,
                                {} as ExtensionToolContext,
                            );
                            const status = result.details;
                            if (!status) throw new Error("Background status failed");
                            const directory = remoteBackgroundTaskLogDirectory();
                            console.log(
                                JSON.stringify({
                                    scenario: input.scenario,
                                    status,
                                    directory,
                                    mode: directory ? (await stat(directory)).mode & 0o777 : 0,
                                    sessionMode: (await stat(dirname(status.log_path))).mode & 0o777,
                                    contents: await readFile(status.log_path, "utf8"),
                                }),
                            );
                        } else {
                            const manager = session.getRootSessionManager() as SessionManager | null;
                            if (!manager) throw new Error("Missing root manager");
                            let plan = await loadPlan(input.cwd, "effect-gate");
                            if (!plan) throw new Error("Missing fixture Plan");
                            let executionCwd = input.cwd;
                            if (input.scenario !== "handoff") {
                                await startActiveExecutionWorkflow({
                                    planName: "effect-gate",
                                    triageMeta: plan.attrs,
                                    currentStatus: plan.attrs.status,
                                    hostedSession: session,
                                    ports: createExecutionStartPorts(),
                                });
                                const workflow = session.getActiveExecutionWorkflow();
                                if (!workflow?.executionCwd || workflow.executionCwd === input.cwd)
                                    throw new Error("Expected isolated worktree");
                                executionCwd = workflow.executionCwd;
                                await writeFile(join(executionCwd, "sentinel.txt"), "remote implementation\n");
                                await finalizePlanImplementation({
                                    projectRoot: input.cwd,
                                    planName: "effect-gate",
                                    triageMeta: plan.attrs,
                                    executionContext: workflow,
                                    hostedSession: session,
                                });
                                plan = (await loadPlan(executionCwd, "effect-gate"))!;
                            }
                            const args = {
                                hostedSession: session,
                                planName: "effect-gate",
                                planContent: plan.markdown,
                                triageMeta: plan.attrs,
                                git: createGitPort(),
                                localCI: {
                                    run: async () => {
                                        ciStarted++;
                                        return { kind: "completed" as const, exitCode: 0, output: "passed" };
                                    },
                                },
                                workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                            };
                            if (["publication", "publication-catch", "repair"].includes(input.scenario)) {
                                await runValidationPhase(args);
                                if (input.scenario !== "repair") await runValidationPhase(args);
                            }
                            const engine = createEngineValidationArgs(args);
                            let publicationContext: PhaseContext | undefined;
                            if (input.scenario === "publication" || input.scenario === "publication-catch") {
                                const phase = await resolvePhaseContext(engine);
                                if (phase.kind !== "ok") throw new Error("Publication context unavailable");
                                publicationContext = phase.context;
                            }
                            session.replaceWorkflowContext(
                                { planName: "effect-gate", planId: "effect-gate-plan", status: plan.attrs.status },
                                { persist: true },
                            );
                            const canonicalPlan = await loadPlan(executionCwd, "effect-gate");
                            const beforePlan = await readFile(join(executionCwd, "docs/plans/effect-gate.md"), "utf8");
                            const beforeRefs = await git(input.cwd, ["show-ref"]);
                            const beforeCommands = await readFile(input.commandLog, "utf8");
                            const ciBeforeFault = ciStarted;
                            let saveError = "";
                            try {
                                if (input.scenario !== "supervisor" && input.scenario !== "publication-catch")
                                    manager.appendCustomEntry("effect-gate-fault", { marker: "swallowed-save" });
                            } catch (error) {
                                saveError = String(error);
                            }
                            let boundaryError = "";
                            try {
                                if (input.scenario === "handoff") {
                                    await startActiveExecutionWorkflow({
                                        planName: "effect-gate",
                                        triageMeta: plan.attrs,
                                        currentStatus: plan.attrs.status,
                                        hostedSession: session,
                                        ports: createExecutionStartPorts(),
                                    });
                                } else if (input.scenario === "supervisor") {
                                    await continueWorkflowValidation(args);
                                } else if (input.scenario === "validation") {
                                    await runValidationPhase(args);
                                } else if (input.scenario === "repair") {
                                    const port = createValidationSessionPort(session);
                                    await port.runIndependentRepairTurn({
                                        kind: "validation",
                                        agentName: "engineer",
                                        userRequest: "Repair the change",
                                        cwd: executionCwd,
                                    });
                                } else {
                                    if (!publicationContext) throw new Error("Publication context missing");
                                    await runPublicationPhase(engine, publicationContext, {
                                        humanReviewMode: "always",
                                        humanReviewDecision: "approved",
                                        humanReviewedAt: new Date().toISOString(),
                                    });
                                }
                            } catch (error) {
                                boundaryError = String(error);
                            }
                            console.log(
                                JSON.stringify({
                                    scenario: input.scenario,
                                    saveError,
                                    boundaryError,
                                    ciStarted,
                                    ciBeforeFault,
                                    executionCwd,
                                    beforePlan,
                                    planStatus: canonicalPlan?.attrs.status,
                                    validationPhase: canonicalPlan?.attrs.validationPhase,
                                    beforeRefs,
                                    beforeCommands,
                                    afterCommands: await readFile(input.commandLog, "utf8"),
                                }),
                            );
                        }
                        return { content: [{ type: "text" as const, text: "Scenario finished." }], details: {} };
                    },
                },
            ],
        })
        .catch((error: Error) => {
            if (input.scenario === "logs") throw error;
            console.log(JSON.stringify({ runtimeError: String(error) }));
        });
} finally {
    await runtime.closeAllSessionsWhenIdle();
    clearModels();
}
