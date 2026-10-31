import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { stat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { savePlan } from "../../plan-store.js";
import { git } from "../workflow/validation-test-helpers.js";
import { assertRemoteStorageAbsent, withRemoteRuntimeFixture } from "./remote-runtime-test-fixture.ts";
import type { BackgroundTaskStatus } from "../session/background-tasks.ts";
import { scriptReviewAndRecord } from "./remote-runtime-workflows-fixture.ts";

interface ScenarioReport {
    scenario: string;
    saveError?: string;
    boundaryError?: string;
    ciStarted?: number;
    ciBeforeFault?: number;
    executionCwd?: string;
    beforePlan?: string;
    planStatus?: string;
    validationPhase?: string | null;
    beforeRefs?: string;
    beforeCommands?: string;
    afterCommands?: string;
    directory?: string;
    mode?: number;
    sessionMode?: number;
    contents?: string;
    status?: BackgroundTaskStatus;
}

for (const scenario of [
    "handoff",
    "validation",
    "repair",
    "publication",
    "supervisor",
    "publication-catch",
    "ci-repair-progress",
    "logs",
] as const) {
    test(
        scenario === "logs"
            ? "remote background status reads private transient logs and runtime exit removes them"
            : `a caught remote save fault prevents ${scenario} effects`,
        async () => {
            await withRemoteRuntimeFixture(async (f) => {
                await savePlan(f.remoteProject, "effect-gate", "# Effect gate\n\nKeep project effects bounded.\n", {
                    planId: "effect-gate-plan",
                    classification: "QUICK_FIX",
                    status: "ready_for_work",
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                });
                scriptReviewAndRecord(f);
                let faulted = false;
                let atFault: string[] = [];
                let modelsAtFault = 0;
                let commandsAtFault = "";
                async function snapshot(root: string): Promise<string[]> {
                    const result: string[] = [];
                    for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
                        a.name.localeCompare(b.name),
                    )) {
                        const path = join(root, item.name);
                        if (item.isDirectory()) result.push(...(await snapshot(path)));
                        else if (path.endsWith("effect-gate.md") || /controller/.test(path))
                            result.push(`${path}:${(await readFile(path)).toString("base64")}`);
                    }
                    return result;
                }
                f.policy.before = async (request, path) => {
                    if (
                        path === "/session/request" &&
                        request.kind === "append" &&
                        (scenario === "supervisor"
                            ? request.contents.includes('"validationGeneration":"')
                            : scenario === "ci-repair-progress"
                              ? request.contents.includes('"stage":"engineer_repair"')
                              : scenario === "publication-catch"
                                ? request.contents.includes('"stage":"merge"')
                                : request.contents.includes("effect-gate-fault"))
                    ) {
                        if (!faulted) {
                            atFault = [...(await snapshot(f.remoteProject)), ...(await snapshot(f.remoteHome))];
                            modelsAtFault = f.modelRequests.length;
                            commandsAtFault = await readFile(f.remoteCommandLog, "utf8");
                        }
                        faulted = true;
                        return new Response("boundary-save-refused", { status: 503 });
                    }
                };
                const output = await captureForegroundProcess(process.execPath, {
                    args: runtimeSourceArgs([
                        "run",
                        "-A",
                        "--quiet",
                        "--config",
                        new URL("../../../deno.json", import.meta.url).pathname,
                        new URL("./remote-runtime-effects-client.ts", import.meta.url).pathname,
                    ]),
                    cwd: f.remoteProject,
                    env: {
                        HOME: f.remoteHome,
                        WLD_TEST_SANDBOX_HOME: f.remoteHome,
                        TMPDIR: join(f.remoteHome, "tmp"),
                        MNEMOTECA_DB_PATH: join(f.remoteHome, "memory.db"),
                        PATH: `${join(f.remoteHome, "bin")}:/usr/bin:/bin`,
                    },
                    stdinText:
                        JSON.stringify({
                            connection: f.connection,
                            resources: f.resources,
                            cwd: f.remoteProject,
                            commandLog: f.remoteCommandLog,
                            scenario,
                        }) + "\n",
                });
                const stdout = new TextDecoder().decode(output.stdout);
                const stderr = new TextDecoder().decode(output.stderr);
                assertEquals(output.code, 0, stderr + stdout);
                const line = stdout.split("\n").find((line) => line.startsWith('{"scenario":'));
                assert(line, stdout + stderr);
                const report: ScenarioReport = JSON.parse(line);
                assertEquals(report.scenario, scenario);
                if (scenario === "logs") {
                    assert(report.directory);
                    assert(report.status);
                    assertEquals(report.mode, 0o700);
                    assertEquals(report.sessionMode, 0o700);
                    assert(relative(join(f.remoteHome, ".wld"), report.directory).startsWith(".."));
                    assertEquals(report.status.state, "completed");
                    assertEquals(report.status.output, "remote-output");
                    assertEquals(report.contents, "remote-output");
                    await assertRejects(() => stat(report.directory!), Error, "ENOENT");
                } else {
                    assert(faulted, `The save bridge must fail before the effect boundary: ${JSON.stringify(report)}`);
                    if (!["supervisor", "publication-catch", "ci-repair-progress"].includes(scenario))
                        assertStringIncludes(report.saveError || "", "Laptop Session save refused (503)");
                    if (!["supervisor", "publication-catch", "ci-repair-progress"].includes(scenario))
                        assertStringIncludes(report.boundaryError || "", "Laptop Session save refused (503)");
                    const afterFault = [...(await snapshot(f.remoteProject)), ...(await snapshot(f.remoteHome))];
                    assertEquals(afterFault, atFault, "No Plan or controller write can follow the refused save");
                    assertEquals(f.modelRequests.length, modelsAtFault, "No repair agent may start after the fault");
                    if (scenario === "supervisor")
                        assert(
                            atFault.some(
                                (entry) =>
                                    entry.includes("/controller/") &&
                                    Buffer.from(entry.split(":").at(-1)!, "base64")
                                        .toString("utf8")
                                        .includes('"state": "running"'),
                            ),
                            "The supervisor must have claimed the durable checkpoint before the save fault",
                        );
                    if (["supervisor", "publication-catch", "ci-repair-progress"].includes(scenario))
                        assertEquals(
                            report.afterCommands,
                            commandsAtFault,
                            "No later Git command can follow the in-flight save fault",
                        );
                    assertEquals(report.ciStarted, scenario === "ci-repair-progress" ? 1 : report.ciBeforeFault);
                    const statusAtFault =
                        scenario === "publication" || scenario === "publication-catch"
                            ? "reviewed"
                            : ["repair", "validation", "supervisor", "ci-repair-progress"].includes(scenario)
                              ? "implemented"
                              : "ready_for_work";
                    assertEquals(report.planStatus, statusAtFault);
                    if (scenario === "repair") assertEquals(report.validationPhase, "semantic");
                    assertEquals(
                        report.ciBeforeFault,
                        ["repair", "publication", "publication-catch"].includes(scenario) ? 1 : 0,
                    );
                    if (!["supervisor", "publication-catch", "ci-repair-progress"].includes(scenario))
                        assertEquals(
                            report.afterCommands,
                            report.beforeCommands,
                            "The fault must prevent all later Git commands",
                        );
                    assert(report.executionCwd);
                    if (scenario !== "handoff")
                        assert(
                            report.executionCwd !== f.remoteProject,
                            "The fault must occur after isolated worktree preparation",
                        );
                    if (!["supervisor", "publication-catch", "ci-repair-progress"].includes(scenario))
                        assertEquals(
                            await readFile(join(report.executionCwd, "docs/plans/effect-gate.md"), "utf8"),
                            report.beforePlan,
                        );
                    if (scenario !== "publication-catch")
                        assertEquals(await git(f.remoteProject, ["show-ref"]), report.beforeRefs);
                }
                await assertRemoteStorageAbsent(f);
            });
        },
    );
}

for (const boundary of ["handoff", "validation", "repair", "publication"] as const) {
    test(`a local Session still performs ${boundary} effects through the same workflow boundary`, async () => {
        await withRemoteRuntimeFixture(async (f) => {
            const { Type } = await import("@earendil-works/pi-ai");
            const { SessionRuntime } = await import("../session/session-runtime.ts");
            const { SessionHost } = await import("../session/session-host.ts");
            const { openFileSessionStore } = await import("../session/file-session-store.ts");
            const { createExecutionStartPorts, startActiveExecutionWorkflow } =
                await import("../workflow/execution-start.ts");
            const { finalizePlanImplementation } = await import("../workflow/implementation-checkpoint.ts");
            const { runValidationPhase, createEngineValidationArgs } = await import("../workflow/validation.ts");
            const { createValidationSessionPort } = await import("../workflow/validation-session-adapter.ts");
            const { resolvePhaseContext } = await import("../workflow/validation-context.ts");
            const { runPublicationPhase } = await import("../workflow/validation-publication.ts");
            const { createGitPort } = await import("../git-port.ts");
            const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../work-records/mnemoteca-port.ts");
            const { loadPlan } = await import("../../plan-store.js");
            const { writeFile } = await import("node:fs/promises");
            await savePlan(f.remoteProject, "effect-gate", "# Local effect gate\n", {
                planId: "local-effect-plan",
                classification: "QUICK_FIX",
                status: "ready_for_work",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            });
            const store = openFileSessionStore();
            const host = new SessionHost();
            const runtime = new SessionRuntime({
                sessionHost: host,
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: crypto.randomUUID(),
            });
            let completed = false;
            let ci = 0;
            scriptReviewAndRecord(f);
            try {
                const id = await runtime.createPromptReadySession({ cwd: f.remoteProject, agentName: "engineer" });
                await runtime.promptUserTurn(id, {
                    agentName: "engineer",
                    initialRequest: "Run the local boundary scenario.",
                    customTools: [
                        {
                            name: "boundary_scenario",
                            label: "Boundary scenario",
                            description: "Run a local workflow boundary.",
                            parameters: Type.Object({}),
                            execute: async () => {
                                const session = host.requireSession(id);
                                const plan = (await loadPlan(f.remoteProject, "effect-gate"))!;
                                // This entry is a normal local save, not a remote capability fault.
                                session
                                    .getRootSessionManager()!
                                    .appendCustomEntry?.("effect-gate-fault", { marker: "local-save" });
                                await startActiveExecutionWorkflow({
                                    planName: "effect-gate",
                                    triageMeta: plan.attrs,
                                    currentStatus: plan.attrs.status,
                                    hostedSession: session,
                                    ports: createExecutionStartPorts(),
                                });
                                const workflow = session.getActiveExecutionWorkflow()!;
                                if (boundary !== "handoff") {
                                    await writeFile(
                                        join(workflow.executionCwd!, "sentinel.txt"),
                                        "local implementation\n",
                                    );
                                    await finalizePlanImplementation({
                                        projectRoot: f.remoteProject,
                                        planName: "effect-gate",
                                        triageMeta: plan.attrs,
                                        executionContext: workflow,
                                        hostedSession: session,
                                    });
                                    const implemented = (await loadPlan(workflow.executionCwd!, "effect-gate"))!;
                                    const args = {
                                        workRecordMnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                                        hostedSession: session,
                                        planName: "effect-gate",
                                        planContent: implemented.markdown,
                                        triageMeta: implemented.attrs,
                                        git: createGitPort(),
                                        localCI: {
                                            run: () => {
                                                ci++;
                                                return Promise.resolve({
                                                    kind: "completed" as const,
                                                    exitCode: 0,
                                                    output: "passed",
                                                });
                                            },
                                        },
                                    };
                                    await runValidationPhase(args);
                                    if (boundary === "repair") {
                                        await createValidationSessionPort(session).runIndependentRepairTurn({
                                            kind: "validation",
                                            agentName: "engineer",
                                            userRequest: "Repair the local change.",
                                            cwd: workflow.executionCwd!,
                                        });
                                    } else if (boundary === "publication") {
                                        await runValidationPhase(args);
                                        const engine = createEngineValidationArgs(args);
                                        const phase = await resolvePhaseContext(engine);
                                        assertEquals(phase.kind, "ok");
                                        if (phase.kind !== "ok")
                                            throw new Error("Local publication context unavailable");
                                        const result = await runPublicationPhase(engine, phase.context, {
                                            humanReviewMode: "always",
                                            humanReviewDecision: "approved",
                                            humanReviewedAt: new Date().toISOString(),
                                        });
                                        assertEquals(result.result.kind, "verified");
                                    }
                                }
                                completed = true;
                                return { content: [{ type: "text" as const, text: "Finished." }], details: {} };
                            },
                        },
                    ],
                });
                assert(completed, "The local operation must pass the live-capability boundary");
                assertEquals(ci, boundary === "handoff" ? 0 : 1);
            } finally {
                await runtime.closeAllSessionsWhenIdle();
                store.close();
            }
        });
    });
}
